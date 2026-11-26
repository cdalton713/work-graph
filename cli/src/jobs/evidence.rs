use super::*;
use serde_json::json;
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::process::ExitStatusExt,
};
use tempfile::NamedTempFile;

fn args(v: &Value) -> Result<Vec<String>, String> {
    list(v)?
        .iter()
        .map(|s| {
            s.as_str()
                .map(str::to_owned)
                .ok_or_else(|| "test command must be a list of strings".into())
        })
        .collect()
}

pub(super) fn suite(plan: &Value, cfg: &Value) -> Result<Vec<String>, String> {
    if let Some(command) = plan["effort"].get("test") {
        return args(command);
    }
    let runner = &cfg["test_runner"];
    if runner.is_null() {
        return Err(
            "no test command: set effort.test in plan.json, or test_runner in config".into(),
        );
    }
    let mut command = args(&runner["run"])?;
    for field in ["suite", "options"] {
        if let Some(a) = runner.get(field) {
            command.extend(args(a)?);
        }
    }
    Ok(command)
}

pub(super) fn run(
    dir: &Path,
    install: &Installation,
    plan: &Value,
    key: &str,
) -> Result<u8, String> {
    if Path::new(key).file_name().and_then(|s| s.to_str()) != Some(key) {
        return Err(format!("invalid evidence key {key}"));
    }
    let full = key.strip_prefix("@full-").is_some_and(|k| {
        plan["phases"]
            .as_array()
            .is_some_and(|ps| ps.iter().any(|p| super::phase_matches(&p["key"], k)))
    });
    if !full && !list(&plan["nodes"])?.iter().any(|n| n["key"] == key) {
        return Err(format!("unknown key {key}"));
    }
    let cwd = Path::new(".");
    if !git(cwd, &["status", "--porcelain"])?.is_empty() {
        return Err("tree is not clean: commit first, the evidence must match one commit".into());
    }
    let sha = git(cwd, &["rev-parse", "HEAD"])?;
    let cfg = install.config.settings();
    let runner = &cfg["test_runner"];
    let mut command = suite(plan, cfg)?;
    if command.is_empty() {
        return Err("empty test command".into());
    }
    let mut base = None;
    let mut scope = "custom";
    if plan["effort"].get("test").is_none() {
        scope = "full";
        if !full {
            let km = crate::state::load_keymap(dir).map_err(|e| e.to_string())?;
            let lower = km["run"]["nodes"][key]["lower"]
                .as_str()
                .ok_or_else(|| format!("{key}: missing run field lower"))?;
            let oid = git(cwd, &["merge-base", lower, "HEAD"])?;
            if !git(cwd, &["diff", "--name-only", &oid, "HEAD"])?
                .lines()
                .any(|f| f.starts_with(".moon/") || (!f.contains('/') && !f.ends_with(".md")))
            {
                let tasks: Value = serde_json::from_str(&output(
                    Command::new("moon")
                        .args(["query", "tasks", "--affected", "--downstream", "deep"])
                        .env("MOON_BASE", &oid)
                        .env("MOON_HEAD", "HEAD"),
                )?)
                .map_err(|e| e.to_string())?;
                let mut targets = Vec::new();
                for (project, names) in tasks["tasks"].as_object().ok_or("invalid task query")? {
                    if list(names)?.iter().any(|n| n == "test") {
                        targets.push(format!("{project}:test"));
                    }
                }
                targets.sort();
                command.clear();
                if !targets.is_empty() {
                    command = args(&runner["run"])?;
                    command.extend(targets);
                    if let Some(a) = runner.get("options") {
                        command.extend(args(a)?);
                    }
                }
                scope = "affected";
            }
            base = Some(oid);
        }
    }
    let marker = runner["commit_marker"]
        .as_str()
        .map(regex::Regex::new)
        .transpose()
        .map_err(|e| e.to_string())?;
    let folder = dir.join("evidence");
    fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let log = folder.join(format!(
        "{key}-{}.log",
        sha.chars().take(10).collect::<String>()
    ));
    let file = fs::File::create(&log).map_err(|e| e.to_string())?;
    let now = || chrono::Utc::now().to_rfc3339();
    let started = now();
    let mut writer = std::io::BufWriter::new(file);
    let mut emit = |s: &str| -> Result<(), String> {
        print!("{s}");
        writer
            .write_all(s.as_bytes())
            .and_then(|_| writer.flush())
            .map_err(|e| e.to_string())
    };
    let mut found = None;
    let mut dirty = false;
    let exit = if command.is_empty() {
        emit(&format!(
            "no test task is affected by {}..{}\n",
            base.as_deref()
                .unwrap_or("")
                .chars()
                .take(10)
                .collect::<String>(),
            sha.chars().take(10).collect::<String>()
        ))?;
        0
    } else {
        if scope != "custom" {
            emit(&format!(
                "{scope} tests{}: {}\n",
                base.as_ref()
                    .map(|s| format!(" over {}", s.chars().take(10).collect::<String>()))
                    .unwrap_or_default(),
                command.join(" ")
            ))?;
        }
        let (read, write) = std::io::pipe().map_err(|e| e.to_string())?;
        let mut child = Command::new(&command[0])
            .args(&command[1..])
            .stdout(write.try_clone().map_err(|e| e.to_string())?)
            .stderr(write)
            .spawn()
            .map_err(|e| e.to_string())?;
        let mut reader = BufReader::new(read);
        let mut bytes = Vec::new();
        while reader
            .read_until(b'\n', &mut bytes)
            .map_err(|e| e.to_string())?
            > 0
        {
            let line = String::from_utf8_lossy(&bytes);
            emit(&line)?;
            if found.is_none()
                && let Some(m) = marker
                    .as_ref()
                    .and_then(|r| r.captures(&line))
                    .and_then(|c| c.get(1))
            {
                found = Some(m.as_str().to_owned());
                dirty = line.contains("with uncommitted changes");
            }
            bytes.clear();
        }
        let status = child.wait().map_err(|e| e.to_string())?;
        status
            .code()
            .unwrap_or_else(|| 128 + status.signal().unwrap_or(0))
    };
    let short = sha.chars().take(10).collect::<String>();
    let valid = command.is_empty()
        || (!dirty
            && found
                .as_ref()
                .map_or(scope == "custom" || marker.is_none(), |s| s == &short));
    let data = json!({"key":key,"sha":sha,"command":command,"scope":scope,"base":base,"started":started,"log":log,"exit":exit,"valid":valid,"finished":now()});
    let mut temp = NamedTempFile::new_in(&folder).map_err(|e| e.to_string())?;
    crate::state::write_pretty_json(&mut temp, &data).map_err(|e| e.to_string())?;
    temp.persist(folder.join(format!("{key}.json")))
        .map_err(|e| e.to_string())?;
    if !valid {
        eprintln!(
            "evidence invalid: {}",
            if dirty {
                "the command tested uncommitted changes".into()
            } else if let Some(s) = found {
                format!("the command tested {s}, not HEAD {short}")
            } else {
                "the command did not print the commit that it tested".into()
            }
        );
        return Ok(3);
    }
    Ok(exit as u8)
}
