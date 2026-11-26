use super::*;
use chrono::{DateTime, NaiveDate, NaiveDateTime, Utc};
use serde_json::json;
use std::{
    collections::BTreeSet,
    fs,
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    time::SystemTime,
};
pub(super) fn entries(dir: &Path) -> Result<Vec<Value>> {
    let (entries, bad) = crate::state::journal_entries(dir).map_err(ioerr)?;
    if bad > 0 {
        eprintln!("warn: {bad} damaged journal line(s) skipped")
    }
    Ok(entries)
}
fn now() -> DateTime<Utc> {
    SystemTime::now().into()
}
fn at(s: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|t| t.timestamp())
        .or_else(|| {
            s.parse::<NaiveDateTime>()
                .ok()
                .map(|t| t.and_utc().timestamp())
        })
        .or_else(|| {
            s.parse::<NaiveDate>()
                .ok()
                .map(|t| t.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp())
        })
}
fn since(s: &str) -> Result<i64> {
    if let Some(t) = at(s) {
        return Ok(t);
    }
    let mut left = s;
    let mut delta = 0i64;
    while !left.is_empty() {
        let n = left.bytes().take_while(u8::is_ascii_digit).count();
        let unit = left.as_bytes().get(n);
        let factor = match unit {
            Some(b'w') => 604800,
            Some(b'd') => 86400,
            Some(b'h') => 3600,
            Some(b'm') => 60,
            Some(b's') => 1,
            _ => break,
        };
        let Ok(v) = left[..n].parse::<i64>() else {
            break;
        };
        delta = delta.saturating_add(v.saturating_mul(factor));
        left = &left[n + 1..];
        if left.is_empty() {
            return Ok(now().timestamp().saturating_sub(delta));
        }
    }
    Err(invalid(format!(
        "invalid --since '{s}': give a duration such as 2h or 3d, or a time such as 2026-01-01T09:00:00Z"
    )))
}
fn short(s: String, width: usize) -> String {
    if s.chars().count() > width {
        s.chars().take(width - 1).chain(['…']).collect()
    } else {
        s
    }
}
fn line(e: &Value) -> String {
    let t = text(e, "time");
    let cmd = e["command"].as_str().unwrap_or("wg");
    if e["kind"] == "baseline" {
        return format!(
            "{t} {cmd} baseline: the run rows of {} node(s)",
            e["run"]["nodes"].as_object().map_or(0, |o| o.len())
        );
    }
    let value = |v: &Value| short(if v.is_null() { "-".into() } else { val(v) }, 24);
    let fields = e["changes"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(k, v)| format!("{k} {} -> {}", value(&v[0]), value(&v[1])))
        .collect::<Vec<_>>()
        .join(", ");
    short(
        format!("{t} {cmd} {} {fields}", e["key"].as_str().unwrap_or("-"))
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" "),
        200,
    )
}
fn duration(s: Option<i64>) -> String {
    let Some(s) = s else { return "-".into() };
    let m = s.div_euclid(60);
    if m >= 1440 {
        format!("{}d{:02}h", m / 1440, m % 1440 / 60)
    } else if m >= 60 {
        format!("{}h{:02}m", m / 60, m % 60)
    } else {
        format!("{m}m")
    }
}
fn times(p: &Value, entries: &[Value], cfg: &Value) {
    let mut any = false;
    for n in list(&p["nodes"]).iter().filter(|n| n["kind"] == "task") {
        let k = text(n, "key");
        let (mut job, mut seen) = ("", false);
        let (mut dispatch, mut code, mut merged, mut wait) = (None, None, None, None);
        let mut waited = 0;
        for e in entries {
            if e["kind"] == "baseline" {
                job = text(&e["run"]["nodes"][k], "job");
                continue;
            }
            if e["key"] != k {
                continue;
            }
            seen = true;
            let t = at(text(e, "time")).unwrap_or_default();
            let changes = &e["changes"];
            if e["kind"] == "run" || e["kind"].is_null() {
                if changes.get("job").is_some() {
                    job = changes["job"][1].as_str().unwrap_or("")
                }
                if dispatch.is_none() && job == "dispatch" && changes["started_at"][1].is_string() {
                    dispatch = Some(t)
                }
                if code.is_none() && changes["code_done_head"][1].is_string() {
                    code = Some(t)
                }
            }
            if e["kind"] == "status" && changes.get("status").is_some() {
                let s = &changes["status"][1];
                if s == "Ready to Merge" || s == &cfg["wait_status"] {
                    wait.get_or_insert(t);
                } else if let Some(start) = wait.take() {
                    waited += t - start
                }
                if merged.is_none() && matches!(s.as_str(), Some("Merged" | "Done")) {
                    merged = Some(t)
                }
            }
        }
        if seen {
            any = true;
            if let Some(start) = wait {
                waited += now().timestamp() - start
            }
            println!(
                "{k}\tdispatch->code done {}\tcode done->merged {}\twait on {} {}",
                duration(code.zip(dispatch).map(|(a, b)| a - b)),
                duration(merged.zip(code).map(|(a, b)| a - b)),
                text(&cfg["config"], "human"),
                duration(Some(waited))
            )
        }
    }
    if !any {
        println!("no task in the journal")
    }
}
pub(super) fn log(dir: &Path, p: &Value, args: &[String], cfg: &Value) -> Result<u8> {
    let mut args = args.iter();
    let (mut key, mut start, mut count, mut show_times) = (None, None, 30i64, false);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--times" => show_times = true,
            "--since" => {
                start = Some(since(
                    args.next()
                        .ok_or_else(|| invalid("missing --since value"))?,
                )?)
            }
            "-n" => {
                count = args
                    .next()
                    .and_then(|s| s.parse().ok())
                    .ok_or_else(|| invalid("-n needs a positive number"))?
            }
            s if !s.starts_with('-') && key.is_none() => {
                if s != "@effort" {
                    node(p, s)?;
                }
                key = Some(s)
            }
            _ => return Err(invalid("invalid log arguments")),
        }
    }
    if count < 1 {
        return Err(invalid("-n needs a positive number"));
    }
    let entries = entries(dir)?
        .into_iter()
        .filter(|e| {
            key.is_none_or(|k| e["key"] == k)
                && start.is_none_or(|t| at(text(e, "time")).is_some_and(|v| v >= t))
        })
        .collect::<Vec<_>>();
    if show_times {
        times(p, &entries, cfg)
    } else if entries.is_empty() {
        println!("no journal entry")
    } else {
        for e in &entries[entries.len().saturating_sub(count as usize)..] {
            println!("{}", line(e))
        }
    }
    Ok(0)
}
fn secret(f: &str) -> bool {
    let f = f.to_ascii_lowercase();
    ["key", "token", "secret", "password"]
        .iter()
        .any(|s| f.contains(s))
}
fn safe(f: &str, v: &Value) -> Value {
    if f == "approved" && v.as_str().is_some_and(|s| !s.is_empty()) {
        format!(
            "{}: approved; the words are in the Linear comment",
            val(v).chars().take(10).collect::<String>()
        )
        .into()
    } else {
        v.clone()
    }
}
fn fields(v: &Value) -> impl Iterator<Item = &String> {
    v.as_object().into_iter().flat_map(|o| o.keys())
}
fn sorted_line(mut v: Value) -> String {
    v.sort_all_objects();
    compact(&v) + "\n"
}
pub(super) fn record(dir: &Path, cmd: &str, before: &Value, after: &Value) -> io::Result<()> {
    let t = now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
    let mut keys = BTreeSet::from(["@effort"]);
    keys.extend(
        fields(&before["nodes"])
            .chain(fields(&after["nodes"]))
            .map(String::as_str),
    );
    for k in keys {
        let row = |v: &Value| {
            if k == "@effort" {
                v["effort"].clone()
            } else {
                v["nodes"][k].clone()
            }
        };
        let (a, b) = (row(before), row(after));
        let mut changes = json!({});
        for f in fields(&a).chain(fields(&b)) {
            if a[f] != b[f] && !secret(f) {
                changes[f] = json!([safe(f, &a[f]), safe(f, &b[f])])
            }
        }
        if changes == json!({}) {
            continue;
        }
        let mut line =
            sorted_line(json!({"time":t,"command":cmd,"kind":"run","key":k,"changes":changes}));
        let path = dir.join("journal.jsonl");
        if fs::metadata(&path).is_ok_and(|m| m.len() + line.len() as u64 > 5 * 1024 * 1024) {
            fs::rename(&path, dir.join("journal.1.jsonl"))?
        }
        if !path.exists() {
            let mut run = after.clone();
            fn redact(row: &mut Value) {
                if let Some(o) = row.as_object_mut() {
                    o.retain(|k, v| {
                        *v = safe(k, v);
                        !secret(k)
                    })
                }
            }
            redact(&mut run["effort"]);
            if let Some(o) = run["nodes"].as_object_mut() {
                for row in o.values_mut() {
                    redact(row)
                }
            }
            line = sorted_line(
                json!({"time":t,"command":cmd,"kind":"baseline","key":"@baseline","changes":{},"run":run}),
            ) + &line
        }
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .open(path)?;
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
        file.write_all(line.as_bytes())?;
    }
    Ok(())
}
