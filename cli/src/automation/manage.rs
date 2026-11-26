//! Orca automations for the coordinator and status check.
use super::{
    arguments::{Autostart, Health},
    machine::*,
};
use crate::state::{Config, load_keymap};
use serde_json::{Value, json};
use std::{env, path::Path, process::Command, time::Duration};

fn required<'a>(obj: &'a Value, key: &str) -> Result<&'a str> {
    obj[key]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("missing {key}").into())
}
fn call(args: &[String]) -> Result<Value> {
    orca(&args.iter().map(String::as_str).collect::<Vec<_>>())
}
fn precheck(program: &Path, args: &[&str]) -> String {
    let path = env::var("PATH")
        .unwrap_or_default()
        .split(':')
        .filter(|s| !s.is_empty() && !s.contains("/.cache/uv/"))
        .collect::<Vec<_>>()
        .join(":");
    let command = std::iter::once(program.to_string_lossy().into_owned())
        .chain(args.iter().map(|s| s.to_string()))
        .map(|s| quote(&s))
        .collect::<Vec<_>>()
        .join(" ");
    format!(
        "env PATH={} ORCA_CLI_COMMAND={} {command}",
        quote(&path),
        quote(&orca_path().to_string_lossy())
    )
}
fn installed() -> Result<Vec<Value>> {
    orca(&["agent", "installed"])?["agents"]
        .as_array()
        .cloned()
        .ok_or_else(|| "missing installed agents".into())
}
fn create(
    name: &str,
    trigger: &str,
    prompt: &str,
    provider: &str,
    tree: &str,
    precheck: &str,
    extra: &str,
) -> Result<String> {
    let mut args = [
        "automations",
        "create",
        "--name",
        name,
        "--trigger",
        trigger,
        "--prompt",
        prompt,
        "--provider",
        provider,
        "--workspace",
        &format!("id:{tree}"),
        "--precheck",
        precheck,
        "--precheck-timeout",
        "120",
        "--fresh-session",
    ]
    .map(str::to_string)
    .to_vec();
    if !extra.is_empty() {
        args.push(format!("--extra-agent-args={extra}"))
    }
    let result = call(&args)?;
    result.get("automation").unwrap_or(&result)["id"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "orca automations create returned no id".into())
}

pub fn autostart(args: &Autostart, config: &Config, program: &Path) -> Result<String> {
    let dir = &args.dir;
    let here = dir.canonicalize()?.display().to_string();
    let row = &load_keymap(dir)?["run"]["effort"];
    let current = row["autostart"].as_str();
    if args.uninstall {
        if let Some(id) = current {
            orca(&["automations", "remove", id])?;
            save_fields(
                dir,
                &[
                    ("autostart", Value::Null),
                    ("autostart_configured", Value::Null),
                ],
            )?;
        }
        return Ok("autostart off".into());
    }
    let report = config.report(Some(dir))?;
    let mut settings = report["agents"]["coordinator"].clone();
    if let Some(agent) = &args.agent {
        if settings["agent"].as_str().is_some_and(|s| s != agent) {
            settings = json!({})
        }
        settings["agent"] = json!(agent);
    }
    for (field, value) in [("model", &args.model), ("effort", &args.effort)] {
        if let Some(v) = value {
            if v.is_empty()
                || v.starts_with('-')
                || v.chars().any(|c| c.is_whitespace() || c.is_control())
            {
                return Err(format!("agents.coordinator.{field}: must be nonempty text with no leading dash, spaces, or control characters").into());
            }
            settings[field] = json!(v);
        }
    }
    if settings["effort"].is_string() && !settings["model"].is_string() {
        return Err("agents.coordinator.effort: needs a model".into());
    }
    let configured = settings.as_object().is_some_and(|s| !s.is_empty());
    if !args.install {
        let mut result = String::new();
        if configured {
            let pairs = settings
                .as_object()
                .unwrap()
                .iter()
                .map(|(k, v)| format!("{k}={}", quote(text(v))))
                .collect::<Vec<_>>()
                .join(" ");
            result = format!("coordinator settings: {pairs}\n");
        }
        if let Some(id) = current {
            let shown = orca(&["automations", "show", id])?;
            let state = if shown["automation"]["enabled"] == false {
                "disabled"
            } else {
                "on"
            };
            result.push_str(&format!(
                "autostart {state}: automation {id}, every 5 minutes"
            ));
        } else {
            result.push_str("autostart off")
        }
        return Ok(result);
    }
    let plan = config.load_plan(dir)?;
    let prompt = autostart_prompt(&here, text(&report["config"]["human"]));
    let check = precheck(program, &["wake", &here]);
    let provider = || -> Result<String> {
        if let Some(agent) = settings["agent"].as_str() {
            return Ok(agent.into());
        }
        Ok(installed()?
            .iter()
            .find(|a| a["default"] == true)
            .and_then(|a| a["id"].as_str())
            .unwrap_or("claude")
            .into())
    };
    let extra = |agent: &str| {
        let mut args = vec![];
        if let Some(model) = settings["model"].as_str() {
            args.extend(["--model".into(), quote(model)]);
        }
        if let Some(effort) = settings["effort"].as_str() {
            if agent == "codex" {
                args.extend([
                    "-c".into(),
                    quote(&format!("model_reasoning_effort={effort}")),
                ]);
            } else {
                args.extend(["--effort".into(), quote(effort)]);
            }
        }
        args.join(" ")
    };
    let configured_value = if configured { json!(true) } else { Value::Null };
    if let Some(id) = current {
        let mut args = [
            "automations",
            "edit",
            id,
            "--precheck",
            &check,
            "--prompt",
            &prompt,
            "--enabled",
        ]
        .map(str::to_string)
        .to_vec();
        let change = configured || row["autostart_configured"] == true;
        if change {
            let agent = provider()?;
            args.extend([
                "--provider".into(),
                agent.clone(),
                format!("--extra-agent-args={}", extra(&agent)),
            ]);
        }
        call(&args)?;
        if change {
            save_fields(dir, &[("autostart_configured", configured_value)])?
        }
        return Ok(format!(
            "autostart on: automation {id}, every 5 minutes (updated)"
        ));
    }
    let tree = orca(&["worktree", "show", "--worktree", &format!("path:{here}")])?;
    let agent = provider()?;
    let id = create(
        &format!("wg coordinator: {}", text(&plan["effort"]["name"])),
        "*/5 * * * *",
        &prompt,
        &agent,
        required(&tree["worktree"], "id")?,
        &check,
        &extra(&agent),
    )?;
    save_fields(
        dir,
        &[
            ("autostart", json!(id)),
            ("autostart_configured", configured_value),
        ],
    )?;
    Ok(format!(
        "autostart on: automation {id}, every 5 minutes, agent {agent}"
    ))
}
fn autostart_prompt(plan_dir: &str, human: &str) -> String {
    format!(
        r#"You are the work-graph coordinator of the effort in {plan_dir}. `wg autostart` started you: `wg next` has work and no coordinator was running. Load the work-graph skill. Run `wg next {plan_dir}` first. For the verb of each `do` and `wait` line, read `wg explain <verb>` before you act on it; do not read references/coordinator.md as a whole. Act on each line, until the effort is complete or a line needs {human}. Then wait as references/coordinator.md "Wait" says (`wg explain human` prints it): one `wg next {plan_dir} --wait` in the background, then end the turn. Do not ask for the autonomy level or the review effort: this run uses the project's current levels (`wg autonomy {plan_dir}`, `wg review-effort {plan_dir}`), as setup.md "Autostart" says."#
    )
}
fn health_prompt(plan_dir: &str, worktree: &str) -> String {
    format!(
        r#"You are the work-graph status check of the effort in {plan_dir}. `wg health` started you. You are read only: edit no file in {plan_dir} or in a repository, move no issue, add no comment or label, send no message to an agent, and run only the wg commands that references/health.md names, each with WG_LINK=off. Load the work-graph skill and read references/health.md (`wg explain health-check` prints it). Do its checks. Write the findings as JSON to a new file in {worktree}/.wg-health/, run `wg health {plan_dir} --report <file>` once, print its last line, and end."#
    )
}

fn repo(tree: &Value) -> &str {
    tree["repoId"]
        .as_str()
        .unwrap_or_else(|| text(&tree["id"]).split("::").next().unwrap_or_default())
}

pub fn health_schedule(args: &Health, config: &Config, program: &Path) -> Result<String> {
    let dir = &args.dir;
    let here = dir.canonicalize()?;
    let km = load_keymap(dir)?;
    let row = &km["run"]["effort"];
    let current = row["health_automation"].as_str();
    let report = config.report(Some(dir))?;
    let cfg = &report["config"];
    if args.uninstall {
        if let Some(id) = current {
            orca(&["automations", "remove", id])?;
        }
        save_fields(dir, &[("health_automation", Value::Null)])?;
        let tail = row["health_worktree"]
            .as_str()
            .map(|s| format!("; the worktree {s} stays (orca worktree rm to remove it)"))
            .unwrap_or_default();
        return Ok(format!("health off{tail}"));
    }
    if !args.install {
        let last = if let Some(value) = row["health"].as_str() {
            format!(
                "last check {value} at {}",
                row["health_at"].as_str().unwrap_or("None")
            )
        } else {
            "no check yet".into()
        };
        let Some(id) = current else {
            return Ok(format!("health off; {last}"));
        };
        let shown = orca(&["automations", "show", id])?;
        let state = if shown["automation"]["enabled"] == false {
            "disabled"
        } else {
            "on"
        };
        return Ok(format!(
            "health {state}: automation {id}, each hour, interval {} hours; {last}",
            cfg["health_interval"]
                .as_f64()
                .ok_or("invalid health interval")?
        ));
    }
    let plan = config.load_plan(dir)?;
    let slug = plan["effort"]["slug"]
        .as_str()
        .ok_or("effort.slug is missing in plan.json")?;
    let listed = orca(&["worktree", "list", "--limit", "10000"])?;
    if listed["truncated"] == true {
        return Err("orca worktree list is truncated".into());
    }
    let trees = listed["worktrees"].as_array().ok_or("missing worktrees")?;
    let core = trees
        .iter()
        .find(|t| {
            Path::new(text(&t["path"]))
                .canonicalize()
                .is_ok_and(|p| p == here)
        })
        .ok_or_else(|| format!("{} is not an Orca worktree", here.display()))?;
    let branch = format!("{}{slug}-health", text(&cfg["branch_prefix"]));
    let tree = if let Some(t) = trees.iter().find(|t| {
        repo(t) == repo(core) && text(&t["branch"]).trim_start_matches("refs/heads/") == branch
    }) {
        t.clone()
    } else {
        let current = output(
            Command::new("git")
                .current_dir(dir)
                .args(["branch", "--show-current"]),
            Duration::from_secs(30),
        )
        .unwrap_or_default();
        let base = if current.trim().is_empty() {
            "HEAD"
        } else {
            current.trim()
        };
        orca(&[
            "worktree",
            "create",
            "--name",
            &format!("{slug}-health"),
            "--branch",
            &branch,
            "--parent-worktree",
            &format!("id:{}", required(core, "id")?),
            "--base-branch",
            base,
            "--setup",
            "skip",
        ])?["worktree"]
            .clone()
    };
    let worktree = std::path::absolute(required(&tree, "path")?)?
        .display()
        .to_string();
    let agent = required(cfg, "health_agent")?;
    let mut agents = installed()?
        .iter()
        .filter_map(|a| a["id"].as_str().map(String::from))
        .collect::<Vec<_>>();
    agents.sort();
    if !agents.iter().any(|s| s == agent) {
        return Err(format!(
            "config health_agent '{agent}' is not an installed Orca agent ({})",
            if agents.is_empty() {
                "none".into()
            } else {
                agents.join(", ")
            }
        )
        .into());
    }
    let here = here.display().to_string();
    let check = precheck(program, &["health", &here, "--due"]);
    let prompt = health_prompt(&here, &worktree);
    if let Some(id) = current {
        orca(&[
            "automations",
            "edit",
            id,
            "--precheck",
            &check,
            "--prompt",
            &prompt,
            "--enabled",
        ])?;
        save_fields(dir, &[("health_worktree", json!(worktree))])?;
        return Ok(format!(
            "health on: automation {id}, each hour (updated), worktree {worktree}"
        ));
    }
    let id = create(
        &format!("wg health: {}", text(&plan["effort"]["name"])),
        "0 * * * *",
        &prompt,
        agent,
        required(&tree, "id")?,
        &check,
        "",
    )?;
    save_fields(
        dir,
        &[
            ("health_worktree", json!(worktree)),
            ("health_automation", json!(id)),
        ],
    )?;
    Ok(format!(
        "health on: automation {id}, each hour, agent {agent}, worktree {worktree}"
    ))
}
