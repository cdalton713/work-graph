use super::*;
use crate::{
    linear::{Client, LinearHttp, SystemTiming},
    state::{PlanLock, load_keymap},
    workflow::{Workflow, move_node},
};
use serde_json::json;

pub(super) fn field<'a>(v: &'a Value, f: &str) -> Result<&'a str, String> {
    v[f].as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("missing {f}"))
}
pub(super) struct Context<'a> {
    pub dir: &'a Path,
    pub install: &'a Installation,
    pub plan: &'a Value,
}
impl Context<'_> {
    pub fn km(&self) -> Result<Value, String> {
        load_keymap(self.dir).map_err(|e| e.to_string())
    }
    pub fn node(&self, k: &str) -> Result<&Value, String> {
        if Path::new(k).file_name().and_then(|s| s.to_str()) != Some(k) {
            return Err(format!("invalid key {k}"));
        }
        list(&self.plan["nodes"])?
            .iter()
            .find(|n| n["key"] == k)
            .ok_or_else(|| format!("unknown key {k}"))
    }
    pub fn scope(&self) -> Result<&str, String> {
        self.plan["effort"]["workspace"]
            .as_str()
            .or_else(|| self.install.workspaces().first()?.get("id")?.as_str())
            .ok_or_else(|| "missing workspace".into())
    }
    pub fn request(&self, doc: &str, vars: Value) -> Result<Value, String> {
        Client::connect(
            self.scope()?,
            self.install,
            self.install,
            &LinearHttp,
            &SystemTiming,
        )?
        .request(doc, vars)
    }
    pub fn lease(&self, km: &Value, k: &str) -> Result<(), String> {
        if let Some(claims) = crate::workflow::current_claims(self.install, self.plan, km)? {
            let held = list(&claims["claims"])?
                .iter()
                .find(|v| v["node"] == k)
                .ok_or_else(|| format!("{k}: no claim"))?;
            if held["mine"] != true {
                return Err(format!(
                    "{k}: {} holds this node now",
                    field(held, "holder")?
                ));
            }
            crate::page::update_claim(
                self.install,
                self.scope()?,
                &km["collab"],
                k,
                Some(&held["job"]),
            )?;
        }
        Ok(())
    }
    pub fn save(
        &self,
        cmd: &str,
        f: impl FnOnce(&mut Value) -> Result<(), String>,
    ) -> Result<(), String> {
        let lock = PlanLock::acquire(self.dir, None).map_err(|e| e.to_string())?;
        let mut km = self.km()?;
        let before = km.clone();
        f(&mut km)?;
        if before != km {
            crate::page::save_run_keymap(self.dir, &lock, self.plan, &mut km)?;
            if let Err(e) = crate::local::record_workflow(self.dir, cmd, &before, &km) {
                eprintln!("warn: journal not written ({e})");
            }
        }
        Ok(())
    }
    pub fn change(
        &self,
        k: &str,
        cmd: &str,
        f: impl FnOnce(&mut Value) -> Result<(), String>,
    ) -> Result<(), String> {
        self.save(cmd, |km| {
            let row = &mut km["run"]["nodes"][k];
            if row.is_null() {
                *row = json!({});
            }
            if !row.is_object() {
                return Err("invalid run row".into());
            }
            f(row)
        })
    }
    pub fn refresh_card(&self, k: &str) {
        let result = self.save("card", |km| {
            let row = km["run"]["nodes"][k].clone();
            let scope = self.scope()?;
            let mut writer = crate::providers::LinearCards::new(scope, &Value::Null);
            crate::local::refresh_card(self.node(k)?, &mut km["nodes"][k], &row, &mut writer)
                .map_err(|e| e.to_string())
        });
        if let Err(e) = result {
            eprintln!("node card not updated ({e}); the next 'wg load --apply' updates it");
        }
    }
    pub fn comment(&self, id: &str, body: &str) -> Result<(), String> {
        let r = self.request(
            "mutation($i:CommentCreateInput!){commentCreate(input:$i){comment{id}}}",
            json!({"i":{"issueId":id,"body":body}}),
        )?;
        field(&r["commentCreate"]["comment"], "id")?;
        Ok(())
    }
    pub fn claim_event(&self, cmd: &str, k: &str, old: Option<&str>, new: Option<&str>) {
        if let Err(e) = crate::local::record_claim(self.dir, cmd, k, old, new) {
            eprintln!("warn: journal not written ({e})");
        }
    }
    pub fn labels(&self, id: &str, input: Value) -> Result<(), String> {
        let r = self.request(
            "mutation($id:String!,$i:IssueUpdateInput!){issueUpdate(id:$id,input:$i){success}}",
            json!({"id":id,"i":input}),
        )?;
        if r["issueUpdate"]["success"] != true {
            return Err("issue update failed".into());
        }
        Ok(())
    }
    pub fn start_project(&self, km: &Value) -> Result<(), String> {
        let id = field(&km["project"], "id")?;
        let data=self.request("query($id:String!){project(id:$id){status{id type createdAt}} projectStatuses{nodes{id name type createdAt}}}",json!({"id":id}))?;
        let current = &data["project"]["status"];
        if !matches!(field(current, "type")?, "backlog" | "planned") {
            return Ok(());
        }
        let statuses = list(&data["projectStatuses"]["nodes"])?;
        let mut started = statuses
            .iter()
            .filter(|s| s["type"] == "started" && s["name"] == "In Progress");
        let target = started
            .clone()
            .find(|s| s["createdAt"] == current["createdAt"])
            .or_else(|| started.next())
            .ok_or("no In Progress project status")?;
        let updated = self.request(
            "mutation($id:String!,$s:String!){projectUpdate(id:$id,input:{statusId:$s}){success}}",
            json!({"id":id,"s":field(target,"id")?}),
        )?;
        if updated["projectUpdate"]["success"] == true {
            println!("project status: In Progress");
        }
        Ok(())
    }
    pub fn transition(&self, cmd: &str, k: &str, to: &str) -> Result<(), String> {
        move_node(
            Workflow {
                dir: self.dir,
                installation: self.install,
                plan: self.plan,
                command: cmd,
            },
            k,
            to,
            None,
            None,
            false,
        )
    }
}

pub(super) fn held(issue: &Value) -> Result<Vec<&Value>, String> {
    Ok(list(&issue["labels"]["nodes"])?
        .iter()
        .filter(|l| l["name"].as_str().is_some_and(|s| s.starts_with("agent:")))
        .collect())
}
pub(super) fn receipt(ctx: &Context, k: &str, cmd: &str) -> Result<Value, String> {
    let km = ctx.km()?;
    let row = &km["run"]["nodes"][k];
    let dispatch = field(row, "dispatch")?;
    let location = row["path"]
        .as_str()
        .or(row["worktree"].as_str())
        .unwrap_or("-");
    ctx.comment(
        field(&km["nodes"][k], "id")?,
        &format!(
            "Claimed: dispatch {dispatch}, worktree {location}, job {}",
            row["job"].as_str().unwrap_or("dispatch")
        ),
    )?;
    ctx.change(k, cmd, |r| {
        if r["dispatch"] != dispatch {
            return Err("dispatch changed".into());
        }
        r.as_object_mut().unwrap().remove("step");
        Ok(())
    })?;
    ctx.refresh_card(k);
    Ok(ctx.km()?["run"]["nodes"][k].clone())
}
pub(super) fn record(ctx: &Context, k: &str, cmd: &str, fields: &Value) -> Result<Value, String> {
    let id = field(fields, "dispatch").map_err(|_| "wg started needs dispatch=<id>")?;
    ctx.save(cmd, |km| {
        if !km["nodes"][k].is_object() {
            return Err(format!("{k}: not loaded"));
        }
        let row = &mut km["run"]["nodes"][k];
        if row["state"] == "running" && row["step"] == "receipt" && row["dispatch"] == id {
            return Ok(());
        }
        if row["state"] != "starting" {
            return Err(format!(
                "{k}: no job is starting (state={}): use wg dispatch or wg claim first",
                row["state"].as_str().unwrap_or("-")
            ));
        }
        for (field, value) in fields.as_object().ok_or("invalid receipt")? {
            if field != "run_id" && value.as_str().is_some_and(|s| !s.is_empty()) {
                row[field] = value.clone();
            }
        }
        for f in ["retry_request", "fresh_worker"] {
            row.as_object_mut().unwrap().remove(f);
        }
        row["state"] = "running".into();
        row["step"] = "receipt".into();
        row["started_at"] = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%SZ")
            .to_string()
            .into();
        if let Some(run) = fields["run_id"].as_str().filter(|s| !s.is_empty()) {
            km["run"]["effort"]["run_id"] = run.into();
        }
        Ok(())
    })?;
    receipt(ctx, k, cmd)
}
pub(super) fn started(ctx: &Context, k: &str, args: &[String]) -> Result<u8, String> {
    ctx.lease(&ctx.km()?, k)?;
    ctx.node(k)?;
    let _job_lock = launch::job_lock(ctx)?;
    let mut fields = json!({});
    let valid = regex::Regex::new("^[a-z][a-z0-9_]*$").unwrap();
    for a in args {
        let (f, v) = a
            .split_once('=')
            .filter(|(f, _)| valid.is_match(f))
            .ok_or_else(|| format!("invalid run field: {}", a.split('=').next().unwrap()))?;
        fields[f] = v.into();
    }
    let row = record(ctx, k, "started", &fields)?;
    println!(
        "{}",
        row.as_object()
            .unwrap()
            .iter()
            .map(|(k, v)| format!("{k}={}", v.as_str().unwrap_or("-")))
            .collect::<Vec<_>>()
            .join(" ")
    );
    Ok(0)
}

fn attach(ctx: &Context, id: &str, pr: &str, cwd: &Path) -> Result<(), String> {
    let data = verify::gh(cwd, &["pr", "view", pr, "--json", "url"])?;
    let url = field(&data, "url")?;
    let mut cursor = Value::Null;
    loop {
        let r=ctx.request("query($id:String!,$after:String){issue(id:$id){attachments(first:50,after:$after){nodes{url} pageInfo{hasNextPage endCursor}}}}",json!({"id":id,"after":cursor}))?;
        let page = &r["issue"]["attachments"];
        if list(&page["nodes"])?.iter().any(|a| a["url"] == url) {
            return Ok(());
        }
        if page["pageInfo"]["hasNextPage"] != true {
            break;
        }
        let next = field(&page["pageInfo"], "endCursor")?;
        if cursor == next {
            return Err("invalid attachment cursor".into());
        }
        cursor = next.into();
    }
    if ctx.request("mutation($id:String!,$url:String!){attachmentLinkGitHubPR(issueId:$id,url:$url){success}}",json!({"id":id,"url":url})).is_ok_and(|r|r["attachmentLinkGitHubPR"]["success"]==true){return Ok(());}
    let r = ctx.request(
        "mutation($input:AttachmentCreateInput!){attachmentCreate(input:$input){success}}",
        json!({"input":{"issueId":id,"title":format!("PR #{pr}"),"url":url}}),
    )?;
    if r["attachmentCreate"]["success"] != true {
        return Err("Linear did not create the attachment".into());
    }
    Ok(())
}

pub(super) fn done(
    ctx: &Context,
    k: &str,
    dispatch: Option<&str>,
    failed: Option<&str>,
    worktree: Option<&Path>,
) -> Result<u8, String> {
    // A delayed completion must not clear the label of a newer dispatch.
    let _job_lock = if ctx.node(k).is_ok() {
        Some(launch::job_lock(ctx)?)
    } else {
        None
    };
    let km = ctx.km()?;
    ctx.lease(&km, k)?;
    let snap = crate::workflow::snapshot(ctx.install, ctx.plan, &km)?;
    let node = ctx.node(k)?;
    if !matches!(node["kind"].as_str(), Some("task" | "spike")) {
        return Err(format!("{k}: wg done is for a task or a spike"));
    }
    let entry = &km["nodes"][k];
    let id = field(entry, "id")?;
    let issue = snap
        .live
        .get(id)
        .ok_or_else(|| format!("{k}: issue not found"))?;
    let row = &km["run"]["nodes"][k];
    let labels = held(issue)?;
    let live = matches!(
        row["state"].as_str(),
        Some("creating" | "starting" | "running")
    );
    if !labels.is_empty() && !live {
        eprintln!(
            "{}: {} has no job in the run row",
            field(entry, "identifier")?,
            field(labels[0], "name")?
        );
        return Ok(1);
    }
    if dispatch.is_some_and(|d| row["dispatch"] != d) {
        eprintln!(
            "{k}: this worker_done is from {}; the job in the run row is {}",
            dispatch.unwrap(),
            row["dispatch"].as_str().unwrap_or("not recorded")
        );
        return Ok(1);
    }
    if live && failed.is_none() && dispatch.is_none() {
        return Err(format!(
            "{k}: a job is live (dispatch {}): pass --dispatch <id> of the worker_done, or --failed",
            row["dispatch"].as_str().unwrap_or("not recorded")
        ));
    }
    if !labels.is_empty() {
        ctx.labels(
            id,
            json!({"removedLabelIds":labels.iter().map(|l|&l["id"]).collect::<Vec<_>>()}),
        )?;
        ctx.claim_event("done", k, Some(field(labels[0], "name")?), None);
        println!("released {}", field(labels[0], "name")?);
    }
    ctx.change(k, "done", |r| {
        if r["dispatch"] != row["dispatch"] {
            return Err("dispatch changed".into());
        }
        if failed.is_some() {
            r["state"] = "failed".into();
        } else {
            r.as_object_mut().unwrap().remove("state");
        }
        Ok(())
    })?;
    if let Some(reason) = failed {
        ctx.comment(
            id,
            &format!(
                "Job `{}` failed: {}",
                row["job"].as_str().unwrap_or("-"),
                if reason.trim().is_empty() {
                    "no error given"
                } else {
                    reason.trim()
                }
            ),
        )?;
        ctx.refresh_card(k);
        println!("{k}: state=failed");
        return Ok(0);
    }
    if node["kind"] == "spike" {
        ctx.refresh_card(k);
        ctx.transition("done", k, "Done")?;
        return Ok(0);
    }
    for f in ["branch", "parent", "lower"] {
        field(row, f).map_err(|_| format!("{k}: missing run field {f}"))?;
    }
    let cwd = worktree
        .or_else(|| row["path"].as_str().map(Path::new))
        .or_else(|| {
            row["worktree"]
                .as_str()?
                .split_once("::")
                .map(|(_, p)| Path::new(p))
        })
        .filter(|p| !p.as_os_str().is_empty());
    let gh_dir = cwd.unwrap_or(ctx.dir);
    let pr = if let Some(pr) = row["pr"].as_str() {
        pr.to_owned()
    } else {
        let result = verify::gh(
            gh_dir,
            &[
                "pr",
                "list",
                "--head",
                field(row, "branch")?,
                "--state",
                "open",
                "--json",
                "number",
            ],
        )?;
        let prs = list(&result)?;
        if prs.len() != 1 {
            println!(
                "FAIL pr: {} open PRs have the head {}",
                prs.len(),
                field(row, "branch")?
            );
            return Ok(1);
        }
        let pr = prs[0]["number"]
            .as_u64()
            .ok_or("invalid PR number")?
            .to_string();
        ctx.change(k, "done", |r| {
            r["pr"] = pr.clone().into();
            Ok(())
        })?;
        pr
    };
    if let Err(e) = attach(ctx, id, &pr, gh_dir) {
        eprintln!(
            "Warning: could not attach PR #{pr} to {}: {e}",
            field(entry, "identifier")?
        );
    }
    if let Some(below) = worktree::below(ctx.plan, node) {
        let below_key = field(below, "key")?;
        let phase = list(&ctx.plan["phases"])?
            .iter()
            .find(|p| p["key"] == node["phase"])
            .ok_or("missing phase")?;
        let target = base::bottom(node, field(phase, "target")?);
        if matches!(
            snap.statuses.get(below_key).map(String::as_str),
            Some("Merged" | "Done")
        ) && row["parent"] != target
        {
            let info = verify::gh(gh_dir, &["pr", "view", &pr, "--json", "baseRefName"])?;
            if info["baseRefName"] != target {
                println!(
                    "FAIL pr: {below_key} below it merged, but the base of PR #{pr} is {}, not {target}: restack it",
                    field(&info, "baseRefName")?
                );
                if snap.statuses.get(k).is_some_and(|s| s == "Ready to Merge") {
                    ctx.transition("done", k, "In Review")?;
                }
                ctx.refresh_card(k);
                return Ok(1);
            }
            ctx.change(k, "done", |r| {
                r["parent"] = target.into();
                r["lower"] = format!("origin/{target}").into();
                Ok(())
            })?;
            println!("the PR below merged: parent {target}, lower origin/{target}");
        }
    }
    let result = verify::run(ctx, k, cwd.unwrap_or(Path::new(".")))?;
    let status = snap.statuses.get(k).map(String::as_str);
    let row = ctx.km()?["run"]["nodes"][k].clone();
    let review_ok = matches!(row["merge_review"].as_str(), Some("clean" | "accepted"))
        || list(&issue["labels"]["nodes"])?
            .iter()
            .any(|l| l["name"] == "reviewed")
        || row["verified_head"].is_string() && row["verified_head"] == row["code_done_head"]
        || matches!(
            row["gate"].as_str(),
            Some("standard" | "light" | "thorough")
        )
        || matches!(
            km["run"]["effort"]["review_seen"].as_str(),
            Some("standard" | "light")
        ) && matches!(row["review"].as_str(), Some("clean" | "accepted"));
    if result == 0 && matches!(status, Some("Todo" | "Ready" | "In Progress"))
        || status == Some("Ready to Merge") && (result != 0 || !review_ok)
    {
        ctx.transition("done", k, "In Review")?;
    }
    ctx.refresh_card(k);
    Ok(result)
}
