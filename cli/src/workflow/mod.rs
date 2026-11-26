//! Live issue state for workflow commands.
use crate::linear::{Client, Installation, LinearHttp, SystemTiming};
mod command;
pub use command::command;
pub(crate) use command::{archive, ordered};

use serde_json::{Value, json};
use std::collections::BTreeMap;

pub struct Snapshot {
    pub live: BTreeMap<String, Value>,
    pub statuses: BTreeMap<String, String>,
}

fn status(issue: &Value, human: &str) -> Result<String, String> {
    let labels = issue["labels"]["nodes"]
        .as_array()
        .ok_or("missing issue labels")?;
    let has = |name: &str| labels.iter().any(|label| label["name"] == name);
    let lower = human.to_lowercase();
    let slug = lower
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    if has(&format!("needs-{slug}")) {
        return Ok(format!("Needs {human}"));
    }
    let state = &issue["state"];
    let name = match state["type"].as_str().ok_or("missing issue state type")? {
        "completed" => "Done",
        "canceled" | "duplicate" => "Canceled",
        _ => match state["name"].as_str().ok_or("missing issue state name")? {
            "Ready for Deploy" => "Merged",
            "External QA" | "In Review" if has("ready-to-merge") => "Ready to Merge",
            "External QA" => "In Review",
            "In Dev" => "In Progress",
            "Ready for Eng" => "Todo",
            name => name,
        },
    };
    Ok(name.to_owned())
}

const ISSUES: &str = "query($ids:[ID!]){issues(first:25,includeArchived:true,filter:{id:{in:$ids}}){nodes{id identifier url sortOrder title team{id} project{id} projectMilestone{id} state{name type} archivedAt labels(first:100){nodes{id name}} relations(first:50,includeArchived:true){nodes{id type relatedIssue{id}} pageInfo{hasNextPage endCursor}}}}}";

pub fn snapshot(
    installation: &Installation,
    plan: &Value,
    keymap: &Value,
) -> Result<Snapshot, String> {
    let nodes = keymap["nodes"]
        .as_object()
        .filter(|m| !m.is_empty())
        .ok_or("keymap.json has no nodes; run wg.py load --apply first")?;
    let mut client = client(installation, plan)?;
    let ids = nodes
        .values()
        .map(|node| node["id"].as_str().ok_or("missing issue id"))
        .collect::<Result<Vec<_>, _>>()?;
    let mut live = BTreeMap::new();
    for chunk in ids.chunks(25) {
        let answer = client.request(ISSUES, json!({"ids":chunk}))?;
        for issue in answer["issues"]["nodes"]
            .as_array()
            .ok_or("invalid issues response")?
        {
            let id = issue["id"].as_str().ok_or("missing issue id")?;
            live.insert(id.to_owned(), issue.clone());
        }
    }
    let human = installation.config.settings()["human"]
        .as_str()
        .ok_or("missing human name")?;
    let mut statuses = BTreeMap::new();
    for (key, node) in nodes {
        if let Some(issue) = node["id"].as_str().and_then(|id| live.get(id)) {
            statuses.insert(key.clone(), status(issue, human)?);
        }
    }
    Ok(Snapshot { live, statuses })
}

pub fn current_claims(
    installation: &Installation,
    plan: &Value,
    keymap: &Value,
) -> Result<Option<Value>, String> {
    if !shared(keymap) {
        return Ok(None);
    };
    let scope = workspace(installation, plan)?;
    crate::page::project_claims(installation, scope, &keymap["collab"]).map(Some)
}

fn workspace<'a>(installation: &'a Installation, plan: &'a Value) -> Result<&'a str, String> {
    plan["effort"]["workspace"]
        .as_str()
        .or_else(|| installation.workspaces().first()?.get("id")?.as_str())
        .ok_or_else(|| "missing workspace".into())
}

type Linear = Client<'static, Value, LinearHttp, SystemTiming>;

fn client(installation: &Installation, plan: &Value) -> Result<Linear, String> {
    Client::connect(
        workspace(installation, plan)?,
        installation,
        installation,
        &LinearHttp,
        &SystemTiming,
    )
}

mod cleanup;
pub use cleanup::cleanup_worktrees;

mod load;

mod transition;

mod settings;

fn journal(dir: &std::path::Path, cmd: &str, old: &Value, new: &Value) {
    if let Err(e) = crate::local::record_workflow(dir, cmd, old, new) {
        eprintln!("warn: journal not written ({e})");
    }
}

fn shared(keymap: &Value) -> bool {
    keymap["collab"].as_object().is_some_and(|m| !m.is_empty())
}

mod levels;

pub(crate) use transition::{Workflow, move_node};
pub(crate) use settings::agent as write_agent_settings;
