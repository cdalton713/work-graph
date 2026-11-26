use super::cleanup::orca;
use serde_json::{Value, json};
use std::{
    fs,
    io::{self, Write},
    path::Path,
    process::Command,
};

fn invalid(e: impl std::fmt::Display) -> io::Error {
    io::Error::other(e.to_string())
}
fn merge(old: &mut Value, new: &Value) {
    match (old, new) {
        (Value::Object(a), Value::Object(b)) => {
            for (k, v) in b {
                merge(a.entry(k).or_insert(Value::Null), v)
            }
        }
        (old, Value::Array(b)) => {
            let mut a = old.as_array().cloned().unwrap_or_default();
            for item in b {
                if !a.contains(item) {
                    a.push(item.clone());
                }
            }
            *old = Value::Array(a);
        }
        (old, new) => *old = new.clone(),
    }
}

fn merge_toml(old: &mut toml::Value, new: toml::Value) {
    match (old, new) {
        (toml::Value::Table(a), toml::Value::Table(b)) => {
            for (k, v) in b {
                if let Some(item) = a.get_mut(&k) {
                    merge_toml(item, v);
                } else {
                    a.insert(k, v);
                }
            }
        }
        (toml::Value::Array(a), toml::Value::Array(b)) => {
            for v in b {
                if !a.contains(&v) {
                    a.push(v);
                }
            }
        }
        (old, new) => *old = new,
    }
}

fn safe_target(dir: &Path, name: &str) -> io::Result<()> {
    let dest = dir.join(name);
    for p in [dest.parent().unwrap(), &dest] {
        if p.is_symlink() {
            return Err(invalid(format!(
                "{} is a symlink; wg does not write through it",
                p.display()
            )));
        }
    }
    let git = |args: &[&str]| Command::new("git").args(args).current_dir(dir).output();
    if git(&["ls-files", "--error-unmatch", name])?
        .status
        .success()
    {
        return Err(invalid(format!(
            "{name} is tracked in {}; wg does not change it",
            dir.display()
        )));
    }
    if !git(&["check-ignore", "-q", name])?.status.success() {
        let r = git(&["rev-parse", "--git-path", "info/exclude"])?;
        if !r.status.success() {
            return Err(invalid(String::from_utf8_lossy(&r.stderr).trim()));
        }
        let exclude = dir.join(String::from_utf8(r.stdout).map_err(invalid)?.trim());
        fs::create_dir_all(exclude.parent().unwrap())?;
        let mut f = fs::OpenOptions::new()
            .read(true)
            .append(true)
            .create(true)
            .open(&exclude)?;
        f.lock()?;
        let current = fs::read_to_string(&exclude)?;
        let line = format!("/{name}");
        if !current.lines().any(|s| s == line) {
            if !current.is_empty() && !current.ends_with('\n') {
                writeln!(f)?;
            }
            writeln!(f, "{line}")?;
        }
        if !git(&["check-ignore", "-q", name])?.status.success() {
            return Err(invalid(format!(
                "git does not ignore {name} in {} (a .gitignore rule overrides info/exclude); wg does not write it",
                dir.display()
            )));
        }
    }
    Ok(())
}

pub(crate) fn agent(dir: &Path, agent: &str, values: &Value, apply: bool) -> io::Result<bool> {
    let name = if agent == "claude" {
        ".claude/settings.local.json"
    } else {
        ".codex/config.toml"
    };
    let path = dir.join(name);
    if apply {
        safe_target(dir, name)?;
    }
    let prior = match fs::read_to_string(&path) {
        Ok(s) => Some(s),
        Err(e) if e.kind() == io::ErrorKind::NotFound => None,
        Err(e) => return Err(e),
    };
    let text = if agent == "claude" {
        let old: Value = serde_json::from_str(prior.as_deref().unwrap_or("{}"))
            .map_err(|e| invalid(format!("{}: does not parse ({e})", path.display())))?;
        if !old.is_object() {
            return Err(invalid(format!("{}: not a JSON object", path.display())));
        }
        let mut new = old.clone();
        merge(&mut new, values);
        if old == new && prior.is_some() {
            return Ok(false);
        }
        serde_json::to_string_pretty(&new)? + "\n"
    } else {
        let old: toml::Table = toml::from_str(prior.as_deref().unwrap_or(""))
            .map_err(|e| invalid(format!("{}: does not parse ({e})", path.display())))?;
        let old = toml::Value::Table(old);
        let mut new = old.clone();
        merge_toml(&mut new, toml::Value::try_from(values).map_err(invalid)?);
        if old == new && prior.is_some() {
            return Ok(false);
        }
        toml::to_string(&new).map_err(invalid)?
    };
    if apply {
        let parent = path.parent().unwrap();
        fs::create_dir_all(parent)?;
        let mut f = tempfile::NamedTempFile::new_in(parent)?;
        f.write_all(text.as_bytes())?;
        if let Ok(meta) = fs::metadata(&path) {
            f.as_file().set_permissions(meta.permissions())?;
        }
        f.as_file().sync_all()?;
        f.persist(&path).map_err(invalid)?;
    }
    Ok(true)
}

pub(super) fn coordinator(
    dir: &Path,
    name: &str,
    cfg: &Value,
    apply: bool,
    changes: &mut Vec<String>,
) {
    let rename = || -> Result<Option<(String, String)>, String> {
        let found = orca(&["worktree", "list", "--limit", "10000"])?;
        if found["truncated"] == true {
            return Err("orca worktree list is truncated".into());
        }
        let path = dir.canonicalize().map_err(|e| e.to_string())?;
        let tree = found["worktrees"]
            .as_array()
            .ok_or("missing worktrees")?
            .iter()
            .find(|w| {
                w["path"]
                    .as_str()
                    .is_some_and(|s| Path::new(s).canonicalize().is_ok_and(|d| d == path))
            });
        let Some(tree) = tree.filter(|t| t["displayName"] != name) else {
            return Ok(None);
        };
        Ok(Some((
            tree["id"].as_str().ok_or("missing worktree id")?.into(),
            tree["displayName"]
                .as_str()
                .unwrap_or(tree["path"].as_str().unwrap_or("-"))
                .into(),
        )))
    };
    let result = rename().and_then(|tree| {
        if let Some((id, old)) = tree {
            changes.push(format!("name the Orca worktree '{old}' as '{name}'"));
            if apply {
                orca(&[
                    "worktree",
                    "set",
                    "--worktree",
                    &format!("id:{id}"),
                    "--display-name",
                    name,
                ])?;
            }
        }
        Ok(())
    });
    if let Err(e) = result {
        eprintln!(
            "warn load: Orca did not name the coordinator worktree ({})",
            e.lines().next().unwrap_or("unknown error")
        );
    }
    let mut settings = cfg["coordinator_settings"].clone();
    let limit = cfg["context_limit"].as_i64().unwrap_or(0);
    if limit != 0 {
        settings["claude"]["autoCompactWindow"] = json!(limit);
    }
    for (key, values) in settings
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(_, v)| v.as_object().is_some_and(|o| !o.is_empty()))
    {
        let name = if key == "claude" {
            ".claude/settings.local.json"
        } else {
            ".codex/config.toml"
        };
        let mut what = vec![];
        if cfg["coordinator_settings"][key]
            .as_object()
            .is_some_and(|o| !o.is_empty())
        {
            what.push(format!("coordinator_settings.{key}"));
        }
        if key == "claude" && limit != 0 {
            what.push(format!("autoCompactWindow {limit}"));
        }
        match agent(dir, key, values, apply) {
            Ok(true) => changes.push(format!(
                "set {} in {}",
                what.join(" and "),
                dir.join(name).display()
            )),
            Ok(false) => (),
            Err(e) => eprintln!("warn: the coordinator settings are not set ({e})"),
        }
    }
}
