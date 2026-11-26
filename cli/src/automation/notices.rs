use super::{machine::*, production::Effort, publish};
use crate::{ConfigProvider, page::page_credential, providers::PageSettings, state};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    env, fs,
    io::{Seek, Write},
    os::unix::fs::PermissionsExt,
    path::Path,
    process::Command,
    time::{Duration, Instant},
};

pub(super) fn page_request(
    e: &Effort,
    path: &[&str],
    body: Option<&Value>,
    time: Duration,
) -> Result<Value> {
    let scope = e.scope()?;
    let settings = PageSettings(e.install).resolve(scope)?;
    let c = &e.km["collab"];
    let base = c["page"]
        .as_str()
        .map(str::to_owned)
        .or_else(|| env::var("WG_UI_URL").ok())
        .or(settings.page.clone())
        .unwrap_or_else(|| "http://127.0.0.1:4747".into());
    let token = page_credential(
        &settings,
        &base,
        scope,
        text(&c["workspace"]).starts_with("shared:"),
        e.install,
    )?;
    let mut url = url::Url::parse(&base)?;
    url.path_segments_mut()
        .map_err(|_| "invalid page path")?
        .pop_if_empty()
        .extend(path);
    let client = reqwest::blocking::Client::builder()
        .timeout(time)
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    let mut req = if let Some(value) = body {
        client
            .post(url)
            .header("Content-Type", "application/json")
            .body(serde_json::to_vec(value)?)
    } else {
        client.get(url)
    };
    req = req.header("x-workspace", c["workspace"].as_str().unwrap_or(scope));
    if let Some(token) = token {
        req = req.header("Authorization", token.into_header())
    } else if body.is_some() {
        return Err("missing page token".into());
    }
    let response = req
        .send()
        .map_err(|_| "page request failed")?
        .error_for_status()
        .map_err(|err| {
            format!(
                "page answered HTTP {}",
                err.status().map(|s| s.as_u16()).unwrap_or(0)
            )
        })?;
    Ok(serde_json::from_slice(&response.bytes()?)?)
}

pub(super) fn send(
    channel: &Value,
    title: &str,
    body: &str,
    link: &str,
    time: Duration,
) -> Result<()> {
    if channel["type"] == "command" {
        let args = channel["argv"].as_array().ok_or("invalid notice argv")?;
        let mut cmd = Command::new(
            args.first()
                .and_then(Value::as_str)
                .ok_or("missing notice command")?,
        );
        cmd.args(args[1..].iter().map(text));
        let mut input = tempfile::tempfile()?;
        writeln!(input, "{title}\n{body}\n{link}")?;
        input.rewind()?;
        let output = capture_with_input(&mut cmd, time, input.into())
            .map_err(|_| "notice command failed")?;
        if !output.status.success() {
            return Err(format!("notice command exited {}", output.status).into());
        }
    } else if channel["type"] == "webhook" {
        let mut url = channel["url_env"]
            .as_str()
            .and_then(|n| env::var(n).ok())
            .unwrap_or_default();
        if url.trim().is_empty()
            && let Some(path) = channel["url_file"].as_str()
        {
            let p = expand(Path::new(path))?;
            if p.metadata()?.permissions().mode() & 0o077 != 0 {
                return Err("webhook URL file must have mode 600".into());
            }
            url = fs::read_to_string(p)?;
        }
        let data = json!({"title":title,"body":format!("{body}\n{link}"),"url":link,"text":format!("{title}\n{body}\n{link}")});
        reqwest::blocking::Client::builder()
            .timeout(time)
            .redirect(reqwest::redirect::Policy::none())
            .build()?
            .post(url.trim())
            .header("Content-Type", "application/json")
            .header("X-Template", "yes")
            .header("X-Title", "{{.title}}")
            .header("X-Message", "{{.body}}")
            .header("X-Click", link)
            .body(data.to_string())
            .send()
            .map_err(|_| "webhook request failed")?
            .error_for_status()
            .map_err(|_| "webhook refused the notice")?;
    } else {
        return Err("unknown notification channel".into());
    }
    Ok(())
}

pub(super) fn asks(e: &Effort) -> Vec<Value> {
    let rows = e.km["run"]["nodes"]
        .as_object()
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    let mut asks = vec![];
    for run in rows
        .iter()
        .filter_map(|(_, r)| r["run_id"].as_str())
        .collect::<BTreeSet<_>>()
    {
        let Ok(reply) = orca(&[
            "orchestration",
            "inbox",
            "--run",
            run,
            "--full",
            "--limit",
            "100",
        ]) else {
            continue;
        };
        for m in reply["messages"].as_array().into_iter().flatten() {
            if m["handled"] == true
                || !matches!(m["type"].as_str(), Some("question" | "escalation"))
            {
                continue;
            }
            let payload = m["payload"]
                .as_str()
                .and_then(|t| serde_json::from_str(t).ok())
                .unwrap_or_else(|| m["payload"].clone());
            let dispatch = payload["dispatchId"].as_str().or(m["from"].as_str());
            if let Some((key, _)) = rows
                .iter()
                .find(|(_, r)| dispatch.is_some() && r["dispatch"].as_str() == dispatch)
            {
                let body = m["body"]
                    .as_str()
                    .map(str::to_string)
                    .or_else(|| {
                        payload["stopReason"]
                            .as_str()
                            .map(|s| format!("The worker stopped: {s}"))
                    })
                    .unwrap_or_default();
                asks.push(json!({"id":m["id"],"key":key,"issue":e.km["nodes"][key]["identifier"],"from":text(&m["from"]),"at":m["createdAt"].as_str().unwrap_or(text(&m["at"])),"run":run,"kind":m["type"],"body":body}));
            }
        }
    }
    asks
}

fn signature(s: &str) -> String {
    format!("{:x}", Sha256::digest(s))[..12].to_owned()
}
fn saved(row: &Value, k: &str) -> BTreeSet<String> {
    text(&row[k])
        .split(',')
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}
fn store(row: &mut Value, k: &str, ids: BTreeSet<String>) {
    if ids.is_empty() {
        if let Some(m) = row.as_object_mut() {
            m.remove(k);
        }
    } else {
        row[k] = json!(ids.into_iter().collect::<Vec<_>>().join(","));
    }
}
pub(super) fn notify(e: &Effort, lines: &[(String, String)], asks: &[Value]) -> Result<()> {
    let Some(channels) = e.install.config.settings()["notify"]
        .as_array()
        .filter(|v| !v.is_empty())
    else {
        return Ok(());
    };
    if lines.iter().any(|(_, t)| t.starts_with("paused @effort")) {
        return Ok(());
    }
    let mut entries = BTreeMap::new();
    for (level, t) in lines {
        let parts = t.split_whitespace().collect::<Vec<_>>();
        if matches!(
            (level.as_str(), parts.first().copied()),
            ("wait", Some("human")) | ("do", Some("ask" | "ask-merge" | "ask-ready"))
        ) && parts.len() >= 3
        {
            let msg = format!("{level} {t}");
            let kind = if matches!(parts[0], "ask-merge" | "ask-ready")
                || t.contains(": merge PR #")
                || t.contains(": mark PR #")
            {
                "merge"
            } else if parts[0] == "ask" {
                "decision"
            } else {
                "wait"
            };
            entries.insert(
                signature(&msg),
                (msg, parts[2].trim_end_matches(':').to_string(), kind),
            );
        }
    }
    for ask in asks {
        let issue = ask["issue"].as_str().unwrap_or(text(&ask["key"]));
        entries.insert(
            signature(&format!("ask:{}", text(&ask["id"]))),
            (
                format!(
                    "{} {issue}: {}",
                    text(&ask["kind"]),
                    text(&ask["body"])
                        .split_whitespace()
                        .collect::<Vec<_>>()
                        .join(" ")
                        .chars()
                        .take(200)
                        .collect::<String>()
                ),
                issue.into(),
                "question",
            ),
        );
    }
    let now = Utc::now();
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut pending = BTreeMap::new();
    {
        let guard = state::PlanLock::acquire(e.dir, None)?;
        let mut km = state::load_keymap(e.dir)?;
        let before = km.clone();
        let row = &mut km["run"]["effort"];
        for n in 0..channels.len() {
            let key = format!("notified_{n}");
            let mut sent = saved(row, &key);
            sent.retain(|k| entries.contains_key(k));
            let failed = row[format!("notify_failed_{n}")]
                .as_str()
                .and_then(|t| DateTime::parse_from_rfc3339(t).ok())
                .is_some_and(|t| now.timestamp() - t.timestamp() < 300);
            if !failed {
                let new = entries
                    .keys()
                    .filter(|k| !sent.contains(*k))
                    .cloned()
                    .collect::<Vec<_>>();
                if !new.is_empty() {
                    sent.extend(new.clone());
                    pending.insert(n, new);
                }
            }
            store(row, &key, sent);
        }
        if km != before {
            guard.save_keymap(&km)?;
        }
    }
    let identifier = regex::Regex::new(r"^[A-Za-z][A-Za-z0-9_]*-[0-9]+$")?;
    for (n, ids) in pending {
        let channel = &channels[n];
        let mut accepted = 0;
        let result = (|| -> Result<()> {
            let remaining = || {
                deadline
                    .checked_duration_since(Instant::now())
                    .ok_or("no time left")
            };
            if channel["type"] == "page" {
                let c = &e.km["collab"];
                let mut target = json!({"workspace":c["workspace"].as_str().unwrap_or(e.scope()?),"project":c["project"].as_str().unwrap_or(e.project()?)});
                if let Some(to) = channel.get("to") {
                    target["recipient"] = to.clone();
                }
                for id in &ids {
                    let (_, issue, kind) = &entries[id];
                    target["issue"] = json!(issue);
                    target["kind"] = json!(kind);
                    if identifier.is_match(issue) {
                        page_request(e, &["api", "push", "notices"], Some(&target), remaining()?)?;
                    }
                    accepted += 1;
                }
            } else {
                let title = format!(
                    "work-graph: {} new move(s) for {} in {}",
                    ids.len(),
                    text(&e.install.config.settings()["human"]),
                    text(&e.plan["effort"]["name"])
                );
                let body = ids
                    .iter()
                    .map(|id| entries[id].0.as_str())
                    .collect::<Vec<_>>()
                    .join("\n");
                send(channel, &title, &body, &publish::url(e)?, remaining()?)?;
            }
            Ok(())
        })();
        let guard = state::PlanLock::acquire(e.dir, None)?;
        let mut km = state::load_keymap(e.dir)?;
        let row = &mut km["run"]["effort"];
        let failed = format!("notify_failed_{n}");
        if let Err(err) = result {
            let key = format!("notified_{n}");
            let mut sent = saved(row, &key);
            for id in &ids[accepted..] {
                sent.remove(id);
            }
            store(row, &key, sent);
            row[failed] = json!(now.format("%Y-%m-%dT%H:%M:%SZ").to_string());
            eprintln!("warn notify: {}: {err}", text(&channel["type"]));
        } else if let Some(m) = row.as_object_mut() {
            m.remove(&failed);
        }
        guard.save_keymap(&km)?;
    }
    Ok(())
}

pub(super) fn health(e: &Effort, value: &str, faults: &BTreeMap<String, Value>, url: &str) {
    let title = format!("work-graph: {} is {value}", text(&e.plan["effort"]["name"]));
    let mut body = faults
        .iter()
        .filter(|(_, f)| f["level"].is_string())
        .take(10)
        .map(|(id, f)| {
            format!(
                "{} {id}: {}",
                text(&f["level"]),
                text(&f["text"]).chars().take(200).collect::<String>()
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    if !url.is_empty() {
        body += &format!("\n{url}");
    }
    let end = Instant::now() + Duration::from_secs(5);
    for c in e.install.config.settings()["notify"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|c| c["type"] != "page")
    {
        let result = (|| {
            send(
                c,
                &title,
                &body,
                &publish::url(e)?,
                end.checked_duration_since(Instant::now())
                    .ok_or("no time left")?,
            )
        })();
        if let Err(err) = result {
            eprintln!("warn notify: {}: {err}", text(&c["type"]));
        }
    }
}

pub(super) fn agent_notices(
    e: &Effort,
    entries: BTreeMap<String, String>,
    state: &mut Value,
) -> Result<()> {
    let Some(channels) = e.install.config.settings()["notify"]
        .as_array()
        .filter(|v| !v.is_empty())
    else {
        return Ok(());
    };
    let key = format!("{}/{}", e.scope()?, e.project()?);
    if entries.is_empty() && state.get(&key).is_none() {
        return Ok(());
    }
    let record = &mut state[&key];
    let deadline = Instant::now() + Duration::from_secs(5);
    let now = Utc::now();
    for (i, c) in channels
        .iter()
        .enumerate()
        .filter(|(_, c)| c["type"] != "page")
    {
        let i = i.to_string();
        let mut sent = record["sent"][&i]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|id| entries.contains_key(*id))
            .map(String::from)
            .collect::<BTreeSet<_>>();
        let new = entries
            .keys()
            .filter(|id| !sent.contains(*id))
            .cloned()
            .collect::<Vec<_>>();
        let recent = record["failed"][&i]
            .as_str()
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            .is_some_and(|t| now.timestamp() - t.timestamp() < 300);
        if !new.is_empty() && !recent {
            let title = format!(
                "work-graph: {} agent(s) wait on {} in {}",
                new.len(),
                text(&e.install.config.settings()["human"]),
                text(&e.plan["effort"]["name"])
            );
            let body = new
                .iter()
                .map(|id| entries[id].as_str())
                .collect::<Vec<_>>()
                .join("\n");
            match send(
                c,
                &title,
                &body,
                &publish::url(e)?,
                deadline
                    .checked_duration_since(Instant::now())
                    .ok_or("no time left")?,
            ) {
                Ok(()) => {
                    sent.extend(new);
                    if let Some(f) = record["failed"].as_object_mut() {
                        f.remove(&i);
                    }
                }
                Err(err) => {
                    record["failed"][&i] = json!(now.format("%Y-%m-%dT%H:%M:%SZ").to_string());
                    eprintln!("warn notify: {}: {err}", text(&c["type"]));
                }
            }
        }
        record["sent"][&i] = json!(sent);
    }
    if entries.is_empty()
        && record["failed"].as_object().is_none_or(|m| m.is_empty())
        && record["sent"]
            .as_object()
            .into_iter()
            .flatten()
            .all(|(_, ids)| ids.as_array().is_none_or(Vec::is_empty))
    {
        state
            .as_object_mut()
            .ok_or("invalid agents state")?
            .remove(&key);
    }
    Ok(())
}
