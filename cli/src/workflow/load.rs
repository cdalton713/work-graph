use super::command::{display, ordered};
use super::*;
use crate::{
    local,
    providers::LinearCards,
    state::{PlanLock, load_keymap},
};
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, path::Path};

fn string<'a>(v: &'a Value, f: &str) -> Result<&'a str, String> {
    v[f].as_str().ok_or_else(|| format!("missing {f}"))
}
fn rows<'a>(v: &'a Value, f: &str) -> Result<&'a Vec<Value>, String> {
    v[f].as_array().ok_or_else(|| format!("missing {f}"))
}
fn named(v: &[Value]) -> Result<BTreeMap<String, Value>, String> {
    v.iter()
        .map(|r| Ok((string(r, "name")?.into(), json!(string(r, "id")?))))
        .collect()
}
fn project_rows(
    l: &mut Linear,
    id: &Value,
    collection: &str,
    fields: &str,
) -> Result<Vec<Value>, String> {
    let doc = format!(
        "query($id:String!,$after:String){{project(id:$id){{{collection}(first:100,after:$after,includeArchived:true){{nodes{{{fields}}} pageInfo{{hasNextPage endCursor}}}}}}}}"
    );
    l.pages(&doc, json!({"id":id}), &format!("/project/{collection}"))
}
fn find_issue(l: &mut Linear, id: &str) -> Result<Option<Value>, String> {
    let (team, num) = id.rsplit_once('-').ok_or("invalid issue identifier")?;
    let n = num.parse::<u64>().map_err(|e| e.to_string())?;
    let result=l.request("query($team:String!,$number:Float!){issues(first:1,includeArchived:true,filter:{team:{key:{eq:$team}},number:{eq:$number}}){nodes{id identifier title project{id} projectMilestone{id} team{id}}}}",json!({"team":team,"number":n}))?;
    Ok(rows(&result["issues"], "nodes")?.first().cloned())
}
fn external(n: &Value) -> Option<&str> {
    n["eng"].as_str().or(n["issue"].as_str())
}
fn mapped(issue: &Value) -> Result<Value, String> {
    Ok(json!({"id":string(issue,"id")?, "identifier":string(issue,"identifier")?}))
}

fn adopt(
    l: &mut Linear,
    plan: &Value,
    km: &mut Value,
    p: &Value,
    team: &Value,
    lock: &PlanLock,
) -> Result<(), String> {
    let phases = named(&project_rows(l, &p["id"], "projectMilestones", "id name")?)?;
    let issues = project_rows(l, &p["id"], "issues", "id identifier description title")?;
    let nodes = rows(plan, "nodes")?;
    km["project"] = json!({"id":p["id"],"url":p["url"]});
    km["milestones"] = json!({});
    for ph in rows(plan, "phases")? {
        if let Some(id) = phases.get(string(ph, "name")?) {
            km["milestones"][display(&ph["key"])] = id.clone();
        }
    }
    let mut known = BTreeMap::new();
    let mut used = BTreeSet::new();
    let mut titles = BTreeMap::<&str, usize>::new();
    for n in nodes {
        let k = string(n, "key")?;
        let issue = if let Some(id) = external(n) {
            find_issue(l, id)?
        } else {
            let marker = format!("work-graph node `{k}`");
            let mut hits = issues.iter().filter(|i| {
                i["description"]
                    .as_str()
                    .is_some_and(|s| s.contains(&marker))
            });
            let hit = hits.next().cloned();
            if hits.next().is_some() {
                return Err(format!(
                    "more than one issue has the work-graph marker for {k}"
                ));
            }
            hit
        };
        if let Some(i) = issue {
            if n["issue"].is_string() && &i["team"]["id"] != team {
                return Err(format!(
                    "{}: issue is not in team {}",
                    display(&n["issue"]),
                    display(&plan["effort"]["team"])
                ));
            }
            used.insert(string(&i, "id")?.to_owned());
            known.insert(k, i);
        } else if external(n).is_none() {
            *titles.entry(string(n, "title")?).or_default() += 1;
        }
    }
    km["nodes"] = json!({});
    for n in nodes {
        let k = string(n, "key")?;
        let title = string(n, "title")?;
        let mut by_title = false;
        let mut issue = known.get(k);
        if issue.is_none() && external(n).is_none() && titles.get(title) == Some(&1) {
            let mut hits = issues.iter().filter(|i| {
                i["title"] == title && i["id"].as_str().is_some_and(|id| !used.contains(id))
            });
            let hit = hits.next();
            if hits.next().is_none() {
                issue = hit;
                by_title = hit.is_some();
            }
        }
        let Some(i) = issue else {
            println!("unmapped {k}");
            continue;
        };
        used.insert(string(i, "id")?.to_owned());
        let mut entry = mapped(i)?;
        let comments=l.pages("query($id:String!,$after:String){issue(id:$id){comments(first:50,after:$after){nodes{id body} pageInfo{hasNextPage endCursor}}}}",json!({"id":i["id"]}),"/issue/comments")?;
        for c in comments {
            if let Some(body)=c["body"].as_str() && body.starts_with(&format!("**work-graph node card** `{k}` ·")) && (body.ends_with("No acceptance or files in plan.json.") || body.ends_with("Generated from plan.json by `wg load`. Change plan.json, not this comment.")){
                entry["card"]=json!({"id":string(&c,"id")?,"sha":format!("{:x}",Sha256::digest(body.as_bytes()))});break;
            }
        }
        km["nodes"][k] = entry;
        println!(
            "adopted {k} -> {}{}",
            display(&i["identifier"]),
            if by_title { " (by title)" } else { "" }
        );
    }
    lock.save_keymap(km).map_err(|e| e.to_string())
}

fn relations(
    l: &mut Linear,
    km: &Value,
    plan: &Value,
    live: &BTreeMap<String, Value>,
    apply: bool,
    prune: bool,
) -> Result<(), String> {
    let mut wanted = BTreeSet::new();
    let mut have = BTreeMap::new();
    let mut identifiers = BTreeMap::new();
    for n in km["nodes"].as_object().ok_or("invalid mappings")?.values() {
        identifiers.insert(string(n, "id")?, string(n, "identifier")?);
    }
    for e in rows(plan, "edges")? {
        let from = &km["nodes"][string(e, "from")?];
        let to = &km["nodes"][string(e, "to")?];
        if let (Some(a), Some(b)) = (to["id"].as_str(), from["id"].as_str()) {
            wanted.insert((a.to_owned(), b.to_owned()));
        }
    }
    for (id, i) in live {
        let mut page = i["relations"].clone();
        let mut seen = BTreeSet::new();
        loop {
            for r in rows(&page, "nodes")? {
                let to = string(&r["relatedIssue"], "id")?;
                if r["type"] == "blocks" && identifiers.contains_key(to) {
                    have.insert((id.clone(), to.to_owned()), string(r, "id")?.to_owned());
                }
            }
            if page["pageInfo"]["hasNextPage"] != true {
                break;
            }
            let after = string(&page["pageInfo"], "endCursor")?.to_owned();
            if !seen.insert(after.clone()) {
                return Err("repeated relation end cursor".into());
            }
            page=l.request("query($id:String!,$after:String){issue(id:$id){relations(first:50,after:$after,includeArchived:true){nodes{id type relatedIssue{id}} pageInfo{hasNextPage endCursor}}}}",json!({"id":id,"after":after}))?["issue"]["relations"].clone();
        }
    }
    for pair in &wanted {
        if have.contains_key(pair) {
            continue;
        }
        let (a, b) = pair;
        println!(
            "relation {} blocks {}: {}",
            identifiers[a.as_str()],
            identifiers[b.as_str()],
            if apply { "created" } else { "missing" }
        );
        if apply {
            let r = l.request(
                "mutation($i:IssueRelationCreateInput!){issueRelationCreate(input:$i){success}}",
                json!({"i":{"issueId":a,"relatedIssueId":b,"type":"blocks"}}),
            )?;
            if r["issueRelationCreate"]["success"] != true {
                return Err("could not create relation".into());
            }
        }
    }
    for (pair, id) in have {
        if wanted.contains(&pair) {
            continue;
        }
        let (a, b) = pair;
        println!(
            "relation {} blocks {}: not in plan.json{}",
            identifiers[a.as_str()],
            identifiers[b.as_str()],
            if apply && prune { " (deleted)" } else { "" }
        );
        if apply
            && prune
            && l.request(
                "mutation($id:String!){issueRelationDelete(id:$id){success}}",
                json!({"id":id}),
            )?["issueRelationDelete"]["success"]
                != true
        {
            return Err("could not delete relation".into());
        }
    }
    Ok(())
}

pub(super) fn load(
    dir: &Path,
    installation: &Installation,
    plan: &Value,
    apply: bool,
    prune: bool,
    adopting: bool,
) -> Result<(), String> {
    let lock = PlanLock::acquire(dir, None).map_err(|e| e.to_string())?;
    let cfg = installation
        .config
        .report(None)
        .map_err(|e| e.to_string())?;
    if !local::check_plan(plan, &cfg) {
        return Err("plan.json fails check; fix it first".into());
    }
    let mut km = load_keymap(dir).map_err(|e| e.to_string())?;
    if km["run"]["effort"].is_null() {
        km["run"]["effort"] = json!({});
    }
    if km["run"]["nodes"].is_null() {
        km["run"]["nodes"] = json!({});
    }
    let mut previous = km.clone();
    let mut save = |km: &Value| -> Result<(), String> {
        lock.save_keymap(km).map_err(|e| e.to_string())?;
        super::journal(dir, "load --apply", &previous, km);
        previous = km.clone();
        Ok(())
    };
    let shared = apply && km["collab"].is_object();
    let plan_sha = || {
        std::fs::read(dir.join("plan.json"))
            .map(|b| format!("{:x}", Sha256::digest(b)))
            .map_err(|e| e.to_string())
    };
    let sha = if shared {
        let sha = plan_sha()?;
        if installation
            .config
            .load_plan(dir)
            .map_err(|e| e.to_string())?
            != *plan
        {
            return Err(
                "plan.json changed during wg load; check the change and run wg load --apply again"
                    .into(),
            );
        }
        Some(sha)
    } else {
        None
    };
    let mut linear = client(installation, plan)?;
    let eff = &plan["effort"];
    let nodes = rows(plan, "nodes")?;
    let mut changes = Vec::new();
    let known_keys: BTreeSet<_> = nodes
        .iter()
        .map(|n| string(n, "key"))
        .collect::<Result<_, _>>()?;
    let orphans: BTreeSet<_> = [&km["nodes"], &km["run"]["nodes"]]
        .into_iter()
        .filter_map(Value::as_object)
        .flat_map(|o| o.keys())
        .filter(|k| !known_keys.contains(k.as_str()))
        .cloned()
        .collect();
    for k in &orphans {
        changes.push(format!(
            "orphan {k} -> {}",
            display(&km["nodes"][k]["identifier"])
        ));
    }
    let teams=linear.request("query($k:String!){teams(filter:{key:{eq:$k}}){nodes{id states(first:50){nodes{id name}}}}}",json!({"k":eff["team"]}))?;
    let team = rows(&teams["teams"], "nodes")?
        .first()
        .ok_or_else(|| format!("team {} not found", display(&eff["team"])))?;
    let tid = &team["id"];
    let states = named(rows(&team["states"], "nodes")?)?;
    let mut labels=named(&linear.pages("query($id:String!,$after:String){team(id:$id){labels(first:100,after:$after){nodes{id name} pageInfo{hasNextPage endCursor}}}}",json!({"id":tid}),"/team/labels")?)?;
    let existing = km["project"].is_object();
    if existing && adopting {
        return Err("--adopt requires a keymap.json with no project".into());
    }
    if !existing {
        let name = string(eff, "name")?;
        let found=linear.request("query($id:String!,$name:String!){team(id:$id){projects(first:2,includeArchived:true,filter:{name:{eq:$name}}){nodes{id name url}}}}",json!({"id":tid,"name":name}))?;
        let mut matches = rows(&found["team"]["projects"], "nodes")?
            .iter()
            .filter(|i| i["name"] == name);
        let project = matches.next();
        if matches.next().is_some() {
            return Err(format!("more than one project is named '{name}'"));
        }
        if adopting {
            let before = km.clone();
            adopt(
                &mut linear,
                plan,
                &mut km,
                project.ok_or_else(|| {
                    format!(
                        "project '{name}' not found in team {}",
                        display(&eff["team"])
                    )
                })?,
                tid,
                &lock,
            )?;
            super::journal(dir, "load", &before, &km);
            return Ok(());
        }
        if let Some(p) = project {
            return Err(format!(
                "project '{name}' exists: {}. Run 'wg load {} --adopt' to rebuild keymap.json.",
                display(&p["url"]),
                dir.display()
            ));
        }
        changes.push(format!("create project '{name}'"));
        if apply {
            let desc = eff["summary"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| {
                    format!("work-graph effort {}", eff["slug"].as_str().unwrap_or(""))
                });
            let r=linear.request("mutation($i:ProjectCreateInput!){projectCreate(input:$i){project{id url}}}",json!({"i":{"name":name,"teamIds":[tid],"description":desc.chars().take(255).collect::<String>()}}))?;
            let project = &r["projectCreate"]["project"];
            string(project, "id")?;
            km["project"] = project.clone();
            save(&km)?;
        }
    }
    if !shared {
        super::settings::coordinator(
            dir,
            string(eff, "name")?,
            installation.config.settings(),
            apply,
            &mut changes,
        );
    }
    let pid = km["project"]["id"].clone();
    if let Some(name) = eff["initiative"].as_str().filter(|s| !s.trim().is_empty()) {
        let scope = workspace(installation, plan)?;
        let scoped = installation
            .workspaces()
            .iter()
            .find(|w| w["id"] == scope)
            .is_none_or(|w| w["team_labels"] != false);
        initiative(
            &mut linear,
            name.trim(),
            tid,
            &pid,
            scoped,
            apply,
            &mut changes,
        )?;
    }
    let mut conflicts = BTreeSet::new();
    if existing
        && nodes.iter().any(|n| {
            km["nodes"][n["key"].as_str().unwrap_or("")].is_null() && external(n).is_none()
        })
    {
        let known: BTreeSet<_> = km["nodes"]
            .as_object()
            .ok_or("invalid mappings")?
            .values()
            .filter_map(|v| v["id"].as_str())
            .collect();
        let issues = project_rows(&mut linear, &pid, "issues", "id identifier title")?;
        for n in nodes {
            let k = string(n, "key")?;
            if !km["nodes"][k].is_null() || external(n).is_some() {
                continue;
            }
            for i in issues.iter().filter(|i| {
                i["title"] == n["title"] && !known.contains(i["id"].as_str().unwrap_or(""))
            }) {
                let ident = string(i, "identifier")?;
                conflicts.insert(k);
                changes.push(format!(
                    "conflict {k}: {ident} has this title; set \"issue\": \"{ident}\" in plan.json"
                ));
            }
        }
        if apply && !conflicts.is_empty() {
            println!("{}", changes.join("\n"));
            return Err("unmapped issue conflicts".into());
        }
    }
    for ph in rows(plan, "phases")? {
        let phase = display(&ph["key"]);
        if !km["milestones"][&phase].is_null() {
            continue;
        }
        let name = string(ph, "name")?;
        changes.push(format!("create milestone '{name}'"));
        if apply {
            let mut desc = format!(
                "target {} · ship to {}",
                ph["target"].as_str().unwrap_or("main"),
                ph["ship_env"].as_str().unwrap_or("?")
            );
            if let Some(soak) = ph["soak"].as_str() {
                desc.push_str(&format!(" · soak {soak}"));
            }
            let r=linear.request("mutation($i:ProjectMilestoneCreateInput!){projectMilestoneCreate(input:$i){projectMilestone{id}}}",json!({"i":{"name":name,"projectId":pid,"description":desc}}))?;
            km["milestones"][phase] =
                string(&r["projectMilestoneCreate"]["projectMilestone"], "id")?.into();
            save(&km)?;
        }
    }
    let kinds: BTreeSet<_> = nodes
        .iter()
        .filter_map(|n| n["kind"].as_str())
        .filter(|k| *k != "task")
        .chain(["reviewed"])
        .collect();
    for label in kinds {
        if labels.contains_key(label) {
            continue;
        }
        changes.push(format!("create label '{label}'"));
        if apply {
            let r = linear.request(
                "mutation($i:IssueLabelCreateInput!){issueLabelCreate(input:$i){issueLabel{id}}}",
                json!({"i":{"name":label,"teamId":tid}}),
            )?;
            labels.insert(
                label.into(),
                string(&r["issueLabelCreate"]["issueLabel"], "id")?.into(),
            );
        }
    }
    let me = if apply {
        let r = linear.request("{viewer{id}}", json!({}))?;
        json!(string(&r["viewer"], "id")?)
    } else {
        Value::Null
    };
    let live = if km["nodes"].as_object().is_some_and(|m| !m.is_empty()) {
        snapshot(installation, plan, &km)?.live
    } else {
        BTreeMap::new()
    };
    for n in nodes {
        let k = string(n, "key")?;
        if conflicts.contains(k) {
            continue;
        }
        let kind = string(n, "kind")?;
        let mut issue = km["nodes"][k]["id"]
            .as_str()
            .and_then(|id| live.get(id))
            .cloned();
        if km["nodes"][k].is_null()
            && let Some(id) = external(n)
        {
            changes.push(format!("map {k} -> existing {id}"));
            if apply || n["issue"].is_string() {
                let i =
                    find_issue(&mut linear, id)?.ok_or_else(|| format!("{id}: issue not found"))?;
                if n["issue"].is_string() && i["team"]["id"] != *tid {
                    return Err(format!(
                        "{id}: issue is not in team {}",
                        display(&eff["team"])
                    ));
                }
                if apply {
                    km["nodes"][k] = mapped(&i)?;
                    save(&km)?;
                }
                issue = Some(i);
            }
        }
        let mid = &km["milestones"][display(&n["phase"])];
        if let Some(i) = issue
            && n["eng"].is_null()
        {
            let mut update = json!({});
            for (label, f, want, actual) in [
                ("project", "projectId", &pid, &i["project"]["id"]),
                ("title", "title", &n["title"], &i["title"]),
                (
                    "milestone",
                    "projectMilestoneId",
                    mid,
                    &i["projectMilestone"]["id"],
                ),
            ] {
                if label == "project" && n["issue"].is_null() {
                    continue;
                }
                if want != actual || want.is_null() {
                    changes.push(format!("update {k}: {label}"));
                    update[f] = want.clone();
                }
            }
            if apply && update!=json!({}) && linear.request("mutation($id:String!,$i:IssueUpdateInput!){issueUpdate(id:$id,input:$i){success}}",json!({"id":i["id"],"i":update}))?["issueUpdate"]["success"]!=true{return Err(format!("could not update issue {}",display(&i["id"])));}
        }
        if external(n).is_some() || !km["nodes"][k].is_null() {
            continue;
        }
        changes.push(format!("create {kind} {k}: {}", display(&n["title"])));
        if apply {
            let (_, card) = local::render_card(n, &Value::Null, &Value::Null);
            let marker = card
                .lines()
                .next()
                .unwrap_or("")
                .trim_start_matches("**work-graph node card** ");
            let notes = format!(
                "+++ Agent notes\n\nwork-graph node {marker}\n\nThe graph lives in plan.json; change edges there and run `wg.py load`.\n\nAcceptance and files are in the node card comment.\n\n+++"
            );
            let desc = n["description"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map_or(notes.clone(), |d| format!("{d}\n\n{notes}"));
            let mut input = json!({"teamId":tid,"title":n["title"],"description":desc,"stateId":states.get("Todo").ok_or("missing Todo state")?,"projectId":pid,"projectMilestoneId":mid,"assigneeId":me,"priority":n["priority"].as_i64().unwrap_or(3)});
            if kind != "task" {
                input["labelIds"] = json!([labels.get(kind).ok_or("missing kind label")?]);
            }
            let r = linear.request(
                "mutation($i:IssueCreateInput!){issueCreate(input:$i){issue{id identifier}}}",
                json!({"i":input}),
            )?;
            km["nodes"][k] = mapped(&r["issueCreate"]["issue"])?;
            save(&km)?;
        }
    }
    let mut writer = LinearCards::new(workspace(installation, plan)?, &cfg);
    for n in nodes {
        let k = string(n, "key")?;
        if conflicts.contains(k) {
            continue;
        }
        let row = km["run"]["nodes"][k].clone();
        let entry = &km["nodes"][k];
        let (_, body) = local::render_card(n, entry, &row);
        if entry["card"]["sha"] == format!("{:x}", Sha256::digest(body.as_bytes())) {
            continue;
        }
        changes.push(format!(
            "card {k}: {}",
            if entry["card"].is_object() {
                "update"
            } else {
                "create"
            }
        ));
        if apply {
            local::refresh_card(n, &mut km["nodes"][k], &row, &mut writer)
                .map_err(|e| e.to_string())?;
            save(&km)?;
        }
    }
    if !apply {
        for e in rows(plan, "edges")? {
            let a = string(e, "to")?;
            let b = string(e, "from")?;
            if !conflicts.contains(a)
                && !conflicts.contains(b)
                && (km["nodes"][a].is_null() || km["nodes"][b].is_null())
            {
                changes.push(format!("relation {a} blocks {b} (after create)"));
            }
        }
    }
    let print_changes = || {
        println!(
            "{}",
            if changes.is_empty() {
                "no changes to nodes".into()
            } else {
                changes.join("\n")
            }
        )
    };
    if !apply {
        print_changes();
    }
    if km["nodes"].as_object().is_some_and(|m| !m.is_empty()) {
        let fresh = snapshot(installation, plan, &km)?;
        relations(&mut linear, &km, plan, &fresh.live, apply, prune)?;
    }
    if apply {
        if prune && !orphans.is_empty() {
            for k in orphans {
                for v in ["nodes", "run"] {
                    let rows = if v == "run" {
                        &mut km["run"]["nodes"]
                    } else {
                        &mut km["nodes"]
                    };
                    if let Some(m) = rows.as_object_mut() {
                        m.shift_remove(&k);
                    }
                }
            }
            save(&km)?;
        }
        if !shared {
            print_changes();
        }
        let fresh = if !nodes.is_empty() {
            snapshot(installation, plan, &km)?.live
        } else {
            BTreeMap::new()
        };
        let mut moved = 0;
        for (index, n) in ordered(plan)?.iter().enumerate() {
            if n["eng"].is_string() {
                continue;
            }
            let id = string(&km["nodes"][string(n, "key")?], "id")?;
            let want = (index + 1) * 1000;
            if fresh.get(id).and_then(|i| i["sortOrder"].as_f64()) != Some(want as f64) {
                let r=linear.request("mutation($id:String!,$o:Float!){issueUpdate(id:$id,input:{sortOrder:$o}){success}}",json!({"id":id,"o":want}))?;
                if r["issueUpdate"]["success"] != true {
                    return Err("could not set sort order".into());
                }
                moved += 1;
            }
        }
        println!("sort order: {moved} issue(s) updated");
        if let Some(sha) = sha {
            if plan_sha()? != sha {
                return Err("plan.json changed during wg load; check the change and run wg load --apply again".into());
            }
            crate::page::publish_load(
                installation,
                workspace(installation, plan)?,
                &lock,
                plan,
                &mut km,
                &sha,
            )?;
            super::settings::coordinator(
                dir,
                string(eff, "name")?,
                installation.config.settings(),
                apply,
                &mut changes,
            );
            println!(
                "{}",
                if changes.is_empty() {
                    "no changes to nodes".into()
                } else {
                    changes.join("\n")
                }
            );
        }
    }
    Ok(())
}

fn project_labels(l: &mut Linear, scope: &Value) -> Result<Vec<Value>, String> {
    let r=l.request("query($f:ProjectLabelFilter!){projectLabels(first:250,filter:$f){nodes{id name isGroup retiredAt parent{id}}}}",json!({"f":scope}))?;
    Ok(rows(&r["projectLabels"], "nodes")?.clone())
}

fn create_label(
    l: &mut Linear,
    scope: &Value,
    body: Value,
    matches: impl Fn(&Value) -> bool,
) -> Result<Value, String> {
    match l.request(
        "mutation($i:ProjectLabelCreateInput!){projectLabelCreate(input:$i){projectLabel{id}}}",
        json!({"i":body}),
    ) {
        Ok(r) => Ok(json!({"id":string(&r["projectLabelCreate"]["projectLabel"],"id")?})),
        Err(e) if e.contains("duplicate label name") => {
            for _ in 0..10 {
                std::thread::sleep(std::time::Duration::from_secs(1));
                if let Some(hit) = project_labels(l, scope)?.into_iter().find(&matches) {
                    return Ok(hit);
                }
            }
            Err(e)
        }
        Err(e) => Err(e),
    }
}

fn initiative(
    l: &mut Linear,
    name: &str,
    tid: &Value,
    pid: &Value,
    scoped: bool,
    apply: bool,
    changes: &mut Vec<String>,
) -> Result<(), String> {
    let scope = if scoped {
        json!({"team":{"id":{"eq":tid}}})
    } else {
        json!({"team":{"null":true}})
    };
    let found = project_labels(l, &scope)?;
    let is_group = |v: &Value| {
        v["isGroup"] == true
            && v["name"]
                .as_str()
                .is_some_and(|s| s.eq_ignore_ascii_case("initiative"))
    };
    let mut group = found.iter().find(|v| is_group(v)).cloned();
    let mut child = group
        .as_ref()
        .and_then(|g| {
            found
                .iter()
                .find(|v| v["parent"]["id"] == g["id"] && v["name"] == name)
        })
        .cloned();
    if group.as_ref().is_some_and(|g| g["retiredAt"].is_string()) {
        return Err("the project label group 'initiative' is retired; restore it in Linear".into());
    }
    if child.as_ref().is_some_and(|v| v["retiredAt"].is_string()) {
        return Err(format!(
            "the initiative label '{name}' is retired; restore it in Linear or name another initiative"
        ));
    }
    if group.is_none() {
        changes.push("create project label group 'initiative'".into());
        if apply {
            let mut input = json!({"name":"initiative","isGroup":true,"groupType":"singleSelect","description":"work-graph: the initiative of each project. Each child label is one initiative."});
            if scoped {
                input["teamId"] = tid.clone();
            }
            group = Some(create_label(l, &scope, input, is_group)?);
        }
    }
    if child.is_none() {
        let mut known: Vec<_> = found
            .iter()
            .filter(|v| {
                group.as_ref().is_some_and(|g| g["id"] == v["parent"]["id"])
                    && v["retiredAt"].is_null()
            })
            .map(|v| display(&v["name"]))
            .collect();
        known.sort();
        changes.push(format!(
            "create initiative '{name}'{}",
            if known.is_empty() {
                String::new()
            } else {
                format!(" (existing: {})", known.join(", "))
            }
        ));
        if let Some(ref g) = group
            && apply
        {
            let mut input = json!({"name":name,"parentId":g["id"]});
            if scoped {
                input["teamId"] = tid.clone();
            }
            child = Some(create_label(l, &scope, input, |v| {
                v["parent"]["id"] == g["id"] && v["name"] == name
            })?);
        }
    }
    let assigned = if pid.is_string() {
        let r = l.request(
            "query($id:String!){project(id:$id){labels(first:50){nodes{id name parent{id}}}}}",
            json!({"id":pid}),
        )?;
        rows(&r["project"]["labels"], "nodes")?.clone()
    } else {
        vec![]
    };
    let stale: Vec<_> = assigned
        .iter()
        .filter(|v| {
            group.as_ref().is_some_and(|g| g["id"] == v["parent"]["id"])
                && !child.as_ref().is_some_and(|c| c["id"] == v["id"])
        })
        .collect();
    if stale.is_empty()
        && child
            .as_ref()
            .is_some_and(|c| assigned.iter().any(|v| v["id"] == c["id"]))
    {
        return Ok(());
    }
    let previous = stale
        .iter()
        .map(|v| format!(" (was '{}')", display(&v["name"])))
        .collect::<String>();
    changes.push(format!("set initiative '{name}'{previous}"));
    if apply {
        for v in stale {
            let r = l.request(
                "mutation($id:String!,$l:String!){projectRemoveLabel(id:$id,labelId:$l){success}}",
                json!({"id":pid,"l":v["id"]}),
            )?;
            if r["projectRemoveLabel"]["success"] != true {
                return Err("could not remove project label".into());
            }
        }
        let child = child.ok_or("missing initiative label")?;
        let r = l.request(
            "mutation($id:String!,$l:String!){projectAddLabel(id:$id,labelId:$l){success}}",
            json!({"id":pid,"l":child["id"]}),
        )?;
        if r["projectAddLabel"]["success"] != true {
            return Err("could not add project label".into());
        }
    }
    Ok(())
}
