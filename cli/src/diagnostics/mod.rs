//! Read-only observations shared by the status check and the doctor command.
use crate::{
    automation::machine::{self, Result, text},
    state,
};
use chrono::{DateTime, Utc};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

mod hosted;
mod services;

pub type Lines = Vec<(String, String)>;

/// The mapped-issue reader supplies normalized status and issue labels, selected for this effort's workspace.
pub struct MappedIssue {
    pub status: String,
    pub labels: Vec<String>,
}

fn line(level: &str, message: impl Into<String>) -> (String, String) {
    (level.into(), message.into())
}

fn settled(status: &str) -> bool {
    matches!(status, "Merged" | "Done" | "Canceled")
}

fn worktrees(km: &Value, statuses: &BTreeMap<String, String>) -> Lines {
    let mut lines = vec![];
    if let Some(rows) = km["run"]["nodes"].as_object() {
        for (key, row) in rows.iter().collect::<BTreeMap<_, _>>() {
            let Some(path) = row["path"].as_str().filter(|p| !p.is_empty()) else {
                continue;
            };
            if !statuses.get(key).is_some_and(|s| settled(s)) && !Path::new(path).exists() {
                lines.push(line(
                    "FAIL",
                    format!("worktree {key}: {path} does not exist"),
                ));
            }
        }
    }
    if lines.is_empty() {
        lines.push(line("ok", "worktrees: each path in the run rows exists"));
    }
    lines
}

fn keymap(
    dir: &Path,
    km: &Value,
    issues: &BTreeMap<String, MappedIssue>,
    now: i64,
    statuses: &mut BTreeMap<String, String>,
) -> Result<Lines> {
    let mut lines = vec![];
    let nodes = km["nodes"].as_object().ok_or("nodes must be an object")?;
    let entries = state::journal_entries(dir)?.0;
    for (key, entry) in nodes.iter().collect::<BTreeMap<_, _>>() {
        let name = format!(
            "keymap {key} {}",
            entry["identifier"].as_str().unwrap_or("-")
        );
        let Some(issue) = issues.get(entry["id"].as_str().ok_or("missing mapped issue id")?) else {
            lines.push(line(
                "FAIL",
                format!("{name}: the issue is gone from Linear; recovery.md \"Run state\""),
            ));
            continue;
        };
        statuses.insert(key.clone(), issue.status.clone());
        let job = text(&km["run"]["nodes"][key]["state"]);
        let live = matches!(job, "creating" | "starting" | "running");
        if !live && let Some(claim) = issue.labels.iter().find(|l| l.starts_with("agent:")) {
            lines.push(line(
                "FAIL",
                format!("{name}: {claim} with no live job in the run row"),
            ));
        }
        if matches!(job, "creating" | "starting") {
            let at = entries
                .iter()
                .rev()
                .find(|e| e["key"] == *key && e["changes"]["state"][1] == job)
                .and_then(|e| DateTime::parse_from_rfc3339(text(&e["time"])).ok())
                .map(|t| t.timestamp());
            let at = match at {
                Some(t) => t,
                None => DateTime::<Utc>::from(dir.join("keymap.json").metadata()?.modified()?)
                    .timestamp(),
            };
            if now - at > 1800 {
                let age = crate::automation::precheck::duration(now - at);
                lines.push(line(
                    "FAIL",
                    format!("{name}: state={job} for {age}; recovery.md \"Resume\""),
                ));
            }
        }
        if live
            && (settled(&issue.status)
                || matches!(
                    issue.status.as_str(),
                    "Todo" | "Ready" | "Backlog" | "Triage"
                ))
        {
            lines.push(line(
                "FAIL",
                format!(
                    "{name}: state={job} in the run row, but the issue is {}",
                    issue.status
                ),
            ));
        }
    }
    if lines.is_empty() {
        lines.push(line(
            "ok",
            format!("keymap: {} node(s) agree with Linear", nodes.len()),
        ));
    }
    Ok(lines)
}

fn failure(name: &str, error: impl std::fmt::Display) -> (String, String) {
    let message = error
        .to_string()
        .lines()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" / ");
    let message = if message.chars().count() > 300 {
        format!("{}…", message.chars().take(299).collect::<String>())
    } else {
        message
    };
    line("FAIL", format!("{name}: {message}"))
}

pub fn effort(
    dir: &Path,
    now: i64,
    fetch: impl FnOnce(&Value) -> Result<BTreeMap<String, MappedIssue>>,
) -> Lines {
    let km = match state::load_keymap(dir) {
        Ok(km) => km,
        Err(e) => return vec![failure("keymap", &e), failure("worktrees", e)],
    };
    let mut statuses = BTreeMap::new();
    let mut lines = if km["nodes"].as_object().is_some_and(|n| n.is_empty()) {
        vec![line("warn", "keymap: no nodes; run wg load --apply")]
    } else {
        fetch(&km)
            .and_then(|issues| keymap(dir, &km, &issues, now, &mut statuses))
            .unwrap_or_else(|e| vec![failure("keymap", e)])
    };
    lines.extend(worktrees(&km, &statuses));
    lines
}

fn trigger(automation: &Value, hourly: bool) -> Option<bool> {
    if let Some(cron) = automation.get("trigger").filter(|v| !v.is_null()) {
        return Some(cron == if hourly { "0 * * * *" } else { "*/5 * * * *" });
    }
    let rule = automation["rrule"].as_str()?.to_ascii_uppercase();
    if !rule.contains("FREQ=") {
        return None;
    }
    let mut parts = rule
        .split(';')
        .filter_map(|p| p.split_once('='))
        .collect::<BTreeMap<_, _>>();
    if parts.get("BYSECOND") == Some(&"0") {
        parts.remove("BYSECOND");
    }
    if parts.get("INTERVAL") == Some(&"1") {
        parts.remove("INTERVAL");
    }
    Some(if hourly {
        parts == BTreeMap::from([("FREQ", "HOURLY")])
            || parts == BTreeMap::from([("FREQ", "HOURLY"), ("BYMINUTE", "0")])
    } else {
        parts == BTreeMap::from([("FREQ", "MINUTELY"), ("INTERVAL", "5")])
            || parts
                == BTreeMap::from([
                    ("FREQ", "HOURLY"),
                    ("BYMINUTE", "0,5,10,15,20,25,30,35,40,45,50,55"),
                ])
    })
}

fn schedules(dirs: &BTreeSet<PathBuf>, hourly: bool) -> Result<Lines> {
    let (name, field, period) = if hourly {
        ("health", "health_automation", "each hour")
    } else {
        ("autostart", "autostart", "each 5 minutes")
    };
    let mut lines = vec![];
    for dir in dirs {
        let km = state::load_keymap(dir)?;
        let row = &km["run"]["effort"];
        let Some(id) = row[field].as_str().filter(|id| !id.is_empty()) else {
            continue;
        };
        let fix = format!(
            "wg {name} {} --install",
            machine::quote(&dir.to_string_lossy())
        );
        let title = format!("{name} {}: automation {id}", dir.display());
        let shown = match machine::orca(&["automations", "show", id]) {
            Ok(result) => result,
            Err(e) => {
                lines.push(line("FAIL", format!("{title}: {e}; {fix}")));
                continue;
            }
        };
        let shown = &shown["automation"];
        let worktree = text(&row["health_worktree"]);
        let finding = if hourly && !worktree.is_empty() && !Path::new(worktree).exists() {
            line(
                "FAIL",
                format!("{title}: its worktree {worktree} does not exist; {fix}"),
            )
        } else if shown["enabled"] == false {
            line("warn", format!("{title} disabled"))
        } else {
            match trigger(shown, hourly) {
                None => line(
                    "warn",
                    format!("{title} on, but its trigger is not readable"),
                ),
                Some(false) => line(
                    "FAIL",
                    format!(
                        "{title} does not run {period} ({}); {fix}",
                        shown["rrule"].as_str().unwrap_or(text(&shown["trigger"]))
                    ),
                ),
                Some(true) if hourly => line(
                    "ok",
                    format!(
                        "{title} on, {period}; last check {}",
                        row["health"].as_str().unwrap_or("none")
                    ),
                ),
                Some(true) => line("ok", format!("{title} on, {period}")),
            }
        };
        lines.push(finding);
    }
    if lines.is_empty() {
        lines.push(line("ok", format!("{name}: off for each loaded effort")))
    }
    Ok(lines)
}

pub fn tools() -> Lines {
    let orca = machine::orca_path();
    [
        ("gh auth", "gh", &["auth", "status"][..]),
        ("st", "st", &["--version"][..]),
        ("orca", orca.to_str().unwrap_or("orca"), &["--version"][..]),
    ]
    .into_iter()
    .map(|(name, program, args)| {
        match machine::output(Command::new(program).args(args), Duration::from_secs(30)) {
            Ok(_) => line("ok", format!("{name}: {program} {}", args.join(" "))),
            Err(e) => failure(name, format!("{program}: {e}")),
        }
    })
    .collect()
}

/// Run the shared local checks against the caller's loaded plans and scoped issue snapshot.
/// Each check retains its own failures so later checks still run.
pub fn collect(
    dir: Option<&Path>,
    roots: &[PathBuf],
    now: i64,
    fetch: impl FnOnce(&Value) -> Result<BTreeMap<String, MappedIssue>>,
) -> Lines {
    let mut lines = tools();
    match state::Config::discover()
        .map_err(Into::into)
        .and_then(|config| services::inspect(dir, &config))
    {
        Ok(services) => lines.extend(services),
        Err(e) => lines.push(failure("config", e)),
    }
    // Effort-specific hosted checks require a readable plan for credential selection.
    if dir.is_none_or(|p| p.join("plan.json").is_file()) {
        match state::Config::discover()
            .map_err(Into::into)
            .and_then(|config| hosted::inspect(dir, &config))
        {
            Ok(found) => lines.extend(found),
            Err(e) => lines.push(failure("hosted diagnostics", e)),
        }
    }
    match machine::plans(roots) {
        Ok(mut dirs) => {
            if let Some(dir) = dir {
                dirs.insert(dir.canonicalize().unwrap_or_else(|_| dir.into()));
            }
            for (name, hourly) in [("autostart", false), ("health", true)] {
                lines.extend(schedules(&dirs, hourly).unwrap_or_else(|e| vec![failure(name, e)]));
            }
        }
        Err(e) => lines.push(failure("plans", e)),
    }
    if let Some(dir) = dir {
        lines.extend(effort(dir, now, fetch));
    }
    lines
}

#[cfg(test)]
mod tests;
