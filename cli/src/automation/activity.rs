//! Collect local Orca activity for each loaded effort.
use super::machine::*;
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap},
    io::Write,
    os::unix::ffi::OsStrExt,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

fn shortened(s: &str, limit: usize) -> String {
    let line = s
        .lines()
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" / ");
    if line.chars().count() > limit {
        format!("{}…", line.chars().take(limit - 1).collect::<String>())
    } else {
        line
    }
}

pub fn rows(dir: &Path, km: &Value, agents: &[Value], now: DateTime<Utc>) -> Result<Vec<Value>> {
    let here = dir.canonicalize()?;
    let mut workers = HashMap::new();
    if let Some(nodes) = km["run"]["nodes"].as_object() {
        for (key, row) in nodes {
            if let Some(path) = row["path"].as_str().filter(|p| !p.is_empty()) {
                let path = expand(Path::new(path))?;
                workers.insert(
                    path.canonicalize().or_else(|_| std::path::absolute(path))?,
                    key,
                );
            }
        }
    }
    let mut found = vec![];
    for agent in agents {
        let Some(path) = agent["path"].as_str().filter(|p| !p.is_empty()) else {
            continue;
        };
        let path = Path::new(path)
            .canonicalize()
            .or_else(|_| std::path::absolute(path))?;
        let coordinator = path == here;
        let key = workers.get(&path).filter(|_| !coordinator);
        if !coordinator && key.is_none() {
            continue;
        }
        let Some(id) = agent["orcaSessionId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .or_else(|| agent["paneKey"].as_str())
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        let at = agent["updatedAt"]
            .as_f64()
            .and_then(|ms| DateTime::from_timestamp_millis(ms as i64));
        if agent["state"] == "done" && at.is_none_or(|t| now - t > chrono::Duration::days(1)) {
            continue;
        }
        found.push(json!({"id":id,"role":if coordinator{"coordinator"}else{"worker"},"key":key,
            "issue":key.and_then(|key|km["nodes"][key]["identifier"].as_str()),"agent":text(&agent["agent"]),
            "state":text(&agent["state"]),"title":shortened(text(&agent["title"]),120),"said":shortened(text(&agent["lastAssistantMessage"]),500),
            "at":at.map(|t|t.format("%Y-%m-%dT%H:%M:%SZ").to_string())}));
    }
    found.sort_by(|a, b| {
        text(&a["role"])
            .cmp(text(&b["role"]))
            .then_with(|| text(&b["at"]).cmp(text(&a["at"])))
    });
    found.truncate(50);
    Ok(found)
}

fn who(row: &Value) -> String {
    if row["role"] == "coordinator" {
        "coordinator".into()
    } else {
        format!(
            "worker {}",
            row["issue"].as_str().unwrap_or(text(&row["key"]))
        )
    }
}

pub fn notice_entries(
    rows: &[Value],
    seen: &mut HashMap<String, usize>,
) -> BTreeMap<String, String> {
    let mut counts = HashMap::new();
    let mut entries = BTreeMap::new();
    for row in rows {
        let why = match text(&row["state"]) {
            "blocked" => "waits at a prompt",
            "waiting" => "waits for your input",
            _ => continue,
        };
        let hash = format!(
            "{:x}",
            Sha256::digest(format!(
                "agent:{}:{}",
                text(&row["id"]),
                text(&row["state"])
            ))
        );
        let id = hash[..12].to_owned();
        let count = seen.get(&id).copied().unwrap_or(0) + 1;
        if count >= 2 {
            entries.insert(
                id.clone(),
                format!(
                    "{} ({}) {why}: {}",
                    who(row),
                    text(&row["agent"]),
                    text(&row["said"]).chars().take(200).collect::<String>()
                ),
            );
        }
        counts.insert(id, count);
    }
    *seen = counts;
    entries
}
pub fn print_rows(out: &mut impl Write, efforts: &[(String, Vec<Value>)]) -> Result<()> {
    for (name, rows) in efforts {
        for row in rows {
            writeln!(
                out,
                "{name}: {} {} {} {}: {}",
                who(row),
                text(&row["agent"]),
                text(&row["state"]),
                row["at"].as_str().unwrap_or("-"),
                text(&row["said"]).chars().take(120).collect::<String>()
            )?;
        }
    }
    if efforts.iter().all(|(_, rows)| rows.is_empty()) {
        writeln!(out, "no agent of a loaded effort is open in Orca")?
    }
    Ok(())
}

pub fn collect(
    roots: &[PathBuf],
    local: bool,
    mut plan: impl FnMut(&Path) -> Result<Value>,
    mut observe: impl FnMut(&Path, &Value, &[Value]) -> Result<()>,
) -> Result<Vec<(String, Vec<Value>)>> {
    let agents = agents(local)?;
    let mut efforts = vec![];
    for dir in plans(roots)? {
        let plan = match plan(&dir) {
            Ok(p) => p,
            Err(e) => {
                eprintln!("warn agents: {}: {e}", dir.display());
                continue;
            }
        };
        let Ok(km) = crate::state::load_keymap(&dir) else {
            continue;
        };
        if text(&km["project"]["id"]).is_empty() {
            continue;
        }
        let rows = rows(&dir, &km, &agents, Utc::now())?;
        observe(&dir, &plan, &rows)?;
        efforts.push((text(&plan["effort"]["name"]).into(), rows));
    }
    Ok(efforts)
}

pub(crate) fn stamp_path(dir: &Path) -> Result<PathBuf> {
    let hash = format!(
        "{:x}",
        Sha256::digest(dir.canonicalize()?.as_os_str().as_bytes())
    );
    let path = home()?
        .join(".local/state/work-graph/agent-sends")
        .join(format!("{hash}.json"));
    Ok(path)
}
pub fn record_send(dir: &Path) -> Result<()> {
    save_state(
        &stamp_path(dir)?,
        &json!({"at":Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()}),
    )
}

#[derive(Default)]
pub struct Heartbeat {
    sent: Option<(Vec<Value>, Instant)>,
}
impl Heartbeat {
    pub fn due(&self, rows: &[Value], now: Instant, resend: bool) -> bool {
        match &self.sent {
            None => !rows.is_empty(),
            Some((previous, at)) => {
                rows != previous
                    || (!rows.is_empty()
                        && (resend || now.duration_since(*at) >= Duration::from_secs(60)))
            }
        }
    }
    pub fn sent(&mut self, rows: Vec<Value>, now: Instant) {
        self.sent = Some((rows, now));
    }
}

fn plugin_reply(args: &[&str]) -> Result<Value> {
    let output = capture(
        std::process::Command::new(orca_path())
            .args(args)
            .arg("--json"),
        Duration::from_secs(30),
    )?;
    Ok(serde_json::from_slice(&output.stdout).map_err(|_| {
        format!(
            "orca {} {}: {}",
            args[0],
            args[1],
            shortened(&process_error(&output), 200)
        )
    })?)
}
fn plugin_result(op: &str, reply: &Value) -> Result<Value> {
    if reply["ok"] != true {
        return Err(format!(
            "orca plugin {op}: {}",
            reply["error"]["message"].as_str().unwrap_or("failed")
        )
        .into());
    }
    Ok(reply["result"].clone())
}

pub fn plugin(
    install_dir: &Path,
    label: &str,
    uninstall: bool,
    approval: Option<&str>,
    out: &mut impl Write,
) -> Result<u8> {
    let label = format!("{label}.agents");
    let legacy = home()?
        .join("Library/LaunchAgents")
        .join(format!("{label}.plist"));
    if legacy.exists() {
        #[cfg(target_os = "macos")]
        {
            let _ = output(
                std::process::Command::new("/bin/launchctl")
                    .args(["bootout", &format!("gui/{}/{label}", nix::unistd::getuid())]),
                Duration::from_secs(30),
            );
        }
        std::fs::remove_file(legacy)?;
        writeln!(out, "removed the launchd sender {label}")?;
    }
    let listed = plugin_result("list", &plugin_reply(&["plugin", "list"])?)?;
    let installed = listed["plugins"].as_array().and_then(|ps| {
        ps.iter()
            .find(|p| text(&p["pluginKey"]).rsplit('.').next() == Some("wg-agents"))
    });
    if uninstall {
        if let Some(p) = installed {
            let key = text(&p["pluginKey"]);
            plugin_result("uninstall", &plugin_reply(&["plugin", "uninstall", key])?)?;
            writeln!(out, "removed the Orca plugin {key}")?;
        } else {
            writeln!(out, "the Orca plugin is not installed")?
        }
        return Ok(0);
    }
    let folder = install_dir.to_str().ok_or("invalid plugin path")?;
    if !install_dir.join("orca-plugin.json").is_file() {
        return Err(format!(
            "no Orca plugin at {folder}: install wg from a checkout of the repository"
        )
        .into());
    }
    let inspected = plugin_result("inspect", &plugin_reply(&["plugin", "inspect", folder])?)?;
    let mut args = vec!["plugin", "install", folder];
    if let Some(p) = installed {
        let source_matches = p["source"]["reference"] == folder;
        let managed = install_dir == home()?.join(".local/share/work-graph/current/orca-plugin");
        if (!managed || source_matches)
            && p["source"]["contentHash"] == inspected["contentHash"]
            && p["needsReconsent"] != true
        {
            writeln!(
                out,
                "the Orca plugin {} is installed and current ({})",
                text(&p["pluginKey"]),
                text(&p["status"])
            )?;
            return Ok(0);
        }
        if source_matches {
            args = vec!["plugin", "update", text(&p["pluginKey"])];
        }
    }
    if let Some(fingerprint) = approval {
        args.extend(["--approve", fingerprint]);
    }
    let reply = plugin_reply(&args)?;
    let error = &reply["error"];
    if matches!(
        error["code"].as_str(),
        Some("approval_required" | "approval_stale")
    ) {
        let data = &error["data"];
        let grants = data["plugin"].get("grants").unwrap_or(&data["grants"]);
        writeln!(out, "The Orca plugin asks for this access:")?;
        if let Some(description) = grants["executionDescription"].as_str() {
            writeln!(out, "  - {description}")?;
        }
        for grant in grants["capabilities"].as_array().into_iter().flatten() {
            writeln!(
                out,
                "  - {}: {}",
                text(&grant["kind"]),
                text(&grant["description"])
            )?;
        }
        if let Some(fingerprint) = text(&data["command"])
            .split_once("--approve ")
            .and_then(|(_, s)| s.split_whitespace().next())
        {
            writeln!(
                out,
                "To approve it, run: wg agents --install --approve {fingerprint}"
            )?;
        }
        return Ok(3);
    }
    let result = plugin_result(args[1], &reply)?;
    writeln!(
        out,
        "installed the Orca plugin {} {}: it starts wg agents in an Orca terminal now and after each Orca start",
        text(&result["pluginKey"]),
        text(&result["version"])
    )?;
    Ok(0)
}

/// Own the sender lock for the lifetime of the process. A poll can include a bounded send
/// for each effort; its execution time counts toward the ten-second interval.
pub fn monitor(
    once: bool,
    wait: bool,
    program: &Path,
    mut poll: impl FnMut() -> Result<Vec<(String, Vec<Value>)>>,
    out: &mut impl Write,
    errors: &mut impl Write,
) -> Result<u8> {
    use std::os::unix::fs::MetadataExt;
    let stamp = || {
        std::fs::metadata(program)
            .ok()
            .map(|m| (m.ino(), m.mtime(), m.mtime_nsec()))
    };
    let before = stamp();
    let path = home()?.join(".local/state/work-graph/agents.json");
    let lock = state_lock(&path)?;
    if !once {
        match lock.try_lock() {
            Ok(()) => (),
            Err(std::fs::TryLockError::WouldBlock) if wait => {
                writeln!(
                    out,
                    "waiting: wg agents is already running; this one starts when it stops"
                )?;
                out.flush()?;
                lock.lock()?;
            }
            Err(std::fs::TryLockError::WouldBlock) => {
                writeln!(out, "skipped: wg agents is already running")?;
                return Ok(0);
            }
            Err(e) => return Err(e.into()),
        }
    }
    let mut warned = None;
    loop {
        let cycle = Instant::now();
        if before != stamp() {
            writeln!(
                errors,
                "note agents: executable changed, restart the sender"
            )?;
            return Ok(1);
        }
        match poll() {
            Ok(rows) if once => {
                print_rows(out, &rows)?;
                return Ok(0);
            }
            Ok(_) => warned = None,
            Err(e) if once => return Err(e),
            Err(e) => {
                let error = shortened(&e.to_string(), 200);
                if warned.as_ref() != Some(&error) {
                    writeln!(errors, "warn agents: {error}")?;
                    warned = Some(error);
                }
            }
        }
        std::thread::sleep(Duration::from_secs(10).saturating_sub(cycle.elapsed()));
    }
}
