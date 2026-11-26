use super::lifecycle::{Context, field, held, receipt, record};
use super::*;
use crate::workflow::Snapshot;
use serde_json::json;
use std::{fs, io::Write};

#[derive(clap::Args)]
pub(super) struct Agent {
    #[arg(long,value_parser=["codex","claude"])]
    agent: Option<String>,
    #[arg(long)]
    model: Option<String>,
    #[arg(long)]
    effort: Option<String>,
}
impl Agent {
    fn settings(&self, ctx: &Context, row: &Value) -> Result<Value, String> {
        let mut s = json!({"agent":"codex"});
        let flags = json!({"agent":self.agent,"model":self.model,"effort":self.effort});
        let sources = if row["dispatch"].is_string() || row["agent"].is_string() {
            vec![row, &flags]
        } else {
            vec![
                &ctx.install.config.settings()["agents"]["worker"],
                &ctx.plan["effort"]["agents"]["worker"],
                &flags,
            ]
        };
        for src in sources {
            if src["agent"].is_string() && src["agent"] != s["agent"] {
                s = json!({});
            }
            for f in ["agent", "model", "effort"] {
                if let Some(v) = src[f].as_str() {
                    if v.is_empty()
                        || v.starts_with('-')
                        || v.chars().any(|c| c.is_whitespace() || c.is_control())
                    {
                        return Err(format!("invalid agent {f}"));
                    }
                    s[f] = v.into();
                }
            }
        }
        if s["effort"].is_string() && !s["model"].is_string() {
            return Err("agents.worker.effort: needs a model".into());
        }
        Ok(s)
    }
}
fn caller(flag: &str, cmd: &str) -> Result<(), String> {
    if ["ORCA_AGENT_SESSION_ID", "ORCA_TERMINAL_HANDLE"]
        .iter()
        .any(|k| std::env::var_os(k).is_some_and(|s| !s.is_empty()))
    {
        Ok(())
    } else {
        Err(format!(
            "{flag} needs an Orca terminal (ORCA_AGENT_SESSION_ID or ORCA_TERMINAL_HANDLE is not set): run wg {cmd} without {flag} to print the commands"
        ))
    }
}
fn claim_label(ctx: &Context, issue: &Value, agent: &str) -> Result<(), String> {
    let name = format!("agent:{agent}");
    if let Some(label) = held(issue)?.first() {
        return Err(format!("{} holds the claim", field(label, "name")?));
    }
    let mut after = Value::Null;
    let mut team_id = None;
    loop {
        let r=ctx.request("query($names:[String!],$after:String){issueLabels(first:100,after:$after,filter:{name:{in:$names}}){nodes{id name team{id}} pageInfo{hasNextPage endCursor}}}",json!({"names":[name],"after":after}))?;
        let page = &r["issueLabels"];
        for l in list(&page["nodes"])? {
            if l["name"] != name {
                continue;
            }
            if l["team"].is_null() {
                return ctx.labels(
                    field(issue, "id")?,
                    json!({"addedLabelIds":[field(l,"id")?]}),
                );
            }
            if l["team"]["id"] == issue["team"]["id"] {
                team_id = Some(field(l, "id")?.to_owned());
            }
        }
        if page["pageInfo"]["hasNextPage"] != true {
            break;
        }
        let next = field(&page["pageInfo"], "endCursor")?;
        if after == next {
            return Err("invalid label cursor".into());
        }
        after = next.into();
    }
    ctx.labels(field(issue,"id")?,json!({"addedLabelIds":[team_id.ok_or_else(||format!("label {name} not found (wg preflight)"))?]}))
}
pub(super) fn job_lock(ctx: &Context) -> Result<fs::File, String> {
    // PlanLock protects each keymap write. Serialize launches on the distinct spec directory.
    let specs = ctx.dir.join("specs");
    fs::create_dir_all(&specs).map_err(|e| e.to_string())?;
    let dir = fs::File::open(specs).map_err(|e| e.to_string())?;
    dir.lock().map_err(|e| e.to_string())?;
    Ok(dir)
}
fn snapshot(ctx: &Context) -> Result<(Value, Snapshot), String> {
    let km = ctx.km()?;
    let snap = crate::workflow::snapshot(ctx.install, ctx.plan, &km)?;
    Ok((km, snap))
}
fn print_started(k: &str, row: &Value, job: &str) {
    if job == "dispatch" {
        println!(
            "started {k} dispatch={} worktree={}",
            row["dispatch"].as_str().unwrap_or("-"),
            row["path"].as_str().unwrap_or("-")
        );
    } else {
        println!(
            "started {k} dispatch={} job={job}",
            row["dispatch"].as_str().unwrap_or("-")
        );
    }
}
fn pending(k: &str, row: &Value, step: &str) -> Result<(), String> {
    if row["step"] == step && !row["retry_request"].is_string() {
        return Err(format!(
            "{k}: an earlier {step} stopped with no known outcome from Orca, so a worker may run. Look for it (orca orchestration worker-list --json); record it with wg started"
        ));
    }
    Ok(())
}
fn apply_worker_settings(ctx: &Context, row: &Value) {
    let Some(agent) = row["agent"].as_str() else {
        return;
    };
    let values = &ctx.install.config.settings()["worker_settings"][agent];
    if values
        .as_object()
        .is_none_or(|settings| settings.is_empty())
    {
        return;
    }
    let path = match row["path"].as_str() {
        Some(path) => Ok(PathBuf::from(path)),
        None => field(row, "worktree").and_then(worktree::path_for_id),
    };
    let result = path.and_then(|path| {
        if !path.is_dir() {
            return Err(format!("no local worktree at {}", path.display()));
        }
        crate::workflow::write_agent_settings(&path, agent, values, true).map_err(|e| e.to_string())
    });
    if let Err(error) = result {
        eprintln!("warning: worker_settings: {error}; the worker starts without them");
    }
}
fn start_args(row: &Value, spec: &Path, title: &str) -> Result<Vec<String>, String> {
    let location = if let Some(id) = row["worktree"].as_str() {
        format!("id:{id}")
    } else {
        format!("path:{}", field(row, "path")?)
    };
    let mut args = [
        "orchestration",
        "worker-start",
        "--spec-file",
        spec.to_str().ok_or("invalid spec path")?,
        "--task-title",
        title,
        "--worktree",
        &location,
        "--agent",
        field(row, "agent")?,
        "--environment",
        "local",
    ]
    .map(str::to_owned)
    .to_vec();
    for f in ["model", "effort"] {
        if let Some(v) = row[f].as_str() {
            args.extend([format!("--{f}"), v.into()]);
        }
    }
    Ok(args)
}
fn launch(
    ctx: &Context,
    k: &str,
    cmd: &str,
    step: &str,
    row: &Value,
    mut args: Vec<String>,
) -> Result<u8, String> {
    let replay = row["retry_request"].as_str();
    pending(k, row, step)?;
    ctx.change(k, cmd, |r| {
        r["step"] = step.into();
        Ok(())
    })?;
    args.push("--json".into());
    if let Some(id) = replay {
        args.extend(["--retry-request".into(), id.into()]);
    }
    let result = worktree::orca()
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    let answer: Value = serde_json::from_slice(&result.stdout).unwrap_or(Value::Null);
    if !result.status.success() || answer["ok"] == false || !answer["result"].is_object() {
        let err = &answer["error"];
        if let Some(id) = err["data"]["recovery"]["orchestrationRequestId"].as_str() {
            ctx.change(k, cmd, |r| {
                r["retry_request"] = id.into();
                Ok(())
            })?;
        } else if replay.is_none() && answer["ok"] == false && err["code"].is_string() {
            ctx.change(k, cmd, |r| {
                r["step"] = "spec".into();
                Ok(())
            })?;
        }
        println!(
            "FAIL {step}: {}",
            err["message"]
                .as_str()
                .unwrap_or("Orca gave no confirmed result")
        );
        return Ok(1);
    }
    let r = &answer["result"];
    let dispatch = r["dispatchId"]
        .as_str()
        .or_else(|| {
            if step == "send" && row["fresh_worker"] != true {
                row["dispatch"].as_str()
            } else {
                None
            }
        })
        .ok_or("Orca gave no dispatchId")?;
    let fields = json!({"dispatch":dispatch,"task":r["taskId"].as_str().or(row["task"].as_str()),"run_id":r["runId"],"worktree":r["workspace"]});
    match record(ctx, k, cmd, &fields) {
        Ok(row) => {
            print_started(k, &row, field(&row, "job")?);
            Ok(0)
        }
        Err(e) => {
            println!("FAIL receipt: {e}");
            eprintln!(
                "worker dispatch {dispatch}; record with wg started if its receipt was not saved"
            );
            Ok(1)
        }
    }
}
fn with_dispatch_lease(
    ctx: &Context,
    km: &Value,
    key: &str,
    acquire: bool,
    dispatch: impl FnOnce() -> Result<u8, String>,
) -> Result<u8, String> {
    if !acquire || !km["collab"].is_object() {
        return dispatch();
    }
    let scope = ctx.scope()?;
    let collab = &km["collab"];
    let result =
        match crate::page::acquire_claim(ctx.install, scope, collab, key, "dispatch", false) {
            Ok(_) => dispatch(),
            Err(crate::page::PageError::Unavailable(error)) => Err(error),
            Err(crate::page::PageError::Failed(error)) => return Err(error),
        };
    if !matches!(result, Ok(0)) {
        match crate::page::update_claim(ctx.install, scope, collab, key, None) {
            Ok(()) => eprintln!("released {key}: dispatch did not complete"),
            Err(error) => eprintln!("warn {key}: could not release claim: {error}"),
        }
    }
    result
}

pub(super) fn dispatch(
    ctx: &Context,
    k: &str,
    agent: &Agent,
    path: Option<&Path>,
    run: bool,
) -> Result<u8, String> {
    if run && let Err(e) = caller("--run", "dispatch") {
        eprintln!("{e}");
        return Ok(1);
    }
    if let Err(problem) = ctx.node(k) {
        snapshot(ctx)?;
        return Err(problem);
    }
    let _lock = job_lock(ctx)?;
    let (km, snap) = snapshot(ctx)?;
    let node = ctx.node(k)?;
    if !matches!(node["kind"].as_str(), Some("task" | "spike")) || node["role"] == "integration" {
        return Err(format!("{k}: only a task or a spike gets a worker"));
    }
    let entry = &km["nodes"][k];
    let issue = snap
        .live
        .get(field(entry, "id")?)
        .ok_or("issue not found")?;
    let row = &km["run"]["nodes"][k];
    let mine =
        row["job"] == "dispatch" && matches!(row["state"].as_str(), Some("creating" | "starting"));
    if run && row["job"] == "dispatch" && row["state"] == "running" && row["step"] == "receipt" {
        ctx.lease(&km, k)?;
        print_started(k, &receipt(ctx, k, "dispatch")?, "dispatch");
        return Ok(0);
    }
    if mine
        && !run
        && row["step"] == "start"
        && let Err(e) = pending(k, row, "start")
    {
        eprintln!("{e}");
        return Ok(1);
    }
    if !run && row["retry_request"].is_string() {
        return Err(format!(
            "{k}: a worker-start request has no known result; retry --run"
        ));
    }
    let n = worktree::names(ctx, node, &km, &snap)?;
    if path.is_some() && !mine {
        return Err(format!("{k}: run wg dispatch first"));
    }
    if !mine {
        let status = snap.statuses.get(k).map(String::as_str);
        if row["state"].is_string()
            || row["branch"].is_string()
            || node["pr"].is_string()
            || node["branch"].is_string()
            || !matches!(status, Some("Todo" | "Ready"))
            || !held(issue)?.is_empty()
        {
            println!("FAIL {k}: node already claimed, started, or not ready");
            return Ok(1);
        }
        if !km["run"]["effort"]["wave"]
            .as_str()
            .unwrap_or("")
            .split(',')
            .any(|w| w == k)
        {
            println!("FAIL {k}: not in the wave");
            return Ok(1);
        }
        for edge in list(&ctx.plan["edges"])?.iter().filter(|e| e["from"] == k) {
            let b = field(edge, "to")?;
            let blocker = ctx.node(b)?;
            let complete = km["run"]["nodes"][b]["code_done_head"].is_string()
                || km["collab"].is_object()
                    && km["nodes"][b]["pr"].is_string()
                    && km["nodes"][b]["branch"].is_string();
            if !crate::local::satisfied(
                blocker,
                node,
                snap.statuses.get(b).map_or("?", String::as_str),
                complete,
            ) {
                println!("FAIL {k}: open blocker {b}");
                return Ok(1);
            }
            if worktree::below(ctx.plan, node) == Some(blocker)
                && matches!(
                    snap.statuses.get(b).map(String::as_str),
                    Some("Ready to Merge" | "In Review")
                )
                && let Some(pr) = km["run"]["nodes"][b]["pr"].as_str()
                && verify::gh(ctx.dir, &["pr", "view", pr, "--json", "headRefOid"])?["headRefOid"]
                    != km["run"]["nodes"][b]["code_done_head"]
            {
                println!("FAIL {k}: {b} has a push that is not code done");
                return Ok(1);
            }
        }
    }
    if path.is_some() {
        ctx.lease(&km, k)?;
    }
    with_dispatch_lease(ctx, &km, k, path.is_none(), || {
        if mine
            && run
            && let Err(e) = pending(k, row, "start")
        {
            eprintln!("{e}");
            return Ok(1);
        }
        if !mine {
            let settings = agent.settings(ctx, &Value::Null)?;
            ctx.change(k, "dispatch", |r| {
                let fields = json!({"state":"creating","job":"dispatch","step":"claim",
                                "branch":n.branch,"parent":n.parent,"lower":n.lower});
                let map = r.as_object_mut().ok_or("invalid run row")?;
                map.extend(fields.as_object().unwrap().clone());
                map.extend(settings.as_object().unwrap().clone());
                Ok(())
            })?;
        }
        let row = ctx.km()?["run"]["nodes"][k].clone();
        if path.is_some() && matches!(row["step"].as_str(), Some("claim" | "status")) {
            return Err("the claim is not complete; run dispatch again".into());
        }
        let label = format!("agent:{}", field(&row, "agent")?);
        let labels = held(issue)?;
        if !labels.iter().any(|l| l["name"] == label) {
            claim_label(ctx, issue, field(&row, "agent")?)?;
        }
        if snap.statuses.get(k).map(String::as_str) != Some("In Progress") {
            ctx.transition("dispatch", k, "In Progress")?;
        }
        if (!mine || matches!(row["step"].as_str(), Some("claim" | "status")))
            && let Err(error) = ctx.start_project(&km)
        {
            eprintln!("project status not updated ({error})");
        }
        ctx.refresh_card(k);
        if !run && path.is_none() {
            ctx.change(k, "dispatch", |r| {
                r.as_object_mut().unwrap().remove("step");
                Ok(())
            })?;
            let parent = quote(&n.parent);
            let branch = quote(&n.branch);
            let lower = quote(&n.lower);
            let stack = quote(&n.stack);
            let plan_dir = quote(&ctx.dir.to_string_lossy());
            println!(
                "branch {branch} on {lower}{}",
                if n.track {
                    format!(", stax parent {parent}")
                } else {
                    ", not tracked by stax".into()
                }
            );
            println!("Run these in order. Each <...> is an id or a path from Orca's output:");
            println!("  orca worktree list --json    # find the coordinator at {plan_dir}");
            if node["kind"] != "spike" {
                let stack_branch = quote(&format!(
                    "{}{}",
                    field(ctx.install.config.settings(), "branch_prefix")?,
                    n.stack
                ));
                let base = if n.lower.starts_with("origin/") {
                    lower.clone()
                } else {
                    quote(&format!("origin/{}", n.target))
                };
                println!(
                    "  orca worktree create --name {stack} --branch {stack_branch} --parent-worktree id:<core-id> --base-branch {base} --setup skip --json    # only when {stack} is missing"
                );
            }
            println!(
                "  orca worktree create --name {} --branch {branch} --base-branch {lower} --parent-worktree id:<parent-id> --setup run --json",
                quote(&n.child)
            );
            println!(
                "  orca worktree set --worktree id:<child-id> --display-name {} --json",
                quote(&n.display)
            );
            if n.track {
                println!("  (cd \"<child-path>\" && st branch track --parent {parent})");
            }
            println!(
                "  wg dispatch {plan_dir} {} --worktree \"<child-path>\"",
                quote(k)
            );
            return Ok(0);
        }
        let retry = row["retry_request"].is_string();
        if !retry {
            if let Some(path) = path {
                worktree::check(ctx, path, &n)?;
                if !worktree::tracked(path, &n) {
                    return Err("incorrect stax parent".into());
                }
                let path = path.canonicalize().map_err(|e| e.to_string())?;
                ctx.change(k, "dispatch", |r| {
                    r["path"] = json!(path);
                    Ok(())
                })?;
            } else {
                if km["collab"].is_object()
                    && let Some(below) = worktree::below(ctx.plan, node)
                    && let Some(b) = below["key"].as_str()
                    && km["nodes"][b]["branch"] == n.lower
                    && !km["run"]["nodes"][b]["branch"].is_string()
                {
                    worktree::fetch_shared_parent(ctx.dir, &n.lower)?;
                }
                worktree::prepare(ctx, k, &n)?;
            }
            ctx.change(k, "dispatch", |r| {
                r["state"] = "starting".into();
                r["step"] = "spec".into();
                Ok(())
            })?;
        }
        let row = ctx.km()?["run"]["nodes"][k].clone();
        if !retry {
            apply_worker_settings(ctx, &row);
        }
        let spec = spec(ctx, k, entry, issue, &row, None, !retry)?;
        let title = format!("{}: {}", field(entry, "identifier")?, field(node, "title")?);
        if !run {
            println!(
                "spec {}\n  orca orchestration worker-start --spec-file '{}' --worktree id:<child-id> --agent {} --json\n  wg started {} {k} dispatch=<dispatch_id> task=<task_id> worktree=<worktree id> run_id=<run_id>",
                spec.display(),
                spec.display(),
                field(&row, "agent")?,
                ctx.dir.display()
            );
            return Ok(0);
        }
        launch(
            ctx,
            k,
            "dispatch",
            "start",
            &row,
            start_args(&row, &spec, &title)?,
        )
    })
}

fn quote(s: &str) -> String {
    if !s.is_empty()
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_.:/@".contains(&c))
    {
        s.to_owned()
    } else {
        format!("'{}'", s.replace('\'', "'\"'\"'"))
    }
}
fn spec(
    ctx: &Context,
    k: &str,
    entry: &Value,
    issue: &Value,
    row: &Value,
    follow: Option<(&str, &str, &str, bool)>,
    write: bool,
) -> Result<PathBuf, String> {
    let dir = ctx.dir.canonicalize().map_err(|e| e.to_string())?;
    let folder = dir.join("specs");
    let first_path = folder.join(format!("{k}.md"));
    let path = follow.map_or_else(
        || first_path.clone(),
        |(job, ..)| folder.join(format!("{k}-{job}.md")),
    );
    if !write {
        if !path.is_file() {
            return Err("the spec of the pending request is missing".into());
        }
        return Ok(path);
    }
    let sections = include_str!("../../../skills/work-graph/references/worker-spec.md");
    let section = |name: &str| -> Result<&str, String> {
        sections
            .split_once(&format!("\n## {name}\n"))
            .map(|(_, tail)| tail.split("\n## ").next().unwrap().trim())
            .ok_or_else(|| format!("missing spec template {name}"))
    };
    let node = ctx.node(k)?;
    let ident = field(entry, "identifier")?;
    let kind = match node["role"].as_str() {
        Some("sync") => "submit sync",
        Some("hotfix") => "submit hotfix",
        _ => "submit lane",
    };
    let lower = field(row, "lower")?;
    let lint = ctx.plan["effort"].get("lint").or_else(|| {
        if ctx.plan["effort"]["test"].is_null() {
            ctx.install.config.settings()["test_runner"].get("lint")
        } else {
            None
        }
    });
    let lint = lint
        .and_then(Value::as_array)
        .map(|args| {
            args.iter()
                .filter_map(Value::as_str)
                .map(|s| quote(&s.replace("{lower}", lower)))
                .collect::<Vec<_>>()
                .join(" ")
        })
        .filter(|s| !s.is_empty())
        .map(|s| format!("run `{s}`, then "))
        .unwrap_or_default();
    let values = json!({"identifier":ident,"url":issue["url"].as_str().unwrap_or("no URL"),"key":k,"path":row["path"].as_str().unwrap_or("-"),"branch":row["branch"],"parent":row["parent"],"lower":lower,"pr":row["pr"].as_str().unwrap_or("-"),"wg":"wg","plan_dir":quote(&dir.to_string_lossy()),"project":ctx.plan["effort"]["name"],"skill":"work-graph","lint":lint,"dispatch_spec":quote(&first_path.to_string_lossy()),"job":follow.map(|f|f.0),"restack":follow.map(|f|f.2).unwrap_or("")});
    let placeholders = regex::Regex::new(r"\{([a-z_]+)\}").unwrap();
    let render = |s: &str| {
        placeholders
            .replace_all(s, |c: &regex::Captures<'_>| {
                values[&c[1]].as_str().unwrap_or("").to_owned()
            })
            .into_owned()
    };
    let task = render(
        &section(if node["kind"] == "spike" {
            "spike"
        } else {
            "task"
        })?
        .replace("{submit}", section(kind)?),
    );
    if follow.is_none() || follow.is_some_and(|f| f.3) {
        let design = ctx.request(
            "query($id:String!){issue(id:$id){description}}",
            json!({"id":entry["id"]}),
        )?;
        let description = design["issue"]["description"].as_str().unwrap_or("");
        let notes =
            regex::Regex::new(r"(?ms)^\+\+\+ Agent notes\n\nwork-graph node .*?^\+\+\+[ \t]*$")
                .unwrap();
        let description = notes.replace_all(description, "");
        let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ");
        let mut body = format!(
            "Written by `wg dispatch` at {now}: a copy of Linear issue `{ident}` and of the node `{k}` of plan.json. The issue stays the record.\n\n{task}\n\n## Design\n\n{}\n\n## Node card",
            if description.trim().is_empty() {
                "The issue has no description."
            } else {
                description.trim()
            }
        );
        if let Some(a) = node["acceptance"].as_str() {
            body.push_str(&format!("\n\n**Acceptance**\n\n{a}"));
        }
        let mut files = Vec::new();
        for f in ["owns", "shares"] {
            for v in node[f].as_array().into_iter().flatten() {
                files.push(format!(
                    "- {f} `{}`{}",
                    v.as_str().ok_or("invalid file pattern")?,
                    if f == "shares" {
                        " (additive only)"
                    } else {
                        ""
                    }
                ));
            }
        }
        if !files.is_empty() {
            body.push_str(&format!("\n\n**Files**\n\n{}", files.join("\n")));
        }
        if let Some(r) = ctx.plan["effort"]["rules"].as_str() {
            body.push_str(&format!("\n\n## Repository rules\n\n{r}"));
        }
        write_spec(&first_path, &body)?;
    }
    if let Some((_, work, _, fresh)) = follow {
        let mut body = if fresh {
            format!("{task}\n\n")
        } else {
            String::new()
        };
        body.push_str(&render(section("job")?));
        if !work.is_empty() {
            body.push_str("\n\n");
            body.push_str(work);
        }
        write_spec(&path, &body)?;
    }
    Ok(path)
}
fn write_spec(path: &Path, body: &str) -> Result<(), String> {
    let parent = path.parent().ok_or("missing spec directory")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    writeln!(file, "{body}").map_err(|e| e.to_string())?;
    file.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}
/// Identify the last parent commit in the child's history, including after the parent was rewritten.
fn old_parent_tip(
    dir: &Path,
    row: &Value,
    target: &str,
    below_row: &Value,
) -> Result<String, String> {
    let branch = field(row, "branch")?;
    let parent = field(row, "parent")?;
    let metadata = worktree::metadata(dir, branch);
    if let Some(revision) = metadata["parentBranchRevision"]
        .as_str()
        .filter(|s| !s.is_empty())
    {
        let ancestor = |tip: &str| {
            Command::new("git")
                .current_dir(dir)
                .args(["merge-base", "--is-ancestor", "--", revision, tip])
                .output()
                .map(|output| output.status.code())
                .map_err(|e| e.to_string())
        };
        if ancestor(branch)? == Some(0) && ancestor(target)? == Some(1) {
            return Ok(revision.to_owned());
        }
    }
    git(dir, &["merge-base", "--", branch, parent]).or_else(|_| {
        let last = field(below_row, "code_done_head")
            .map_err(|_| format!("no old tip of the merged parent {parent}"))?;
        git(dir, &["merge-base", "--", branch, last])
    })
}

pub(super) fn claim(
    ctx: &Context,
    k: &str,
    job: &str,
    agent: &Agent,
    send: bool,
    takeover: bool,
    work: Option<&Path>,
) -> Result<u8, String> {
    if send && work.is_none() {
        return Err("wg claim --send needs --work-file <file> with the work of the job".into());
    }
    if send && let Err(e) = caller("--send", "claim") {
        eprintln!("{e}");
        return Ok(1);
    }
    let work = work
        .map(fs::read_to_string)
        .transpose()
        .map_err(|e| e.to_string())?
        .map(|s| s.trim().to_owned());
    if work.as_deref() == Some("") {
        return Err("empty work file".into());
    }
    let _lock = job_lock(ctx)?;
    let km = ctx.km()?;
    if !takeover {
        ctx.lease(&km, k)?;
    }
    let action = if km["collab"].is_object() {
        crate::page::acquire_claim(ctx.install, ctx.scope()?, &km["collab"], k, job, takeover)?
    } else if takeover {
        return Err("--takeover needs a collaborative effort".into());
    } else {
        String::new()
    };
    let snap = crate::workflow::snapshot(ctx.install, ctx.plan, &km)?;
    let node = ctx.node(k)?;
    if node["kind"] != "task" {
        return Err(format!("{k}: wg claim is for a task"));
    }
    let entry = &km["nodes"][k];
    let id = field(entry, "id")?;
    let mut issue = snap.live.get(id).cloned().ok_or("issue not found")?;
    let row = &km["run"]["nodes"][k];
    let settings = agent.settings(ctx, row)?;
    let same = send
        && row["job"] == job
        && ["agent", "model", "effort"]
            .iter()
            .all(|f| row[*f] == settings[*f]);
    if same && row["state"] == "running" && row["step"] == "receipt" {
        print_started(k, &receipt(ctx, k, "claim")?, job);
        return Ok(0);
    }
    let resume = same && row["state"] == "starting";
    if resume && let Err(e) = pending(k, row, "send") {
        eprintln!("{e}");
        return Ok(1);
    }
    let pr = row["pr"].as_str();
    let worker = field(&settings, "agent")?;
    if !resume
        && matches!(
            row["state"].as_str(),
            Some("creating" | "starting" | "running")
        )
    {
        println!("FAIL {k}: a job is live");
        return Ok(1);
    }
    for f in ["branch", "parent", "lower"] {
        if field(row, f).is_err() {
            println!("FAIL {k}: missing run field {f}");
            return Ok(1);
        }
    }
    if (job == "dispatch") != pr.is_none() {
        println!("FAIL {k}: job does not match PR state");
        return Ok(1);
    }
    if job == "restack"
        && km["run"]["nodes"]
            .as_object()
            .into_iter()
            .flatten()
            .any(|(key, r)| {
                key != k
                    && r["job"] == "restack"
                    && matches!(
                        r["state"].as_str(),
                        Some("creating" | "starting" | "running")
                    )
            })
    {
        println!("FAIL one restack job at a time");
        return Ok(1);
    }
    let fresh = row["dispatch"].is_null()
        || if resume {
            row["fresh_worker"] == true
        } else {
            ["agent", "model", "effort"]
                .iter()
                .any(|f| row[*f] != settings[*f] && (*f != "agent" || !row["agent"].is_null()))
        };
    if send && fresh && row["worktree"].is_null() && row["path"].is_null() {
        println!("FAIL {k}: no worktree in the run row for a new worker");
        return Ok(1);
    }
    let mut restack = String::new();
    if job == "restack" {
        let n = worktree::names(ctx, node, &km, &snap)?;
        let phase = node["phase"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| node["phase"].to_string());
        let target = &n.target;
        let frozen = git(
            ctx.dir,
            &["cat-file", "-p", &format!("refs/branch-metadata/{target}")],
        )
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .is_some_and(|m| m["frozen"] == true);
        let pin = if matches!(node["role"].as_str(), Some("sync" | "hotfix")) {
            field(ctx.install.config.settings(), "release_branch")?
        } else {
            target
        };
        if frozen && pin == target {
            if base::run(ctx.dir, ctx.install, ctx.plan, Some(&phase))? != 0 {
                return Err("base refresh failed".into());
            }
        } else {
            git(
                ctx.dir,
                &[
                    "fetch",
                    "--no-tags",
                    "--no-recurse-submodules",
                    "origin",
                    &format!("+refs/heads/{pin}:refs/remotes/origin/{pin}"),
                ],
            )?;
        }
        let sha = git(ctx.dir, &["rev-parse", &format!("origin/{pin}")])?;
        let below = worktree::below(ctx.plan, node).and_then(|node| node["key"].as_str());
        let merged_parent = below.filter(|key| {
            snap.statuses
                .get(*key)
                .is_some_and(|s| matches!(s.as_str(), "Merged" | "Done"))
                && row["parent"] != pin
        });
        restack = format!(
            "target {pin} at {sha}; parent merged: {}",
            if merged_parent.is_some() { "yes" } else { "no" }
        );
        if let Some(below) = merged_parent {
            let old = old_parent_tip(
                ctx.dir,
                row,
                &format!("origin/{pin}"),
                &km["run"]["nodes"][below],
            )?;
            restack.push_str(&format!("; refresh: git rebase --onto origin/{pin} {old}, then st branch reparent --parent {pin}"));
            ctx.change(k, "claim", |r| {
                r["lower"] = format!("origin/{pin}").into();
                Ok(())
            })?;
        }
    }
    if action == "taken_over" {
        let labels = held(&issue)?;
        if !labels.is_empty() {
            ctx.labels(
                id,
                json!({"removedLabelIds":labels.iter().map(|l|&l["id"]).collect::<Vec<_>>()}),
            )?;
            issue = crate::workflow::snapshot(ctx.install, ctx.plan, &km)?
                .live
                .remove(id)
                .ok_or("issue not found")?;
        }
    }
    let labels = held(&issue)?;
    if !resume && !labels.is_empty() {
        eprintln!("{} holds the claim", field(labels[0], "name")?);
        return Ok(1);
    }
    if !resume {
        ctx.change(k, "claim", |r| {
            for f in [
                "agent",
                "model",
                "effort",
                "started_at",
                "fresh_worker",
                "retry_request",
                "step",
            ] {
                r.as_object_mut().unwrap().remove(f);
            }
            if job == "review" {
                r.as_object_mut().unwrap().remove("review_patch");
                r.as_object_mut().unwrap().remove("review_dispatch");
            }
            r["state"] = "starting".into();
            r["job"] = job.into();
            r["step"] = "claim".into();
            r.as_object_mut()
                .unwrap()
                .extend(settings.as_object().unwrap().clone());
            if fresh && r["dispatch"].is_string() {
                r["fresh_worker"] = true.into();
            }
            Ok(())
        })?;
    }
    if !labels
        .iter()
        .any(|l| l["name"] == format!("agent:{worker}"))
    {
        claim_label(ctx, &issue, worker)?;
    }
    let row = ctx.km()?["run"]["nodes"][k].clone();
    let spec = spec(
        ctx,
        k,
        entry,
        &issue,
        &row,
        Some((job, work.as_deref().unwrap_or(""), &restack, fresh)),
        !row["retry_request"].is_string(),
    )?;
    let title = format!("{}: {}", field(entry, "identifier")?, field(node, "title")?);
    let args = if fresh {
        if !row["retry_request"].is_string() {
            apply_worker_settings(ctx, &row);
        }
        start_args(&row, &spec, &title)?
    } else {
        let subject = format!(
            "{job}: {}",
            pr.map(|p| format!("#{p}"))
                .unwrap_or_else(|| row["branch"].as_str().unwrap_or("-").to_owned())
        );
        vec![
            "orchestration".into(),
            "send".into(),
            "--to".into(),
            format!("dispatch:{}", field(&row, "dispatch")?),
            "--subject".into(),
            subject,
            "--body-file".into(),
            spec.to_string_lossy().into_owned(),
        ]
    };
    println!(
        "claimed {} agent:{worker} for job {job}",
        field(entry, "identifier")?
    );
    if !restack.is_empty() {
        println!("{restack}");
    }
    ctx.refresh_card(k);
    if !send {
        println!(
            "spec {}\n  orca {} --json\n  wg started {} {k} dispatch=<dispatch_id> task=<task_id>",
            spec.display(),
            args.iter().map(|s| quote(s)).collect::<Vec<_>>().join(" "),
            ctx.dir.display()
        );
        return Ok(0);
    }
    launch(ctx, k, "claim", "send", &row, args)
}
