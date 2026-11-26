//! Production services for a plan, with the same scoped credentials as the workflow commands.
use super::{
    findings::{Findings, journal_changed},
    machine::{Result, capture, process_error, text},
    precheck::HealthReads,
};
use crate::{
    linear::{Client, Installation, LinearHttp, SystemTiming},
    state, workflow,
};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::Path,
    process::{Command, Output},
    time::Duration,
};

pub(super) struct Effort<'a> {
    pub install: &'a Installation,
    pub dir: &'a Path,
    pub plan: Value,
    pub km: Value,
}
impl<'a> Effort<'a> {
    pub fn read(install: &'a Installation, dir: &'a Path) -> Result<Self> {
        crate::page::refresh_workflow(install, dir, false)?;
        Ok(Self {
            install,
            dir,
            plan: install.config.load_plan(dir)?,
            km: state::load_keymap(dir)?,
        })
    }
    pub fn scope(&self) -> Result<&str> {
        self.plan["effort"]["workspace"]
            .as_str()
            .or_else(|| self.install.workspaces().first()?.get("id")?.as_str())
            .ok_or_else(|| "missing workspace".into())
    }
    pub fn linear(&self) -> Result<Client<'static, Value, LinearHttp, SystemTiming>> {
        Ok(Client::connect(
            self.scope()?,
            self.install,
            self.install,
            &LinearHttp,
            &SystemTiming,
        )?)
    }
    pub fn project(&self) -> Result<&str> {
        self.km["project"]["id"]
            .as_str()
            .ok_or_else(|| "keymap.json has no project; run wg load --apply".into())
    }
    pub fn snapshot(&self) -> Result<workflow::Snapshot> {
        Ok(workflow::snapshot(self.install, &self.plan, &self.km)?)
    }
    pub fn labels(&self) -> Result<Vec<Value>> {
        let data = self.linear()?.request(
            "query($id:String!){project(id:$id){labels(first:50){nodes{name parent{name}}}}}",
            json!({"id":self.project()?}),
        )?;
        data["project"]["labels"]["nodes"]
            .as_array()
            .cloned()
            .ok_or_else(|| "invalid project labels".into())
    }
    pub fn ships_complete(&self, snapshot: &workflow::Snapshot) -> bool {
        let mut ships = self.plan["nodes"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|n| n["kind"] == "ship-point")
            .peekable();
        ships.peek().is_some()
            && ships.all(|n| {
                matches!(
                    snapshot.statuses.get(text(&n["key"])).map(String::as_str),
                    Some("Done" | "Canceled")
                )
            })
    }
    fn file_faults(&self, findings: &Findings) -> Result<BTreeMap<String, String>> {
        let previous = text(&self.km["run"]["effort"]["health_faults"])
            .split(',')
            .collect::<std::collections::BTreeSet<_>>();
        let new: Vec<_> = findings
            .faults
            .iter()
            .filter(|(id, _)| !previous.contains(id.as_str()))
            .collect();
        let mut filed = BTreeMap::new();
        if new.is_empty() {
            return Ok(filed);
        }
        let mut client = self.linear()?;
        let scope = self.scope()?;
        let team_key = self.plan["effort"]["team"]
            .as_str()
            .or_else(|| {
                self.install
                    .workspaces()
                    .iter()
                    .find(|w| w["id"] == scope)?["team"]
                    .as_str()
            })
            .ok_or("effort.team is missing")?;
        let team=client.request("query($k:String!){teams(filter:{key:{eq:$k}}){nodes{id states(first:50){nodes{id name}}}}}",json!({"k":team_key}))?;
        let team = &team["teams"]["nodes"][0];
        let tid = team["id"].as_str().ok_or("project team not found")?;
        let states = team["states"]["nodes"]
            .as_array()
            .ok_or("missing team states")?;
        let state = ["Triage", "Backlog"].iter().find_map(|s| {
            states
                .iter()
                .find(|row| row["name"] == *s)?
                .get("id")?
                .as_str()
        });
        let labels=client.pages("query($id:String!,$after:String){team(id:$id){labels(first:100,after:$after){nodes{id name} pageInfo{hasNextPage endCursor}}}}",json!({"id":tid}),"/team/labels")?;
        let label = if let Some(label) = labels.iter().find(|l| l["name"] == "health") {
            label["id"].clone()
        } else {
            client.request(
                "mutation($i:IssueLabelCreateInput!){issueLabelCreate(input:$i){issueLabel{id}}}",
                json!({"i":{"name":"health","teamId":tid}}),
            )?["issueLabelCreate"]["issueLabel"]["id"]
                .clone()
        };
        if !label.is_string() {
            return Err("health label has no id".into());
        }
        for (id, fault) in new {
            let found=client.request("query($t:ID!,$m:String!){issues(first:5,filter:{team:{id:{eq:$t}},labels:{name:{eq:\"health\"}},state:{type:{nin:[\"completed\",\"canceled\"]}},description:{contains:$m}}){nodes{id identifier}}}",json!({"t":tid,"m":format!("wg-health-fault: {id}")}))?;
            let mut body = text(&fault["text"]).to_owned();
            if !text(&fault["fix"]).is_empty() {
                body.push_str(&format!("\n\nFix: {}", text(&fault["fix"])));
            }
            let rows = found["issues"]["nodes"]
                .as_array()
                .ok_or("missing health issues")?;
            let issue = if let Some(open) = rows.first() {
                let result=client.request("mutation($i:CommentCreateInput!){commentCreate(input:$i){success}}",json!({"i":{"issueId":open["id"],"body":format!("The status check found this fault again.\n\n{body}")}}))?;
                if result["commentCreate"]["success"] != true {
                    return Err("could not comment on health issue".into());
                }
                open.clone()
            } else {
                let gap = fault["kind"] == "doctor-gap";
                let title = if gap {
                    format!("health: add a wg doctor check: {}", text(&fault["subject"]))
                } else {
                    format!(
                        "health: {} {}: {}",
                        text(&fault["kind"]),
                        text(&fault["subject"]),
                        text(&fault["text"])
                    )
                };
                let mut input = json!({"teamId":tid,"title":title.chars().take(120).collect::<String>(),"labelIds":[label],"description":format!("{body}\n\nThe work-graph status check of {} found this fault.\n\nwg-health-fault: {id}",text(&self.plan["effort"]["name"]))});
                if let Some(state) = state {
                    input["stateId"] = json!(state);
                }
                if !gap {
                    input["projectId"] = json!(self.project()?);
                }
                client.request(
                    "mutation($i:IssueCreateInput!){issueCreate(input:$i){issue{id identifier}}}",
                    json!({"i":input}),
                )?["issueCreate"]["issue"]
                    .clone()
            };
            filed.insert(
                id.clone(),
                issue["identifier"]
                    .as_str()
                    .ok_or("missing health issue identifier")?
                    .to_string(),
            );
        }
        Ok(filed)
    }
    pub fn report(&self, path: &Path) -> Result<String> {
        let mut findings = Findings::read(path)?;
        let project = self.project()?;
        let snapshot = self.snapshot()?;
        let complete = self.ships_complete(&snapshot);
        let now = Utc::now();
        let roots = self.install.config.settings()["tick_roots"]
            .as_array()
            .ok_or("invalid tick_roots")?
            .iter()
            .filter_map(|p| p.as_str().map(std::path::PathBuf::from))
            .collect::<Vec<_>>();
        findings.collect_diagnostics(self.dir, &roots, now.timestamp(), complete, |_| {
            let mut issues = BTreeMap::new();
            for (key, status) in &snapshot.statuses {
                let id = text(&self.km["nodes"][key]["id"]);
                let issue = &snapshot.live[id];
                let labels = issue["labels"]["nodes"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|l| l["name"].as_str().map(String::from))
                    .collect();
                issues.insert(
                    id.to_owned(),
                    crate::diagnostics::MappedIssue {
                        status: status.clone(),
                        labels,
                    },
                );
            }
            Ok(issues)
        })?;
        let filed = self.file_faults(&findings)?;
        let at = now.format("%Y-%m-%dT%H:%M:%SZ").to_string();
        let data=self.linear()?.request("mutation($i:ProjectUpdateCreateInput!){projectUpdateCreate(input:$i){projectUpdate{id url}}}",json!({"i":{"projectId":project,"body":findings.body(&filed,&at),"health":findings.value()}}))?;
        let update = &data["projectUpdateCreate"]["projectUpdate"];
        let id = update["url"]
            .as_str()
            .filter(|s| !s.is_empty())
            .or(update["id"].as_str())
            .ok_or("no project update returned")?;
        findings.save_published(self.dir, &at, id)?;
        let rank = |v: &str| match v {
            "offTrack" => 2,
            "atRisk" => 1,
            _ => 0,
        };
        if rank(findings.value()) > rank(text(&self.km["run"]["effort"]["health"]))
            && self.install.config.settings()["notify"]
                .as_array()
                .is_some_and(|v| !v.is_empty())
            && !self.labels()?.iter().any(|l| l["name"] == "paused")
        {
            super::notices::health(
                self,
                findings.value(),
                &findings.faults,
                text(&update["url"]),
            );
        }
        Ok(format!(
            "health {}: {} fault(s), {} issue(s) filed or commented; {id}",
            findings.value(),
            findings
                .faults
                .values()
                .filter(|f| !f["level"].is_null())
                .count(),
            filed.len()
        ))
    }
}
impl HealthReads for Effort<'_> {
    fn paused(&mut self) -> Result<bool> {
        let cached = &self.km["run"]["effort"];
        Ok(match self.labels() {
            Ok(labels) => labels.iter().any(|l| l["name"] == "paused") || cached["paused"] == "yes",
            Err(_) => cached["paused_seen"] == "yes" || cached["paused"] == "yes",
        })
    }
    fn complete(&mut self) -> Result<bool> {
        Ok(self.ships_complete(&self.snapshot()?))
    }
    fn changed_since(&mut self, since: i64) -> Result<bool> {
        if journal_changed(self.dir, since)? {
            return Ok(true);
        }
        let at = DateTime::from_timestamp(since, 0)
            .ok_or("invalid last check time")?
            .format("%Y-%m-%dT%H:%M:%SZ")
            .to_string();
        let data=self.linear()?.request("query($p:ID!,$t:DateTimeOrDuration!){issues(first:50,filter:{project:{id:{eq:$p}},updatedAt:{gt:$t}}){nodes{id labels(first:20){nodes{name}}}}}",json!({"p":self.project()?,"t":at}))?;
        Ok(data["issues"]["nodes"]
            .as_array()
            .ok_or("invalid changed issues")?
            .iter()
            .any(|i| {
                !i["labels"]["nodes"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|l| l["name"] == "health")
            }))
    }
}

const PR_FIELDS: &str =
    "state,headRefOid,isDraft,mergeCommit,mergeable,baseRefName,reviews,comments";
const PR_SELECTION: &str = "state headRefOid isDraft mergeCommit { oid } mergeable baseRefName
 reviews(first:100){nodes{body} pageInfo{hasNextPage}}
 comments(first:100){nodes{body} pageInfo{hasNextPage}}
 commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{
 __typename ... on CheckRun{name status conclusion startedAt checkSuite{workflowRun{event workflow{name}}}}
 ... on StatusContext{context state}} pageInfo{hasNextPage}}}}}}";

fn gh(dir: &Path, args: &[&str]) -> Result<Output> {
    capture(
        Command::new("gh").current_dir(dir).args(args),
        Duration::from_secs(30),
    )
}

fn valid_pr_number(number: &str) -> bool {
    !number.is_empty() && !number.starts_with('0') && number.bytes().all(|b| b.is_ascii_digit())
}
fn pr_state(pr: &Value) -> bool {
    matches!(pr["state"].as_str(), Some("OPEN" | "CLOSED" | "MERGED"))
}
fn complete_page(connection: &Value) -> Option<&Vec<Value>> {
    (connection["pageInfo"]["hasNextPage"] == false).then(|| connection["nodes"].as_array())?
}
fn batch_entry(mut pr: Value) -> Option<(Value, bool)> {
    if !pr_state(&pr) {
        return None;
    }
    for name in ["reviews", "comments"] {
        pr[name] = Value::Array(complete_page(&pr[name])?.clone());
    }
    let [head] = pr["commits"]["nodes"].as_array()?.as_slice() else {
        return None;
    };
    let rollup = head["commit"].as_object()?.get("statusCheckRollup");
    let mut passed = true;
    if let Some(rollup) = rollup.filter(|v| !v.is_null()) {
        let mut contexts = complete_page(&rollup["contexts"])?
            .iter()
            .collect::<Vec<_>>();
        contexts.sort_by(|a, b| text(&b["startedAt"]).cmp(text(&a["startedAt"])));
        let mut seen = HashSet::new();
        for c in contexts {
            c.as_object()?;
            let (key, state) = if c["__typename"] == "StatusContext" {
                ((true, text(&c["context"]).into()), &c["state"])
            } else {
                let run = &c["checkSuite"]["workflowRun"];
                (
                    (
                        false,
                        format!(
                            "{}/{}/{}",
                            text(&c["name"]),
                            text(&run["workflow"]["name"]),
                            text(&run["event"])
                        ),
                    ),
                    if c["status"] == "COMPLETED" {
                        &c["conclusion"]
                    } else {
                        &c["status"]
                    },
                )
            };
            if seen.insert(key)
                && matches!(
                    state.as_str(),
                    Some("ERROR" | "FAILURE" | "TIMED_OUT" | "ACTION_REQUIRED")
                )
            {
                passed = false;
            }
        }
    }
    pr.as_object_mut()?.remove("commits");
    Some((pr, passed))
}

/// Batch PRs and checks once per refresh. Read incomplete entries individually.
pub(super) struct PullRequests<'a> {
    dir: &'a Path,
    tolerant: bool,
    strict_checks: bool,
    infos: HashMap<String, Value>,
    unreadable: HashSet<String>,
    checks: HashMap<String, bool>,
    pub merge_allowed: Option<bool>,
}
impl<'a> PullRequests<'a> {
    pub fn new(
        dir: &'a Path,
        tolerant: bool,
        strict_checks: bool,
        numbers: impl Iterator<Item = &'a str>,
    ) -> Self {
        let mut reads = Self {
            dir,
            tolerant,
            strict_checks,
            infos: HashMap::new(),
            unreadable: HashSet::new(),
            checks: HashMap::new(),
            merge_allowed: None,
        };
        let mut numbers: Vec<_> = numbers.filter(|n| valid_pr_number(n)).collect();
        numbers.sort_unstable_by_key(|n| (n.len(), *n));
        numbers.dedup();
        if !numbers.is_empty()
            && let Err(error) = reads.batch(&numbers)
        {
            eprintln!(
                "warn next: the request for all PRs failed, so each PR is read alone: {error}"
            );
        }
        reads
    }
    fn batch(&mut self, numbers: &[&str]) -> Result<()> {
        let result = gh(self.dir, &["repo", "view", "--json", "owner,name,url"])?;
        if !result.status.success() {
            return Err(process_error(&result).into());
        }
        let repo: Value = serde_json::from_slice(&result.stdout)?;
        let url = url::Url::parse(text(&repo["url"]))?;
        let host = url.host_str().ok_or("missing repository host")?;
        let owner = format!(
            "owner={}",
            repo["owner"]["login"]
                .as_str()
                .ok_or("missing repository owner")?
        );
        let name = format!(
            "name={}",
            repo["name"].as_str().ok_or("missing repository name")?
        );
        for chunk in numbers.chunks(50) {
            let mut query = String::from(
                "query=query($owner:String!,$name:String!){repository(owner:$owner,name:$name){",
            );
            for n in chunk {
                query.push_str(&format!("pr{n}:pullRequest(number:{n}){{{PR_SELECTION}}} "));
            }
            query.push_str("}}");
            let result = match gh(
                self.dir,
                &[
                    "api",
                    "graphql",
                    "--hostname",
                    host,
                    "-f",
                    &query,
                    "-f",
                    &owner,
                    "-f",
                    &name,
                ],
            ) {
                Ok(out) => out,
                Err(e) => {
                    eprintln!("warn next: PR batch: {e}");
                    continue;
                }
            };
            let Ok(answer) = serde_json::from_slice::<Value>(&result.stdout) else {
                continue;
            };
            let errors = answer["errors"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or_default();
            if !result.status.success() && errors.is_empty() {
                continue;
            }
            for &n in chunk {
                let alias = format!("pr{n}");
                if errors.iter().any(|err| {
                    let path = &err["path"];
                    path[0] != "repository"
                        || path[1]
                            .as_str()
                            .is_none_or(|s| !s.starts_with("pr") || s == alias)
                }) {
                    continue;
                }
                if let Some((pr, pass)) = batch_entry(answer["data"]["repository"][&alias].clone())
                {
                    self.infos.insert(n.into(), pr);
                    self.checks.insert(n.into(), pass);
                }
            }
        }
        Ok(())
    }
    pub fn info(&mut self, key: &str, n: &str, optional: bool) -> Result<Value> {
        if !valid_pr_number(n) {
            return Err(format!("{key}: invalid PR number {n:?}").into());
        }
        if self.unreadable.contains(key) {
            return Ok(Value::Null);
        }
        if let Some(pr) = self.infos.get(n) {
            return Ok(pr.clone());
        }
        let read = || -> Result<Value> {
            let out = gh(self.dir, &["pr", "view", n, "--json", PR_FIELDS])?;
            if !out.status.success() {
                return Err(process_error(&out).into());
            }
            let pr: Value = serde_json::from_slice(&out.stdout)?;
            if !pr_state(&pr) {
                return Err("invalid PR response".into());
            }
            Ok(pr)
        };
        let pr = match read() {
            Err(err) if optional || self.tolerant => {
                eprintln!("warn next: {key} #{n}: {err}");
                self.unreadable.insert(key.into());
                return Ok(Value::Null);
            }
            res => res?,
        };
        self.infos.insert(n.into(), pr.clone());
        Ok(pr)
    }
    pub fn passed(&mut self, key: &str, n: &str) -> Result<bool> {
        if let Some(pass) = self.checks.get(n) {
            return Ok(*pass);
        }
        let read = || -> Result<bool> {
            let out = gh(self.dir, &["pr", "checks", n, "--json", "name,bucket"])?;
            let code = out.status.code();
            if out.stdout.iter().all(u8::is_ascii_whitespace) {
                if out.status.success()
                    || code == Some(1)
                        && String::from_utf8_lossy(&out.stderr)
                            .to_lowercase()
                            .contains("no checks reported")
                {
                    return Ok(true);
                }
            } else if matches!(code, Some(0 | 1 | 8)) {
                let checks: Vec<Value> = serde_json::from_slice(&out.stdout)?;
                let failed = checks.iter().any(|c| c["bucket"] == "fail");
                if !self.strict_checks
                    || code == Some(0)
                    || code == Some(1) && failed
                    || code == Some(8) && checks.iter().any(|c| c["bucket"] == "pending")
                {
                    return Ok(!failed);
                }
            }
            if self.strict_checks {
                Err(process_error(&out).into())
            } else {
                Ok(false)
            }
        };
        let passed = match read() {
            Err(e) if self.tolerant => {
                eprintln!("warn next: {key} #{n}: {e}");
                true
            }
            res => res?,
        };
        self.checks.insert(n.into(), passed);
        Ok(passed)
    }
}
