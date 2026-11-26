use super::lifecycle::{Context, field};
use super::*;
use crate::workflow::Snapshot;
use serde_json::json;
use std::collections::HashSet;

pub(super) fn below<'a>(plan: &'a Value, node: &Value) -> Option<&'a Value> {
    let edges = plan["edges"].as_array()?;
    plan["nodes"].as_array()?.iter().find(|n| {
        n["kind"] == "task"
            && n["lane"] == node["lane"]
            && n["phase"] == node["phase"]
            && edges
                .iter()
                .any(|e| e["from"] == node["key"] && e["to"] == n["key"])
    })
}

pub(super) struct Names {
    pub stack: String,
    pub child: String,
    pub branch: String,
    pub parent: String,
    pub lower: String,
    pub target: String,
    pub track: bool,
    pub display: String,
}
pub(super) fn names(
    ctx: &Context,
    node: &Value,
    km: &Value,
    snap: &Snapshot,
) -> Result<Names, String> {
    let key = field(node, "key")?;
    let slug = field(&ctx.plan["effort"], "slug")?;
    let prefix = field(ctx.install.config.settings(), "branch_prefix")?;
    let phase = node["phase"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| node["phase"].to_string());
    let phases = list(&ctx.plan["phases"])?;
    let target = field(
        phases
            .iter()
            .find(|p| p["key"] == node["phase"])
            .ok_or("missing phase")?,
        "target",
    )?
    .to_owned();
    let spike = node["kind"] == "spike";
    let sync = node["role"] == "sync";
    let hotfix = node["role"] == "hotfix" && ctx.plan["effort"]["stacked_hotfix"] != true;
    let stack = if spike {
        format!("{slug}-core")
    } else if sync {
        format!("{slug}-p{phase}-sync")
    } else {
        let lane = field(node, "lane")?;
        if phases.first().is_some_and(|p| p["key"] == node["phase"]) {
            format!("{slug}-{lane}")
        } else {
            format!("{slug}-p{phase}-{lane}")
        }
    };
    let mut seen = HashSet::new();
    let mut cursor = node;
    while let Some(n) = below(ctx.plan, cursor) {
        if !seen.insert(field(n, "key")?) {
            return Err("cycle in lane".into());
        }
        cursor = n;
    }
    let index = seen.len();
    let child = if spike {
        format!("{slug}-spike-{key}")
    } else if sync {
        format!("{stack}-00-sync")
    } else {
        format!("{stack}-{index:02}-{key}")
    };
    let branch = if sync {
        format!("sync/{slug}-p{phase}")
    } else if hotfix {
        format!("hotfix/{slug}-{key}")
    } else {
        format!("{prefix}{child}")
    };
    let parent = if sync {
        "main"
    } else if hotfix {
        field(ctx.install.config.settings(), "release_branch")?
    } else {
        &target
    };
    let mut parent = parent.to_owned();
    let mut lower = format!("origin/{parent}");
    let row = &km["run"]["nodes"][key];
    if row["branch"].is_string() {
        parent = field(row, "parent")?.into();
        lower = field(row, "lower")?.into();
    } else if !spike
        && !sync
        && !hotfix
        && let Some(n) = below(ctx.plan, node)
    {
        let k = field(n, "key")?;
        match snap.statuses.get(k).map(String::as_str) {
            Some("Canceled") => return Err(format!("{key}: {k} below it in the lane is Canceled")),
            Some("Merged" | "Done") => (),
            _ => {
                parent = km["run"]["nodes"][k]["branch"]
                    .as_str()
                    .or(km["nodes"][k]["branch"].as_str())
                    .ok_or_else(|| format!("{key}: {k} below it has no branch"))?
                    .into();
                lower = parent.clone();
            }
        }
    }
    Ok(Names {
        stack,
        child,
        branch: row["branch"].as_str().unwrap_or(&branch).into(),
        parent,
        lower,
        target,
        track: !spike && !hotfix && !sync,
        display: if spike {
            format!("spike {key}")
        } else if sync {
            "00 sync".into()
        } else {
            format!("{index:02} {key}")
        },
    })
}

pub(super) fn orca() -> Command {
    Command::new(std::env::var_os("ORCA_CLI_COMMAND").unwrap_or_else(|| "orca".into()))
}
fn request(args: &[&str]) -> Result<Value, String> {
    let v: Value = serde_json::from_str(&output(orca().args(args).arg("--json"))?)
        .map_err(|e| e.to_string())?;
    v.get("result")
        .filter(|r| r.is_object())
        .cloned()
        .ok_or_else(|| "invalid Orca response".into())
}
pub(super) fn path_for_id(id: &str) -> Result<PathBuf, String> {
    let response = request(&["worktree", "list", "--limit", "10000"])?;
    if response["truncated"] == true {
        return Err("orca worktree list is truncated".into());
    }
    let tree = list(&response["worktrees"])?
        .iter()
        .find(|tree| tree["id"] == id)
        .ok_or_else(|| format!("no local path for worktree {id}"))?;
    Ok(PathBuf::from(field(tree, "path")?))
}
fn branch(tree: &Value) -> &str {
    let s = tree["branch"].as_str().unwrap_or("");
    s.strip_prefix("refs/heads/").unwrap_or(s)
}
fn repo(tree: &Value) -> Option<&str> {
    tree["repoId"]
        .as_str()
        .or_else(|| tree["id"].as_str()?.split("::").next())
}
fn create(
    name: &str,
    branch: &str,
    parent: &Value,
    base: &str,
    setup: &str,
) -> Result<Value, String> {
    let result = request(&[
        "worktree",
        "create",
        "--name",
        name,
        "--branch",
        branch,
        "--parent-worktree",
        &format!("id:{}", field(parent, "id")?),
        "--base-branch",
        base,
        "--setup",
        setup,
    ])?;
    Ok(result["worktree"].clone())
}
fn metadata(path: &Path, branch: &str) -> Value {
    git(
        path,
        &["cat-file", "-p", &format!("refs/branch-metadata/{branch}")],
    )
    .ok()
    .and_then(|s| serde_json::from_str(&s).ok())
    .unwrap_or(Value::Null)
}
pub(super) fn check(ctx: &Context, path: &Path, n: &Names) -> Result<(), String> {
    let common = ["rev-parse", "--path-format=absolute", "--git-common-dir"];
    if git(path, &common)? != git(ctx.dir, &common)? {
        return Err("worktree belongs to another repository".into());
    }
    if git(path, &["branch", "--show-current"])? != n.branch {
        return Err(format!("worktree is not on {}", n.branch));
    }
    if !git(path, &["status", "--porcelain"])?.is_empty() {
        return Err("the new worktree is not clean".into());
    }
    git(path, &["merge-base", "--is-ancestor", &n.lower, "HEAD"])
        .map_err(|_| format!("HEAD does not contain {}", n.lower))?;
    Ok(())
}
pub(super) fn tracked(path: &Path, n: &Names) -> bool {
    !n.track || metadata(path, &n.branch)["parentBranchName"] == n.parent
}
pub(super) fn fetch_shared_parent(dir: &Path, branch: &str) -> Result<(), String> {
    let reference = format!("refs/heads/{branch}");
    git(dir, &["check-ref-format", &reference])?;
    if git(dir, &["show-ref", "--verify", "--quiet", &reference]).is_ok() {
        return Ok(());
    }
    let remote = format!("refs/remotes/origin/{branch}");
    git(
        dir,
        &[
            "fetch",
            "--no-tags",
            "--no-recurse-submodules",
            "origin",
            &format!("{reference}:{remote}"),
        ],
    )?;
    git(dir, &["branch", "--track", "--", branch, &remote])?;
    Ok(())
}

pub(super) fn prepare(ctx: &Context, k: &str, n: &Names) -> Result<(), String> {
    let found = request(&["worktree", "list", "--limit", "10000"])?;
    if found["truncated"] == true {
        return Err("orca worktree list is truncated".into());
    }
    let trees = list(&found["worktrees"])?;
    let dir = ctx.dir.canonicalize().map_err(|e| e.to_string())?;
    let core = trees
        .iter()
        .find(|t| {
            t["path"]
                .as_str()
                .is_some_and(|s| Path::new(s).canonicalize().is_ok_and(|p| p == dir))
        })
        .ok_or("coordinator is not an Orca worktree")?;
    let find = |b: &str| {
        trees
            .iter()
            .find(|t| repo(t) == repo(core) && branch(t) == b)
    };
    let child = find(&n.branch);
    let parent = if n.stack == format!("{}-core", field(&ctx.plan["effort"], "slug")?) {
        core.clone()
    } else {
        let lane = format!(
            "{}{}",
            field(ctx.install.config.settings(), "branch_prefix")?,
            n.stack
        );
        if let Some(tree) = find(&lane) {
            if tree["parentWorktreeId"] != core["id"] {
                return Err("lane worktree has the wrong parent".into());
            }
            tree.clone()
        } else {
            if child.is_some() {
                return Err("the child worktree has no lane parent".into());
            }
            let base = if n.lower.starts_with("origin/") {
                n.lower.clone()
            } else {
                format!("origin/{}", n.target)
            };
            create(&n.stack, &lane, core, &base, "skip")?
        }
    };
    let tree = if let Some(tree) = child {
        if tree["parentWorktreeId"] != parent["id"] {
            return Err("child worktree has the wrong parent".into());
        }
        tree.clone()
    } else {
        create(&n.child, &n.branch, &parent, &n.lower, "run")?
    };
    if branch(&tree) != n.branch {
        return Err("Orca created a worktree on a different branch".into());
    }
    let path = Path::new(field(&tree, "path")?)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    check(ctx, &path, n)?;
    let id = field(&tree, "id")?;
    ctx.change(k, "dispatch", |r| {
        r["worktree"] = id.into();
        r["path"] = json!(path);
        r["step"] = "track".into();
        Ok(())
    })?;
    request(&[
        "worktree",
        "set",
        "--worktree",
        &format!("id:{id}"),
        "--display-name",
        &n.display,
    ])?;
    if !tracked(&path, n) {
        output(
            Command::new("st")
                .current_dir(&path)
                .args(["branch", "track", "--parent", &n.parent]),
        )?;
    }
    if !tracked(&path, n) {
        return Err("stax did not track the branch on its parent".into());
    }
    Ok(())
}
