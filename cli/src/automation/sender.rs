//! The local agent sender never acquires a coordinator presence on the page.
use super::{activity, arguments::Agents, machine::*, production::Effort};
use crate::{
    ConfigProvider,
    linear::Installation,
    page::{link::Link, page_credential},
    providers::PageSettings,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    env,
    io::Write,
    path::PathBuf,
    process::Command,
    time::{Duration, Instant},
};

pub(super) fn link(effort: &Effort) -> Result<(Link, String, String)> {
    let scope = effort.scope()?;
    let settings = PageSettings(effort.install).resolve(scope)?;
    let c = &effort.km["collab"];
    let shared = text(&c["workspace"]).starts_with("shared:");
    let page = if shared {
        c["page"]
            .as_str()
            .ok_or("shared project has no page")?
            .into()
    } else {
        env::var("WG_UI_URL")
            .ok()
            .or_else(|| settings.page.clone())
            .unwrap_or_else(|| "http://127.0.0.1:4747".into())
    };
    let workspace = if shared { text(&c["workspace"]) } else { scope };
    let token = page_credential(&settings, &page, scope, shared, effort.install)?;
    let path = effort.dir.canonicalize()?;
    let host = output(
        Command::new("/usr/bin/uname").arg("-n"),
        Duration::from_secs(2),
    )?;
    let host = host.trim();
    let session =
        format!("{:x}", Sha256::digest(format!("{host}:{}", path.display())))[..12].to_owned();
    let contract = format!(
        "{:x}",
        Sha256::digest(include_bytes!("../../../skills/work-graph/contract.json"))
    );
    let hello = json!({"plan":path,"session":session,"host":host,"wg":&contract[..12]});
    Ok((
        Link::new(
            &settings,
            &page,
            workspace,
            effort.project()?,
            &session,
            hello,
            token,
        )?,
        page,
        session,
    ))
}
fn idle(effort: &Effort, ident: &str) -> Result<Option<(Value, Value)>> {
    let mut found = agents(true)?;
    found.retain(|a| a["orcaSessionId"] == ident);
    let km = crate::state::load_keymap(effort.dir)?;
    let rows = activity::rows(effort.dir, &km, &found, chrono::Utc::now())?;
    Ok(
        if rows.len() == 1 && found.len() == 1 && rows[0]["state"] == "done" {
            Some((found.remove(0), rows.into_iter().next().unwrap()))
        } else {
            None
        },
    )
}
fn terminal_ready(agent: &Value) -> Result<bool> {
    let reply = orca(&[
        "terminal",
        "list",
        "--include-visual-layouts",
        "--environment",
        "local",
    ])?;
    if reply["truncated"] == true {
        return Ok(false);
    }
    let targets = reply["terminals"]
        .as_array()
        .ok_or("missing terminals")?
        .iter()
        .filter(|t| {
            t["worktreeId"] == agent["worktreeId"]
                && t["connected"] == true
                && t["writable"] == true
                && !text(&t["tabId"]).is_empty()
                && !text(&t["leafId"]).is_empty()
                && format!("{}:{}", text(&t["tabId"]), text(&t["leafId"]))
                    == text(&agent["paneKey"])
        })
        .collect::<Vec<_>>();
    let [target] = targets.as_slice() else {
        return Ok(false);
    };
    let handle = target["handle"].as_str().ok_or("missing terminal handle")?;
    let read = orca(&[
        "terminal",
        "read",
        "--terminal",
        handle,
        "--screen",
        "--environment",
        "local",
    ])?;
    let term = &read["terminal"];
    let choice = regex::Regex::new(r"^\s*(?:[❯›>]\s*(?:\d+[.)]|[○●◯□■])|[○●◯□■])\s")?;
    Ok(term["source"] == "screen"
        && term["tail"].as_array().is_some_and(|r| {
            !r.is_empty()
                && r.iter()
                    .all(|v| v.as_str().is_some_and(|s| !choice.is_match(s)))
        }))
}

fn deliver(effort: &Effort, reply: &Value) -> Value {
    let id = &reply["id"];
    let refused = |s: &str| json!({"id":id,"status":"refused","reason":s});
    let unknown = || json!({"id":id,"status":"unconfirmed","reason":"Orca did not confirm the mail. Check Orca before you reply again"});
    let ident = text(&reply["agent"]);
    let bare = ident.strip_prefix("orca_session_id:").unwrap_or(ident);
    if !(1..=180).contains(&bare.len())
        || !bare
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    {
        return refused("Invalid Orca session id");
    }
    let Some(body) = reply["body"].as_str().filter(|s| s.chars().count() <= 4000) else {
        return refused("Invalid reply text");
    };
    let body = body
        .replace("\r\n", "\n")
        .chars()
        .filter(|c| *c == '\n' || !c.is_control())
        .collect::<String>();
    if body.trim().is_empty() {
        return refused("Invalid reply text");
    }
    let Ok(Some((agent, row))) = idle(effort, ident) else {
        return refused("The agent is no longer idle in this effort");
    };
    match agent["kind"].as_str() {
        Some("chat") => (),
        Some("terminal") => {
            if !terminal_ready(&agent).unwrap_or(false) {
                return refused("Answer this agent in Orca");
            }
            if !idle(effort, ident)
                .ok()
                .flatten()
                .is_some_and(|(current, _)| {
                    ["paneKey", "worktreeId", "kind"]
                        .iter()
                        .all(|k| current[k] == agent[k])
                })
            {
                return refused("The agent is no longer idle in this effort");
            }
        }
        _ => return refused("Answer this agent in Orca"),
    }
    let Ok(mut file) = tempfile::NamedTempFile::new() else {
        return unknown();
    };
    if file.write_all(body.as_bytes()).is_err() {
        return unknown();
    }
    let target = format!("orca_session_id:{bare}");
    let mut retry = None;
    loop {
        let mut cmd = Command::new(orca_path());
        cmd.args([
            "orchestration",
            "send",
            "--to",
            &target,
            "--subject",
            "Reply from the project page",
            "--body-file",
        ])
        .arg(file.path())
        .args(["--environment", "local", "--json"]);
        if let Some(request) = &retry {
            cmd.arg("--retry-request").arg(request);
        }
        let Ok(out) = capture(&mut cmd, Duration::from_secs(3)) else {
            return unknown();
        };
        let Ok(response) = serde_json::from_slice::<Value>(&out.stdout) else {
            return unknown();
        };
        if out.status.success()
            && response["ok"] != false
            && let Some(message) = response["result"]["message"]["id"]
                .as_str()
                .filter(|s| !s.is_empty())
        {
            if row["role"] == "worker"
                && let Some(issue) = effort.km["nodes"][text(&row["key"])]["id"].as_str()
            {
                let result = effort.linear().and_then(|mut c| {
                    Ok(c.request(
                        "mutation($i:CommentCreateInput!){commentCreate(input:$i){success}}",
                        json!({"i":{"issueId":issue,"body":format!("Reply to the agent: {body}")}}),
                    )?)
                });
                if result.is_err() {
                    eprintln!("warn agents: Linear did not record the agent reply");
                }
            }
            return json!({"id":id,"status":"delivered","messageId":message});
        }
        if retry.is_some() {
            return unknown();
        }
        if let Some(request) = response
            .pointer("/error/data/recovery/orchestrationRequestId")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            retry = Some(request.to_string());
            continue;
        }
        if !out.status.success() && response["ok"] == false && response["error"]["code"].is_string()
        {
            return refused("Orca refused the mail. Answer this agent in Orca");
        }
        return unknown();
    }
}
pub(super) fn roots(settings: &Value, override_roots: &[PathBuf]) -> Result<Vec<PathBuf>> {
    if !override_roots.is_empty() {
        return Ok(override_roots.to_vec());
    }
    Ok(settings["tick_roots"]
        .as_array()
        .ok_or("invalid tick roots")?
        .iter()
        .map(|p| PathBuf::from(text(p)))
        .collect())
}
pub(super) fn run(args: &Agents) -> Result<u8> {
    let install = Installation::load()?;
    if args.install || args.uninstall {
        let exe = env::current_exe()?;
        let mut candidates: Vec<PathBuf> = exe.ancestors().map(|p| p.join("orca-plugin")).collect();
        for base in [".agents", ".codex", ".claude"] {
            if let Ok(path) = home()?.join(base).join("skills/work-graph").canonicalize() {
                candidates.extend(path.ancestors().map(|p| p.join("orca-plugin")))
            }
        }
        let folder = candidates
            .iter()
            .find(|p| p.join("orca-plugin.json").is_file())
            .unwrap_or(&candidates[0]);
        return activity::plugin(
            folder,
            text(&install.config.settings()["tick_label"]),
            args.uninstall,
            args.approve.as_deref(),
            &mut std::io::stdout().lock(),
        );
    }
    let mut beats: HashMap<PathBuf, activity::Heartbeat> = HashMap::new();
    let mut unsupported = HashSet::new();
    let mut failures: HashMap<PathBuf, (Instant, bool)> = HashMap::new();
    activity::monitor(
        args.once,
        args.wait,
        &env::current_exe()?,
        || {
            let install = Installation::load()?;
            let settings = install.config.settings();
            let replies = settings["agent_replies"] == true;
            let local = replies
                && ["ORCA_AGENT_SESSION_ID", "ORCA_TERMINAL_HANDLE"]
                    .iter()
                    .any(|k| env::var_os(k).is_some_and(|v| !v.is_empty()));
            let dirs = roots(settings, &args.root)?;
            activity::collect(
                &dirs,
                local,
                |dir| {
                    crate::page::refresh_workflow(&install, dir, false)?;
                    Ok(install.config.load_plan(dir)?)
                },
                |dir, plan, rows| {
                    let beat = beats.entry(dir.into()).or_default();
                    let now = Instant::now();
                    if !beat.due(rows, now, local) {
                        return Ok(());
                    }
                    let effort = Effort {
                        install: &install,
                        dir,
                        plan: plan.clone(),
                        km: crate::state::load_keymap(dir)?,
                    };
                    let result = (|| -> Result<()> {
                        let (link, endpoint, session) = link(&effort)?;
                        let enabled = local && !unsupported.contains(&endpoint);
                        let mut payload = json!({"agents":rows});
                        if replies {
                            payload["replies"] = json!(enabled);
                        }
                        if enabled {
                            payload["sender"] = json!(session);
                        }
                        if !link.send_agents(payload, |reply| deliver(&effort, reply))? {
                            unsupported.insert(endpoint);
                        }
                        activity::record_send(dir)?;
                        Ok(())
                    })();
                    let name = text(&plan["effort"]["name"]);
                    match result {
                        Ok(()) => {
                            beat.sent(rows.to_vec(), now);
                            if failures.remove(dir).is_some_and(|(_, warned)| warned) {
                                eprintln!("ok link: {name}: agents send recovered")
                            }
                        }
                        Err(e) => {
                            let (start, warned) =
                                failures.entry(dir.into()).or_insert((now, false));
                            if args.once || (!*warned && start.elapsed() > Duration::from_secs(60))
                            {
                                eprintln!("warn link: {name}: {e}");
                                *warned = true;
                            }
                        }
                    }
                    Ok(())
                },
            )
        },
        &mut std::io::stdout().lock(),
        &mut std::io::stderr().lock(),
    )
}
