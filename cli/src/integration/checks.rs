use super::*;
use crate::{
    automation::machine,
    diagnostics::{self, Lines, MappedIssue},
    state, workflow,
};
use serde_json::{Value, json};
use std::{collections::BTreeSet, process::Command, time::Duration};

fn finding(lines: &mut Lines, level: &str, name: &str, message: impl std::fmt::Display) {
    lines.push((level.into(), format!("{name}: {message}")));
}
fn report(lines: Lines) -> Output {
    Output {
        status: u8::from(lines.iter().any(|(l, _)| l == "FAIL")),
        stdout: lines
            .into_iter()
            .map(|(l, m)| format!("{l} {m}"))
            .collect::<Vec<_>>()
            .join("\n"),
        ..Default::default()
    }
}
fn exec(dir: &Path, cmd: &str, args: &[&str]) -> Result<String, String> {
    machine::output(
        Command::new(cmd).current_dir(dir).args(args),
        Duration::from_secs(30),
    )
    .map(|s| s.trim().into())
    .map_err(|e| e.to_string().replace('\n', " "))
}
fn workflow_checks(
    install: &Installation,
    dir: &Path,
    plan: &Value,
    lines: &mut Lines,
) -> Result<(), String> {
    let mut api = workflow::client(install, plan)?.for_diagnostics();
    api.request("{ viewer { id } }", json!({}))?;
    let team = plan["effort"]["team"].as_str().ok_or("missing team")?;
    let setup = if !state::load_keymap(dir).map_err(|e| e.to_string())?["collab"].is_null() {
        format!(
            "wg setup --workspace {} --apply",
            machine::quote(machine::text(&plan["effort"]["workspace"]))
        )
    } else {
        "wg setup".into()
    };
    team_checks(
        &mut api,
        team,
        machine::text(&install.config.settings()["human"]),
        &setup,
        lines,
    )
}

pub(crate) fn team_checks(
    api: &mut workflow::Linear,
    team: &str,
    human: &str,
    setup: &str,
    lines: &mut Lines,
) -> Result<(), String> {
    let result=api.request("query($k:String!){teams(filter:{key:{eq:$k}}){nodes{id states(first:50){nodes{id name}}}}}",json!({"k":team}))?;
    let Some(id) = result["teams"]["nodes"][0]["id"].as_str() else {
        finding(
            lines,
            "FAIL",
            "linear",
            format!("team {team} not found. Run wg setup."),
        );
        return Ok(());
    };
    let labels=api.pages("query($id:String!,$after:String){team(id:$id){labels(first:100,after:$after){nodes{id name} pageInfo{hasNextPage endCursor}}}}",json!({"id":id}),"/team/labels")?;
    let mut missing: BTreeSet<_> = ["agent:codex", "agent:claude", "agent:coordinator"]
        .into_iter()
        .map(String::from)
        .collect();
    for label in labels {
        if let Some(name) = label["name"].as_str() {
            missing.remove(name);
        }
    }
    if !missing.is_empty() {
        let labels=api.pages("query($names:[String!],$after:String){issueLabels(first:100,after:$after,filter:{name:{in:$names}}){nodes{name team{id}} pageInfo{hasNextPage endCursor}}}",json!({"names":missing}),"/issueLabels")?;
        for label in labels {
            if label["team"].is_null()
                && let Some(name) = label["name"].as_str()
            {
                missing.remove(name);
            }
        }
    }
    let contract: Value =
        serde_json::from_str(include_str!("../../../skills/work-graph/contract.json"))
            .map_err(|e| e.to_string())?;
    let expected: Vec<_> = contract["setup"]["statuses"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| {
            (
                s["name"].as_str().unwrap().replace("{name}", human),
                s["type"].as_str().unwrap(),
            )
        })
        .collect();
    let optional = ["Triage", "Backlog", "Duplicate"];
    let known = result["teams"]["nodes"][0]["states"]["nodes"]
        .as_array()
        .ok_or("invalid team states")?;
    for (name, _) in &expected {
        if !optional.contains(&name.as_str()) && !known.iter().any(|s| s["name"] == *name) {
            missing.insert(name.clone());
        }
    }
    if missing.is_empty() {
        finding(
            lines,
            "ok",
            "linear",
            format!("{team} workflow and agent labels"),
        )
    } else {
        finding(
            lines,
            "FAIL",
            "linear",
            format!(
                "{team} missing {}. Run {setup}.",
                missing.into_iter().collect::<Vec<_>>().join(", ")
            ),
        )
    }
    let states = match api.pages(
        "query($id:String!,$after:String){team(id:$id){states(first:100,after:$after){nodes{id name type} pageInfo{hasNextPage endCursor}}}}",
        json!({"id": id}),
        "/team/states",
    ) {
        Ok(states) => states,
        Err(e) => {
            finding(lines, "warn", "linear", format!("{team} could not check status types. Run wg setup. {e}"));
            return Ok(());
        }
    };
    let absent: BTreeSet<_> = optional
        .into_iter()
        .filter(|n| !states.iter().any(|s| s["name"] == *n))
        .collect();
    if !absent.is_empty() {
        finding(
            lines,
            "warn",
            "linear",
            format!(
                "{team} missing {}. Run wg setup.",
                absent.into_iter().collect::<Vec<_>>().join(", ")
            ),
        );
    }
    for (name, kind) in expected {
        if let Some(state) = states.iter().find(|s| s["name"] == name)
            && state["type"] != kind
        {
            // Only workflow state types are suitable for display in diagnostics.
            let actual = state["type"]
                .as_str()
                .filter(|v| {
                    matches!(
                        *v,
                        "triage"
                            | "backlog"
                            | "unstarted"
                            | "started"
                            | "completed"
                            | "canceled"
                            | "duplicate"
                    )
                })
                .unwrap_or("unknown");
            finding(
                lines,
                "warn",
                "linear",
                format!("{team} {name} has type {actual}, expected {kind}. Run wg setup."),
            );
        }
    }
    Ok(())
}

fn base_problem(dir: &Path, branch: &str, parent: &str) -> Result<(), String> {
    let data = exec(
        dir,
        "gh",
        &[
            "pr",
            "list",
            "--head",
            branch,
            "--state",
            "open",
            "--json",
            "number,baseRefName,commits",
        ],
    )?;
    let prs: Vec<Value> = serde_json::from_str(&data).map_err(|e| e.to_string())?;
    let Some(pr) = prs.first() else { return Ok(()) };
    let base = pr["baseRefName"].as_str().ok_or("missing PR base")?;
    let n = pr["number"].as_u64().ok_or("missing PR number")?;
    if !parent.is_empty() && parent != base {
        return Err(format!(
            "PR #{n} of {branch} targets {base}, but its stax parent is {parent}"
        ));
    }
    let count = exec(
        dir,
        "git",
        &[
            "rev-list",
            "--count",
            &format!("origin/{base}..origin/{branch}"),
        ],
    )?;
    let commits = pr["commits"].as_array().map_or(0, Vec::len);
    if count != commits.to_string() {
        return Err(format!(
            "PR #{n} of {branch} carries {commits} commits on GitHub, but the branch has {count} over origin/{base}: rebase only its own commits onto origin/{base}"
        ));
    }
    if exec(
        dir,
        "gh",
        &[
            "api",
            &format!("repos/{{owner}}/{{repo}}/pulls/{n}"),
            "--jq",
            ".stack.number // empty",
        ],
    )
    .is_ok_and(|s| !s.is_empty())
    {
        return Err(format!(
            "PR #{n} of {branch} is in native GitHub stack: st stack unlink it"
        ));
    }
    Ok(())
}

pub(crate) fn preflight(
    install: &Installation,
    dir: &Path,
    plan: &Value,
    phase: Option<&str>,
) -> Result<Output, String> {
    let phases: Vec<_> = plan["phases"]
        .as_array()
        .ok_or("missing phases")?
        .iter()
        .filter(|p| {
            phase.is_none_or(|k| {
                p["key"] == k || p["key"].as_i64().is_some_and(|n| n.to_string() == k)
            })
        })
        .collect();
    if let Some(k) = phase
        && phases.is_empty()
    {
        return Err(format!("unknown phase {k}"));
    }
    let mut lines = vec![];
    let cfg = install.config.report(None).map_err(|e| e.to_string())?;
    let errors = crate::local::plan_findings(plan, &cfg);
    if errors.is_empty() {
        finding(&mut lines, "ok", "plan", "valid")
    } else {
        finding(&mut lines, "FAIL", "plan", errors.join("; "))
    }
    let mut errors = vec![];
    for (tool, args) in [
        ("git", &["rev-parse", "--git-dir"][..]),
        ("gh", &["auth", "status"]),
        ("st", &["--version"]),
    ] {
        if let Err(e) = exec(dir, tool, args) {
            errors.push(format!("{tool}: {e}"))
        }
    }
    if errors.is_empty() {
        finding(&mut lines, "ok", "tools", "git, gh, st")
    } else {
        finding(&mut lines, "FAIL", "tools", errors.join("; "))
    }
    if let Err(e) = workflow_checks(install, dir, plan, &mut lines) {
        finding(&mut lines, "FAIL", "linear", e)
    }
    let release = &cfg["config"]["release_branch"];
    let trunk = if phases
        .iter()
        .any(|p| &p["target"] != release && release != crate::local::final_base(p))
    {
        exec(dir, "git", &["cat-file", "-p", "refs/stax/trunk"]).unwrap_or_default()
    } else {
        String::new()
    };
    let metadata = |branch: &str| {
        exec(
            dir,
            "git",
            &["cat-file", "-p", &format!("refs/branch-metadata/{branch}")],
        )
        .ok()
        .map(|s| serde_json::from_str::<Value>(&s).unwrap_or(Value::Null))
    };
    for p in phases {
        let target = p["target"].as_str().unwrap_or("");
        let title = format!(
            "phase {} targets {target}",
            p["key"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| p["key"].to_string())
        );
        let (level, detail) = if release == target
            || (crate::local::integration_target(target) && release == crate::local::final_base(p))
        {
            ("ok", "no stax".into())
        } else if trunk.is_empty() {
            finding(
                &mut lines,
                "FAIL",
                "trunk",
                format!("{title}, but the stax trunk is not set"),
            );
            continue;
        } else if trunk == target {
            ("ok", "stax trunk".into())
        } else {
            let integration = crate::local::integration_target(target);
            let branch = if integration { "main" } else { target };
            let meta = metadata(branch).unwrap_or_default();
            if branch != trunk
                && !(meta["frozen"] == true
                    && meta["sourceRemote"].as_str().is_some_and(|s| !s.is_empty()))
            {
                finding(
                    &mut lines,
                    "FAIL",
                    "trunk",
                    format!(
                        "{title}, but the stax trunk is {trunk} and {branch} is not an imported, frozen stax branch\n  ask {} to run, in the checkout that holds {branch}: st get {branch} --parent {trunk} --no-checkout --downstack --no-restack && st freeze {branch}",
                        machine::text(&cfg["config"]["human"])
                    ),
                );
                continue;
            }
            if integration {
                if metadata(target).is_some_and(|m| m["frozen"] != true) {
                    (
                        "FAIL",
                        format!(
                            "the integration branch is tracked but not frozen (st freeze {target})"
                        ),
                    )
                } else {
                    ("ok", "integration branch on main".into())
                }
            } else {
                let parent = machine::text(&meta["parentBranchName"]);
                finding(
                    &mut lines,
                    "ok",
                    "trunk",
                    format!(
                        "{title}: frozen base{}",
                        if parent.is_empty() {
                            String::new()
                        } else {
                            format!(" under {parent}")
                        }
                    ),
                );
                match base_problem(dir, branch, parent) {
                    Ok(()) => finding(
                        &mut lines,
                        "ok",
                        "base",
                        format!("{branch} sits on its PR base"),
                    ),
                    Err(e) => finding(&mut lines, "FAIL", "base", format!("{title}: {e}")),
                }
                continue;
            }
        };
        finding(&mut lines, level, "trunk", format!("{title}: {detail}"));
    }
    Ok(report(lines))
}

pub(super) fn doctor(
    install: &Installation,
    dir: Option<&Path>,
    fix: bool,
) -> Result<Output, String> {
    let config = install.config.settings();
    let roots = config["tick_roots"]
        .as_array()
        .ok_or("invalid tick_roots")?
        .iter()
        .filter_map(|v| v.as_str().map(PathBuf::from))
        .collect::<Vec<_>>();
    let plan = dir.map(|p| install.config.load_plan(p));
    let mut lines = vec![];
    let mut dirs = machine::plans(&roots).map_err(|e| e.to_string())?;
    if let Some(dir) = dir {
        dirs.insert(dir.canonicalize().unwrap_or_else(|_| dir.into()));
    }
    if config["context_limit"] == 0
        && config["coordinator_settings"]
            .as_object()
            .is_none_or(|settings| {
                settings
                    .values()
                    .all(|v| v.as_object().is_none_or(|map| map.is_empty()))
            })
    {
        finding(
            &mut lines,
            "ok",
            "settings",
            "off (no coordinator_settings, context_limit 0)",
        );
    }
    for dir in dirs {
        if !dir.join("plan.json").is_file() || !dir.join("keymap.json").is_file() {
            continue;
        }
        for (file, result, _) in workflow::coordinator_settings(&dir, config, fix) {
            let name = format!("settings {}", dir.display());
            match result {
                Ok(true) if fix => finding(
                    &mut lines,
                    "ok",
                    &name,
                    format!("{file} set; a new session uses it"),
                ),
                Ok(true) => finding(
                    &mut lines,
                    "warn",
                    &name,
                    format!(
                        "{file} lacks the configured values; wg doctor {} --fix",
                        machine::quote(&dir.to_string_lossy())
                    ),
                ),
                Ok(false) => {}
                Err(e) => finding(&mut lines, if fix { "warn" } else { "FAIL" }, &name, e),
            }
        }
    }
    if let Some(result) = &plan {
        match result {
            Ok(p) => {
                let errors = crate::local::plan_findings(
                    p,
                    &install.config.report(None).map_err(|e| e.to_string())?,
                );
                if errors.is_empty() {
                    finding(&mut lines, "ok", "plan", "wg check is clean")
                } else {
                    finding(&mut lines, "FAIL", "plan", errors.join("; "))
                }
            }
            Err(e) => finding(&mut lines, "FAIL", "plan", e),
        }
    }
    let lines = diagnostics::collect_ordered(
        install,
        dir,
        plan.as_ref().and_then(|r| r.as_ref().ok()),
        &roots,
        chrono::Utc::now().timestamp(),
        lines,
        |km| {
            let plan = plan
                .as_ref()
                .and_then(|r| r.as_ref().ok())
                .ok_or("cannot read plan")?;
            let snapshot = workflow::snapshot_using(install, km, || {
                Ok(workflow::client(install, plan)?.for_diagnostics())
            })?;
            let mut issues = std::collections::BTreeMap::new();
            for (key, status) in snapshot.statuses {
                let id = km["nodes"][&key]["id"].as_str().ok_or("missing issue id")?;
                let labels = snapshot.live[id]["labels"]["nodes"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|l| l["name"].as_str().map(str::to_owned))
                    .collect();
                issues.insert(id.into(), MappedIssue { status, labels });
            }
            Ok(issues)
        },
    );
    Ok(report(lines))
}
