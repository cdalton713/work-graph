use super::*;
use std::collections::BTreeSet;
use std::fs::OpenOptions;

pub(super) fn run(
    dir: &Path,
    installation: &Installation,
    plan: &Value,
    phase: Option<&str>,
) -> Result<u8, String> {
    let mut seen = BTreeSet::new();
    let mut failed = false;
    for p in list(&plan["phases"])? {
        if phase.is_some_and(|s| !super::phase_matches(&p["key"], s)) {
            continue;
        }
        let target = p["target"].as_str().ok_or("missing phase target")?;
        if !seen.insert(target) {
            continue;
        }
        let result = if installation.config.settings()["release_branch"] == target {
            Ok("no stax".into())
        } else if git(dir, &["cat-file", "-p", "refs/stax/trunk"]).as_deref() == Ok(target) {
            Ok("stax trunk (st sync refreshes it)".into())
        } else if target.starts_with("effort/") {
            Ok("coordinator-owned".into())
        } else {
            refresh(dir, target)
        };
        match result {
            Ok(detail) => println!("ok base {target}: {detail}"),
            Err(e) => {
                println!("FAIL base {target}: {e}");
                failed = true;
            }
        }
    }
    if seen.is_empty() {
        return Err(format!("unknown phase {}", phase.unwrap_or("")));
    }
    Ok(u8::from(failed))
}

fn refresh(dir: &Path, target: &str) -> Result<String, String> {
    let meta = git(
        dir,
        &["cat-file", "-p", &format!("refs/branch-metadata/{target}")],
    )
    .ok()
    .and_then(|s| serde_json::from_str::<Value>(&s).ok())
    .unwrap_or(Value::Null);
    if meta["frozen"] != true || meta["sourceRemote"].as_str().unwrap_or("").is_empty() {
        return Err("not an imported, frozen stax branch (run wg preflight)".into());
    }
    let common = git(
        dir,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(Path::new(&common).join("wg-base.lock"))
        .map_err(|e| e.to_string())?;
    lock.lock().map_err(|e| e.to_string())?;
    let reference = format!("refs/heads/{target}");
    git(dir, &["check-ref-format", &reference])?;
    let old = git(dir, &["rev-parse", "--verify", &reference])?;
    let inventory = git(dir, &["worktree", "list", "--porcelain", "-z"])?;
    let checkout = inventory
        .split("\0\0")
        .find(|block| {
            block
                .split('\0')
                .any(|s| s.strip_prefix("branch ") == Some(&reference))
        })
        .and_then(|block| block.split('\0').next()?.strip_prefix("worktree "));
    git(
        dir,
        &[
            "fetch",
            "--no-tags",
            "--no-recurse-submodules",
            "--refmap=",
            "origin",
            &reference,
        ],
    )?;
    let fetched = git(dir, &["rev-parse", "--verify", "FETCH_HEAD"])?;
    git(dir, &["merge-base", "--is-ancestor", &old, &fetched]).map_err(|e| {
        if e.is_empty() {
            "Not possible to fast-forward, aborting.".into()
        } else {
            e
        }
    })?;
    if let Some(path) = checkout {
        git(
            Path::new(path),
            &["merge", "--ff-only", "--no-autostash", &fetched],
        )?;
        git(
            dir,
            &[
                "update-ref",
                &format!("refs/remotes/origin/{target}"),
                &fetched,
            ],
        )?;
    } else {
        git(
            dir,
            &[
                "fetch",
                "--no-tags",
                "--no-recurse-submodules",
                "origin",
                &format!("{reference}:{reference}"),
            ],
        )?;
    }
    let new = git(dir, &["rev-parse", "--verify", &reference])?;
    let short = |s: &str| s.chars().take(10).collect::<String>();
    Ok(if old == new {
        format!("up to date {}", short(&new))
    } else {
        format!("{} -> {}", short(&old), short(&new))
    })
}
