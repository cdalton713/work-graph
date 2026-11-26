use super::*;
use crate::state::load_keymap;
use serde_json::json;
use std::io::Write;

fn pairs(row: &Value) -> Vec<String> {
    row.as_object()
        .into_iter()
        .flatten()
        .map(|(k, v)| format!("{k}={}", val(v)))
        .collect()
}
fn defaults(run: &mut Value) -> Result<()> {
    if run.is_null() {
        *run = json!({})
    }
    let o = run
        .as_object_mut()
        .ok_or_else(|| invalid("run must be an object"))?;
    for f in ["effort", "nodes"] {
        if !o.entry(f).or_insert_with(|| json!({})).is_object() {
            return Err(invalid(format!("run.{f} must be an object")));
        }
    }
    Ok(())
}
fn show(p: &Value, run: &Value, args: &[String]) -> Result<u8> {
    let mut key = None;
    let mut pretty = false;
    for arg in args {
        if arg == "--json" {
            pretty = true
        } else if key.replace(arg.as_str()).is_some() || arg.starts_with('-') {
            return Err(invalid("invalid run show arguments"));
        }
    }
    let mut row = run;
    if let Some(k) = key {
        row = if k == "@effort" {
            &run["effort"]
        } else {
            node(p, k)?;
            &run["nodes"][k]
        }
    }
    if pretty {
        println!(
            "{}",
            if row.is_null() {
                "{}".into()
            } else {
                ascii(&serde_json::to_string_pretty(row).unwrap())
            }
        )
    } else if key.is_some() {
        for pair in pairs(row) {
            println!("{pair}")
        }
    } else {
        for pair in pairs(&row["effort"]) {
            println!("{pair}")
        }
        let mut ordered = vec![];
        let nodes = list(&p["nodes"]);
        let phases = list(&p["phases"]);
        let mut left = nodes.iter().collect::<Vec<_>>();
        while !left.is_empty() {
            let free = left
                .iter()
                .enumerate()
                .filter(|(_, n)| {
                    list(&p["edges"])
                        .iter()
                        .filter(|e| e["from"] == n["key"])
                        .all(|e| !left.iter().any(|n| e["to"] == n["key"]))
                })
                .min_by_key(|(_, n)| {
                    (
                        phases
                            .iter()
                            .position(|ph| val(&ph["key"]) == val(&n["phase"]))
                            .unwrap_or(99),
                        nodes.iter().position(|x| x["lane"] == n["lane"]),
                    )
                });
            if let Some((i, _)) = free {
                ordered.push(left.remove(i))
            } else {
                ordered.append(&mut left);
                break;
            }
        }
        for n in ordered {
            let k = text(n, "key");
            if let Some(r) = row["nodes"].get(k) {
                println!("{k}\t{}", pairs(r).join(" "))
            }
        }
    }
    Ok(0)
}
fn set(
    row: &mut Value,
    dir: &Path,
    k: &str,
    args: &[String],
    human: &str,
    level: &str,
) -> Result<()> {
    let mut fields = json!({});
    for a in args {
        let (f, v) = a.split_once('=').unwrap_or((a, ""));
        if !a.contains('=')
            || !f.starts_with(|c: char| c.is_ascii_lowercase())
            || !f
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_')
        {
            return Err(invalid(format!("invalid run field: {f}")));
        }
        fields[f] = v.into()
    }
    if !text(&fields, "approved").is_empty() {
        return Err(failed(format!(
            "an approval is recorded with wg approve, with {human}'s own words"
        )));
    }
    let until = text(&fields, "soak_until");
    if !until.is_empty()
        && !chrono::DateTime::parse_from_rfc3339(until)
            .is_ok_and(|v| v.offset().local_minus_utc() == 0)
    {
        return Err(invalid(format!(
            "{k}: invalid soak_until '{until}': expected UTC offset"
        )));
    }
    let o = row
        .as_object_mut()
        .ok_or_else(|| invalid("run row must be an object"))?;
    for (f, v) in fields.as_object().unwrap() {
        if v == "" {
            o.shift_remove(f);
        } else {
            o.insert(f.clone(), v.clone());
        }
    }
    let pr_view = |pr: &str, f: &str| -> Result<Value> {
        let out = std::process::Command::new("gh")
            .args(["pr", "view", pr, "--json", f])
            .current_dir(dir)
            .output()
            .map_err(ioerr)?;
        if !out.status.success() {
            return Err(invalid(String::from_utf8_lossy(&out.stderr).trim()));
        }
        serde_json::from_slice(&out.stdout).map_err(|e| invalid(e.to_string()))
    };
    for (f, start) in [("review", "review_dispatch"), ("merge_review", "")] {
        let patch = format!("{f}_patch");
        let started = !text(&fields, start).is_empty();
        if started || fields[f] == "requested" {
            row[&patch] = text(row, "patch").into()
        }
        if started {
            row["review_head"] = text(row, "code_done_head").into()
        }
        if f == "merge_review" && fields[f] == "requested" {
            let count = text(row, "thorough_count");
            let count = if count.is_empty() {
                0
            } else {
                count.parse::<i64>().map_err(|e| invalid(e.to_string()))?
            };
            if count >= 2 {
                return Err(failed(format!(
                    "{k}: {count} thorough reviews ran; check the fix yourself, or {human} accepts it with the label 'reviewed' (review-and-merge.md \"Merge point\" step 2)"
                )));
            }
            row["thorough_count"] = (count + 1).to_string().into();
            row["thorough_head"] = text(row, "code_done_head").into()
        }
        let pr = text(row, "pr").to_string();
        if fields[f] == "requested" && !pr.is_empty() {
            let seen = match pr_view(&pr, "reviews,comments") {
                Ok(info) => list(&info["reviews"])
                    .iter()
                    .chain(list(&info["comments"]))
                    .filter(|v| !text(v, "body").contains("@claude-thorough"))
                    .count(),
                Err((_, msg)) => {
                    eprintln!("PR #{pr} not read ({msg}): merge_review_seen=0");
                    0
                }
            };
            row["merge_review_seen"] = seen.to_string().into()
        }
        if matches!(text(&fields, f), "clean" | "accepted") {
            if !text(row, &patch).is_empty()
                && !text(row, "patch").is_empty()
                && row[&patch] != row["patch"]
            {
                return Err(failed(format!(
                    "{k}: the patch changed after the review started; start the review again"
                )));
            }
            if !pr.is_empty() {
                let info = pr_view(&pr, "headRefOid")?;
                if info["headRefOid"] != row["code_done_head"] {
                    return Err(failed(format!(
                        "{k}: the PR head {} is not code done; run wg done, then record a review of that head",
                        val(&info["headRefOid"])
                            .chars()
                            .take(10)
                            .collect::<String>()
                    )));
                }
            }
            let o = row.as_object_mut().unwrap();
            o.shift_remove(&patch);
            if f == "review" {
                o.shift_remove(start);
                if matches!(level, "light" | "standard") {
                    row["gate"] = level.into()
                }
            } else {
                o.shift_remove("merge_review_seen");
            }
        }
    }
    Ok(())
}
fn rebuild(dir: &Path, p: &Value, km: &mut Value, apply: bool) -> Result<bool> {
    let entries = journal::entries(dir)?;
    if entries.is_empty() {
        return Err(failed(format!(
            "no journal in {}: the run rows cannot be rebuilt (recovery.md)",
            dir.display()
        )));
    }
    let i=entries.iter().rposition(|e|e["kind"]=="baseline").ok_or_else(||failed("the journal has no baseline line, so it cannot give complete run rows; nothing is changed (recovery.md)"))?;
    let mut run = entries[i]["run"].clone();
    defaults(&mut run)?;
    for e in &entries[i + 1..] {
        if !e["kind"].is_null() && e["kind"] != "run" {
            continue;
        }
        let k = text(e, "key");
        let row = if k == "@effort" {
            &mut run["effort"]
        } else {
            &mut run["nodes"][k]
        };
        if row.is_null() {
            *row = json!({})
        }
        for (f, v) in e["changes"].as_object().unwrap() {
            if v[1].is_null() {
                row.as_object_mut()
                    .ok_or_else(|| invalid("invalid baseline row"))?
                    .shift_remove(f);
            } else {
                row[f] = v[1].clone()
            }
        }
    }
    run["nodes"]
        .as_object_mut()
        .unwrap()
        .retain(|k, v| node(p, k).is_ok() && v.as_object().is_some_and(|o| !o.is_empty()));
    println!(
        "from the baseline of {} and the changes after it",
        text(&entries[i], "time")
    );
    if run["effort"] != json!({}) {
        println!("@effort\t{}", pairs(&run["effort"]).join(" "))
    }
    for n in list(&p["nodes"]) {
        let k = text(n, "key");
        if let Some(r) = run["nodes"].get(k) {
            println!("{k}\t{}", pairs(r).join(" "))
        }
    }
    if !apply {
        println!("dry run: add --apply to write these run rows to keymap.json");
        return Ok(false);
    }
    if km["nodes"] == json!({}) {
        return Err(failed(
            "keymap.json maps no node: run wg load --adopt first (recovery.md)",
        ));
    }
    if km["run"].as_object().is_some_and(|o| !o.is_empty()) {
        let backup = dir.join("keymap.run-before-rebuild.json");
        let mut temp = tempfile::NamedTempFile::new_in(dir).map_err(ioerr)?;
        writeln!(
            temp,
            "{}",
            ascii(&serde_json::to_string_pretty(&km["run"]).unwrap())
        )
        .map_err(ioerr)?;
        temp.persist(&backup).map_err(|e| ioerr(e.error))?;
        println!("the replaced run rows are in {}", backup.display())
    }
    km["run"] = run;
    Ok(true)
}
pub(super) fn run(
    mode: &str,
    dir: &Path,
    p: &Value,
    args: &[String],
    lock: Option<&PlanLock>,
    cards: Option<&mut dyn CardWriter>,
    cfg: &Value,
) -> Result<u8> {
    let mut km = load_keymap(dir).map_err(ioerr)?;
    let before = km["run"].clone();
    let mut row = before.clone();
    defaults(&mut row)?;
    if mode == "show" {
        return show(p, &row, args);
    }
    let lock = lock.ok_or_else(|| invalid("unknown run mode"))?;
    if km
        .get("collab")
        .is_some_and(|c| c.is_object() && c != &json!({}))
    {
        return Err(failed("shared plan writes require the page provider"));
    }
    let journal_command = if mode == "rebuild" && args == ["--apply"] {
        "run rebuild --apply".into()
    } else {
        format!("run {mode}")
    };
    let printed;
    if mode == "rebuild" {
        if !(args.is_empty() || args == ["--apply"]) {
            return Err(invalid("invalid run rebuild arguments"));
        }
        if !rebuild(dir, p, &mut km, !args.is_empty())? {
            return Ok(0);
        }
        printed = format!(
            "wrote the run rows of {} node(s) to keymap.json",
            km["run"]["nodes"].as_object().unwrap().len()
        );
    } else {
        let (k, fields) = args
            .split_first()
            .ok_or_else(|| invalid("missing node key"))?;
        let effort = k == "@effort" && mode == "set";
        if !effort {
            node(p, k)?;
        }
        let mapped = !effort && km["nodes"].get(k).is_some();
        if mapped && cards.is_none() {
            return Err(failed("mapped run writes require the Linear card provider"));
        }
        let level = text(&row["effort"], "review_seen").to_owned();
        match mode {
            "reset" if fields.is_empty() => {
                let state = text(&row["nodes"][k], "state");
                if matches!(state, "running" | "starting" | "creating") {
                    return Err(failed(format!(
                        "{k}: a job is live (state={state}): end it with wg done first"
                    )));
                }
                row["nodes"].as_object_mut().unwrap().shift_remove(k);
                printed = format!("{k}: run row removed")
            }
            "set" if !fields.is_empty() => {
                let r = if effort {
                    &mut row["effort"]
                } else {
                    &mut row["nodes"][k]
                };
                if r.is_null() {
                    *r = json!({})
                }
                set(r, dir, k, fields, text(&cfg["config"], "human"), &level)?;
                printed = pairs(r).join(" ")
            }
            _ => return Err(invalid("invalid run arguments")),
        }
        km["run"] = row;
        if mapped {
            lock.save_keymap(&km).map_err(ioerr)?;
            if let Err(e) = journal::record(dir, &journal_command, &before, &km["run"]) {
                eprintln!("warn: journal not written ({e})")
            }
            let r = km["run"]["nodes"][k].clone();
            match card::refresh(node(p, k)?, &mut km["nodes"][k], &r, cards.unwrap()) {
                Ok(()) => lock.save_keymap(&km).map_err(ioerr)?,
                Err(e) => {
                    eprintln!("node card not updated ({e}); the next 'wg load --apply' updates it")
                }
            }
            println!("{printed}");
            return Ok(0);
        }
    }
    lock.save_keymap(&km).map_err(ioerr)?;
    if let Err(e) = journal::record(dir, &journal_command, &before, &km["run"]) {
        eprintln!("warn: journal not written ({e})")
    }
    println!("{printed}");
    Ok(0)
}
