use super::lifecycle::{Context, field};
use super::*;
use sha2::{Digest, Sha256};

pub(super) fn gh(dir: &Path, args: &[&str]) -> Result<Value, String> {
    serde_json::from_str(&output(Command::new("gh").current_dir(dir).args(args))?)
        .map_err(|e| e.to_string())
}

fn patch(dir: &Path, lower: &str) -> Result<String, String> {
    let out = Command::new("git")
        .args([
            "diff",
            "--binary",
            "--no-color",
            "--no-ext-diff",
            "--no-renames",
            &format!("{lower}...HEAD"),
        ])
        .current_dir(dir)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().into());
    }
    if out.stdout.is_empty() {
        return Ok("empty".into());
    }
    let mut digest = Sha256::new();
    for line in out.stdout.split_inclusive(|b| *b == b'\n') {
        if !line.starts_with(b"index ") {
            digest.update(if line.starts_with(b"@@ ") {
                b"@@\n"
            } else {
                line
            });
        }
    }
    Ok(format!("{:x}", digest.finalize())[..40].into())
}

pub(super) fn run(ctx: &Context, key: &str, cwd: &Path) -> Result<u8, String> {
    let node = ctx.node(key)?;
    let km = ctx.km()?;
    let row = &km["run"]["nodes"][key];
    let required = |f| field(row, f).map_err(|_| format!("{key}: missing run field {f}"));
    let pr = required("pr")?;
    let branch = required("branch")?;
    let parent = required("parent")?;
    let lower = required("lower")?;
    if !pr.starts_with(['1', '2', '3', '4', '5', '6', '7', '8', '9'])
        || !pr.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(format!("{key}: invalid PR number '{pr}'"));
    }
    let mut failed = false;
    let mut check = |name: &str, res: Result<String, String>| match res {
        Ok(detail) => println!("ok {name}: {detail}"),
        Err(detail) => {
            failed = true;
            println!("FAIL {name}: {detail}");
        }
    };
    let info = gh(
        cwd,
        &[
            "pr",
            "view",
            pr,
            "--json",
            "state,baseRefName,headRefName,headRefOid,isDraft",
        ],
    );
    check(
        "pr",
        info.as_ref().map_err(Clone::clone).and_then(|v| {
            let description = format!(
                "#{pr} {} {} -> {}",
                field(v, "state")?,
                field(v, "headRefName")?,
                field(v, "baseRefName")?
            );
            if v["state"] == "OPEN" && v["baseRefName"] == parent && v["headRefName"] == branch {
                Ok(description)
            } else {
                Err(description)
            }
        }),
    );
    if info.is_ok() {
        check(
            "scope",
            (|| {
                let n = list(&gh(cwd, &["pr", "view", pr, "--json", "commits"])?["commits"])?.len();
                let own = git(cwd, &["rev-list", "--count", &format!("{lower}..HEAD")])?;
                if n.to_string() != own {
                    return Err(format!(
                        "PR #{pr} carries {n} commits, the branch has {own} over {lower}"
                    ));
                }
                Ok(format!(
                    "PR #{pr} carries the branch's {own} commits over {lower}"
                ))
            })(),
        );
        check(
            "stack",
            output(Command::new("gh").current_dir(cwd).args([
                "api",
                &format!("repos/{{owner}}/{{repo}}/pulls/{pr}"),
                "--jq",
                ".stack.number // empty",
            ]))
            .and_then(|s| {
                if s.is_empty() {
                    Ok(format!("PR #{pr} is in no native stack"))
                } else {
                    Err(format!("PR #{pr} is in native GitHub stack #{s}"))
                }
            }),
        );
    }
    let sha = info
        .as_ref()
        .ok()
        .and_then(|v| v["headRefOid"].as_str())
        .unwrap_or("");
    let head = (|| {
        let h = git(cwd, &["rev-parse", "HEAD"])?;
        let clean = git(cwd, &["status", "--porcelain"])?.is_empty();
        let detail = format!(
            "HEAD {:.10}, PR {:.10}, tree {}",
            h,
            if sha.is_empty() { "?" } else { sha },
            if clean { "clean" } else { "dirty" }
        );
        if clean && h == sha {
            Ok(detail)
        } else {
            Err(detail)
        }
    })();
    let same = head.is_ok();
    check("head", head);
    if same {
        let tracked = patch(cwd, lower).and_then(|patch| {
            ctx.change(key, "verify", |row| {
                if row["patch"].as_str().map_or_else(
                    || row["code_done_head"].as_str().is_some_and(|s| s != sha),
                    |s| s != patch,
                ) {
                    if matches!(row["review"].as_str(), Some("clean" | "accepted")) {
                        row.as_object_mut().unwrap().remove("review_round");
                    }
                    for f in [
                        "review",
                        "merge_review",
                        "merge_review_seen",
                        "merge_review_patch",
                        "verified_head",
                        "gate",
                    ] {
                        row.as_object_mut().unwrap().remove(f);
                    }
                }
                row["patch"] = patch.into();
                Ok(())
            })
        });
        if let Err(e) = tracked {
            check("patch", Err(e));
        }
    }
    check(
        "tests",
        (|| {
            let bytes = std::fs::read(ctx.dir.join("evidence").join(format!("{key}.json")))
                .map_err(|e| {
                    if e.kind() == std::io::ErrorKind::NotFound {
                        "no evidence".into()
                    } else {
                        e.to_string()
                    }
                })?;
            let rec: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
            if sha.is_empty() || rec["sha"] != sha || rec["valid"] != true {
                return Err("invalid evidence or evidence does not match the PR head".into());
            }
            if !(ctx.plan["effort"].get("test").is_none()
                && matches!(rec["scope"].as_str(), Some("full" | "affected")))
                && rec["command"]
                    != serde_json::json!(evidence::suite(ctx.plan, ctx.install.config.settings())?)
            {
                return Err("the evidence is for another command: run wg evidence again".into());
            }
            if rec["exit"] == 0 {
                return Ok(format!("passed on {sha:.10}"));
            }
            if let Some(why) = row["tests_accepted"]
                .as_str()
                .and_then(|s| s.strip_prefix(&format!("{sha}:")))
                .filter(|s| !s.trim().is_empty())
            {
                return Ok(format!("accepted: {why}"));
            }
            Err(format!("command exit: {}", rec["exit"]))
        })(),
    );
    if node["role"] != "integration" {
        check(
            "owns",
            (|| {
                let files = git(cwd, &["diff", "--name-only", &format!("{lower}...HEAD")])?;
                if node["owns"].as_array().is_none_or(Vec::is_empty) {
                    return Err("node has no owns".into());
                }
                let patterns = ["owns", "shares"]
                    .into_iter()
                    .filter_map(|f| node[f].as_array())
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(glob::Pattern::new)
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| e.to_string())?;
                if files.lines().all(|f| patterns.iter().any(|p| p.matches(f))) {
                    Ok("diff stays in owns/shares".into())
                } else {
                    Err("files outside owns/shares".into())
                }
            })(),
        );
    }
    check(
        "checks",
        (|| {
            let r = Command::new("gh")
                .current_dir(cwd)
                .args(["pr", "checks", pr, "--json", "name,bucket"])
                .output()
                .map_err(|e| e.to_string())?;
            let err = String::from_utf8_lossy(&r.stderr);
            if r.stdout.is_empty() {
                return if r.status.success()
                    || r.status.code() == Some(1)
                        && err.to_lowercase().contains("no checks reported")
                {
                    Ok("no checks".into())
                } else {
                    Err(err.trim().into())
                };
            }
            let checks: Vec<Value> =
                serde_json::from_slice(&r.stdout).map_err(|e| e.to_string())?;
            let failures: Vec<_> = checks
                .iter()
                .filter(|c| c["bucket"] == "fail")
                .filter_map(|c| c["name"].as_str())
                .collect();
            if !failures.is_empty() {
                return Err(failures.join(", "));
            }
            if !matches!(r.status.code(), Some(0 | 1 | 8)) {
                return Err(err.trim().into());
            }
            let pending = checks.iter().filter(|c| c["bucket"] == "pending").count();
            Ok(if pending > 0 {
                format!("no failed checks ({pending} pending)")
            } else {
                "no failed checks".into()
            })
        })(),
    );
    ctx.change(key, "verify", |r| {
        if failed {
            if !sha.is_empty() && r["code_done_head"] == sha {
                r.as_object_mut().unwrap().remove("code_done_head");
                println!("{key}: {sha:.10} is no longer code done");
            }
        } else {
            r["code_done_head"] = sha.into();
            println!("code done: {key} #{pr} {sha:.10}");
        }
        Ok(())
    })?;
    Ok(u8::from(failed))
}
