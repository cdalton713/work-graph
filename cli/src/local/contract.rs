use super::*;
use serde_json::json;

pub(super) const KINDS: [&str; 6] = [
    "decision",
    "merge-point",
    "ops",
    "ship-point",
    "spike",
    "task",
];
const STATUSES: [&str; 10] = [
    "Todo",
    "Ready",
    "In Progress",
    "Needs Human",
    "In Review",
    "Ready to Merge",
    "Merged",
    "Verifying",
    "Done",
    "Canceled",
];

fn samples() -> Vec<Value> {
    let row = json!({"branch": "wg/xy-write-00-a", "pr": "7", "review": "clean", "merge_review": "requested", "state": "running", "job": "review", "started_at": "2025-12-31T23:00:00Z", "soak_until": "2026-01-01T00:00:00Z", "code_done_head": "abc"});
    let entry = json!({"published": {"wave": "yes", "next": "do ask-merge: #7\nwait human: 2 review rounds; accept or ask for a fix"}});
    KINDS
        .iter()
        .map(|&kind| {
            let mut n = json!({"key":"a","kind":kind,"phase":"1","title":"A","acceptance":"Pass."});
            if kind == "task" {
                n["lane"] = "write".into();
                n["role"] = "sync".into();
                n["owns"] = json!(["src/a/**"]);
                n["shares"] = json!(["pnpm-lock.yaml"]);
            }
            let (data, body) = if matches!(kind, "task" | "ship-point") {
                card::render(&n, &entry, &row)
            } else {
                card::render(&n, &Value::Null, &Value::Null)
            };
            json!({"data":data,"body":body})
        })
        .collect()
}
pub(crate) fn satisfied(blocker: &Value, node: &Value, state: &str, code_done: bool) -> bool {
    if matches!(state, "Canceled" | "Done") {
        return true;
    }
    if blocker["kind"] != "task" {
        return false;
    }
    if node["kind"] == "task"
        && blocker["lane"] == node["lane"]
        && blocker["phase"] == node["phase"]
    {
        return state == "Merged" || code_done && matches!(state, "In Review" | "Ready to Merge");
    }
    state == "Merged"
        && (node["kind"] == "merge-point"
            || node["kind"] == "ship-point"
                && matches!(text(blocker, "role"), "sync" | "integration"))
}
fn edges() -> Vec<Value> {
    let cases = [
        (
            "a task of the same lane",
            json!({"kind": "task", "lane": "x", "phase": "1"}),
            json!({"kind": "task", "lane": "x", "phase": "1"}),
        ),
        (
            "a task of another lane",
            json!({"kind": "task", "lane": "x", "phase": "1"}),
            json!({"kind": "task", "lane": "y", "phase": "1"}),
        ),
        (
            "a task of the same lane name in another phase",
            json!({"kind": "task", "lane": "x", "phase": "1"}),
            json!({"kind": "task", "lane": "x", "phase": "2"}),
        ),
        (
            "a task before its merge point",
            json!({"kind": "task", "lane": "x", "phase": "1"}),
            json!({"kind": "merge-point", "phase": "1"}),
        ),
        (
            "a post-merge task before its ship point",
            json!({"kind": "task", "lane": "sync", "role": "sync", "phase": "1"}),
            json!({"kind": "ship-point", "phase": "1"}),
        ),
        (
            "a pre-merge task before a ship point",
            json!({"kind": "task", "lane": "x", "phase": "1"}),
            json!({"kind": "ship-point", "phase": "1"}),
        ),
        (
            "a merge point before an ops node",
            json!({"kind": "merge-point", "phase": "1"}),
            json!({"kind": "ops", "phase": "1"}),
        ),
        (
            "an ops node before a ship point",
            json!({"kind": "ops", "phase": "1"}),
            json!({"kind": "ship-point", "phase": "1"}),
        ),
        (
            "a ship point before the next phase",
            json!({"kind": "ship-point", "phase": "1"}),
            json!({"kind": "task", "lane": "x", "phase": "2"}),
        ),
        (
            "a decision before a task",
            json!({"kind": "decision", "phase": "1"}),
            json!({"kind": "task", "lane": "x", "phase": "1"}),
        ),
    ];
    cases
        .into_iter()
        .map(|(name, blocker, node)| {
            let clear = |code_done| {
                STATUSES
                    .into_iter()
                    .filter(|s| satisfied(&blocker, &node, s, code_done))
                    .collect::<Vec<_>>()
            };
            json!({
                "name":name,"blocker":blocker,"node":node,
                "clear":clear(true),"clear_without_code_done":clear(false)
            })
        })
        .collect()
}

const AUTONOMY: [&str; 3] = ["full", "standard", "supervised"];
const REVIEW: [&str; 3] = ["thorough", "standard", "light"];

fn setup() -> Value {
    let groups = [
        ("triage", &["Triage"][..]),
        ("backlog", &["Backlog"]),
        ("unstarted", &["Todo", "Ready"]),
        (
            "started",
            &[
                "In Progress",
                "Needs {name}",
                "In Review",
                "Ready to Merge",
                "Merged",
                "Verifying",
            ],
        ),
        ("completed", &["Done"]),
        ("canceled", &["Canceled"]),
        ("duplicate", &["Duplicate"]),
    ];
    let statuses: Vec<_> = groups
        .into_iter()
        .flat_map(|(kind, names)| {
            names
                .iter()
                .map(move |name| json!({"name":name,"type":kind}))
        })
        .collect();
    json!({
        "statuses":statuses,
        "team_issue_labels":["merge-point","ship-point","ops","decision","spike","reviewed"],
        "workspace_issue_labels":["answered"],
        "workspace_label_groups":{"agent":["agent:codex","agent:claude","agent:coordinator"]},
        "project_label_groups":{
            "initiative":[], "autonomy":AUTONOMY, "review":REVIEW.map(|s|format!("review:{s}"))
        },
        "project_labels":["paused","shared"]
    })
}

pub(super) fn generate() -> String {
    let fields: Vec<_> = card::PLAN_FIELDS
        .into_iter()
        .chain(card::RUN_FIELDS)
        .collect();
    let labels: Vec<_> = KINDS.into_iter().filter(|k| *k != "task").collect();
    let contract = json!({
        "version":3, "kinds":KINDS, "kind_labels":labels, "setup":setup(),
        "status_aliases":{
            "Ready for Deploy":"Merged","External QA":"In Review","In Dev":"In Progress","Ready for Eng":"Todo"
        },
        "human":{
            "default":"Human","status":"Needs {name}","label":"needs-{slug}","wait":"wait human",
            "slug":"lowercase; each run of other characters than a-z and 0-9 is one -; no - at the ends"
        },
        "labels":{
            "needs_human":"needs-human","ready_to_merge":"ready-to-merge","reviewed":"reviewed",
            "claim_prefix":"agent:","answered":"answered"
        },
        "project_labels":{
            "initiative_group":"initiative","autonomy_group":"autonomy","autonomy_levels":AUTONOMY,
            "autonomy_default":"standard","review_group":"review","review_prefix":"review:",
            "review_levels":REVIEW,"review_default":"thorough","paused":"paused"
        },
        "card":{
            "prefix":card::PREFIX,"footers":[card::FOOTER,"No acceptance or files in plan.json."],
            "fields":fields,"samples":samples()
        },
        "status_doc":{
            "title":"work-graph status","fields":["status","wave","lines","at","ran","wait_interval","contract","agents"]
        },
        "statuses":STATUSES,"satisfied":edges(),
        "link":{
            "version":1, "path":"/api/link","to_coordinator":["changed","answer","reply","command","agent-reply"],
            "from_coordinator":["hello","state","asks","progress","ack","wrote","agents","agent-reply-result"],
            "commands":["next","dispatch","pause","resume","autonomy","agents"],
            "agent_reply_statuses":["delivered","refused","unconfirmed"],"close_codes":{"restart":1012,"recycle":4001}
        }
    });
    ascii(&serde_json::to_string_pretty(&contract).expect("JSON value")) + "\n"
}
