use super::*;
use clap::{Parser, Subcommand};
use std::{collections::BTreeSet, path::PathBuf, process::ExitCode};

#[derive(Parser)]
struct Args {
    #[command(subcommand)]
    verb: Verb,
}

#[derive(Subcommand)]
enum Verb {
    Autonomy {
        dir: PathBuf,
        #[arg(value_parser=["full","standard","supervised"])]
        level: Option<String>,
    },
    ReviewEffort {
        dir: PathBuf,
        #[arg(value_parser=["thorough","standard","light"])]
        level: Option<String>,
    },
    Move {
        dir: PathBuf,
        key: String,
        status: String,
        #[arg(long)]
        note: Option<String>,
        #[arg(long)]
        force: Option<String>,
        #[arg(long)]
        keep_worktree: bool,
    },
    Approve {
        dir: PathBuf,
        #[arg(required = true)]
        keys: Vec<String>,
        #[arg(long)]
        quote: String,
    },
    Load {
        dir: PathBuf,
        #[arg(long)]
        apply: bool,
        #[arg(long)]
        prune: bool,
        #[arg(long)]
        adopt: bool,
    },
    Ready {
        dir: PathBuf,
        #[arg(long)]
        apply: bool,
    },
    Archive {
        dir: PathBuf,
        #[arg(long)]
        apply: bool,
    },
    Status {
        dir: PathBuf,
        #[arg(long)]
        phase: Option<String>,
    },
}

pub fn command() -> ExitCode {
    match execute(Args::parse().verb) {
        Ok(code) => ExitCode::from(code),
        Err(message) => {
            eprintln!("{message}");
            ExitCode::from(
                if message.contains(": not moved to ")
                    || message == "plan.json fails check; fix it first"
                    || message.starts_with("wg approve takes node keys")
                {
                    1
                } else {
                    2
                },
            )
        }
    }
}

fn execute(verb: Verb) -> Result<u8, String> {
    let installation = Installation::load()?;
    let dir = match &verb {
        Verb::Autonomy { dir, .. }
        | Verb::ReviewEffort { dir, .. }
        | Verb::Move { dir, .. }
        | Verb::Approve { dir, .. }
        | Verb::Load { dir, .. }
        | Verb::Ready { dir, .. }
        | Verb::Archive { dir, .. }
        | Verb::Status { dir, .. } => dir,
    };
    crate::page::refresh_workflow(
        &installation,
        dir,
        matches!(verb, Verb::Load { apply: true, .. }),
    )?;
    let plan = installation
        .config
        .load_plan(dir)
        .map_err(|e| e.to_string())?;
    match verb {
        Verb::Autonomy { ref dir, level } => {
            super::levels::Level::Autonomy.run(dir, &installation, &plan, level.as_deref())
        }
        Verb::ReviewEffort { ref dir, level } => {
            super::levels::Level::Review.run(dir, &installation, &plan, level.as_deref())
        }
        Verb::Move {
            ref dir,
            key,
            status,
            note,
            force,
            keep_worktree,
        } => super::transition::move_node(
            super::transition::Workflow {
                dir,
                installation: &installation,
                plan: &plan,
                command: "move",
            },
            &key,
            &status,
            note.as_deref(),
            force.as_deref(),
            keep_worktree,
        ),
        Verb::Approve {
            ref dir,
            keys,
            quote,
        } => super::transition::approve(dir, &installation, &plan, &keys, &quote),
        Verb::Load {
            ref dir,
            apply,
            prune,
            adopt,
        } => return super::load::load(dir, &installation, &plan, apply, prune, adopt),
        Verb::Ready { ref dir, apply } => {
            let _lock = if apply {
                Some(crate::state::PlanLock::acquire(dir, None).map_err(|e| e.to_string())?)
            } else {
                None
            };
            let km = crate::state::load_keymap(dir).map_err(|e| e.to_string())?;
            ready(
                dir,
                &installation,
                &plan,
                &km,
                apply,
                false,
                "ready --apply",
            )
        }
        Verb::Archive { apply, .. } => archive(&mut client(&installation, &plan)?, apply, true),
        Verb::Status { ref dir, phase } => {
            let km = crate::state::load_keymap(dir).map_err(|e| e.to_string())?;
            let snap = if km["nodes"].as_object().is_some_and(|m| m.is_empty()) {
                Snapshot {
                    live: BTreeMap::new(),
                    statuses: BTreeMap::new(),
                }
            } else {
                snapshot(&installation, &plan, &km)?
            };
            print_status(&plan, &km, &snap, phase.as_deref())
        }
    }?;
    Ok(0)
}

pub(super) fn archive(linear: &mut Linear, apply: bool, explicit: bool) -> Result<(), String> {
    let org = linear.request("query{organization{subscription{type}}}", json!({}))?;
    if org["organization"].get("subscription") != Some(&Value::Null) {
        if explicit {
            println!("no archive: the workspace has a paid Linear plan");
        }
        return Ok(());
    }
    let mut labels = Vec::new();
    let mut refused = false;
    let result: Result<(), String> = (|| {
        let issues = linear.pages("query($after:String){issues(first:100,after:$after,filter:{state:{type:{in:[\"completed\",\"canceled\"]}}}){nodes{id identifier} pageInfo{hasNextPage endCursor}}}",json!({}),"/issues")?;
        for issue in issues {
            let id = issue["id"].as_str().ok_or("missing issue id")?;
            let label = issue["identifier"]
                .as_str()
                .ok_or("missing issue identifier")?;
            if apply {
                let r = linear.request(
                    "mutation($id:String!){issueArchive(id:$id){success}}",
                    json!({"id":id}),
                )?;
                if r["issueArchive"]["success"] != true {
                    eprintln!("warn: Linear refused to archive {label}");
                    refused = true;
                    continue;
                }
            }
            labels.push(label.to_owned());
        }
        Ok(())
    })();
    if let Err(e) = &result {
        eprintln!("warn: archive of settled issues failed: {e}");
    }
    if labels.is_empty() {
        if explicit && !refused && result.is_ok() {
            println!("no completed or canceled issue to archive");
        }
    } else {
        let verb = if apply { "archived" } else { "would archive" };
        let tail = if labels.len() > 20 { " …" } else { "" };
        println!(
            "{verb} {} completed or canceled issues (Linear Free plan, 250 issues): {}{tail}",
            labels.len(),
            labels[..labels.len().min(20)].join(" ")
        );
    }
    Ok(())
}

fn array<'a>(v: &'a Value, k: &str) -> Result<&'a [Value], String> {
    v[k].as_array()
        .map(Vec::as_slice)
        .ok_or_else(|| format!("missing {k} array"))
}
pub(super) fn display(v: &Value) -> String {
    match v {
        Value::Null => "-".into(),
        Value::String(s) if s.is_empty() => "-".into(),
        Value::String(s) => s.clone(),
        v => v.to_string(),
    }
}

pub(super) fn ordered(plan: &Value) -> Result<Vec<&Value>, String> {
    let nodes = array(plan, "nodes")?;
    let phases = array(plan, "phases")?;
    let edges = array(plan, "edges")?;
    let mut ordered = Vec::new();
    let mut done = BTreeSet::new();
    while ordered.len() < nodes.len() {
        let mut remaining = nodes
            .iter()
            .filter(|n| !done.contains(n["key"].as_str().unwrap_or("")));
        let free = remaining.clone().filter(|n| {
            edges.iter().filter(|e| e["from"] == n["key"]).all(|e| {
                !nodes.iter().any(|b| b["key"] == e["to"])
                    || done.contains(e["to"].as_str().unwrap_or(""))
            })
        });
        let Some(next) = free.min_by_key(|n| {
            (
                phases
                    .iter()
                    .position(|p| display(&p["key"]) == display(&n["phase"]))
                    .unwrap_or(99),
                nodes.iter().position(|b| b["lane"] == n["lane"]),
            )
        }) else {
            ordered.extend(&mut remaining);
            break;
        };
        done.insert(next["key"].as_str().ok_or("missing node key")?);
        ordered.push(next);
    }
    Ok(ordered)
}

fn print_status(
    plan: &Value,
    km: &Value,
    snap: &Snapshot,
    phase: Option<&str>,
) -> Result<(), String> {
    for n in ordered(plan)? {
        let ph = display(&n["phase"]);
        if phase.is_some_and(|p| p != ph) {
            continue;
        }
        let k = n["key"].as_str().ok_or("missing node key")?;
        let entry = &km["nodes"][k];
        let issue = entry["id"].as_str().and_then(|id| snap.live.get(id));
        let name = snap
            .statuses
            .get(k)
            .map(String::as_str)
            .unwrap_or(if entry.is_null() { "not loaded" } else { "?" });
        let mut claims = issue
            .and_then(|v| v["labels"]["nodes"].as_array())
            .into_iter()
            .flatten()
            .filter_map(|v| v["name"].as_str())
            .filter(|s| s.starts_with("agent:"))
            .collect::<Vec<_>>()
            .join(",");
        if claims.is_empty() {
            claims.push('-');
        }
        let row = &km["run"]["nodes"][k];
        let extra = ["state", "pr", "code_done_head", "review", "dispatch"].map(|f| {
            let v = display(&row[f]);
            if f == "code_done_head" {
                v.chars().take(10).collect()
            } else {
                v
            }
        });
        println!(
            "{k}\t{}\t{name}\t{claims}\t{}\tphase {ph}\t{}\t{}",
            display(&entry["identifier"]),
            display(&n["kind"]),
            display(&n["lane"]),
            extra.join("\t")
        );
    }
    Ok(())
}

pub(super) fn ready(
    dir: &std::path::Path,
    installation: &Installation,
    plan: &Value,
    km: &Value,
    apply: bool,
    quiet: bool,
    command: &str,
) -> Result<(), String> {
    let snap = snapshot(installation, plan, km)?;
    let mut linear = client(installation, plan)?;
    let states = if apply {
        let team=linear.request("query($k:String!){teams(filter:{key:{eq:$k}}){nodes{id states(first:50){nodes{id name}}}}}",json!({"k":plan["effort"]["team"]}))?;
        array(&team["teams"]["nodes"][0]["states"], "nodes")?.to_vec()
    } else {
        vec![]
    };
    let ordered = ordered(plan)?;
    let nodes: BTreeMap<_, _> = ordered
        .iter()
        .filter_map(|n| Some((n["key"].as_str()?, *n)))
        .collect();
    for n in ordered {
        let k = n["key"].as_str().ok_or("missing node key")?;
        let Some(status) = snap.statuses.get(k) else {
            continue;
        };
        if !matches!(status.as_str(), "Todo" | "Ready") {
            let wait = format!(
                "Needs {}",
                display(&installation.config.settings()["human"])
            );
            if !quiet
                && n["kind"] == "task"
                && status != &wait
                && !matches!(
                    status.as_str(),
                    "Triage"
                        | "Backlog"
                        | "In Progress"
                        | "In Review"
                        | "Ready to Merge"
                        | "Merged"
                        | "Verifying"
                        | "Done"
                        | "Canceled"
                )
            {
                eprintln!("skipped {k}: status {status}");
            }
            continue;
        }
        let mut clear = true;
        for edge in array(plan, "edges")?.iter().filter(|e| e["from"] == k) {
            let b = edge["to"].as_str().ok_or("invalid edge")?;
            let blocker = nodes.get(b).ok_or("unknown blocker")?;
            if !crate::local::satisfied(
                blocker,
                n,
                snap.statuses.get(b).map(String::as_str).unwrap_or("?"),
                km["run"]["nodes"][b]["code_done_head"]
                    .as_str()
                    .is_some_and(|s| !s.is_empty()),
            ) {
                clear = false;
                break;
            }
        }
        let id = &km["nodes"][k];
        let ident = display(&id["identifier"]);
        if clear && !quiet {
            println!(
                "{k}\t{ident}\t{}\t{}",
                display(&n["kind"]),
                display(&n["lane"])
            );
        }
        let want = if clear { "Ready" } else { "Todo" };
        if apply && status != want && n["eng"].is_null() {
            let state_id = states
                .iter()
                .find(|s| s["name"] == want)
                .and_then(|s| s["id"].as_str())
                .ok_or_else(|| format!("workflow has no status {want}"))?;
            let result = linear.request(
                "mutation($id:String!,$s:String!){issueUpdate(id:$id,input:{stateId:$s}){success}}",
                json!({"id":id["id"],"s":state_id}),
            )?;
            if result["issueUpdate"]["success"] != true {
                eprintln!("warn: {ident}: state update failed");
                continue;
            }
            if let Err(e) = crate::local::record_status(dir, command, &km["run"], k, status, want) {
                eprintln!("warn: journal: {e}");
            }
            eprintln!("  moved {ident} {status} -> {want}");
        }
    }
    Ok(())
}
