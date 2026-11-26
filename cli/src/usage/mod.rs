//! Read agent transcripts for the effort and its recorded worktrees.
mod discovery;
mod table;
mod transcript;
use chrono::{DateTime, FixedOffset, NaiveDate, NaiveDateTime, Utc};
use regex::Regex;
use serde_json::{Value, json};
use std::{path::Path, process::ExitCode, sync::LazyLock, time::SystemTime};

const WORKER: &str = "You are working inside Orca, a multi-agent IDE. You are a dispatched worker.";
static UTILITY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(chat|session|conversation|thread|tab)(?:'s)? (name|title)\b|\bbranch name\b|\bcommit message\b|^\s*reply with ok\b").unwrap()
});
const HELP: &str = "usage: wg-preview usage [-h] [--json] [--since SINCE] [--all] dir

positional arguments:
  dir

options:
  -h, --help     show this help message and exit
  --json         exact integers and each session
  --since SINCE  only calls after this: a duration back from now (2h, 3d) or
                 an ISO time
  --all          print each session, not the largest 15";

#[derive(Default)]
struct Session {
    first_message: Option<String>,
    cwd: Option<String>,
    coordinating: bool,
    models: Vec<(String, u64)>,
    calls: u64,
    fresh: u64,
    write: u64,
    read: u64,
    output: u64,
    max_context: u64,
    start_context: Option<u64>,
    first: Option<String>,
    last: Option<String>,
    subagents: u64,
}

impl Session {
    fn call(&mut self, stamp: &Value, model: Option<&str>, context: Option<u64>) {
        self.calls += 1;
        if let Some(t) = stamp.as_str().filter(|s| !s.is_empty()) {
            if self.first.as_deref().is_none_or(|f| t < f) {
                self.first = Some(t.into());
            }
            if self.last.as_deref().is_none_or(|l| t > l) {
                self.last = Some(t.into());
            }
        }
        if let Some(model) = model.filter(|m| !m.is_empty()) {
            if let Some((_, n)) = self.models.iter_mut().find(|(m, _)| m == model) {
                *n += 1;
            } else {
                self.models.push((model.into(), 1));
            }
        }
        if let Some(c) = context {
            self.max_context = self.max_context.max(c);
            self.start_context.get_or_insert(c);
        }
    }

    fn row(self, agent: &str, file: &Path, key: &Option<String>) -> Value {
        let first = self.first_message.as_deref().unwrap_or("").trim_start();
        let role = if first.starts_with(WORKER) {
            "worker"
        } else if key.is_none()
            && self.coordinating
            && !UTILITY.is_match(&first.chars().take(300).collect::<String>())
        {
            "coordinator"
        } else {
            "other"
        };
        let model = self
            .models
            .iter()
            .rev()
            .max_by_key(|(_, n)| n)
            .map(|(m, _)| m);
        let mut row = json!({
            "agent": agent,
            "session": file.file_stem().and_then(|s| s.to_str()),
            "file": file,
            "key": key,
            "role": role,
            "model": model
        });
        if model.is_none() {
            row["models"] = json!({});
        }
        row["calls"] = self.calls.into();
        row["fresh"] = self.fresh.into();
        row["cache_write"] = self.write.into();
        row["cache_read"] = self.read.into();
        row["output"] = self.output.into();
        row["max_context"] = self.max_context.into();
        row["start_context"] = self.start_context.unwrap_or(0).into();
        row["first"] = self.first.into();
        row["last"] = self.last.into();
        row["subagents"] = self.subagents.into();
        row["input"] = (self.fresh + self.read + self.write).into();
        row
    }
}

fn datetime(s: &str) -> Option<DateTime<FixedOffset>> {
    let s = s.replace(' ', "T");
    DateTime::parse_from_rfc3339(&s).ok().or_else(|| {
        s.parse::<NaiveDateTime>()
            .ok()
            .or_else(|| s.parse::<NaiveDate>().ok()?.and_hms_opt(0, 0, 0))
            .map(|t| t.and_utc().fixed_offset())
    })
}
fn epoch(s: &str) -> Option<i64> {
    Some(datetime(s)?.timestamp_micros())
}

fn cutoff(text: &str) -> Result<i64, String> {
    let s = text.trim();
    if let Some(t) = epoch(s) {
        return Ok(t);
    }
    let mut left = s;
    let mut seconds = 0i64;
    while !left.is_empty() {
        let n = left.bytes().take_while(u8::is_ascii_digit).count();
        let Ok(count) = left[..n].parse::<i64>() else {
            break;
        };
        let factor = match left.as_bytes().get(n) {
            Some(b's') => 1,
            Some(b'm') => 60,
            Some(b'h') => 3600,
            Some(b'd') => 86400,
            Some(b'w') => 604800,
            _ => break,
        };
        seconds = seconds.saturating_add(count.saturating_mul(factor));
        left = &left[n + 1..];
        if left.is_empty() {
            return Ok(DateTime::<Utc>::from(SystemTime::now())
                .timestamp_micros()
                .saturating_sub(seconds.saturating_mul(1_000_000)));
        }
    }
    Err(format!(
        "invalid --since '{s}': give a duration such as 2h or 3d, or a time such as 2026-01-01T09:00:00Z"
    ))
}

fn sum<'a>(rows: impl Iterator<Item = &'a Value>) -> Value {
    let mut totals = json!({"sessions":0,"calls":0,"fresh":0,"cache_write":0,"cache_read":0,"input":0,"output":0});
    for row in rows {
        for (k, v) in totals.as_object_mut().unwrap() {
            *v = json!(
                v.as_u64().unwrap()
                    + if k == "sessions" {
                        1
                    } else {
                        row[k].as_u64().unwrap()
                    }
            );
        }
    }
    totals
}

pub fn command(args: impl Iterator<Item = String>) -> ExitCode {
    match run(args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("{e}");
            ExitCode::from(2)
        }
    }
}

fn run(mut args: impl Iterator<Item = String>) -> Result<(), String> {
    let (mut dir, mut since, mut all, mut json) = (None, None, false, false);
    let mut positional = false;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--" if !positional => positional = true,
            "-h" | "--help" if !positional => {
                println!("{HELP}");
                return Ok(());
            }
            "--all" if !positional => all = true,
            "--json" if !positional => json = true,
            "--since" if !positional => {
                since = Some(args.next().ok_or("--since requires a value")?)
            }
            s if !positional && s.starts_with("--since=") => since = Some(s[8..].to_owned()),
            s if (positional || !s.starts_with('-')) && dir.is_none() => dir = Some(arg),
            _ => return Err(format!("unexpected argument: {arg}")),
        }
    }
    let dir = dir.ok_or("usage requires a plan directory")?;
    let path = Path::new(&dir);
    if !path.join("plan.json").is_file() {
        return Err(format!("no plan.json in {dir}"));
    }
    let start = since
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(cutoff)
        .transpose()?;
    let rows = discovery::sessions(path, start).map_err(|e| e.to_string())?;
    let mut roles = json!({});
    for role in ["coordinator", "worker", "other"] {
        roles[role] = sum(rows.iter().filter(|r| r["role"] == role));
    }
    let total = sum(rows.iter());
    if json {
        crate::state::write_pretty_json(
            std::io::stdout().lock(),
            &json!({"plan_dir":dir,"since":since,"sessions":rows,"roles":roles,"total":total}),
        )
        .map_err(|e| e.to_string())?;
    } else {
        table::print(&rows, &roles, &total, all);
    }
    Ok(())
}
