use super::{effort::Effort, *};
use crate::{
    CredentialProvider,
    page::{Collaboration, LockedEffort, Output, ProjectAccess, Result},
};
use std::{ffi::OsStr, os::unix::ffi::OsStrExt, process::Command};

fn git(dir: &Path, args: &[&str]) -> Result<Vec<u8>> {
    let out = Command::new("git")
        .current_dir(dir)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }
    Ok(out.stdout)
}
fn existing(repo: &Path, branch: &str) -> Result<Option<PathBuf>> {
    let entries = git(repo, &["worktree", "list", "--porcelain", "-z"])?;
    let mut path = None;
    let wanted = format!("branch refs/heads/{branch}");
    for field in entries.split(|b| *b == 0) {
        if let Some(p) = field.strip_prefix(b"worktree ") {
            path = Some(PathBuf::from(OsStr::from_bytes(p)))
        } else if field == wanted.as_bytes() {
            return Ok(path);
        } else if field.is_empty() {
            path = None
        }
    }
    Ok(None)
}
impl Collaboration for Installation {
    fn lock(&self, dir: &Path) -> Result<Box<dyn LockedEffort + '_>> {
        Ok(Box::new(Effort::open(dir)?))
    }
    fn join_worktree(
        &self,
        repo: &Path,
        plan: &Value,
        _membership: &str,
    ) -> Result<(PathBuf, Box<dyn LockedEffort + '_>)> {
        let name = format!("{}-core", field(&plan["effort"], "slug")?);
        let branch = format!(
            "{}{}",
            self.config.settings()["branch_prefix"]
                .as_str()
                .unwrap_or("wg/"),
            name
        );
        let path = match existing(repo, &branch)? {
            Some(path) => path,
            None => {
                if env::var_os("ORCA_AGENT_SESSION_ID").is_none()
                    && env::var_os("ORCA_TERMINAL_HANDLE").is_none()
                {
                    return Err(format!(
                        "Create the coordinator worktree {name} in Orca on branch {branch}, then run wg join again."
                    ));
                }
                let root = git(repo, &["rev-parse", "--show-toplevel"])?;
                let repo_arg = format!(
                    "path:{}",
                    std::str::from_utf8(&root)
                        .map_err(|_| "invalid repo path")?
                        .trim_end()
                );
                let target = plan["phases"][0]["target"].as_str().unwrap_or("main");
                let out =
                    Command::new(env::var_os("ORCA_CLI_COMMAND").unwrap_or_else(|| "orca".into()))
                        .args([
                            "worktree",
                            "create",
                            "--name",
                            &name,
                            "--branch",
                            &branch,
                            "--repo",
                            &repo_arg,
                            "--no-parent",
                            "--base-branch",
                            &format!("origin/{target}"),
                            "--setup",
                            "skip",
                            "--json",
                        ])
                        .output()
                        .map_err(|e| e.to_string())?;
                if !out.status.success() {
                    return Err(String::from_utf8_lossy(&out.stderr).into());
                }
                let response: Value =
                    serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())?;
                let created = PathBuf::from(field(&response["result"]["worktree"], "path")?)
                    .canonicalize()
                    .map_err(|e| e.to_string())?;
                if existing(repo, &branch)?.as_deref() != Some(created.as_path()) {
                    return Err("unexpected coordinator worktree".into());
                }
                created
            }
        };
        let lock = self.lock(&path)?;
        if !git(
            &path,
            &["status", "--porcelain", "--untracked-files=normal"],
        )?
        .is_empty()
        {
            return Err("the coordinator worktree has local changes".into());
        }
        for f in ["plan.json", "keymap.json", "PLAN.md"] {
            match fs::symlink_metadata(path.join(f)) {
                Ok(_) => return Err("the coordinator worktree already has plan files".into()),
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.to_string()),
            }
        }
        Ok((path, lock))
    }
    fn preflight(&self, path: &Path, _: &str, plan: &Value) -> Result<Output> {
        crate::integration::preflight(self, path, plan, None)
    }
    fn next(&self, path: &Path, _: &str, _: &Value) -> Result<Output> {
        crate::automation::joined_next(path)
    }
    fn normalize(&self, plan: &mut Value) -> Result<()> {
        self.config
            .normalize(plan, &Value::Null)
            .map_err(|e| e.to_string())
    }
    fn normalize_and_check(&self, plan: &mut Value) -> Result<()> {
        self.normalize(plan)?;
        let cfg = self.config.report(None).map_err(|e| e.to_string())?;
        if !crate::local::check_plan(plan, &cfg) {
            return Err("invalid shared plan".into());
        }
        Ok(())
    }
    fn project_workspace(
        &self,
        team: &str,
        project: &str,
        name: &str,
        page: &str,
        _: &str,
    ) -> Result<ProjectAccess> {
        let mut has_key = false;
        for row in self.workspaces() {
            let scope = field(row, "id")?;
            if self.credential(scope, "linear")?.is_none() {
                continue;
            }
            has_key = true;
            if self
                .normalize(&mut json!({"effort":{"team":team,"workspace":scope}}))
                .is_err()
            {
                continue;
            }
            let Ok(data) = request(
                self,
                scope,
                "query($id:String!,$team:String!){teams(filter:{key:{eq:$team}}){nodes{id}} project(id:$id){id name teams{nodes{id}}}}",
                json!({"id":project,"team":team}),
            ) else {
                continue;
            };
            let p = &data["project"];
            if p["id"] == project
                && p["name"] == name
                && data["teams"]["nodes"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|r| r["id"].as_str())
                    .any(|id| {
                        p["teams"]["nodes"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .any(|r| r["id"] == id)
                    })
            {
                return Ok(ProjectAccess::Workspace(scope.into()));
            }
        }
        Ok(ProjectAccess::Unavailable {
            has_key,
            setup: format!(
                "Configure a workspace for team {team} and page {page} in {} and set its Linear API key.",
                self.config.path.display()
            ),
        })
    }
    fn verify_issue(
        &self,
        scope: &str,
        project: &str,
        identifier: &str,
        id: Option<&str>,
    ) -> Result<()> {
        let data = request(
            self,
            scope,
            "query($id:String!){issue(id:$id){id identifier project{id}}}",
            json!({"id":id.unwrap_or(identifier)}),
        )?;
        let issue = &data["issue"];
        if issue["project"]["id"] != project
            || issue["identifier"] != identifier
            || id.is_some_and(|s| issue["id"] != s)
        {
            return Err(
                "the shared keymap has an issue outside the project or an incorrect identifier"
                    .into(),
            );
        }
        Ok(())
    }
    fn verify_milestone(&self, scope: &str, project: &str, id: &str) -> Result<()> {
        let query = "query($id:String!,$after:String){project(id:$id){
            projectMilestones(first:50,after:$after,includeArchived:true){
                nodes{id} pageInfo{hasNextPage endCursor}}}}";
        let mut client = Client::connect(scope, self, self, &LinearHttp, &SystemTiming)?;
        let rows = client.pages(query, json!({"id":project}), "/project/projectMilestones")?;
        if !rows.iter().any(|r| r["id"] == id) {
            return Err("the shared keymap has a milestone outside the project".into());
        }
        Ok(())
    }
    fn verify_card(&self, scope: &str, issue: &str, id: &str) -> Result<()> {
        let data = request(
            self,
            scope,
            "query($id:String!){comment(id:$id){issue{id}}}",
            json!({"id":id}),
        )?;
        if data["comment"]["issue"]["id"] != issue {
            return Err("the shared keymap has a card outside its issue".into());
        }
        Ok(())
    }
    fn verify_document(&self, scope: &str, project: &str, id: &str) -> Result<()> {
        let data = request(
            self,
            scope,
            "query($id:String!){document(id:$id){project{id}}}",
            json!({"id":id}),
        )?;
        if data["document"]["project"]["id"] != project {
            return Err("the shared keymap has a status document outside the project".into());
        }
        Ok(())
    }
}
