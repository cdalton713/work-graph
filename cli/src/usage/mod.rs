//! Read agent transcripts for the effort and its recorded worktrees.
mod discovery;
mod table;
mod transcript;
use crate::local::time;
use chrono::Utc;
use regex::Regex;
use serde_json::{Value, json};
use std::{path::Path, process::ExitCode, sync::LazyLock};

const WORKER: &str = "You are working inside Orca, a multi-agent IDE. You are a dispatched worker.";
static UTILITY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(chat|session|conversation|thread|tab)(?:'s)? (name|title)\b|\bbranch name\b|\bcommit message\b|^\s*reply with ok\b").unwrap()
});
const HELP: &str = "usage: wg.py usage [-h] [--json] [--since SINCE] [--all] dir

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
    let usage_error = |reason: &str| {
        format!(
            "{}\nwg.py usage: error: {reason}",
            HELP.lines().next().unwrap()
        )
    };
    let mut positional = false;
    let mut extra = Vec::new();
    while let Some(arg) = args.next() {
        if !positional && arg == "--" {
            positional = true;
            continue;
        }
        let (flag, value) = arg
            .split_once('=')
            .map_or((arg.as_str(), None), |(f, v)| (f, Some(v)));
        let option = if positional {
            None
        } else if flag == "-h" {
            Some("--help")
        } else {
            ["--help", "--since", "--json", "--all"]
                .into_iter()
                .find(|name| flag.starts_with("--") && flag.len() > 2 && name.starts_with(flag))
        };
        if let (Some(name), Some(value)) = (option, value)
            && name != "--since"
        {
            let label = if name == "--help" { "-h/--help" } else { name };
            return Err(usage_error(&format!(
                "argument {label}: ignored explicit argument '{value}'"
            )));
        }
        match option {
            Some("--help") => {
                println!("{HELP}");
                return Ok(());
            }
            Some("--json") => json = true,
            Some("--all") => all = true,
            Some("--since") => {
                since = Some(
                    value
                        .map(str::to_owned)
                        .or_else(|| {
                            args.next().filter(|v| {
                                v == "-" || !v.starts_with('-') || v.parse::<f64>().is_ok()
                            })
                        })
                        .ok_or_else(|| usage_error("argument --since: expected one argument"))?,
                );
            }
            _ if dir.is_none() && (positional || arg == "-" || !arg.starts_with('-')) => {
                dir = Some(arg)
            }
            _ => extra.push(arg),
        }
    }
    let dir = dir.ok_or_else(|| usage_error("the following arguments are required: dir"))?;
    if !extra.is_empty() {
        return Err(format!(
            "{}wg.py: error: unrecognized arguments: {}",
            include_str!("../local/help/usage.txt"),
            extra.join(" ")
        ));
    }
    let path = Path::new(&dir);
    if !path.join("plan.json").is_file() {
        return Err(format!("no plan.json in {dir}"));
    }
    let start = since
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(|s| time::since(s, Utc::now().timestamp_micros()))
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
