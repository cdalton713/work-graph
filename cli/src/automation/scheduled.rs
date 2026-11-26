//! Schedule and run machine-wide page refreshes.
use super::machine::*;
use serde_json::{Value, json};
use std::{
    fs,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

fn trim_logs(dir: &Path) -> Result<()> {
    for filename in ["out.log", "error.log"] {
        let mut log = match fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(dir.join(filename))
        {
            Ok(log) => log,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e.into()),
        };
        if log.metadata()?.len() > 1024 * 1024 {
            log.seek(SeekFrom::End(-200 * 1024))?;
            let mut tail = Vec::new();
            log.read_to_end(&mut tail)?;
            log.rewind()?;
            log.write_all(&tail)?;
            log.set_len(tail.len() as u64)?;
        }
    }
    Ok(())
}

pub trait TickServices {
    fn refresh(
        &mut self,
        dir: &Path,
        state: &mut Value,
        state_path: &Path,
        notify: bool,
    ) -> Result<String>;
    fn archive(&mut self, paths: &[PathBuf]) -> Result<()>;
}

pub fn tick(
    roots: &[PathBuf],
    notify: bool,
    services: &mut impl TickServices,
    out: &mut impl Write,
) -> Result<u8> {
    let home = home()?;
    let path = home.join(".local/state/work-graph/tick.json");
    let dirs = plans(roots)?.into_iter().collect::<Vec<_>>();
    let lock = state_lock(&path)?;
    match lock.try_lock() {
        Ok(()) => (),
        Err(std::fs::TryLockError::WouldBlock) => {
            writeln!(out, "skipped: a tick is already running")?;
            return Ok(0);
        }
        Err(e) => return Err(e.into()),
    }
    trim_logs(&home.join("Library/Logs/wg-tick"))?;
    let mut state = read_state(&path)?;
    let mut failed = false;
    for dir in &dirs {
        let key = dir.to_string_lossy();
        let outcome = match services.refresh(dir, &mut state, &path, notify) {
            Ok(s) => s,
            Err(e) => {
                let message = format!("error: {e}");
                state["path-errors"][key.as_ref()] =
                    json!({"at":chrono::Utc::now().to_rfc3339(),"result":message});
                save_state(&path, &state)?;
                message
            }
        };
        if outcome.starts_with("error:") {
            failed = true;
        } else if let Some(errors) = state["path-errors"].as_object_mut() {
            errors.remove(key.as_ref());
        }
        writeln!(
            out,
            "{key}: {}",
            outcome.lines().collect::<Vec<_>>().join(" ")
        )?;
        out.flush()?;
    }
    save_state(&path, &state)?;
    services.archive(&dirs)?;
    Ok(u8::from(failed))
}

fn xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
fn string(s: &str) -> String {
    format!("<string>{}</string>", xml(s))
}

pub fn tick_schedule(
    config: &Value,
    program: &Path,
    roots: &[PathBuf],
    channel: Option<&str>,
    uninstall: bool,
    out: &mut impl Write,
) -> Result<u8> {
    let home = home()?;
    let label = config["tick_label"].as_str().ok_or("invalid tick_label")?;
    let path = home
        .join("Library/LaunchAgents")
        .join(format!("{label}.plist"));
    let domain = format!("gui/{}", nix::unistd::getuid());
    if uninstall {
        writeln!(out, "/bin/launchctl bootout {domain}/{label}")?;
        match fs::remove_file(path) {
            Ok(()) => (),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(e.into()),
        }
        return Ok(0);
    }
    let user = text(&config["github_user"]);
    let account = if user.is_empty() {
        String::new()
    } else {
        format!(" as {user}")
    };
    let gh = std::path::absolute(
        executable("gh").ok_or_else(|| format!("install gh and authenticate it{account}"))?,
    )?;
    let login = output(
        Command::new(&gh)
            .env_remove("GH_TOKEN")
            .env_remove("GITHUB_TOKEN")
            .env_remove("GH_CONFIG_DIR")
            .env("GH_PROMPT_DISABLED", "1")
            .args(["api", "--hostname", "github.com", "user", "--jq", ".login"]),
        Duration::from_secs(60),
    )
    .map_err(|e| format!("authenticate gh{account} for the scheduled user: {e}"))?;
    if !user.is_empty() && login.trim() != user {
        return Err(format!("authenticate gh{account} for the scheduled user").into());
    }
    let program = std::path::absolute(program)?;
    let mut args = vec![program.display().to_string(), "tick".into()];
    if let Some(channel) = channel {
        args.extend(["--channel".into(), channel.into()]);
    }
    for root in roots {
        args.extend([
            "--root".into(),
            std::path::absolute(expand(root)?)?.display().to_string(),
        ]);
    }
    let args = args.iter().map(|s| string(s)).collect::<String>();
    let mut dirs = vec![];
    for dir in [
        gh.parent().unwrap(),
        program.parent().unwrap(),
        Path::new("/usr/bin"),
        Path::new("/bin"),
        Path::new("/usr/sbin"),
        Path::new("/sbin"),
    ] {
        let s = dir.display().to_string();
        if !dirs.contains(&s) {
            dirs.push(s)
        }
    }
    let log = home.join("Library/Logs/wg-tick");
    fs::create_dir_all(&log)?;
    fs::create_dir_all(path.parent().unwrap())?;
    let times = [0, 15, 30, 45]
        .map(|minute| format!("<dict><key>Minute</key><integer>{minute}</integer></dict>"))
        .join("");
    let contents = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key>{}
<key>ProgramArguments</key><array>{args}</array>
<key>RunAtLoad</key><true/>
<key>StartCalendarInterval</key><array>{times}</array>
<key>EnvironmentVariables</key><dict><key>PATH</key>{}<key>GH_PROMPT_DISABLED</key><string>1</string></dict>
<key>StandardOutPath</key>{}
<key>StandardErrorPath</key>{}
</dict></plist>
"#,
        string(label),
        string(&dirs.join(":")),
        string(&log.join("out.log").to_string_lossy()),
        string(&log.join("error.log").to_string_lossy())
    );
    fs::write(&path, contents)?;
    writeln!(
        out,
        "Put each Linear key in a private file (mode 600) in ~/.config/work-graph."
    )?;
    let keys = config["workspaces"]
        .as_array()
        .ok_or("invalid workspaces")?
        .iter()
        .map(|w| format!("{}-linear-api-key", text(&w["id"])))
        .collect::<Vec<_>>();
    writeln!(
        out,
        "Name each file <workspace id>-linear-api-key: {}.",
        keys.join(", ")
    )?;
    writeln!(
        out,
        "/bin/launchctl bootstrap {domain} {}",
        quote(&path.to_string_lossy())
    )?;
    Ok(0)
}

/// Preserve the previous digest and pending deliveries across a restart.
pub fn deliver_members(
    record: &mut Value,
    members: &serde_json::Map<String, Value>,
    mut persist: impl FnMut(&Value) -> Result<()>,
    send: impl FnOnce(&[Value]) -> Result<()>,
) -> Result<()> {
    let mut pending = std::collections::BTreeMap::new();
    for (key, value) in members {
        if record["pending"].get(key).is_some()
            || record
                .get("members")
                .is_some_and(|previous| previous.get(key).is_none())
        {
            pending.insert(key, value.clone());
        }
    }
    record["members"] = json!(members);
    record["pending"] = json!(pending);
    persist(record)?;
    if !pending.is_empty() {
        send(&pending.into_values().collect::<Vec<_>>())?;
        record["pending"] = json!({});
        persist(record)?;
    }
    Ok(())
}
