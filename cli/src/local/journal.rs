use super::*;
use chrono::{DateTime, Utc};
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
    time::parse(s).ok().map(|t| t.micros)
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
    let m = s.div_euclid(60_000_000);
    if m.div_euclid(1440) != 0 {
        format!("{}d{:02}h", m.div_euclid(1440), m.rem_euclid(1440) / 60)
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
                if dispatch.is_none() && job == "dispatch" && truth(&changes["started_at"][1]) {
                    dispatch = Some(t)
                }
                if code.is_none() && truth(&changes["code_done_head"][1]) {
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
                waited += now().timestamp_micros() - start
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
fn log_usage(reason: &str) -> Error {
    let usage = include_str!("help/log.txt").lines().next().unwrap();
    invalid(format!("{usage}\nwg.py log: error: {reason}"))
}
pub(super) fn log(dir: &Path, p: &Value, args: &[String], cfg: &Value) -> Result<u8> {
    let mut args = args.iter().map(String::as_str);
    let (mut key, mut raw_since, mut count, mut show_times) = (None, None, 30i64, false);
    while let Some(arg) = args.next() {
        let (flag, attached) = arg
            .split_once('=')
            .map_or((arg, None), |(f, v)| (f, Some(v)));
        let long = flag.starts_with("--") && flag.len() > 2;
        if long && "--times".starts_with(flag) && attached.is_none() {
            show_times = true
        } else if long && "--since".starts_with(flag) {
            raw_since = Some(
                attached
                    .or_else(|| args.next())
                    .ok_or_else(|| log_usage("argument --since: expected one argument"))?,
            );
        } else if let Some(suffix) = arg.strip_prefix("-n") {
            let v = if suffix.is_empty() {
                args.next()
                    .ok_or_else(|| log_usage("argument -n: expected one argument"))?
            } else {
                suffix.strip_prefix('=').unwrap_or(suffix)
            };
            count = v.parse().map_err(|_| {
                log_usage(&format!("argument -n: invalid int value: {}", repr_str(v)))
            })?;
        } else if !arg.starts_with('-') && key.is_none() {
            key = Some(arg);
        } else {
            let extra = std::iter::once(arg)
                .chain(args)
                .collect::<Vec<_>>()
                .join(" ");
            return Err(invalid(format!(
                "{}wg.py: error: unrecognized arguments: {extra}",
                include_str!("help/usage.txt")
            )));
        }
    }
    if let Some(k) = key
        && k != "@effort"
    {
        node(p, k)?;
    }
    if count < 1 {
        return Err(invalid("-n needs a positive number"));
    }
    let entries = entries(dir)?;
    let start = raw_since
        .filter(|s| !s.is_empty())
        .map(|s| time::since(s, now().timestamp_micros()).map_err(invalid))
        .transpose()?;
    let entries = entries
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
    let mut keys = BTreeSet::new();
    keys.extend(
        fields(&before["nodes"])
            .chain(fields(&after["nodes"]))
            .map(String::as_str),
    );
    for k in std::iter::once("@effort").chain(keys) {
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
        append(
            dir,
            cmd,
            after,
            &t,
            json!({"time":t,"command":cmd,"kind":"run","key":k,"changes":changes}),
        )?;
    }
    Ok(())
}

pub(crate) fn record_status(
    dir: &Path,
    cmd: &str,
    run: &Value,
    key: &str,
    old: &str,
    new: &str,
) -> io::Result<()> {
    if old == new {
        return Ok(());
    }
    let t = now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
    append(
        dir,
        cmd,
        run,
        &t,
        json!({"time":t,"command":cmd,"kind":"status","key":key,"changes":{"status":[old,new]}}),
    )
}

fn append(dir: &Path, cmd: &str, after: &Value, t: &str, entry: Value) -> io::Result<()> {
    let mut line = sorted_line(entry);
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
    file.write_all(line.as_bytes())
}
