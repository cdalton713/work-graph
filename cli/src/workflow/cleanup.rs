//! Remove settled worktrees by Orca ID. Keep branches and live or dirty worktrees.
use super::*;
use crate::state::{PlanLock, load_keymap};
use serde::Deserialize;
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    process::Command,
};

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Tree {
    id: String,
    path: PathBuf,
    branch: Option<String>,
    is_main_worktree: bool,
    #[serde(default)]
    child_worktree_ids: Vec<String>,
}

fn orca(args: &[&str]) -> Result<Value, String> {
    let binary = std::env::var_os("ORCA_CLI_COMMAND").unwrap_or_else(|| "orca".into());
    let out = Command::new(binary)
        .args(args)
        .arg("--json")
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_owned());
    }
    let v: Value = serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())?;
    v.get("result")
        .cloned()
        .ok_or_else(|| "invalid Orca response".into())
}

fn remove(tree: &Tree, label: &str, dry: bool) -> Result<(), String> {
    let out = Command::new("git")
        .current_dir(&tree.path)
        .args(["status", "--porcelain"])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_owned());
    }
    if !out.stdout.is_empty() {
        return Err("it has uncommitted changes".into());
    }
    if !dry {
        orca(&["worktree", "rm", "--worktree", &format!("id:{}", tree.id)])?;
    }
    println!(
        "{} worktree {} ({label})",
        if dry { "would remove" } else { "removed" },
        tree.path.display()
    );
    Ok(())
}

fn removable(tree: &Tree, core: &Path) -> bool {
    !tree.is_main_worktree && tree.path.canonicalize().is_ok_and(|p| p != core)
}

/// A targeted move supplies the node and its confirmed new status. A cleanup command
/// supplies None to inspect all mapped nodes. Returns the count of worktrees kept on error.
pub fn cleanup_worktrees(
    dir: &Path,
    installation: &Installation,
    plan: &Value,
    target: Option<(&str, &str)>,
    dry: bool,
) -> usize {
    match cleanup(dir, installation, plan, target, dry) {
        Ok(kept) => kept,
        Err(e) => {
            eprintln!("warning: worktree cleanup skipped: {e}");
            1
        }
    }
}

fn cleanup(
    dir: &Path,
    installation: &Installation,
    plan: &Value,
    target: Option<(&str, &str)>,
    dry: bool,
) -> Result<usize, String> {
    let core = dir.canonicalize().map_err(|e| e.to_string())?;
    let lock = PlanLock::acquire(dir, None).map_err(|e| e.to_string())?;
    let mut km = load_keymap(dir).map_err(|e| e.to_string())?;
    if let Some((k, _)) = target {
        let row = &km["run"]["nodes"][k];
        if row["worktree_removed"].is_string()
            || (!row["worktree"].is_string() && !row["path"].is_string())
        {
            return Ok(0);
        }
    }
    let mut statuses = snapshot(installation, plan, &km)?.statuses;
    if let Some((k, s)) = target {
        statuses.insert(k.into(), s.into());
    }
    let list = orca(&["worktree", "list", "--limit", "10000"])?;
    if list["truncated"] == true {
        return Err("orca worktree list is truncated".into());
    }
    let mut trees: Vec<Tree> =
        serde_json::from_value(list["worktrees"].clone()).map_err(|e| e.to_string())?;
    let nodes = plan["nodes"].as_array().ok_or("missing nodes")?;
    let mut lanes: BTreeMap<String, Vec<&str>> = BTreeMap::new();
    let mut keys = BTreeSet::new();
    for n in nodes {
        let k = n["key"].as_str().ok_or("missing key")?;
        keys.insert(k);
        if n["kind"] != "task" || n["role"] == "integration" {
            continue;
        }
        let Some(slug) = plan["effort"]["slug"].as_str() else {
            continue;
        };
        let phase = command::display(&n["phase"]);
        let first = command::display(&plan["phases"][0]["key"]);
        let lane = n["lane"].as_str().ok_or("missing lane")?;
        let stack = if n["role"] == "sync" {
            format!("{slug}-p{phase}-sync")
        } else if phase == first {
            format!("{slug}-{lane}")
        } else {
            format!("{slug}-p{phase}-{lane}")
        };
        lanes.entry(stack).or_default().push(k);
    }
    let mut kept = 0;
    let mut changed = false;
    for k in keys {
        let row = &km["run"]["nodes"][k];
        if target.is_some_and(|(key, _)| key != k)
            || !matches!(statuses.get(k).map(String::as_str), Some("Merged" | "Done"))
            || row["worktree_removed"].is_string()
        {
            continue;
        }
        let id = row["worktree"].as_str();
        let path = row["path"].as_str().map(Path::new);
        if id.is_none() && path.is_none() {
            continue;
        }
        let index = trees
            .iter()
            .position(|w| Some(w.id.as_str()) == id)
            .or_else(|| trees.iter().position(|w| Some(w.path.as_path()) == path));
        let stamp = if let Some(index) = index {
            let tree = &trees[index];
            if !removable(tree, &core) {
                continue;
            }
            let result = if matches!(
                row["state"].as_str(),
                Some("creating" | "starting" | "running")
            ) {
                Err(format!(
                    "a {} job is live",
                    row["job"].as_str().unwrap_or("-")
                ))
            } else {
                remove(tree, k, dry)
            };
            if let Err(e) = result {
                eprintln!("warning: {k}: worktree {} stays: {e}", tree.path.display());
                kept += 1;
                continue;
            }
            trees.remove(index);
            chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
        } else {
            "gone".into()
        };
        if !dry {
            km["run"]["nodes"][k]["worktree_removed"] = stamp.into();
            changed = true;
        }
    }
    let prefix = installation.config.settings()["branch_prefix"]
        .as_str()
        .ok_or("missing branch prefix")?;
    for (lane, members) in lanes {
        if target.is_some_and(|(k, _)| !members.contains(&k))
            || !members.iter().all(|k| {
                matches!(
                    statuses.get(*k).map(String::as_str),
                    Some("Merged" | "Done" | "Canceled")
                )
            })
        {
            continue;
        }
        let branch = format!("{prefix}{lane}");
        let Some(tree) = trees.iter().find(|w| {
            w.branch
                .as_deref()
                .map(|s| s.strip_prefix("refs/heads/").unwrap_or(s))
                == Some(&branch)
        }) else {
            continue;
        };
        if !removable(tree, &core)
            || trees
                .iter()
                .any(|w| tree.child_worktree_ids.contains(&w.id))
        {
            continue;
        }
        if let Err(e) = remove(tree, &format!("lane {lane}"), dry) {
            eprintln!(
                "warning: lane {lane}: worktree {} stays: {e}",
                tree.path.display()
            );
            kept += 1;
        }
    }
    if changed {
        lock.save_keymap(&km).map_err(|e| e.to_string())?;
    }
    Ok(kept)
}
