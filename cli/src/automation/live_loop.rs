//! Public coordinator and scheduled refresh entry points.
use super::{
    actions::{Actions, COMPLETE},
    machine::*,
    precheck::{Decision, HealthReads},
    production::Effort,
    *,
};
use crate::{linear::Installation, page::link::Link, workflow};
use chrono::Utc;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    time::Duration,
};

fn note(a: &mut Actions, l: &str, s: String) {
    a.lines.push((l.into(), s))
}
fn label<'a>(labels: &'a [Value], group: &str, default: &'a str) -> &'a str {
    labels
        .iter()
        .find(|l| {
            l["parent"]["name"]
                .as_str()
                .is_some_and(|s| s.eq_ignore_ascii_case(group))
        })
        .and_then(|l| l["name"].as_str())
        .map(|s| s.strip_prefix("review:").unwrap_or(s))
        .unwrap_or(default)
}
fn levels(e: &mut Effort, a: &mut Actions, labels: &[Value]) -> Result<()> {
    let human = text(&e.install.config.settings()["human"]);
    let mut lines = vec![];
    let mut fields = vec![];
    for (group, field, verb, default) in [
        ("autonomy", "autonomy_seen", "autonomy", "standard"),
        ("review", "review_seen", "review", "thorough"),
    ] {
        let value = label(labels, group, default);
        let old = e.km["run"]["effort"][field].as_str();
        if old != Some(value) {
            fields.push((field, json!(value)))
        }
        let changed = old.is_some_and(|s| s != value);
        let detail = if changed {
            let (noun, rule) = if group == "autonomy" {
                (
                    "autonomy level",
                    format!("from now on act as references/autonomy.md says for {value}"),
                )
            } else {
                (
                    "review effort",
                    format!(
                        "from now on review each PR that has not passed its review gate as review-and-merge.md \"Review effort\" says for {value}"
                    ),
                )
            };
            format!(
                "{human} set the {noun} to {value} (was {}); {rule}",
                old.unwrap_or_default()
            )
        } else {
            value.into()
        };
        lines.push((
            if changed { "do" } else { "note" }.into(),
            format!("{verb} @effort -: {detail}"),
        ));
    }
    let paused =
        labels.iter().any(|l| l["name"] == "paused") || e.km["run"]["effort"]["paused"] == "yes";
    let seen = if paused { "yes" } else { "no" };
    if e.km["run"]["effort"]["paused_seen"] != seen {
        fields.push(("paused_seen", json!(seen)));
    }
    if paused {
        let held = a.lines.iter().filter(|(l, _)| l == "do").count();
        a.lines.retain(|(l, _)| l != "do");
        note(
            a,
            "wait",
            format!(
                "paused @effort -: {human} paused this effort on the page; {held} action(s) wait for Resume"
            ),
        );
    } else if e.km["run"]["effort"]["paused_seen"] == "yes"
        || e.km["run"]["effort"]["resumed"] == "yes"
    {
        fields.push(("resumed", Value::Null));
        a.lines.insert(0,("do".into(),format!("resumed @effort -: {human} resumed this effort on the page; acknowledge it and continue the loop")));
    }
    if !fields.is_empty() {
        save_fields(e.dir, &fields)?;
        e.km = crate::state::load_keymap(e.dir)?;
    }
    if a.head != COMPLETE {
        lines.append(&mut a.lines);
        a.lines = lines;
    }
    let row = &e.km["run"]["effort"];
    if matches!(row["health"].as_str(), Some("atRisk" | "offTrack")) {
        note(
            a,
            "note",
            format!(
                "health @effort -: {} at {}, {} fault(s); {}",
                text(&row["health"]),
                row["health_at"].as_str().unwrap_or("?"),
                text(&row["health_faults"])
                    .split(',')
                    .filter(|s| !s.is_empty())
                    .count(),
                row["health_update"].as_str().unwrap_or("no update")
            ),
        );
    }
    Ok(())
}
fn answers(e: &Effort) -> Result<Vec<(String, String)>> {
    let result=e.linear()?.request("query($n:String!){issues(first:50,filter:{labels:{some:{name:{eq:$n}}}}){nodes{id identifier state{name type} labels(first:100){nodes{id name}} comments(first:20){nodes{body createdAt}}}}}",json!({"n":"answered"}))?;
    let mut lines = vec![];
    let human = text(&e.install.config.settings()["human"]);
    let waiting = format!("Needs {human}");
    let label = format!(
        "needs-{}",
        human
            .to_lowercase()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join("-")
    );
    for issue in result["issues"]["nodes"]
        .as_array()
        .ok_or("missing answered issues")?
    {
        if issue["state"]["name"] != waiting
            && !issue["labels"]["nodes"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|l| l["name"] == label)
        {
            continue;
        }
        if let Some((key, _)) = e.km["nodes"]
            .as_object()
            .into_iter()
            .flatten()
            .find(|(_, n)| n["id"] == issue["id"])
        {
            let comment = issue["comments"]["nodes"]
                .as_array()
                .into_iter()
                .flatten()
                .max_by_key(|c| text(&c["createdAt"]))
                .and_then(|c| c["body"].as_str())
                .unwrap_or("(see the issue)");
            lines.push((
                key.clone(),
                format!(
                    "answer {key} {}: {}",
                    text(&issue["identifier"]),
                    comment
                        .lines()
                        .map(str::trim)
                        .collect::<Vec<_>>()
                        .join(" / ")
                ),
            ));
        }
    }
    Ok(lines)
}
struct Run<'a> {
    install: &'a Installation,
    args: &'a arguments::Next,
    link: Option<Link>,
    actions: Option<Actions>,
    page_url: String,
    claims_error: Option<String>,
}
impl Run<'_> {
    fn refresh_effort(&mut self, msgs: &[Value]) -> Result<Refresh> {
        let mut e = Effort::read(self.install, &self.args.dir)?;
        let claims = match workflow::current_claims(self.install, &e.plan, &e.km) {
            Ok(c) => c,
            Err(error) => {
                self.claims_error = Some(error);
                return Ok(Refresh {
                    actionable: false,
                    complete: false,
                    claims_unavailable: true,
                    settled: vec![],
                });
            }
        };
        let snap = e.snapshot()?;
        let mut a = Actions::read(&e, &snap, claims.as_ref())?;
        let mut extra = vec![];
        let mut settled = vec![];
        match answers(&e) {
            Ok(lines) => {
                for (key, line) in lines {
                    if !a.runners.contains_key(&key) {
                        extra.push(("do".into(), line));
                    }
                }
            }
            Err(err) => extra.push((
                "note".into(),
                format!("answer @effort -: answers not read ({err})"),
            )),
        }
        let asks = notices::asks(&e);
        for m in msgs {
            let payload = &m["payload"];
            let id = text(&m["id"]);
            let key = payload["key"]
                .as_str()
                .or_else(|| {
                    e.km["nodes"]
                        .as_object()?
                        .iter()
                        .find(|(_, n)| n["identifier"] == payload["issue"])
                        .map(|(k, _)| k.as_str())
                })
                .unwrap_or("-");
            let issue = payload["issue"].as_str().unwrap_or("-");
            match text(&m["type"]) {
                "answer" if !a.runners.contains_key(key) => {
                    if !extra
                        .iter()
                        .any(|(_, s)| s.starts_with(&format!("answer {key} {issue}:")))
                    {
                        extra.push((
                            "do".into(),
                            format!("answer {key} {issue}: {}", text(&payload["body"])),
                        ));
                    }
                }
                "answer" => extra.push((
                    "note".into(),
                    format!("answer {key} {issue}: waits on {}", a.runners[key]),
                )),
                "command"
                    if payload["name"] == "dispatch"
                        && !key.is_empty()
                        && !a.runners.contains_key(key) =>
                {
                    extra.push((
                        "do".into(),
                        format!(
                            "dispatch {key} {issue}: {} asked for it on the page",
                            text(&self.install.config.settings()["human"])
                        ),
                    ))
                }
                "reply" if a.runners.contains_key(key) => extra.push((
                    "note".into(),
                    format!("reply {key} {issue}: waits on {}", a.runners[key]),
                )),
                "reply" => {
                    let ask = text(&payload["ask"]);
                    let body = text(&payload["body"]);
                    let run = payload["run"]
                        .as_str()
                        .or_else(|| asks.iter().find(|q| q["id"] == ask)?.get("run")?.as_str());
                    let mut input = tempfile::tempfile()?;
                    std::io::Write::write_all(&mut input, body.as_bytes())?;
                    std::io::Seek::rewind(&mut input)?;
                    let mut cmd = std::process::Command::new(orca_path());
                    cmd.args([
                        "orchestration",
                        "reply",
                        "--id",
                        ask,
                        "--body-file",
                        "-",
                        "--json",
                    ]);
                    if let Some(run) = run {
                        cmd.args(["--run", run]);
                    }
                    match capture_with_input(&mut cmd, Duration::from_secs(30), input.into()) {
                        Ok(out) if out.status.success() => {
                            extra.push(("note".into(), format!("replied {key} {issue}: {body}")))
                        }
                        result => {
                            let err = result
                                .map(|out| process_error(&out))
                                .unwrap_or_else(|err| err.to_string());
                            extra.push(("do".into(),format!("relay {key} {issue}: send this reply to {ask} yourself ({err}): {body}")));
                        }
                    }
                }
                "command" if matches!(payload["name"].as_str(), Some("pause" | "resume")) => extra
                    .push((
                        "note".into(),
                        format!(
                            "{} @effort -: on the page",
                            if payload["name"] == "pause" {
                                "paused"
                            } else {
                                "resumed"
                            }
                        ),
                    )),
                "changed" | "command" => (),
                _ => continue,
            }
            settled.push(id.into());
        }
        extra.append(&mut a.lines);
        a.lines = extra;
        let labels = e.labels()?;
        levels(&mut e, &mut a, &labels)?;
        let actionable = a.lines.iter().any(|(l, _)| l == "do");
        let complete = a.head == COMPLETE;
        if let Some(link) = &mut self.link {
            let _ = link.send("asks", json!({"asks":asks}));
            let _=link.send("state",json!({"head":a.head,"mode":if !self.args.wait||actionable||complete{"working"}else{"waiting"},"lines":publish::messages(&a)}));
            let progress=e.km["run"]["nodes"].as_object().into_iter().flatten().filter(|(_,r)|r["state"].is_string()||r["job"].is_string()).map(|(k,r)|json!({"key":k,"issue":e.km["nodes"][k]["identifier"],"job":r["job"],"state":r["state"],"ci":r["ci"],"at":r["started_at"],"evidence":null})).collect::<Vec<_>>();
            let _ = link.send("progress", json!({"nodes":progress}));
        }
        if !self.args.no_publish
            && let Err(err) =
                publish::publish(&e, &a, self.args.wait.then_some(self.args.interval), false)
        {
            eprintln!("warn publish: {err}")
        }
        if let Err(err) = notices::notify(&e, &a.lines, &asks) {
            eprintln!("warn notify: {err}")
        }
        self.actions = Some(a);
        Ok(Refresh {
            complete,
            actionable,
            claims_unavailable: false,
            settled,
        })
    }
}
impl Coordinator for Run<'_> {
    fn receive(&mut self, interval: Duration) -> std::result::Result<Option<Value>, String> {
        wait_for_change(self.link.as_mut(), interval)
    }
    fn refresh(&mut self, messages: &[Value]) -> std::result::Result<Refresh, String> {
        self.refresh_effort(messages).map_err(|e| e.to_string())
    }
    fn report(&mut self, result: &Refresh, finished: bool) -> std::result::Result<(), String> {
        if let Some(error) = self.claims_error.take() {
            println!("wait claims page: {error}");
            return Ok(());
        }
        let a = self.actions.as_ref().ok_or("no current actions")?;
        if finished {
            println!("{}", a.head);
            let dir = quote(
                &self
                    .args
                    .dir
                    .canonicalize()
                    .map_err(|e| e.to_string())?
                    .to_string_lossy(),
            );
            let mut hidden = 0;
            for (l, t) in &a.lines {
                let verb = t.split_whitespace().next().unwrap_or("");
                if !self.args.all
                    && l == "note"
                    && !matches!(
                        verb,
                        "autonomy" | "review" | "health" | "triage" | "doctor" | "page" | "stale"
                    )
                {
                    hidden += 1;
                    continue;
                }
                let suffix = if l == "do" {
                    let key = t.split_whitespace().nth(1).unwrap_or("-");
                    let k = quote(key);
                    match verb {
                        "verify" => format!(" -> wg done {dir} {k}"),
                        "dispatch" => format!(" -> wg dispatch {dir} {k} --run"),
                        "merged" => format!(" -> wg move {dir} {k} Merged"),
                        "close" | "ship" => format!(" -> wg move {dir} {k} Done"),
                        "verifying" => format!(" -> wg move {dir} {k} Verifying"),
                        "load" => format!(" -> wg load {dir} --apply"),
                        _ => String::new(),
                    }
                } else {
                    String::new()
                };
                println!("{l} {t}{suffix}");
            }
            if hidden > 0 {
                println!(
                    "note other: {hidden} more note line{}; wg next {dir} --all prints them",
                    if hidden == 1 { "" } else { "s" }
                )
            }
            if !result.complete {
                println!("note page {}", self.page_url);
            }
        }
        Ok(())
    }
    fn acknowledge(&mut self, ids: &[String]) {
        if let Some(link) = &mut self.link {
            let _ = link.send("ack", json!({"ids":ids}));
        }
    }
}
pub(super) fn next_command(args: &arguments::Next, watch: bool) -> Result<u8> {
    let interval = Duration::try_from_secs_f64(args.interval)
        .map_err(|_| "--interval must be a positive number of seconds")?;
    let install = Installation::load()?;
    let e = Effort::read(&install, &args.dir)?;
    if watch {
        eprintln!(
            "wg watch is now wg next: load the work-graph skill again and read coordinator.md \"Loop\""
        );
    }
    let disabled = matches!(
        std::env::var("WG_LINK")
            .unwrap_or_default()
            .to_lowercase()
            .as_str(),
        "off" | "0" | "no"
    );
    let link = if disabled {
        None
    } else {
        Some(sender::link(&e)?.0)
    };
    let mut run = Run {
        install: &install,
        args,
        link,
        page_url: publish::url(&e)?,
        actions: None,
        claims_error: None,
    };
    super::next(
        &mut run,
        args.wait,
        interval,
        vec![],
        &mut std::io::stderr().lock(),
    )?;
    Ok(0)
}
pub(super) fn wake_command(dir: &Path) -> Result<u8> {
    let install = Installation::load()?;
    let mut e = Effort::read(&install, dir)?;
    let decision = precheck::wake(
        dir,
        &e.km.clone(),
        Utc::now().timestamp_millis() as f64 / 1000.,
        || {
            let labels = e.labels()?;
            let autonomy = label(&labels, "autonomy", "standard");
            if autonomy == "supervised" {
                return Ok(Decision::Skip(format!(
                    "autonomy supervised: {} starts the coordinator",
                    text(&install.config.settings()["human"])
                )));
            }
            if e.paused()? {
                return Ok(Decision::Skip("the effort is paused".into()));
            }
            let presence = notices::page_request(
                &e,
                &["api", "projects", e.project()?, "presence"],
                None,
                Duration::from_secs(3),
            )
            .unwrap_or(Value::Null);
            if let Some(waiting) = presence["waiting"].as_u64().filter(|n| *n > 0) {
                return Ok(Decision::Start(format!(
                    "{waiting} page message(s) wait for the coordinator"
                )));
            }
            if let Some((_, answer)) = answers(&e)?.into_iter().next() {
                return Ok(Decision::Start(answer));
            }
            if e.km["run"]["effort"]["autonomy_seen"]
                .as_str()
                .is_some_and(|s| s != autonomy)
            {
                return Ok(Decision::Start(format!("autonomy changed to {autonomy}")));
            }
            let snap = e.snapshot()?;
            let claims = workflow::current_claims(&install, &e.plan, &e.km)?;
            let a = Actions::read(&e, &snap, claims.as_ref())?;
            if a.head == COMPLETE {
                return Ok(Decision::Skip("the effort is complete".into()));
            }
            Ok(match a.lines.into_iter().find(|(l, _)| l == "do") {
                Some((_, t)) => Decision::Start(t),
                None => Decision::Skip(format!("nothing to do: {}", a.head)),
            })
        },
    )?;
    let (code, msg) = decision.result();
    println!("{msg}");
    Ok(code)
}

struct Tick<'a>(&'a Installation);
impl scheduled::TickServices for Tick<'_> {
    fn refresh(
        &mut self,
        dir: &Path,
        state: &mut Value,
        state_path: &Path,
        notify: bool,
    ) -> Result<String> {
        let e = Effort::read(self.0, dir)?;
        if e.km["nodes"].as_object().is_none_or(|n| n.is_empty()) || e.project().is_err() {
            return Ok("skipped: plan is not loaded".into());
        }
        let key = format!("{}/{}", e.scope()?, e.project()?);
        let snap = e.snapshot()?;
        for n in e.plan["nodes"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|n| n["kind"] == "ship-point")
        {
            if !snap.statuses.contains_key(text(&n["key"])) {
                return Err(format!(
                    "{}: ship point is missing from the keymap or Linear",
                    text(&n["key"])
                )
                .into());
            }
        }
        let claims = workflow::current_claims(self.0, &e.plan, &e.km)?;
        let complete = e.ships_complete(&snap);
        let outcome = if complete && state[&key]["complete"] == true {
            "skipped: complete".into()
        } else {
            let a = if complete {
                Actions {
                    head: COMPLETE.into(),
                    lines: vec![],
                    wave: vec![],
                    members: BTreeMap::new(),
                    runners: BTreeMap::new(),
                }
            } else {
                Actions::read(&e, &snap, claims.as_ref())?
            };
            if let Some(skip) = publish::publish(&e, &a, None, true)? {
                format!("skipped: {skip}")
            } else {
                let mut record = state.get(&key).cloned().unwrap_or(json!({}));
                record["complete"] = json!(complete);
                if notify
                    && !complete
                    && let Err(err) = notices::notify(&e, &a.lines, &notices::asks(&e))
                {
                    eprintln!("warn notify: {err}");
                }
                let members = a.members.into_iter().collect();
                scheduled::deliver_members(
                    &mut record,
                    &members,
                    |r| {
                        state[&key] = r.clone();
                        save_state(state_path, state)
                    },
                    |_| Ok(()),
                )?;
                "ok".into()
            }
        };
        state[&key]["last"] = json!({"at":Utc::now().to_rfc3339(),"result":outcome});
        save_state(state_path, state)?;
        Ok(outcome)
    }
    fn archive(&mut self, paths: &[PathBuf]) -> Result<()> {
        let mut workspaces = BTreeSet::new();
        for path in paths {
            if let Ok(e) = Effort::read(self.0, path)
                && workspaces.insert(e.scope()?.to_owned())
                && let Err(err) = e
                    .linear()
                    .and_then(|mut c| Ok(workflow::archive(&mut c, true, false)?))
            {
                eprintln!("warn: archive of settled issues failed: {err}");
            }
        }
        Ok(())
    }
}
pub(super) fn tick_command(args: &arguments::Tick) -> Result<u8> {
    let install = Installation::load()?;
    let settings = install.config.settings();
    let notify = args.channel.as_deref().map_or_else(
        || settings["notify"].as_array().is_some_and(|c| !c.is_empty()),
        |c| c == "notify",
    );
    scheduled::tick(
        &sender::roots(settings, &args.root)?,
        notify,
        &mut Tick(&install),
        &mut std::io::stdout().lock(),
    )
}
