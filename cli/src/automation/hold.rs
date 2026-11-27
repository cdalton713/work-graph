//! The agent check of a held effort (the page's src/lib/hold.ts has the same record format).
//! `wg tick` asks the coordinator's agent CLI the hold's check question when it is due, and replies on the
//! hold update in Linear only when the result changes. A met check ends the hold on the page as a move of
//! the human; the coordinator stays paused until the human resumes the effort.
use super::machine::*;
use super::production::Effort;
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use std::{path::Path, process::Command, time::Duration};

pub const HOLD_LABEL: &str = "on-hold";
const EVERY_DEFAULT: i64 = 24;
const AGENT_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Debug, Clone, PartialEq)]
pub struct Check {
    pub at: String,
    pub met: bool,
    pub evidence: String,
}
#[derive(Debug, Clone, PartialEq)]
pub struct Hold {
    pub waiting_for: String,
    pub until: Option<String>,
    pub check: Option<String>,
    pub every_hours: i64,
    pub update_id: String,
    pub last_check: Option<Check>,
}

fn one_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The hold fields of a project update body, or None when it is not a hold.
pub fn parse_hold(body: &str, update_id: &str) -> Option<Hold> {
    let lines: Vec<String> = body
        .lines()
        .map(|l| l.replace('\\', "").trim().to_owned())
        .filter(|l| !l.is_empty())
        .collect();
    let waiting_for = lines
        .first()?
        .strip_prefix("On hold. Waiting for: ")?
        .to_owned();
    let mut hold = Hold {
        waiting_for,
        until: None,
        check: None,
        every_hours: EVERY_DEFAULT,
        update_id: update_id.to_owned(),
        last_check: None,
    };
    for line in &lines[1..] {
        if let Some(date) = line.strip_prefix("Until: ")
            && date.len() == 10
        {
            hold.until = Some(date.to_owned());
        }
        if let Some(rest) = line.strip_prefix("Check every ")
            && let Some((hours, question)) = rest.split_once(" h: ")
            && let Ok(hours) = hours.parse::<i64>()
        {
            hold.every_hours = hours.max(1);
            hold.check = Some(question.to_owned());
        }
    }
    Some(hold)
}

/// A check result from the body of a reply on the hold update.
pub fn parse_check(body: &str, at: &str) -> Option<Check> {
    let body = body.trim();
    let (met, rest) = if let Some(rest) = body.strip_prefix("Check met:") {
        (true, rest)
    } else {
        (false, body.strip_prefix("Check not met:")?)
    };
    Some(Check {
        at: at.to_owned(),
        met,
        evidence: one_line(rest),
    })
}

pub fn check_body(met: bool, evidence: &str) -> String {
    format!(
        "Check {}: {}",
        if met { "met" } else { "not met" },
        one_line(evidence)
    )
}

/// The newest hold update of the project's updates, with its newest check result.
pub fn hold_from_updates(updates: &[Value]) -> Option<Hold> {
    let mut updates: Vec<&Value> = updates.iter().collect();
    updates.sort_by(|a, b| text(&b["createdAt"]).cmp(text(&a["createdAt"])));
    let (update, mut hold) = updates
        .into_iter()
        .find_map(|u| parse_hold(text(&u["body"]), text(&u["id"])).map(|h| (u, h)))?;
    hold.last_check = update["comments"]["nodes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|c| parse_check(text(&c["body"]), text(&c["createdAt"])))
        .max_by(|a, b| a.at.cmp(&b.at));
    Some(hold)
}

/// Is a check due? Not when the hold has no question, the check already said met, or the until date
/// came (the page ends the hold then). Else when this hold was never checked here, or `every_hours` passed.
pub fn due(hold: &Hold, last_run: &Value, now: DateTime<Utc>) -> bool {
    if hold.check.is_none() || hold.last_check.as_ref().is_some_and(|c| c.met) {
        return false;
    }
    if let Some(until) = &hold.until
        && until.as_str()
            <= now
                .with_timezone(&chrono::Local)
                .format("%Y-%m-%d")
                .to_string()
                .as_str()
    {
        return false;
    }
    if text(&last_run["update"]) != hold.update_id {
        return true;
    }
    DateTime::parse_from_rfc3339(text(&last_run["at"]))
        .map(|at| now.signed_duration_since(at).num_hours() >= hold.every_hours)
        .unwrap_or(true)
}

/// Post a reply only when the result differs from the newest one on the update.
pub fn changed(last: Option<&Check>, met: bool) -> bool {
    last.is_none_or(|c| c.met != met)
}

/// The question for the agent, with the rules of a read-only check and the answer format.
pub fn prompt(project: &str, hold: &Hold) -> String {
    format!(
        "You check whether an outside wait is over for the project \"{project}\".\n\
         It waits for: {}.\n\
         Question: {}\n\n\
         Use only tools that search or read (connectors, web search, files). Do not send messages, \
         write files, run commands that change anything, or change any record.\n\
         Answer \"met\" only when you found clear evidence. End with one line that holds only this JSON:\n\
         {{\"met\": true or false, \"evidence\": \"one sentence with the source or link\"}}",
        hold.waiting_for,
        hold.check.as_deref().unwrap_or_default()
    )
}

/// The verdict of the agent: the last line of its answer that is a JSON object with a boolean `met`.
pub fn verdict(answer: &str) -> Option<(bool, String)> {
    answer.lines().rev().find_map(|line| {
        let line = line.trim().trim_matches('`');
        let value: Value =
            serde_json::from_str(line.strip_prefix("json").unwrap_or(line).trim()).ok()?;
        Some((value["met"].as_bool()?, one_line(text(&value["evidence"]))))
    })
}

/// The tools that Claude may use without a prompt: the read-only built-in tools, and the tools that config
/// `hold_tools` names (for example `mcp__slack__search`). Every other tool stays denied in print mode.
const READ_TOOLS: [&str; 5] = ["Read", "Grep", "Glob", "WebSearch", "WebFetch"];

pub fn allowed_tools(config: &Value) -> Vec<String> {
    READ_TOOLS
        .iter()
        .map(|t| (*t).to_owned())
        .chain(
            config["hold_tools"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|t| t.as_str())
                .filter(|t| !t.is_empty() && !t.starts_with('-'))
                .map(str::to_owned),
        )
        .collect()
}

/// The headless command of the agent CLI, read-only where the CLI can enforce it.
pub fn agent_command(agent: &str, prompt: &str, dir: &Path, tools: &[String]) -> Result<Command> {
    let mut command = match agent {
        "codex" => {
            let mut c =
                Command::new(executable("codex").ok_or("install codex for the hold check")?);
            c.args([
                "exec",
                "--sandbox",
                "read-only",
                "--skip-git-repo-check",
                prompt,
            ]);
            c
        }
        _ => {
            let mut c =
                Command::new(executable("claude").ok_or("install claude for the hold check")?);
            // Print mode denies each tool that needs a permission; only the allowed list runs.
            c.args(["-p", prompt, "--output-format", "text", "--allowedTools"]);
            c.args(tools);
            c.args(["--disallowedTools", "Bash", "Edit", "Write", "NotebookEdit"]);
            c
        }
    };
    command.current_dir(dir).stdin(std::process::Stdio::null());
    Ok(command)
}

fn read_hold(e: &Effort) -> Result<Option<(String, Hold)>> {
    let data = e.linear()?.request(
        "query($id:String!){project(id:$id){name labels(first:50){nodes{name parent{name}}}
           marks: labels(first:5, filter:{name:{eq:\"on-hold\"}}){nodes{name parent{name}}}
           projectUpdates(first:10){nodes{id body createdAt comments(first:20){nodes{body createdAt}}}}}}",
        json!({"id":e.project()?}),
    )?;
    let project = &data["project"];
    let held = ["labels", "marks"].iter().any(|k| {
        project[k]["nodes"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|l| l["name"] == HOLD_LABEL && l["parent"].is_null())
    });
    if !held {
        return Ok(None);
    }
    let updates = project["projectUpdates"]["nodes"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    Ok(hold_from_updates(&updates).map(|h| (text(&project["name"]).to_owned(), h)))
}

/// Run the hold check of one effort when it is due. Returns a note for the tick log, or None: no hold.
pub fn tick(e: &Effort, record: &mut Value) -> Result<Option<String>> {
    let Some((project, hold)) = read_hold(e)? else {
        if let Some(r) = record.as_object_mut() {
            r.remove("hold");
        }
        return Ok(None);
    };
    let now = Utc::now();
    if !due(&hold, &record["hold"], now) {
        return Ok(Some("hold: no check due".into()));
    }
    let agent = e.install.config.settings()["agents"]["coordinator"]["agent"]
        .as_str()
        .unwrap_or("claude")
        .to_owned();
    let answer = output(
        &mut agent_command(
            &agent,
            &prompt(&project, &hold),
            e.dir,
            &allowed_tools(e.install.config.settings()),
        )?,
        AGENT_TIMEOUT,
    )?;
    // A run that gives no verdict counts as a check, so a broken prompt does not run on every tick.
    record["hold"] = json!({"update": hold.update_id, "at": now.to_rfc3339()});
    let Some((met, evidence)) = verdict(&answer) else {
        return Ok(Some(format!("hold: {agent} gave no verdict")));
    };
    if changed(hold.last_check.as_ref(), met) {
        e.linear()?.request(
            "mutation($i:CommentCreateInput!){commentCreate(input:$i){success}}",
            json!({"i":{"projectUpdateId":hold.update_id,"body":check_body(met, &evidence)}}),
        )?;
    }
    Ok(Some(format!(
        "hold: check {}",
        if met { "met" } else { "not met" }
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    const BODY: &str = "On hold. Waiting for: Shopify app review\n\nUntil: 2026-12-04\n\nCheck every 24 h: Has Shopify replied?";

    #[test]
    fn reads_the_page_format_and_the_newest_result() {
        let hold = parse_hold(BODY, "u").unwrap();
        assert_eq!(hold.waiting_for, "Shopify app review");
        assert_eq!(hold.until.as_deref(), Some("2026-12-04"));
        assert_eq!(hold.check.as_deref(), Some("Has Shopify replied?"));
        assert_eq!(hold.every_hours, 24);
        assert!(parse_hold("Status: on track", "u").is_none());
        let updates = json!([
            {"id":"old","body":"On hold. Waiting for: Old","createdAt":"2026-11-01T00:00:00Z"},
            {"id":"new","body":BODY,"createdAt":"2026-11-27T00:00:00Z","comments":{"nodes":[
                {"body":check_body(false, "no reply"),"createdAt":"2026-11-28T00:00:00Z"},
                {"body":"a person writes","createdAt":"2026-11-29T00:00:00Z"},
                {"body":"Check met: approved","createdAt":"2026-11-28T12:00:00Z"}]}}
        ]);
        let hold = hold_from_updates(updates.as_array().unwrap()).unwrap();
        assert_eq!(hold.update_id, "new");
        assert_eq!(
            hold.last_check,
            Some(Check {
                at: "2026-11-28T12:00:00Z".into(),
                met: true,
                evidence: "approved".into()
            })
        );
    }

    #[test]
    fn a_check_is_due_once_per_interval_until_it_is_met_or_the_date_comes() {
        let now = DateTime::parse_from_rfc3339("2026-11-28T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let hold = parse_hold(BODY, "u").unwrap();
        assert!(due(&hold, &Value::Null, now));
        assert!(due(
            &hold,
            &json!({"update":"other","at":"2026-11-28T11:00:00Z"}),
            now
        ));
        assert!(!due(
            &hold,
            &json!({"update":"u","at":"2026-11-28T00:00:01Z"}),
            now
        ));
        assert!(due(
            &hold,
            &json!({"update":"u","at":"2026-11-27T12:00:00Z"}),
            now
        ));
        let met = Hold {
            last_check: Some(Check {
                at: "t".into(),
                met: true,
                evidence: String::new(),
            }),
            ..hold.clone()
        };
        assert!(!due(&met, &Value::Null, now));
        assert!(!due(
            &Hold {
                check: None,
                ..hold.clone()
            },
            &Value::Null,
            now
        ));
        assert!(!due(
            &Hold {
                until: Some("2026-11-01".into()),
                ..hold
            },
            &Value::Null,
            now
        ));
    }

    #[test]
    fn replies_only_on_a_changed_result_and_reads_the_last_json_line() {
        let no = Check {
            at: "t".into(),
            met: false,
            evidence: String::new(),
        };
        assert!(changed(None, false));
        assert!(!changed(Some(&no), false));
        assert!(changed(Some(&no), true));
        let answer = "I searched Slack.\n{\"met\": false, \"evidence\": \"old\"}\nThen email.\n```json\n{\"met\": true, \"evidence\": \"Shopify approved it in #partners\"}\n```";
        assert_eq!(
            verdict(answer),
            Some((true, "Shopify approved it in #partners".into()))
        );
        assert_eq!(verdict("no json here"), None);
        assert!(
            prompt("P", &parse_hold(BODY, "u").unwrap()).contains("Question: Has Shopify replied?")
        );
        assert_eq!(
            allowed_tools(&json!({"hold_tools":["mcp__slack__search", "--danger", 3]})),
            [
                "Read",
                "Grep",
                "Glob",
                "WebSearch",
                "WebFetch",
                "mcp__slack__search"
            ]
        );
    }
}
