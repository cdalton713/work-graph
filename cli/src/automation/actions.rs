//! Compute the next coordinator actions from one scoped workflow snapshot.
use super::{machine::*, production::Effort, pull_requests::PullRequests};
use crate::{local::satisfied, workflow};
use serde_json::{Value, json};
use std::{collections::BTreeMap, process::Command, time::Duration};

pub(super) const COMPLETE: &str = "every ship point is Done or Canceled";
pub(super) struct Actions {
    pub head: String,
    pub lines: Vec<(String, String)>,
    pub members: BTreeMap<String, Value>,
    pub held: std::collections::BTreeSet<String>,
    pub current_claims: Option<Value>,
}
fn settled(s: &str) -> bool {
    matches!(s, "Done" | "Merged" | "Canceled")
}
fn good(v: &Value) -> bool {
    matches!(v.as_str(), Some("clean" | "accepted"))
}
fn show(v: &Value) -> String {
    v.as_str()
        .map(String::from)
        .unwrap_or_else(|| v.to_string())
}
fn count(v: &Value) -> u64 {
    v.as_u64().or_else(|| text(v).parse().ok()).unwrap_or(0)
}
struct TaskPr<'a> {
    key: &'a str,
    row: &'a Value,
    status: &'a str,
    reviewed: bool,
    below: Option<(&'a str, &'a str)>,
}
fn pr_action(
    e: &Effort,
    prs: &mut PullRequests,
    pr: &Value,
    base: &str,
    task: TaskPr,
) -> Result<(&'static str, &'static str, String)> {
    let TaskPr {
        key,
        row,
        status,
        reviewed,
        below,
    } = task;
    let number = text(&row["pr"]);
    let head = text(&pr["headRefOid"]);
    let short = head.chars().take(10).collect::<String>();
    let tag = format!("#{number}");
    if status == "Merged" {
        return Ok((
            "do",
            "reconcile",
            format!("status Merged, but PR {tag} is {}", text(&pr["state"])),
        ));
    }
    if pr["state"] == "MERGED" {
        return Ok((
            "do",
            "merged",
            format!(
                "{tag} {}",
                text(&pr["mergeCommit"]["oid"])
                    .chars()
                    .take(10)
                    .collect::<String>()
            ),
        ));
    }
    if pr["state"] != "OPEN" {
        return Ok(("do", "closed", tag));
    }
    if row["code_done_head"] != pr["headRefOid"] || head.is_empty() {
        return Ok((
            "do",
            "verify",
            format!("{tag} head {short} is not code done"),
        ));
    }
    let effort = &e.km["run"]["effort"];
    let level = effort["review_seen"].as_str().unwrap_or("thorough");
    let rounds = count(&row["review_round"]);
    let round = || {
        let other = match text(&row["agent"]) {
            "codex" => ", agent claude",
            "claude" => ", agent codex",
            _ => "",
        };
        format!("{tag} round {}{other}", rounds + 1)
    };
    let review = || {
        if row["review_dispatch"].is_string() {
            ("wait", "reviewer", format!("{tag} round {}", rounds.max(1)))
        } else if level == "light" {
            ("do", "review", format!("{tag}: read the diff yourself"))
        } else if level != "thorough"
            && let Some(old) = row["review_head"].as_str()
        {
            (
                "do",
                "review",
                format!(
                    "{tag}: check the fix since {}",
                    old.chars().take(10).collect::<String>()
                ),
            )
        } else if level == "thorough" && rounds >= 2 {
            (
                "wait",
                "human",
                format!(
                    "{tag}: 2 review rounds had blocking findings; only this PR is held (label 'reviewed' accepts them, or ask for one more fix)"
                ),
            )
        } else {
            ("do", "review", round())
        }
    };
    if !good(&row["review"]) && pr["isDraft"] == true && !reviewed {
        return Ok(review());
    }
    if below.is_some_and(|(_, s)| matches!(s, "Merged" | "Done")) && row["parent"] != base {
        return Ok(("do", "restack", format!("{tag}: the PR below it merged")));
    }
    if pr["isDraft"] == true {
        return Ok(if row["draft"] == "yes" {
            ("wait", "human", format!("mark PR {tag} ready for review"))
        } else if effort["merge_prep"].as_str().unwrap_or("coordinator") == "coordinator" {
            ("do", "undraft", tag)
        } else {
            ("do", "ask-ready", tag)
        });
    }
    let gate = good(&row["merge_review"])
        || row["verified_head"] == head
        || reviewed
        || matches!(
            row["gate"].as_str(),
            Some("standard" | "thorough" | "light")
        )
        || level != "thorough" && good(&row["review"]);
    if !gate {
        if level != "thorough" {
            return Ok(review());
        }
        if row["merge_review"] != "requested" {
            let detail = if let Some(last) = row["thorough_head"].as_str() {
                format!(
                    "check the fix since {}, no new thorough review",
                    last.chars().take(10).collect::<String>()
                )
            } else {
                "request the thorough review".into()
            };
            return Ok(("do", "merge-review", format!("{tag}: {detail}")));
        }
        let seen = ["reviews", "comments"]
            .into_iter()
            .flat_map(|k| pr[k].as_array().into_iter().flatten())
            .filter(|r| !text(&r["body"]).contains("@claude-thorough"))
            .count() as u64;
        return Ok(if seen > count(&row["merge_review_seen"]) {
            ("do", "merge-review", format!("{tag}: read the new review"))
        } else {
            (
                "wait",
                "review",
                format!("{tag}: the thorough review is requested"),
            )
        });
    }
    if let Some((key, s)) = below
        && !settled(s)
    {
        return Ok((
            "wait",
            "below",
            format!("{tag} is ready; {key} merges first"),
        ));
    }
    if pr["baseRefName"] != base {
        return Ok((
            "do",
            "restack",
            format!(
                "{tag}: its base is {}, not {base}",
                text(&pr["baseRefName"])
            ),
        ));
    }
    if pr["mergeable"] == "CONFLICTING" {
        return Ok(("do", "restack", format!("{tag} conflicts with {base}")));
    }
    if !prs.passed(key, number)? {
        return Ok(("do", "verify", format!("{tag}: a check failed")));
    }
    Ok(
        if effort["autonomy_seen"] == "full"
            && *prs.merge_allowed.get_or_insert_with(|| may_merge(e))
        {
            ("do", "merge", tag)
        } else if status != "Ready to Merge" {
            ("do", "ask-merge", tag)
        } else {
            ("wait", "human", format!("merge PR {tag}"))
        },
    )
}

pub(super) struct Claims {
    current: Option<Value>,
    gates: BTreeMap<String, (&'static str, String)>,
    runners: BTreeMap<String, String>,
}
pub(super) fn maintain_claims(
    e: &Effort,
    snap: &workflow::Snapshot,
    claims: Option<Value>,
) -> Result<Claims> {
    let mut runners = BTreeMap::new();
    let rows = &e.km["run"]["nodes"];
    let status = |key: &str| snap.statuses.get(key).map(String::as_str).unwrap_or("");
    let mut gates = BTreeMap::new();
    if let Some(current) = &claims {
        if current["role"] != "owner" {
            for n in workflow::ordered(&e.plan)? {
                if matches!(
                    n["kind"].as_str(),
                    Some("merge-point" | "ship-point" | "ops" | "decision")
                ) {
                    let key = text(&n["key"]);
                    gates.insert(key.to_string(), ("wait", format!("owner {key}")));
                    runners.insert(key.into(), "the owner".into());
                }
            }
        }
        let held = current["claims"].as_array().ok_or("missing claims")?;
        let mut session = None;
        for claim in held {
            let key = text(&claim["node"]);
            let holder = text(&claim["holder"]);
            if claim["mine"] == true {
                let release = settled(status(key));
                if !release && rows[key].as_object().is_none_or(|r| r.is_empty()) {
                    gates.insert(
                        key.into(),
                        (
                            "do",
                            format!(
                                "reconcile {key}: this account holds a claim with no local job"
                            ),
                        ),
                    );
                } else {
                    let mut update = || -> Result<Option<String>> {
                        let client = match &session {
                            Some(client) => client,
                            None => session.insert(crate::page::ClaimSession::new(
                                e.install,
                                e.scope()?,
                                &e.km["collab"],
                            )?),
                        };
                        Ok(client.update(key, (!release).then_some(&claim["job"]))?)
                    };
                    match update() {
                        Ok(Some(detail)) => {
                            gates.insert(key.into(), ("do", format!("reconcile {key}: {detail}")));
                        }
                        Err(err) if release => {
                            eprintln!("warn {key}: could not release claim: {err}")
                        }
                        other => {
                            other?;
                        }
                    }
                }
            } else {
                runners.insert(key.into(), holder.into());
                if claim["stale"] == true {
                    let age = chrono::DateTime::parse_from_rfc3339(text(&claim["leaseUntil"]))
                        .map(|end| {
                            format!(
                                "{}s ago",
                                (chrono::Utc::now().timestamp() - end.timestamp()).max(0)
                            )
                        })
                        .unwrap_or_else(|_| "at an unknown time".into());
                    gates
                        .entry(key.into())
                        .or_insert(("note", format!("stale {key}: {holder}, lease ended {age}")));
                } else {
                    gates.entry(key.into()).or_insert((
                        "wait",
                        format!("collaborator {holder} {key}: job={}", text(&claim["job"])),
                    ));
                }
            }
        }
        for (key, row) in rows.as_object().into_iter().flatten() {
            let local_label = row["agent"].as_str().is_some_and(|agent| {
                let label = format!("agent:{agent}");
                snap.live
                    .get(text(&e.km["nodes"][key]["id"]))
                    .and_then(|i| i["labels"]["nodes"].as_array())
                    .is_some_and(|labels| labels.iter().any(|l| l["name"] == label))
            });
            if (local_label
                || matches!(
                    row["state"].as_str(),
                    Some("creating" | "starting" | "running")
                ))
                && !settled(status(key))
                && !held.iter().any(|c| c["node"] == *key && c["mine"] == true)
            {
                let reason = held
                    .iter()
                    .find(|c| c["node"] == *key)
                    .map(|c| format!("{} holds this node now", text(&c["holder"])))
                    .unwrap_or_else(|| "no claim".into());
                gates.insert(key.clone(), ("do", format!("reconcile {key}: {reason}")));
            }
        }
    }
    Ok(Claims {
        current: claims,
        gates,
        runners,
    })
}
#[derive(Clone, Copy, PartialEq)]
pub(super) enum ReadMode {
    Next,
    Wait,
    Tick,
}
impl Actions {
    pub fn answer_runner(&self, key: &str) -> Option<&str> {
        let current = self.current_claims.as_ref()?;
        if let Some(claim) = current["claims"]
            .as_array()?
            .iter()
            .find(|c| c["node"] == key)
        {
            return (claim["mine"] != true).then(|| text(&claim["holder"]));
        }
        (current["role"] != "owner").then_some("the owner")
    }
    pub fn read(
        e: &Effort,
        snap: &workflow::Snapshot,
        claims_state: Claims,
        mode: ReadMode,
    ) -> Result<Self> {
        let nodes = workflow::ordered(&e.plan)?;
        let edges = e.plan["edges"].as_array().ok_or("missing edges")?;
        let phases = e.plan["phases"].as_array().ok_or("missing phases")?;
        let mut wave = text(&e.km["run"]["effort"]["wave"])
            .split(',')
            .filter(|k| !k.is_empty())
            .map(String::from)
            .collect::<Vec<_>>();
        let mut out = Self {
            head: COMPLETE.into(),
            lines: vec![],
            members: BTreeMap::new(),
            held: claims_state.gates.keys().cloned().collect(),
            current_claims: claims_state.current,
        };
        let mut idle = vec![];
        let status = |key: &str| snap.statuses.get(key).map(String::as_str).unwrap_or("");
        let rows = &e.km["run"]["nodes"];
        let role = out.current_claims.as_ref().and_then(|c| c["role"].as_str());
        let gates = claims_state.gates;
        let runners = claims_state.runners;
        wave.retain(|k| !gates.contains_key(k));
        let mut prs = PullRequests::new(
            e.dir,
            mode == ReadMode::Wait,
            mode == ReadMode::Tick,
            rows.as_object()
                .into_iter()
                .flatten()
                .filter(|(key, _)| !gates.contains_key(*key))
                .filter_map(|(_, r)| r["pr"].as_str()),
        );
        out.lines.extend(
            gates
                .iter()
                .filter(|(key, (level, _))| {
                    *level == "do" && !nodes.iter().any(|n| n["key"] == key.as_str())
                })
                .map(|(_, (level, line))| (level.to_string(), line.clone())),
        );

        for node in &nodes {
            let key = text(&node["key"]);
            let s = status(key);
            let kind = text(&node["kind"]);
            let row = &rows[key];
            let entry = &e.km["nodes"][key];
            let issue = snap.live.get(text(&entry["id"]));
            let labels = issue
                .and_then(|i| i["labels"]["nodes"].as_array())
                .map(Vec::as_slice)
                .unwrap_or_default();
            let marked = labels.iter().any(|l| l["name"] == "reviewed");
            let ident = entry["identifier"].as_str().unwrap_or("-");
            if let Some((level, msg)) = gates.get(key) {
                let runner = runners.get(key);
                let wait_label = runner.map(|r| {
                    format!(
                        "needs-{}",
                        r.to_lowercase()
                            .split(|c: char| !c.is_ascii_alphanumeric())
                            .filter(|s| !s.is_empty())
                            .collect::<Vec<_>>()
                            .join("-")
                    )
                });
                if let Some(runner) = runner
                    && !s.is_empty()
                    && !settled(s)
                    && (s.starts_with("Needs ")
                        || s == "Ready to Merge"
                        || labels
                            .iter()
                            .any(|l| l["name"].as_str() == wait_label.as_deref()))
                {
                    let who = if msg == &format!("owner {key}") {
                        s.strip_prefix("Needs ").unwrap_or(runner)
                    } else {
                        runner
                    };
                    out.lines
                        .push(("note".into(), format!("human {key}: waits on {who}")));
                    if *level == "do" || msg.starts_with("stale ") {
                        out.lines.push((level.to_string(), msg.clone()));
                    }
                } else if !settled(s) || *level == "do" {
                    out.lines.push((level.to_string(), msg.clone()));
                }
                continue;
            }
            if matches!(s, "Triage" | "Ready to Merge")
                || s == format!("Needs {}", text(&e.install.config.settings()["human"]))
            {
                out.members
                    .insert(text(&entry["id"]).into(), json!({"issue":ident,"reason":s}));
            }
            if matches!(s, "Done" | "Canceled" | "Backlog" | "Triage") {
                continue;
            }
            let phase = phases
                .iter()
                .find(|p| p["key"] == node["phase"])
                .ok_or("missing phase")?;
            let deps = edges
                .iter()
                .filter(|v| v["from"] == key)
                .filter_map(|edge| nodes.iter().copied().find(|n| n["key"] == edge["to"]))
                .collect::<Vec<_>>();
            let mut blockers: Vec<_> = deps
                .iter()
                .filter(|b| {
                    let k = text(&b["key"]);
                    !satisfied(
                        b,
                        node,
                        status(k),
                        rows[k]["code_done_head"].is_string()
                            || (role.is_some()
                                && !rows[k]["pr"].is_string()
                                && e.km["nodes"][k]["pr"].is_string()
                                && e.km["nodes"][k]["branch"].is_string()),
                    )
                })
                .map(|b| text(&b["key"]))
                .collect();
            let blocked = !blockers.is_empty();
            if matches!(kind, "merge-point" | "ship-point") {
                for n in e.plan["nodes"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|n| {
                        n["kind"] == "task"
                            && n["phase"] == node["phase"]
                            && (kind == "ship-point"
                                || !matches!(n["role"].as_str(), Some("sync" | "integration")))
                            && !settled(status(text(&n["key"])))
                    })
                {
                    let k = text(&n["key"]);
                    if !blockers.contains(&k) {
                        blockers.push(k);
                    }
                }
            }
            let phase_blocked = !blockers.is_empty();
            let below = deps
                .iter()
                .find(|b| {
                    b["kind"] == "task" && b["lane"] == node["lane"] && b["phase"] == node["phase"]
                })
                .map(|b| text(&b["key"]));
            let waiting = matches!(s, "Ready" | "Todo");
            let title = node["title"]
                .as_str()
                .or_else(|| issue?.get("title")?.as_str())
                .unwrap_or("");
            let action = if entry.is_null() {
                ("do", "load", "not in keymap.json".into())
            } else if issue.is_none() {
                ("do", "reconcile", "the issue is not in Linear".into())
            } else if matches!(
                row["state"].as_str(),
                Some("unknown" | "failed" | "blocked")
            ) {
                ("wait", "human", format!("state={}", text(&row["state"])))
            } else if matches!(row["state"].as_str(), Some("creating" | "starting")) {
                (
                    "do",
                    "reconcile",
                    format!(
                        "state={}: no receipt of the job is recorded{}",
                        text(&row["state"]),
                        row["step"]
                            .as_str()
                            .map(|s| format!(" (step={s})"))
                            .unwrap_or_default()
                    ),
                )
            } else if row["state"] == "running" {
                let detail = format!(
                    "job={} dispatch={}",
                    row["job"].as_str().unwrap_or("?"),
                    row["dispatch"].as_str().unwrap_or("?")
                );
                if row["step"] == "receipt" {
                    (
                        "do",
                        "reconcile",
                        format!(
                            "{detail} runs; its claim comment is not written: run the same wg dispatch --run or wg claim --send again"
                        ),
                    )
                } else {
                    ("wait", "worker", detail)
                }
            } else if let Some(label) = labels
                .iter()
                .find_map(|l| l["name"].as_str().filter(|s| s.starts_with("agent:")))
            {
                (
                    "do",
                    "reconcile",
                    format!("{label} with no job in the run row"),
                )
            } else if s == format!("Needs {}", text(&e.install.config.settings()["human"])) {
                ("wait", "human", title.into())
            } else if role.is_some()
                && let Some(who) = s.strip_prefix("Needs ")
            {
                out.held.insert(key.into());
                out.lines
                    .push(("note".into(), format!("human {key}: waits on {who}")));
                continue;
            } else if kind == "task"
                && !matches!(
                    s,
                    "Todo"
                        | "Ready"
                        | "In Progress"
                        | "In Review"
                        | "Ready to Merge"
                        | "Merged"
                        | "Verifying"
                )
            {
                ("do", "reconcile", format!("ENG status {s} has no twin"))
            } else if kind == "task" && row["pr"].is_string() {
                let pr = prs.info(key, text(&row["pr"]), s == "Merged")?;
                if pr.is_null() {
                    continue;
                }
                if s == "Merged" && pr["state"] == "MERGED" {
                    continue;
                }
                pr_action(
                    e,
                    &mut prs,
                    &pr,
                    if node["role"] == "sync" {
                        "main"
                    } else {
                        text(&phase["target"])
                    },
                    TaskPr {
                        key,
                        row,
                        status: s,
                        reviewed: marked,
                        below: below.map(|k| (k, status(k))),
                    },
                )?
            } else if kind == "task" && s == "Merged" {
                continue;
            } else if kind == "task" && !(waiting && blocked) {
                if node["role"] == "integration" {
                    ("do", "integration", String::new())
                } else if row["branch"].is_string() {
                    ("do", "verify", "no pr in the run row".into())
                } else if !waiting {
                    ("do", "reconcile", format!("{s} with no run row"))
                } else if node["branch"].is_string() || node["pr"].is_string() {
                    ("do", "adopt", String::new())
                } else if !wave.iter().any(|k| k == key) {
                    idle.push(key);
                    continue;
                } else if let Some(b) = below.filter(|b| {
                    rows[*b]["pr"].is_string()
                        && matches!(status(b), "In Review" | "Ready to Merge")
                }) && prs.info(b, text(&rows[b]["pr"]), false)?["headRefOid"]
                    != rows[b]["code_done_head"]
                {
                    (
                        "wait",
                        "below",
                        format!("{b} has a push that is not code done"),
                    )
                } else {
                    ("do", "dispatch", String::new())
                }
            } else if kind == "ops" && node["by"] == "coordinator" && s == "In Progress" {
                ("wait", "coordinator", title.into())
            } else if kind == "spike" && s == "In Progress" {
                (
                    "do",
                    "reconcile",
                    "In Progress with no job in the run row".into(),
                )
            } else if kind == "ship-point"
                && let Some(problem) = suite_problem(e, snap, node, phase, &mut prs)?
            {
                ("do", "full-suite", problem)
            } else if waiting && !blocked {
                match kind {
                    "spike" if wave.iter().any(|k| k == key) => ("do", "dispatch", String::new()),
                    "spike" => {
                        idle.push(key);
                        continue;
                    }
                    "ops" if node["by"] == "coordinator" => ("do", "ops", title.into()),
                    "decision" | "ops" => ("do", "ask", title.into()),
                    "merge-point" if !phase_blocked => ("do", "close", String::new()),
                    "ship-point" if !phase_blocked => ("do", "verifying", String::new()),
                    _ => continue,
                }
            } else if kind == "ship-point" && s == "Verifying" {
                if phase_blocked {
                    (
                        "wait",
                        "blockers",
                        format!("{} opened again", blockers.join(", ")),
                    )
                } else if let Some(until) = row["soak_until"].as_str() {
                    if chrono::DateTime::parse_from_rfc3339(until)? > chrono::Utc::now() {
                        ("wait", "soak", format!("until {until}"))
                    } else {
                        ("do", "ship", format!("the soak passed at {until}"))
                    }
                } else if let Some(soak) = phase["soak"].as_str() {
                    (
                        "wait",
                        "human",
                        format!("no soak_until: when did the {soak} soak start?"),
                    )
                } else {
                    ("do", "ship", String::new())
                }
            } else {
                continue;
            };
            let (level, verb, detail) = action;
            if verb == "merge" {
                out.members.remove(text(&entry["id"]));
            }
            let detail = if detail.is_empty() {
                detail
            } else {
                format!(": {detail}")
            };
            out.lines
                .push((level.into(), format!("{verb} {key} {ident}{detail}")));
            if matches!(
                (level, verb),
                ("wait", "human") | ("do", "ask" | "ask-ready" | "ask-merge")
            ) {
                out.members.insert(
                    text(&entry["id"]).into(),
                    json!({"issue":ident,"reason":format!("{level} {verb}{detail}")}),
                );
            }
        }
        let code_done = |prs: &mut PullRequests, key: &str| -> Result<bool> {
            if settled(status(key)) {
                return Ok(true);
            }
            let row = &rows[key];
            if !row["code_done_head"].is_string() || !row["pr"].is_string() {
                return Ok(false);
            }
            let pr = prs.info(key, text(&row["pr"]), false)?;
            Ok(pr["state"] == "MERGED"
                || pr["state"] == "OPEN" && pr["headRefOid"] == row["code_done_head"])
        };
        let mut open = false;
        if !idle.is_empty() {
            for key in &wave {
                if let Some(n) = nodes.iter().find(|n| n["key"] == key.as_str())
                    && (if n["kind"] == "task" {
                        !code_done(&mut prs, key)?
                    } else {
                        !settled(status(key))
                    })
                {
                    open = true;
                    break;
                }
            }
        }
        if !idle.is_empty() && !open {
            out.lines.push((
                "do".into(),
                format!("wave: pick the next wave from {}", idle.join(",")),
            ));
        }
        if role.is_none_or(|role| role == "owner") {
            let triage=e.linear()?.pages("query($id:String!,$after:String){project(id:$id){issues(first:50,after:$after,includeArchived:true){nodes{id identifier title state{name}} pageInfo{hasNextPage endCursor}}}}",json!({"id":e.project()?}),"/project/issues");
            let triage = match triage {
                Err(e) if mode == ReadMode::Wait => {
                    eprintln!("warn next: {e}");
                    vec![]
                }
                res => res?,
            };
            for i in triage {
                if i["state"]["name"] == "Triage"
                    && !e.km["nodes"]
                        .as_object()
                        .into_iter()
                        .flatten()
                        .any(|(_, n)| n["id"] == i["id"])
                {
                    let full = e.km["run"]["effort"]["autonomy_seen"] == "full";
                    out.lines.push((
                        if full { "do" } else { "note" }.into(),
                        format!("triage {}: {}", text(&i["identifier"]), text(&i["title"])),
                    ));
                    if !full {
                        out.members.insert(
                            text(&i["id"]).into(),
                            json!({"issue":i["identifier"],"reason":"Triage"}),
                        );
                    }
                }
            }
        }
        if let Some(phase) = phases.iter().find(|p| {
            nodes.iter().any(|n| {
                n["kind"] == "ship-point"
                    && n["phase"] == p["key"]
                    && !matches!(status(text(&n["key"])), "Done" | "Canceled")
            })
        }) {
            let tasks = nodes
                .iter()
                .filter(|n| n["kind"] == "task" && n["phase"] == phase["key"])
                .map(|n| text(&n["key"]))
                .collect::<Vec<_>>();
            let code = tasks
                .iter()
                .filter(|k| settled(status(k)) || rows[**k]["code_done_head"].is_string())
                .count();
            let mut reviewed = 0;
            for &key in &tasks {
                if gates.contains_key(key) {
                    continue;
                }
                if settled(status(key)) {
                    reviewed += 1;
                    continue;
                }
                if code_done(&mut prs, key)?
                    && (good(&rows[key]["review"])
                        || prs.info(key, text(&rows[key]["pr"]), false)?["isDraft"] == false
                        || snap
                            .live
                            .get(text(&e.km["nodes"][key]["id"]))
                            .and_then(|i| i["labels"]["nodes"].as_array())
                            .is_some_and(|ls| ls.iter().any(|l| l["name"] == "reviewed")))
                {
                    reviewed += 1;
                }
            }
            let merged = tasks
                .iter()
                .filter(|k| matches!(status(k), "Done" | "Merged"))
                .count();
            let n = tasks.len();
            out.head = format!(
                "phase {}: {n} task{}, {code} code done, {reviewed} reviewed, {merged} merged",
                show(&phase["key"]),
                if n == 1 { "" } else { "s" }
            );
            if !wave.is_empty() {
                out.head += &format!("; wave {}", wave.join(","));
            }
        }
        out.lines.sort_by_key(|(level, _)| match level.as_str() {
            "do" => 0,
            "wait" => 1,
            _ => 2,
        });
        Ok(out)
    }
}

fn suite_problem(
    e: &Effort,
    snap: &workflow::Snapshot,
    node: &Value,
    phase: &Value,
    prs: &mut PullRequests,
) -> Result<Option<String>> {
    let nodes = e.plan["nodes"].as_array().ok_or("missing nodes")?;
    let status = |n: &Value| {
        snap.statuses
            .get(text(&n["key"]))
            .map(String::as_str)
            .unwrap_or("")
    };
    if !nodes
        .iter()
        .any(|n| n["kind"] == "merge-point" && n["phase"] == node["phase"] && status(n) == "Done")
    {
        return Ok(None);
    }
    let rows = &e.km["run"]["nodes"];
    let mut merges = vec![];
    for task in nodes.iter().filter(|n| {
        n["phase"] == node["phase"]
            && n["kind"] == "task"
            && !matches!(n["role"].as_str(), Some("sync" | "integration"))
            && matches!(status(n), "Done" | "Merged")
    }) {
        let key = text(&task["key"]);
        let Some(number) = rows[key]["pr"].as_str() else {
            continue;
        };
        if let Some(oid) = prs.info(key, number, false)?["mergeCommit"]["oid"].as_str() {
            merges.push(oid.to_string());
        }
    }
    if merges.is_empty() {
        return Ok(None);
    }
    let p = show(&node["phase"]);
    let k = format!("@full-{p}");
    if k.contains('/') {
        return Err("invalid evidence key".into());
    }
    let run = format!(
        "in a clean worktree at origin/{}: wg evidence {} {}",
        text(&phase["target"]),
        quote(&e.dir.canonicalize()?.to_string_lossy()),
        quote(&k)
    );
    let path = e.dir.join("evidence").join(format!("{k}.json"));
    let Ok(record) = std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .ok_or(())
    else {
        return Ok(Some(format!("no repo-wide test run of phase {p}; {run}")));
    };
    let cmd = e.plan["effort"]
        .get("test")
        .unwrap_or(&e.install.config.settings()["test_runner"]);
    let sha = text(&record["sha"]);
    if record["valid"] != true
        || cmd != &record["command"]
        || !(40..=64).contains(&sha.len())
        || !sha.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Ok(Some(format!(
            "the repo-wide test run of phase {p} is invalid; {run}"
        )));
    }
    for oid in merges {
        if !capture(
            Command::new("git")
                .current_dir(e.dir)
                .args(["merge-base", "--is-ancestor", &oid, sha]),
            Duration::from_secs(30),
        )?
        .status
        .success()
        {
            return Ok(Some(format!(
                "the repo-wide test run on {} does not hold merge commit {}; {run}",
                &sha[..10],
                oid.chars().take(10).collect::<String>()
            )));
        }
    }
    let key = text(&node["key"]);
    let accepted = text(&rows[key]["tests_accepted"])
        .split_once(':')
        .is_some_and(|(s, r)| s == sha && !r.trim().is_empty());
    if record["exit"] != 0 && !accepted {
        return Ok(Some(format!(
            "the repo-wide test run on {} failed (exit {}): read {}; then a fix, or wg run set … {key} \"tests_accepted={sha}:<reason>\"",
            &sha[..10],
            record["exit"],
            text(&record["log"])
        )));
    }
    Ok(None)
}

fn may_merge(e: &Effort) -> bool {
    let Some(allowed) = e.install.config.settings()["agent_merge"]
        .as_array()
        .filter(|v| !v.is_empty())
    else {
        return false;
    };
    let Ok(raw) = output(
        Command::new("gh")
            .current_dir(e.dir)
            .args(["repo", "view", "--json", "nameWithOwner"]),
        Duration::from_secs(10),
    ) else {
        return false;
    };
    let Ok(repo) = serde_json::from_str::<Value>(&raw) else {
        return false;
    };
    let name = text(&repo["nameWithOwner"]);
    let Some((owner, _)) = name.split_once('/') else {
        return false;
    };
    allowed
        .iter()
        .filter_map(Value::as_str)
        .any(|entry| entry.eq_ignore_ascii_case(name) || entry.eq_ignore_ascii_case(owner))
}
