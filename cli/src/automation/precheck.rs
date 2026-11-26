//! Local guards for starting coordinator and health automations.
use super::machine::*;
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use std::{collections::HashSet, path::Path};

pub enum Decision {
    Start(String),
    Skip(String),
}
impl Decision {
    pub fn result(self) -> (u8, String) {
        match self {
            Self::Start(reason) => (0, format!("start: {reason}")),
            Self::Skip(reason) => (1, format!("skip: {reason}")),
        }
    }
}
fn unloaded(km: &Value) -> bool {
    text(&km["project"]["id"]).is_empty()
        || km["nodes"].as_object().is_none_or(|nodes| nodes.is_empty())
}
fn live() -> Result<Vec<Value>> {
    Ok(agents(false)?
        .into_iter()
        .filter(|a| a["state"] != "done")
        .collect())
}
fn unavailable(e: Box<dyn std::error::Error>) -> Decision {
    Decision::Skip(format!(
        "Orca cannot be read ({})",
        e.to_string()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .chars()
            .take(120)
            .collect::<String>()
    ))
}

pub fn wake(
    dir: &Path,
    km: &Value,
    now: f64,
    remote: impl FnOnce() -> Result<Decision>,
) -> Result<Decision> {
    if unloaded(km) {
        return Ok(Decision::Skip("the plan is not loaded".into()));
    }
    let here = dir.canonicalize()?.display().to_string();
    let alive = match live() {
        Ok(alive) => alive,
        Err(e) => return Ok(unavailable(e)),
    };
    if alive.iter().any(|a| a["path"] == here) {
        return Ok(Decision::Skip(
            "a coordinator agent runs in this worktree".into(),
        ));
    }
    let coordinators = alive
        .iter()
        .map(|a| Path::new(text(&a["path"])))
        .filter(|p| p.join("plan.json").is_file() && p.join("keymap.json").is_file())
        .collect::<HashSet<_>>();
    if coordinators.len() >= 2 {
        return Ok(Decision::Skip(format!(
            "{} coordinator agents run on this machine (limit 2)",
            coordinators.len()
        )));
    }
    let path = home()?.join(".local/state/work-graph/wake.json");
    let mut state = read_state(&path)?;
    let mut starts: Vec<f64> =
        serde_json::from_value(state.get(&here).cloned().unwrap_or(json!([])))?;
    starts.retain(|time| now - time < 3600.);
    if starts.len() >= 3 {
        return Ok(Decision::Skip(format!(
            "{} starts in the last hour (limit 3); start one by hand",
            starts.len()
        )));
    }
    let decision = remote()?;
    if matches!(decision, Decision::Start(_)) {
        starts.push(now);
        state[here] = json!(starts);
        save_state(&path, &state)?;
    }
    Ok(decision)
}

pub(super) fn duration(seconds: i64) -> String {
    let minutes = seconds.div_euclid(60);
    if minutes >= 1440 {
        format!("{}d{:02}h", minutes / 1440, minutes % 1440 / 60)
    } else if minutes >= 60 {
        format!("{}h{:02}m", minutes / 60, minutes % 60)
    } else {
        format!("{minutes}m")
    }
}
pub trait HealthReads {
    fn paused(&mut self) -> Result<bool>;
    fn complete(&mut self) -> Result<bool>;
    fn changed_since(&mut self, since: i64) -> Result<bool>;
}
pub fn due(
    dir: &Path,
    km: &Value,
    interval_hours: f64,
    now: DateTime<Utc>,
    service: &mut impl HealthReads,
) -> Result<Decision> {
    if unloaded(km) {
        return Ok(Decision::Skip("the plan is not loaded".into()));
    }
    let row = &km["run"]["effort"];
    if let Some(path) = row["health_worktree"].as_str() {
        let path = std::fs::canonicalize(path).or_else(|_| std::path::absolute(path))?;
        match live() {
            Ok(alive) if alive.iter().any(|a| Path::new(text(&a["path"])) == path) => {
                return Ok(Decision::Skip("a status check agent runs".into()));
            }
            Err(e) => return Ok(unavailable(e)),
            _ => (),
        }
    }
    let last = ["health_started", "health_at"]
        .iter()
        .filter_map(|k| DateTime::parse_from_rfc3339(text(&row[k])).ok())
        .map(|t| t.timestamp())
        .max();
    let elapsed = last.map(|t| now.timestamp() - t);
    let interval = (interval_hours * 3600.) as i64;
    if let Some(age) = elapsed.filter(|age| *age < interval) {
        return Ok(Decision::Skip(format!(
            "the last check was {} ago (interval {})",
            duration(age),
            duration(interval)
        )));
    }
    if service.paused()? {
        return Ok(Decision::Skip("the effort is paused".into()));
    }
    if service.complete()? {
        return Ok(Decision::Skip("the effort is complete".into()));
    }
    let reason = match last {
        None => "no check yet".into(),
        Some(_)
            if text(&row["health_at"]).is_empty()
                || text(&row["health_started"]) > text(&row["health_at"]) =>
        {
            "the last start gave no report".into()
        }
        Some(t) if now.timestamp() - t >= 86400 => {
            format!("no check for {}", duration(now.timestamp() - t))
        }
        Some(t) if service.changed_since(t)? => "the effort changed since the last check".into(),
        _ => return Ok(Decision::Skip("no change since the last check".into())),
    };
    save_fields(
        dir,
        &[(
            "health_started",
            json!(now.format("%Y-%m-%dT%H:%M:%SZ").to_string()),
        )],
    )?;
    Ok(Decision::Start(reason))
}
