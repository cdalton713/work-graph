//! Local effort files shared with the Python CLI.
mod config;
mod json;
pub use config::{Config, Workspace};
pub use json::write_pretty_json;

use serde_json::{Value, json};
use std::{
    fs::{self, File, Permissions},
    io,
    os::unix::fs::PermissionsExt,
    path::Path,
    time::{Duration, Instant},
};
use tempfile::NamedTempFile;

pub(crate) fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

fn read_object(path: &Path) -> io::Result<Value> {
    let value: Value = serde_json::from_slice(&fs::read(path)?)?;
    if !value.is_object() {
        return Err(invalid(format!(
            "{} must contain an object",
            path.display()
        )));
    }
    Ok(value)
}

pub fn load_keymap(dir: &Path) -> io::Result<Value> {
    let path = dir.join("keymap.json");
    let mut data = match fs::read(path) {
        Ok(bytes) if !bytes.is_empty() => serde_json::from_slice(&bytes)?,
        Ok(_) => json!({}),
        Err(e) if e.kind() == io::ErrorKind::NotFound => json!({}),
        Err(e) => return Err(e),
    };
    let map = data
        .as_object_mut()
        .ok_or_else(|| invalid("keymap must be an object"))?;
    for field in ["milestones", "nodes"] {
        map.entry(field).or_insert_with(|| json!({}));
    }
    Ok(data)
}

/// Hold this guard across the complete read-modify-write operation. Pass it to
/// nested operations so they share the same directory lock.
pub struct PlanLock {
    dir: std::path::PathBuf,
    directory: File,
}
impl PlanLock {
    pub fn acquire(dir: &Path, wait: Option<Duration>) -> io::Result<Self> {
        let directory = File::open(dir)?;
        if let Some(wait) = wait {
            let start = Instant::now();
            loop {
                match directory.try_lock() {
                    Ok(()) => break,
                    Err(std::fs::TryLockError::WouldBlock) if start.elapsed() < wait => {
                        std::thread::sleep(
                            Duration::from_millis(50).min(wait.saturating_sub(start.elapsed())),
                        )
                    }
                    Err(std::fs::TryLockError::WouldBlock) => {
                        return Err(io::Error::new(
                            io::ErrorKind::TimedOut,
                            "the plan lock is held",
                        ));
                    }
                    Err(std::fs::TryLockError::Error(e)) => return Err(e),
                }
            }
        } else {
            directory.lock()?;
        }
        Ok(Self {
            dir: dir.to_owned(),
            directory,
        })
    }

    /// Replace the local keymap file. The caller handles journal and collaboration updates.
    pub fn save_keymap(&self, data: &Value) -> io::Result<()> {
        self.save("keymap.json", data)
    }
    pub fn save_plan(&self, data: &Value) -> io::Result<()> {
        self.save("plan.json", data)
    }
    fn save(&self, name: &str, data: &Value) -> io::Result<()> {
        let path = self.dir.join(name);
        let mode = match fs::metadata(&path) {
            Ok(meta) => meta.permissions().mode() & 0o7777,
            Err(e) if e.kind() == io::ErrorKind::NotFound => 0o644,
            Err(e) => return Err(e),
        };
        let mut temp = NamedTempFile::new_in(&self.dir)?;
        write_pretty_json(&mut temp, data)?;
        temp.as_file()
            .set_permissions(Permissions::from_mode(mode))?;
        temp.as_file().sync_all()?;
        temp.persist(path)?;
        self.directory.sync_all()
    }
}

pub fn journal_entries(dir: &Path) -> io::Result<(Vec<Value>, usize)> {
    let mut entries = Vec::new();
    let mut skipped = 0;
    for name in ["journal.1.jsonl", "journal.jsonl"] {
        let content = match fs::read_to_string(dir.join(name)) {
            Ok(text) => text,
            Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e),
        };
        for line in content.lines().filter(|line| !line.trim().is_empty()) {
            let entry = serde_json::from_str::<Value>(line).ok().filter(|v| {
                let kind = v.get("kind").map_or(Some("run"), Value::as_str);
                matches!(
                    kind,
                    Some("run" | "status" | "claim" | "issue" | "baseline")
                ) && (kind != Some("baseline") || v["run"].is_object())
                    && v["time"].as_str().is_some_and(|t| {
                        chrono::DateTime::parse_from_rfc3339(t).is_ok()
                            || t.parse::<chrono::NaiveDateTime>().is_ok()
                            || t.parse::<chrono::NaiveDate>().is_ok()
                    })
                    && v["changes"].as_object().is_some_and(|changes| {
                        changes
                            .values()
                            .all(|pair| pair.as_array().is_some_and(|a| a.len() == 2))
                    })
            });
            if let Some(entry) = entry {
                entries.push(entry);
            } else {
                skipped += 1;
            }
        }
    }
    Ok((entries, skipped))
}
