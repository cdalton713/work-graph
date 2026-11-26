//! Production services for a plan, with the same scoped credentials as the workflow commands.
use super::{
    findings::{Findings, journal_changed},
    machine::{Result, text},
    precheck::HealthReads,
};
use crate::{
    linear::{Client, Installation, LinearHttp, SystemTiming},
    state, workflow,
};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::Path};

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
