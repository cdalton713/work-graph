use super::command::{archive, display, ready};
use super::*;
use crate::state::{PlanLock, load_keymap};
use std::{path::Path, process::Command};

fn node<'a>(p: &'a Value, k: &str) -> Result<&'a Value, String> {
    p["nodes"]
        .as_array()
        .and_then(|a| a.iter().find(|n| n["key"] == k))
        .ok_or_else(|| format!("unknown key {k}"))
}
fn human(i: &Installation) -> &str {
    i.config.settings()["human"].as_str().unwrap_or("Human")
}
fn keymap(dir: &Path) -> Result<Value, String> {
    load_keymap(dir).map_err(|e| e.to_string())
}
fn comment(l: &mut Linear, id: &Value, body: &str) -> Result<(), String> {
    let r = l.request(
        "mutation($i:CommentCreateInput!){commentCreate(input:$i){comment{id}}}",
        json!({"i":{"issueId":id,"body":body}}),
    )?;
    r["commentCreate"]["comment"]["id"]
        .as_str()
        .ok_or("failed to add issue comment")?;
    Ok(())
}
fn sync_ready(dir: &Path, i: &Installation, p: &Value, cmd: &str) {
    let result = (|| {
        let _lock = PlanLock::acquire(dir, None).map_err(|e| e.to_string())?;
        let km = keymap(dir)?;
        ready(dir, i, p, &km, true, true, cmd)
    })();
    if let Err(e) = result {
        eprintln!("Todo and Ready not synced ({e}); run 'wg ready --apply'");
    }
}
pub(super) fn approve(
    dir: &Path,
    i: &Installation,
    p: &Value,
    keys: &[String],
    quote: &str,
) -> Result<(), String> {
    let quote = quote.split_whitespace().collect::<Vec<_>>().join(" ");
    if quote.chars().count() < 2 {
        return Err(format!("--quote needs {}'s own words", human(i)));
    }
    if keys.iter().any(|k| k.starts_with('@')) {
        return Err(
            "wg approve takes node keys; no gate waits for an approval of the effort".into(),
        );
    }
    let km = keymap(dir)?;
    let mut selected = json!({"nodes":{}});
    for k in keys {
        node(p, k)?;
        if !km["nodes"][k].is_object() {
            return Err(format!("{k}: not loaded"));
        }
        selected["nodes"][k] = km["nodes"][k].clone();
    }
    let snap = snapshot(i, p, &selected)?;
    let mut linear = client(i, p)?;
    let date = chrono::Utc::now().format("%Y-%m-%d").to_string();
    for k in keys {
        let entry = &selected["nodes"][k];
        {
            let lock = PlanLock::acquire(dir, None).map_err(|e| e.to_string())?;
            let mut km = keymap(dir)?;
            if km["nodes"][k]["id"] != entry["id"] {
                return Err(format!("{k}: issue mapping changed"));
            }
            let before = km.clone();
            km["run"]["nodes"][k]["approved"] = format!("{date}: {quote}").into();
            crate::page::save_run_keymap(dir, &lock, p, &mut km)?;
            super::journal(dir, "approve", &before, &km);
        }
        comment(
            &mut linear,
            &entry["id"],
            &format!(
                "**wg approve** {}, {date}. Their words: \"{quote}\"",
                human(i)
            ),
        )?;
        println!("approved {k} {}", display(&entry["identifier"]));
        if snap.statuses.get(k) == Some(&format!("Needs {}", human(i))) {
            move_node(
                Workflow {
                    dir,
                    installation: i,
                    plan: p,
                    command: "approve",
                },
                k,
                "Todo",
                None,
                None,
                false,
            )?;
        }
    }
    sync_ready(dir, i, p, "approve");
    Ok(())
}

fn gh(dir: &Path, pr: &str, fields: &str) -> Result<Value, String> {
    let r = Command::new("gh")
        .args(["pr", "view", pr, "--json", fields])
        .current_dir(dir)
        .output()
        .map_err(|e| e.to_string())?;
    if !r.status.success() {
        return Err(String::from_utf8_lossy(&r.stderr).trim().into());
    }
    serde_json::from_slice(&r.stdout).map_err(|e| e.to_string())
}

#[derive(Clone, Copy)]
pub(super) struct Workflow<'a> {
    pub dir: &'a Path,
    pub installation: &'a Installation,
    pub plan: &'a Value,
    pub command: &'a str,
}

fn guard(
    ctx: Workflow<'_>,
    km: &Value,
    n: &Value,
    want: &str,
    note: Option<&str>,
    issue: &Value,
) -> Result<(Vec<String>, Vec<String>), String> {
    let Workflow {
        dir,
        installation: i,
        plan: p,
        ..
    } = ctx;
    let mut failures = vec![];
    let mut notes = vec![];
    let key = n["key"].as_str().ok_or("missing key")?;
    let row = &km["run"]["nodes"][key];
    let kind = n["kind"].as_str().ok_or("missing kind")?;
    let phase = p["phases"]
        .as_array()
        .and_then(|a| {
            a.iter()
                .find(|ph| display(&ph["key"]) == display(&n["phase"]))
        })
        .ok_or("missing phase")?;
    let target = phase["target"].as_str().unwrap_or("main");
    if matches!(kind, "decision" | "ops") && want == "Done" && note.unwrap_or("").trim().is_empty()
    {
        failures.push(format!(
            "{key}: a Done {kind} needs --note with {}'s {}",
            human(i),
            if kind == "ops" { "evidence" } else { "answer" }
        ));
    }
    if kind == "task" && matches!(want, "Ready to Merge" | "Merged" | "Done") {
        let pr = display(&row["pr"]);
        if pr == "-" {
            failures.push(format!("{key}: no pr in the run row"));
            return Ok((failures, notes));
        }
        let info = gh(
            dir,
            &pr,
            "state,isDraft,headRefOid,mergeCommit,baseRefName,mergeable",
        )?;
        let state = display(&info["state"]);
        if want == "Ready to Merge" {
            if state != "OPEN" || info["isDraft"] == true {
                failures.push(format!(
                    "{key}: PR #{pr} is {}",
                    if state == "OPEN" { "a draft" } else { &state }
                ));
            }
            if row["code_done_head"].as_str().is_none_or(str::is_empty)
                || row["code_done_head"] != info["headRefOid"]
            {
                failures.push(format!("{key}: the PR head is not code done (wg done)"));
            }
            let level = km["run"]["effort"]["review_seen"]
                .as_str()
                .unwrap_or("thorough");
            let clean = |v: &Value| matches!(v.as_str(), Some("clean" | "accepted"));
            let reviewed = issue["labels"]["nodes"]
                .as_array()
                .is_some_and(|a| a.iter().any(|l| l["name"] == "reviewed"));
            if !(reviewed
                || clean(&row["merge_review"])
                || (info["headRefOid"].is_string() && row["verified_head"] == info["headRefOid"])
                || matches!(
                    row["gate"].as_str(),
                    Some("thorough" | "standard" | "light")
                )
                || (matches!(level, "standard" | "light") && clean(&row["review"])))
            {
                failures.push(if level=="thorough"{format!("{key}: no merge review of this patch: review-and-merge.md \"Merge point\" step 2, then wg run set … merge_review=clean")}else{format!("{key}: no review of this patch at review effort {level}: review-and-merge.md \"Review effort\", then wg run set … review=clean")});
            }
            let base = if n["role"] == "sync" { "main" } else { target };
            if info["baseRefName"] != base {
                failures.push(format!(
                    "{key}: the base of PR #{pr} is {}, not {base}",
                    display(&info["baseRefName"])
                ));
            }
            if info["mergeable"] == "CONFLICTING" {
                failures.push(format!("{key}: PR #{pr} conflicts with {base}"));
            }
            let r = Command::new("gh")
                .args(["pr", "checks", &pr, "--json", "name,bucket"])
                .current_dir(dir)
                .output()
                .map_err(|e| e.to_string())?;
            if !r.stdout.is_empty() {
                let checks: Vec<Value> =
                    serde_json::from_slice(&r.stdout).map_err(|e| e.to_string())?;
                let failed = checks
                    .iter()
                    .filter(|v| v["bucket"] == "fail")
                    .map(|v| display(&v["name"]))
                    .collect::<Vec<_>>();
                if !failed.is_empty() || !matches!(r.status.code(), Some(0 | 1 | 8)) {
                    failures.push(format!(
                        "{key}: a check of PR #{pr} failed: {}",
                        failed.join(", ")
                    ));
                }
            } else if !r.status.success()
                && !(r.status.code() == Some(1)
                    && String::from_utf8_lossy(&r.stderr)
                        .to_lowercase()
                        .contains("no checks reported"))
            {
                failures.push(format!(
                    "{key}: a check of PR #{pr} failed: {}",
                    String::from_utf8_lossy(&r.stderr).trim()
                ));
            }
            let snap = snapshot(i, p, km)?;
            for edge in p["edges"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|e| e["from"] == key)
            {
                let below = edge["to"].as_str().ok_or("invalid edge")?;
                let b = node(p, below)?;
                if b["kind"] != "task"
                    || b["lane"] != n["lane"]
                    || display(&b["phase"]) != display(&n["phase"])
                {
                    continue;
                }
                match snap.statuses.get(below).map(String::as_str) {
                    Some("Canceled") => (),
                    Some("Merged" | "Done") => {
                        let num = display(&km["run"]["nodes"][below]["pr"]);
                        if num != "-" && gh(dir, &num, "state")?["state"] != "MERGED" {
                            failures.push(format!(
                                "{key}: {below} is below it and its PR #{num} is not merged"
                            ));
                        }
                    }
                    _ => failures.push(format!(
                        "{key}: {below} is below it in the lane and is not merged"
                    )),
                }
                break;
            }
        } else if state != "MERGED" {
            failures.push(format!("{key}: PR #{pr} is {state}, not MERGED"));
        } else {
            notes.push(format!(
                "PR #{pr} merged to `{}` as `{}`.",
                display(&info["baseRefName"]),
                display(&info["mergeCommit"]["oid"])
            ));
        }
    }
    if matches!(kind, "merge-point" | "ship-point") && matches!(want, "Verifying" | "Done") {
        milestone(ctx, km, n, want, phase, &mut failures, &mut notes)?;
    }
    Ok((failures, notes))
}

fn milestone(
    ctx: Workflow<'_>,
    km: &Value,
    n: &Value,
    want: &str,
    ph: &Value,
    failures: &mut Vec<String>,
    notes: &mut Vec<String>,
) -> Result<(), String> {
    let Workflow {
        dir,
        installation: i,
        plan: p,
        ..
    } = ctx;
    let snap = snapshot(i, p, km)?;
    let k = n["key"].as_str().ok_or("missing key")?;
    let ship = n["kind"] == "ship-point";
    let phase = display(&ph["key"]);
    let target = ph["target"].as_str().unwrap_or("main");
    let mut blocked = vec![];
    for e in p["edges"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|e| e["from"] == k)
    {
        let b = e["to"].as_str().ok_or("missing blocker")?;
        if !crate::local::satisfied(
            node(p, b)?,
            n,
            snap.statuses.get(b).map(String::as_str).unwrap_or("?"),
            km["run"]["nodes"][b]["code_done_head"]
                .as_str()
                .is_some_and(|h| !h.is_empty()),
        ) && !blocked.contains(&b)
        {
            blocked.push(b);
        }
    }
    let tasks = p["nodes"]
        .as_array()
        .ok_or("missing nodes")?
        .iter()
        .filter(|b| b["kind"] == "task" && display(&b["phase"]) == phase);
    let post = |b: &Value| matches!(b["role"].as_str(), Some("sync" | "integration"));
    for b in tasks.clone().filter(|b| ship || !post(b)) {
        let bk = b["key"].as_str().ok_or("missing key")?;
        if !matches!(
            snap.statuses.get(bk).map(String::as_str),
            Some("Merged" | "Done" | "Canceled")
        ) && !blocked.contains(&bk)
        {
            blocked.push(bk);
        }
    }
    for b in blocked {
        failures.push(format!(
            "{k}: blocker {b} is {}",
            snap.statuses
                .get(b)
                .map(String::as_str)
                .unwrap_or("not loaded")
        ));
    }
    if !ship && (want != "Done" || !failures.is_empty()) {
        return Ok(());
    }
    let git = |args: &[&str]| {
        Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .map_err(|e| e.to_string())
    };
    if !ship {
        let r = git(&[
            "fetch",
            "--no-tags",
            "--no-recurse-submodules",
            "--refmap=",
            "origin",
            &format!("refs/heads/{target}"),
        ])?;
        if !r.status.success() {
            failures.push(format!(
                "{k}: cannot fetch origin/{target}: {}",
                String::from_utf8_lossy(&r.stderr)
                    .lines()
                    .last()
                    .unwrap_or("")
            ));
            return Ok(());
        }
    }
    let mut merges = vec![];
    for b in tasks {
        let bk = b["key"].as_str().ok_or("missing key")?;
        let status = snap.statuses.get(bk).map(String::as_str);
        if !matches!(status, Some("Merged" | "Done")) || (!ship && post(b)) {
            continue;
        }
        let num = display(&km["run"]["nodes"][bk]["pr"]);
        if num == "-" {
            if !ship || want == "Done" && status == Some("Merged") {
                failures.push(format!("{bk}: no pr in the run row"));
            }
            continue;
        }
        let info = gh(dir, &num, "state,mergeCommit")?;
        let oid = info["mergeCommit"]["oid"].as_str();
        if (!ship || want == "Done") && (info["state"] != "MERGED" || !ship && oid.is_none()) {
            failures.push(format!(
                "{bk}: PR #{num} is {}, not MERGED",
                display(&info["state"])
            ));
            continue;
        }
        if let Some(oid) = oid
            && !post(b)
        {
            if !ship
                && !git(&["merge-base", "--is-ancestor", oid, "FETCH_HEAD"])?
                    .status
                    .success()
            {
                failures.push(format!(
                    "{bk}: merge commit {} of PR #{num} is not in origin/{target}",
                    oid.chars().take(10).collect::<String>()
                ));
            }
            merges.push(oid.to_owned());
        }
    }
    let row = &km["run"]["nodes"][k];
    if ship && want == "Done" {
        if let Some(until) = row["soak_until"].as_str() {
            let time = chrono::DateTime::parse_from_rfc3339(until)
                .map_err(|e| format!("{k}: invalid soak_until '{until}': {e}"))?;
            if time.offset().local_minus_utc() != 0 {
                return Err(format!(
                    "{k}: invalid soak_until '{until}': expected UTC offset"
                ));
            }
            if time > chrono::Utc::now() {
                failures.push(format!("{k}: the soak ends at {until}"));
            }
        } else if let Some(soak) = ph["soak"].as_str().filter(|s| !s.is_empty()) {
            failures.push(format!(
                "{k}: the phase has a {soak} soak and the run row has no soak_until"
            ));
        }
    }
    if failures.is_empty() && ship && !merges.is_empty() {
        if phase.contains('/') {
            return Err("invalid phase key".into());
        }
        let record = std::fs::read(dir.join("evidence").join(format!("@full-{phase}.json")))
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok());
        let hint = format!(
            "in a clean worktree at origin/{target}: wg evidence {} @full-{phase}",
            dir.display()
        );
        let Some(r) = record else {
            failures.push(format!(
                "{k}: no repo-wide test run of phase {phase}; {hint}"
            ));
            return Ok(());
        };
        let runner = &i.config.settings()["test_runner"];
        let default = Value::Array(
            ["run", "suite", "options"]
                .into_iter()
                .filter_map(|f| runner[f].as_array())
                .flatten()
                .cloned()
                .collect(),
        );
        let cmd = p["effort"].get("test").unwrap_or(&default);
        let sha = r["sha"].as_str().unwrap_or("");
        if r["valid"] != true || &r["command"] != cmd || sha.is_empty() {
            failures.push(format!(
                "{k}: the repo-wide test run of phase {phase} is invalid; {hint}"
            ));
        } else {
            for oid in merges {
                if !git(&["merge-base", "--is-ancestor", &oid, sha])?
                    .status
                    .success()
                {
                    failures.push(format!(
                        "{k}: the repo-wide test run on {} does not hold merge commit {}; {hint}",
                        sha.chars().take(10).collect::<String>(),
                        oid.chars().take(10).collect::<String>()
                    ));
                    break;
                }
            }
            if r["exit"] != 0
                && !row["tests_accepted"]
                    .as_str()
                    .and_then(|s| s.strip_prefix(&format!("{sha}:")))
                    .is_some_and(|s| !s.trim().is_empty())
            {
                failures.push(format!("{k}: the repo-wide test run on {} failed (exit {}): read {}; then a fix, or wg run set … {k} \"tests_accepted={sha}:<reason>\"",sha.chars().take(10).collect::<String>(),display(&r["exit"]),display(&r["log"])));
            }
        }
    } else if !ship && failures.is_empty() {
        notes.push(format!("All pre-merge PRs are merged to `{target}`."));
    }
    Ok(())
}

pub(super) fn move_node(
    ctx: Workflow<'_>,
    k: &str,
    want: &str,
    note: Option<&str>,
    force: Option<&str>,
    keep: bool,
) -> Result<(), String> {
    let Workflow {
        dir,
        installation: i,
        plan: p,
        ..
    } = ctx;
    let human = human(i);
    let wait = format!("Needs {human}");
    if !matches!(
        want,
        "Triage"
            | "Backlog"
            | "Todo"
            | "Ready"
            | "In Progress"
            | "In Review"
            | "Ready to Merge"
            | "Merged"
            | "Verifying"
            | "Done"
            | "Canceled"
    ) && want != wait
    {
        return Err(format!("unknown status {want}"));
    }
    if force.is_some_and(|s| s.trim().is_empty()) {
        return Err("--force needs the reason".into());
    }
    let n = node(p, k)?;
    let eng = n["eng"].is_string();
    let state = if eng {
        match want {
            "Todo" | "Ready" => Some("Ready for Eng"),
            "In Progress" => Some("In Dev"),
            "Ready to Merge" | "In Review" => Some("In Review"),
            "Merged" => Some("Ready for Deploy"),
            "Done" | "Canceled" => Some(want),
            s if s == wait => None,
            _ => return Err(format!("no ENG status for {want}: ask {human}")),
        }
    } else {
        Some(want)
    };
    let km = keymap(dir)?;
    let entry = &km["nodes"][k];
    let ident = entry["identifier"]
        .as_str()
        .ok_or_else(|| format!("{k}: not loaded"))?;
    let scope = workspace(i, p)?;
    let require = || -> Result<(), String> {
        if let Some(c) = current_claims(i, p, &km)? {
            let held = c["claims"]
                .as_array()
                .and_then(|a| a.iter().find(|v| v["node"] == k))
                .ok_or_else(|| format!("{k}: no claim"))?;
            if held["mine"] != true {
                return Err(format!(
                    "{k}: {} holds this node now",
                    display(&held["holder"])
                ));
            }
            crate::page::update_claim(i, scope, &km["collab"], k, Some(&held["job"]))?;
        }
        Ok(())
    };
    if want == "Ready to Merge" && n["kind"] == "task" {
        require()?;
    }
    if want == wait
        && let Some(c) = current_claims(i, p, &km)?
    {
        let mut runner = if c["role"] != "owner"
            && matches!(
                n["kind"].as_str(),
                Some("merge-point" | "ship-point" | "decision" | "ops")
            ) {
            Some("the owner")
        } else {
            None
        };
        if let Some(held) = c["claims"]
            .as_array()
            .and_then(|a| a.iter().find(|v| v["node"] == k && v["mine"] != true))
        {
            runner = held["holder"].as_str();
        }
        if let Some(r) = runner {
            return Err(format!("{k}: {r} runs this node and sets its wait status"));
        }
    }
    let snap = snapshot(i, p, &json!({"nodes":{(k):entry}}))?;
    let id = entry["id"].as_str().ok_or("missing issue id")?;
    let issue = snap
        .live
        .get(id)
        .ok_or_else(|| format!("{ident}: issue not found"))?;
    let old = &snap.statuses[k];
    if want == "Merged"
        && n["kind"] == "task"
        && !matches!(old.as_str(), "Done" | "Merged" | "Canceled")
    {
        require()?;
    }
    let mut notes = vec![];
    if force.is_none() {
        let (fail, msg) = guard(ctx, &km, n, want, note, issue)?;
        if !fail.is_empty() {
            for f in fail {
                println!("FAIL {f}");
            }
            return Err(format!("{ident}: not moved to {want}"));
        }
        notes = msg;
    }
    let mut linear = client(i, p)?;
    let mut fields = json!({});
    if let Some(state) = state
        && issue["state"]["name"] != state
    {
        let r = linear.request(
            "query($id:String!){team(id:$id){states(first:50){nodes{id name}}}}",
            json!({"id":issue["team"]["id"]}),
        )?;
        fields["stateId"] = r["team"]["states"]["nodes"]
            .as_array()
            .and_then(|a| a.iter().find(|v| v["name"] == state))
            .and_then(|v| v["id"].as_str())
            .ok_or_else(|| format!("{ident}: workflow has no status {state}"))?
            .into();
    }
    let wait_label = format!(
        "needs-{}",
        human
            .to_lowercase()
            .split(|c: char| !c.is_ascii_alphanumeric())
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("-")
    );
    let marker = if !eng {
        None
    } else if want == wait {
        Some(wait_label.as_str())
    } else if want == "Ready to Merge" {
        Some("ready-to-merge")
    } else {
        None
    };
    let labels = issue["labels"]["nodes"]
        .as_array()
        .ok_or("missing labels")?;
    if let Some(m) = marker
        && !labels.iter().any(|l| l["name"] == m)
    {
        let groups=linear.pages("query($names:[String!],$after:String){issueLabels(first:100,after:$after,filter:{name:{in:$names}}){nodes{id name team{id}} pageInfo{hasNextPage endCursor}}}",json!({"names":[m]}),"/issueLabels")?;
        let id = if let Some(v) = groups
            .iter()
            .find(|v| v["name"] == m && v["team"].is_null())
        {
            v["id"].clone()
        } else {
            linear.request(
                "mutation($i:IssueLabelCreateInput!){issueLabelCreate(input:$i){issueLabel{id}}}",
                json!({"i":{"name":m}}),
            )?["issueLabelCreate"]["issueLabel"]["id"]
                .clone()
        };
        if !id.is_string() {
            return Err("missing marker label id".into());
        }
        fields["addedLabelIds"] = json!([id]);
    }
    let stale = labels
        .iter()
        .filter(|v| {
            v["name"] == "answered"
                || (v["name"] == "ready-to-merge" || v["name"] == wait_label)
                    && v["name"].as_str() != marker
        })
        .map(|v| v["id"].clone())
        .collect::<Vec<_>>();
    if !stale.is_empty() {
        fields["removedLabelIds"] = stale.into();
    }
    if issue["archivedAt"].is_string()
        && !matches!(want, "Done" | "Canceled")
        && linear.request(
            "mutation($id:String!){issueUnarchive(id:$id){success}}",
            json!({"id":id}),
        )?["issueUnarchive"]["success"]
            != true
    {
        return Err(format!("could not unarchive {ident}"));
    }
    if fields != json!({})
        && linear.request(
            "mutation($id:String!,$i:IssueUpdateInput!){issueUpdate(id:$id,input:$i){success}}",
            json!({"id":id,"i":fields}),
        )?["issueUpdate"]["success"]
            != true
    {
        return Err(format!("could not update issue {id}"));
    }
    {
        let _lock = PlanLock::acquire(dir, None).map_err(|e| e.to_string())?;
        if let Err(e) = crate::local::record_status(dir, ctx.command, &km["run"], k, old, want) {
            eprintln!("warn: journal: {e}");
        }
    }
    let before = if labels.iter().any(|l| l["name"] == wait_label) {
        &wait
    } else if labels.iter().any(|l| l["name"] == "ready-to-merge") {
        "Ready to Merge"
    } else {
        issue["state"]["name"].as_str().unwrap_or("?")
    };
    println!(
        "{ident}: {before} -> {}",
        state
            .into_iter()
            .chain(marker)
            .collect::<Vec<_>>()
            .join(" + ")
    );
    if matches!(want, "Merged" | "Done" | "Canceled")
        && super::shared(&km)
        && let Err(e) = crate::page::update_claim(i, scope, &km["collab"], k, None)
    {
        eprintln!("warn {k}: could not release claim: {e}");
    }
    if want == wait {
        let base = std::env::var("WG_UI_URL")
            .ok()
            .or_else(|| {
                i.workspaces()
                    .iter()
                    .find(|w| w["id"] == scope)
                    .and_then(|w| w["page_url"].as_str())
                    .or(i.config.settings()["page_url"].as_str())
                    .map(str::to_owned)
            })
            .unwrap_or_else(|| "http://127.0.0.1:4747".into());
        let mut q = url::form_urlencoded::Serializer::new(String::new());
        q.append_pair("project", &display(&p["effort"]["name"]));
        if i.workspaces().first().is_some_and(|w| w["id"] != scope) {
            q.append_pair("workspace", scope);
        }
        q.append_pair("issue", ident);
        println!(
            "page {}/?{}",
            base.trim_end_matches('/'),
            q.finish().replace('+', "%20")
        );
    }
    if let Some(s) = note.map(str::trim).filter(|s| !s.is_empty()) {
        notes.insert(
            0,
            format!(
                "{}: {s}",
                match n["kind"].as_str() {
                    Some("ops") => "Evidence",
                    Some("decision") => "Answer",
                    _ => "Note",
                }
            ),
        );
    }
    if let Some(s) = force {
        notes.push(format!(
            "Moved to {want} with `--force`, without the `wg` check: {}",
            s.trim()
        ));
    }
    if !notes.is_empty() {
        comment(&mut linear, &entry["id"], &notes.join("\n\n"))?;
    }
    if want == "Done" && n["kind"] == "ship-point" {
        let all = snapshot(i, p, &km)?;
        for task in p["nodes"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|b| b["kind"] == "task" && display(&b["phase"]) == display(&n["phase"]))
        {
            let key = task["key"].as_str().ok_or("missing key")?;
            if all.statuses.get(key).is_some_and(|v| v == "Merged")
                && let Err(e) = move_node(ctx, key, "Done", None, None, false)
            {
                eprintln!(
                    "{key}: stays Merged; move it with wg move after you fix the cause ({e})"
                );
            }
        }
    }
    if matches!(want, "Merged" | "Done" | "Canceled" | "In Review") {
        sync_ready(dir, i, p, ctx.command);
    }
    if !keep && matches!(want, "Merged" | "Done") {
        super::cleanup_worktrees(dir, i, p, Some((k, want)), false);
    }
    if matches!(want, "Done" | "Canceled")
        && let Err(e) = archive(&mut linear, true, false)
    {
        eprintln!("warn: archive of settled issues failed: {e}");
    }
    Ok(())
}
