//! Local child processes and files used by the scheduled commands.
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    env,
    ffi::OsStr,
    fs,
    io::{Read, Seek, SeekFrom},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
pub fn text(v: &Value) -> &str {
    v.as_str().unwrap_or_default()
}

pub fn executable(name: &str) -> Option<PathBuf> {
    env::split_paths(&env::var_os("PATH")?)
        .map(|p| p.join(name))
        .find(|p| fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0))
}

pub fn orca_path() -> PathBuf {
    env::var_os("ORCA_CLI_COMMAND")
        .map(PathBuf::from)
        .or_else(|| executable("orca"))
        .unwrap_or_else(|| {
            let app = Path::new("/Applications/Orca.app/Contents/Resources/bin/orca");
            if app.is_file() {
                app.into()
            } else {
                "orca".into()
            }
        })
}

/// Temporary files allow the child to write either stream without filling a pipe.
pub fn output(command: &mut Command, timeout: Duration) -> Result<String> {
    let mut out = tempfile::tempfile()?;
    let mut err = tempfile::tempfile()?;
    let mut child = command
        .stdin(Stdio::null())
        .stdout(out.try_clone()?)
        .stderr(err.try_clone()?)
        .spawn()?;
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait()? {
            let file = if status.success() { &mut out } else { &mut err };
            file.seek(SeekFrom::Start(0))?;
            let mut body = String::new();
            file.read_to_string(&mut body)?;
            if status.success() {
                return Ok(body);
            }
            let reason = if body.trim().is_empty() {
                format!("command exited {}", status.code().unwrap_or(-1))
            } else {
                body.trim().to_owned()
            };
            return Err(reason.into());
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            child.wait()?;
            return Err(
                format!("command timed out after {} seconds", timeout.as_secs_f64()).into(),
            );
        }
        thread::sleep(
            Duration::from_millis(10).min(deadline.saturating_duration_since(Instant::now())),
        );
    }
}

pub fn orca(args: &[&str]) -> Result<Value> {
    let result = output(
        Command::new(orca_path()).args(args).arg("--json"),
        Duration::from_secs(30),
    )
    .map_err(|e| format!("orca {} {}: {e}", args[0], args[1]))?;
    let reply: Value = serde_json::from_str(&result)?;
    if reply["ok"] == false {
        return Err(format!(
            "orca {} {}: {}",
            args[0],
            args[1],
            reply["error"]["message"].as_str().unwrap_or("failed")
        )
        .into());
    }
    Ok(reply["result"].clone())
}

pub fn agents(local: bool) -> Result<Vec<Value>> {
    let args: &[&str] = if local {
        &["agent", "list", "--environment", "local"]
    } else {
        &["agent", "list"]
    };
    let reply = orca(args)?;
    let mut agents = reply["agents"]
        .as_array()
        .ok_or("orca agent list returned no agents array")?
        .clone();
    for agent in &mut agents {
        let tree = text(&agent["worktreeId"]);
        agent["path"] = json!(tree.split_once("::").map_or(tree, |(_, p)| p));
    }
    Ok(agents)
}

pub fn home() -> Result<PathBuf> {
    env::home_dir().ok_or_else(|| "cannot find home directory".into())
}
pub fn expand(path: &Path) -> Result<PathBuf> {
    if let Ok(rest) = path.strip_prefix("~") {
        Ok(home()?.join(rest))
    } else {
        Ok(path.to_owned())
    }
}

pub fn plans(roots: &[PathBuf]) -> Result<BTreeSet<PathBuf>> {
    let mut plans = BTreeSet::new();
    for root in roots {
        let entries = match fs::read_dir(expand(root)?) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e.into()),
        };
        for entry in entries {
            let dir = entry?.path();
            if dir
                .file_name()
                .and_then(OsStr::to_str)
                .is_some_and(|s| s.ends_with("-core"))
                && dir.join("plan.json").is_file()
                && dir.join("keymap.json").is_file()
            {
                plans.insert(dir.canonicalize()?);
            }
        }
    }
    Ok(plans)
}

pub fn read_state(path: &Path) -> Result<Value> {
    match fs::read(path) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(e) => Err(e.into()),
    }
}
pub fn save_state(path: &Path, state: &Value) -> Result<()> {
    let parent = path.parent().ok_or("no state directory")?;
    fs::create_dir_all(parent)?;
    let mut file = tempfile::NamedTempFile::new_in(parent)?;
    crate::state::write_pretty_json(&mut file, state)?;
    file.as_file().sync_all()?;
    file.persist(path)?;
    Ok(())
}
pub fn state_lock(path: &Path) -> Result<fs::File> {
    fs::create_dir_all(path.parent().ok_or("no state directory")?)?;
    Ok(fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(path.with_extension("lock"))?)
}

pub fn save_fields(dir: &Path, fields: &[(&str, Value)]) -> Result<()> {
    let lock = crate::state::PlanLock::acquire(dir, None)?;
    let mut km = crate::state::load_keymap(dir)?;
    let run = &mut km["run"];
    for key in ["nodes", "effort"] {
        if run[key].is_null() {
            run[key] = json!({});
        }
    }
    let row = run["effort"].as_object_mut().ok_or("invalid effort row")?;
    for (key, value) in fields {
        if value.is_null() {
            row.remove(*key);
        } else {
            row.insert((*key).into(), value.clone());
        }
    }
    lock.save_keymap(&km)?;
    Ok(())
}
pub fn quote(s: &str) -> String {
    if !s.is_empty()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_@%+=:,./-".contains(&b))
    {
        s.into()
    } else {
        format!("'{}'", s.replace('\'', "'\u{22}'\u{22}'"))
    }
}

/// Preserve the installed symlink in scheduled commands so replacement releases remain reachable.
pub fn scheduled_program() -> Result<PathBuf> {
    let running = env::current_exe()?;
    let Some(arg) = env::args_os().next() else {
        return Ok(running);
    };
    let arg = Path::new(&arg);
    let invoked = if arg.components().count() == 1 {
        arg.to_str().and_then(executable)
    } else {
        Some(arg.into())
    };
    if let Some(invoked) = invoked
        && invoked
            .canonicalize()
            .is_ok_and(|path| running.canonicalize().is_ok_and(|r| r == path))
    {
        return Ok(std::path::absolute(invoked)?);
    }
    Ok(running)
}
