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
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}");
            ExitCode::from(2)
        }
    }
}

fn execute(verb: Verb) -> Result<(), String> {
    let installation = Installation::load()?;
    let dir = match &verb {
        Verb::Archive { dir, .. } | Verb::Status { dir, .. } => dir,
    };
    let plan = installation
        .config
        .load_plan(dir)
        .map_err(|e| e.to_string())?;
    match verb {
        Verb::Archive { apply, .. } => archive(&mut client(&installation, &plan)?, apply),
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
    }
}

fn archive(linear: &mut Linear, apply: bool) -> Result<(), String> {
    let org = linear.request("query{organization{subscription{type}}}", json!({}))?;
    if org["organization"].get("subscription") != Some(&Value::Null) {
        println!("no archive: the workspace has a paid Linear plan");
        return Ok(());
    }
    let result = (|| {
        let issues = linear.pages("query($after:String){issues(first:100,after:$after,filter:{state:{type:{in:[\"completed\",\"canceled\"]}}}){nodes{id identifier} pageInfo{hasNextPage endCursor}}}",json!({}),"/issues")?;
        let mut labels = Vec::new();
        for issue in issues {
            let id = issue["id"].as_str().ok_or("missing issue id")?;
            labels.push(
                issue["identifier"]
                    .as_str()
                    .ok_or("missing issue identifier")?
                    .to_owned(),
            );
            if apply {
                let r = linear.request(
                    "mutation($id:String!){issueArchive(id:$id){success}}",
                    json!({"id":id}),
                )?;
                if r["issueArchive"]["success"] != true {
                    return Err("Linear refused to archive the issue".to_owned());
                }
            }
        }
        Ok(labels)
    })();
    let labels = result.unwrap_or_else(|e| {
        eprintln!("warn: archive of settled issues failed: {e}");
        Vec::new()
    });
    if labels.is_empty() {
        println!("no completed or canceled issue to archive");
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
fn display(v: &Value) -> String {
    match v {
        Value::Null => "-".into(),
        Value::String(s) if s.is_empty() => "-".into(),
        Value::String(s) => s.clone(),
        v => v.to_string(),
    }
}

fn ordered(plan: &Value) -> Result<Vec<&Value>, String> {
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
