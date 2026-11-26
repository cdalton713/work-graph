//! Read PRs and checks once per refresh, with individual reads for incomplete batch entries.
use super::machine::*;
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    path::Path,
    process::{Command, Output},
    time::Duration,
};

const FIELDS: &str = "state,headRefOid,isDraft,mergeCommit,mergeable,baseRefName,reviews,comments";
const SELECTION: &str = "state headRefOid isDraft mergeCommit { oid } mergeable baseRefName
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

fn valid(number: &str) -> bool {
    !number.is_empty() && !number.starts_with('0') && number.bytes().all(|b| b.is_ascii_digit())
}
fn pr_state(pr: &Value) -> bool {
    matches!(pr["state"].as_str(), Some("OPEN" | "CLOSED" | "MERGED"))
}
fn nodes(connection: &Value) -> Option<&Vec<Value>> {
    (connection["pageInfo"]["hasNextPage"] == false).then(|| connection["nodes"].as_array())?
}
fn batch_entry(mut pr: Value) -> Option<(Value, bool)> {
    if !pr_state(&pr) {
        return None;
    }
    for name in ["reviews", "comments"] {
        pr[name] = Value::Array(nodes(&pr[name])?.clone());
    }
    let [head] = pr["commits"]["nodes"].as_array()?.as_slice() else {
        return None;
    };
    let rollup = head["commit"].as_object()?.get("statusCheckRollup");
    let mut passed = true;
    if let Some(rollup) = rollup.filter(|v| !v.is_null()) {
        let mut contexts = nodes(&rollup["contexts"])?.iter().collect::<Vec<_>>();
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
        let mut numbers: Vec<_> = numbers.filter(|n| valid(n)).collect();
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
                query.push_str(&format!("pr{n}:pullRequest(number:{n}){{{SELECTION}}} "));
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
        if !valid(n) {
            return Err(format!("{key}: invalid PR number {n:?}").into());
        }
        if self.unreadable.contains(key) {
            return Ok(Value::Null);
        }
        if let Some(pr) = self.infos.get(n) {
            return Ok(pr.clone());
        }
        let read = || -> Result<Value> {
            let out = gh(self.dir, &["pr", "view", n, "--json", FIELDS])?;
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
