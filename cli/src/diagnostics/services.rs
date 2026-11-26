//! Inspect installed services without starting, stopping or repairing them.
use super::{Lines, failure, line};
use crate::automation::{
    activity,
    machine::{self, Result, text},
};
use serde_json::{Value, json};
use std::{fs, os::unix::fs::MetadataExt, path::Path, process::Command, time::Duration};

fn tick(label: &str) -> Result<(String, String)> {
    if !cfg!(target_os = "macos") {
        return Ok(line(
            "warn",
            "tick: wg tick --install uses launchd (macOS); schedule wg tick another way",
        ));
    }
    let path = machine::home()?
        .join("Library/LaunchAgents")
        .join(format!("{label}.plist"));
    if !path.exists() {
        return Ok(line("warn", "tick: not installed (wg tick --install)"));
    }
    let domain = format!("gui/{}", nix::unistd::getuid());
    if machine::output(
        Command::new("/bin/launchctl").args(["print", &format!("{domain}/{label}")]),
        Duration::from_secs(10),
    )
    .is_err()
    {
        return Ok(line(
            "warn",
            format!(
                "tick: {} is not loaded (/bin/launchctl bootstrap {domain} {})",
                path.display(),
                machine::quote(&path.to_string_lossy())
            ),
        ));
    }
    let plist = machine::output(
        Command::new("/usr/bin/plutil")
            .args(["-convert", "json", "-o", "-", "--"])
            .arg(&path),
        Duration::from_secs(10),
    );
    let Some(plist) = plist
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
    else {
        return Ok(line(
            "warn",
            format!(
                "tick: {label} loaded, but its trigger in {} is not readable",
                path.display()
            ),
        ));
    };
    let trigger = &plist["StartCalendarInterval"];
    if trigger != &json!([{"Minute":0},{"Minute":15},{"Minute":30},{"Minute":45}]) {
        return Ok(line(
            "FAIL",
            format!(
                "tick: the trigger of {} is {trigger}, not each 15 minutes; wg tick --install again",
                path.display()
            ),
        ));
    }
    Ok(line("ok", format!("tick: {label} loaded, each 15 minutes")))
}

fn plugin() -> Result<Option<Value>> {
    let reply = machine::orca(&["plugin", "list"])?;
    Ok(reply["plugins"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|p| text(&p["pluginKey"]).rsplit('.').next() == Some("wg-agents"))
        .cloned())
}
fn agent_service(dir: &Path, config_path: &Path) -> Result<(String, String)> {
    let path = machine::home()?.join(".local/state/work-graph/agents.lock");
    let running = match fs::File::open(&path) {
        Ok(f) => match f.try_lock() {
            Ok(()) => false,
            Err(fs::TryLockError::WouldBlock) => true,
            Err(e) => return Err(e.into()),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(e) => return Err(e.into()),
    };
    let stamp = machine::read_state(&activity::stamp_path(dir)?)?;
    let message = format!(
        "agents: service {}; last send: {}",
        if running { "running" } else { "stopped" },
        stamp["at"].as_str().unwrap_or("none")
    );
    if !running {
        return Ok(line("warn", message));
    }
    let sender = machine::read_state(&path.with_extension("sender"))?;
    if sender.get("script").is_none() {
        return Ok(line(
            "warn",
            format!(
                "{message}; cannot verify sender settings, close its Orca terminal; the Orca plugin starts a new one"
            ),
        ));
    }
    let stamp = |path: &Path| {
        fs::metadata(path)
            .ok()
            .map(|m| {
                json!([
                    i128::from(m.mtime()) * 1_000_000_000 + i128::from(m.mtime_nsec()),
                    m.ino()
                ])
            })
            .unwrap_or(Value::Null)
    };
    if sender["source"] != stamp(Path::new(text(&sender["script"])))
        || sender["config"] != stamp(config_path)
        || sender["tokens"]
            .as_object()
            .is_some_and(|m| m.iter().any(|(p, s)| &stamp(Path::new(p)) != s))
    {
        return Ok(line(
            "warn",
            format!(
                "{message}; the agents sender runs old settings, it reloads or restarts at its next cycle"
            ),
        ));
    }
    Ok(line("ok", message))
}

pub(super) fn inspect(dir: Option<&Path>, config: &crate::state::Config) -> Result<Lines> {
    let report = config.report(None)?;
    let settings = &report["config"];
    let mut lines =
        vec![tick(text(&settings["tick_label"])).unwrap_or_else(|e| failure("tick", e))];
    let resources = crate::integration::resources::root();
    lines.push(match &resources {
        Ok(root) if root.join("orca-plugin/orca-plugin.json").is_file() => line(
            "ok",
            format!("installation: skill and plugin at {}", root.display()),
        ),
        Ok(root) => line(
            "warn",
            format!("installation: no Orca plugin at {}", root.display()),
        ),
        Err(e) => line("warn", format!("installation: {e}")),
    });
    let installed = plugin();
    let finding = match &installed {
        Err(e) => line(
            "warn",
            format!("agents: cannot read the Orca plugins ({e})"),
        ),
        Ok(None) => line(
            "warn",
            "agents: the Orca plugin is not installed (wg agents --install); the page does not show the agents",
        ),
        Ok(Some(p)) => {
            let key = text(&p["pluginKey"]);
            if p["needsReconsent"] == true {
                line(
                    "warn",
                    format!(
                        "agents: the Orca plugin {key} needs a new approval (wg agents --install)"
                    ),
                )
            } else if let Ok(root) = &resources
                && let Some(folder) = root.join("orca-plugin").to_str()
                && let Ok(local) = machine::orca(&["plugin", "inspect", folder])
                && local["contentHash"].is_string()
                && local["contentHash"] != p["source"]["contentHash"]
            {
                line(
                    "warn",
                    format!(
                        "agents: the Orca plugin {key} differs from the installed version (wg agents --install)"
                    ),
                )
            } else if matches!(p["status"].as_str(), Some("disabled" | "error" | "failed")) {
                line(
                    "warn",
                    format!("agents: the Orca plugin {key} is {}", text(&p["status"])),
                )
            } else {
                line(
                    "ok",
                    format!(
                        "agents: the Orca plugin {key} keeps wg agents running ({})",
                        text(&p["status"])
                    ),
                )
            }
        }
    };
    lines.push(finding);
    if let Some(dir) = dir {
        lines.push(agent_service(dir, &config.path).unwrap_or_else(|e| failure("agents", e)));
    }
    lines.push(if settings["agent_replies"]!=true{line("ok","agent replies: off")}
        else if ["ORCA_AGENT_SESSION_ID","ORCA_TERMINAL_HANDLE"].iter().any(|k|std::env::var_os(k).is_some_and(|s|!s.is_empty())){line("ok","agent replies: on; this Orca terminal can run the watcher")}
        else if let Ok(Some(p))=installed && p["needsReconsent"]!=true{line("ok",format!("agent replies: on; the Orca plugin {} runs the watcher in an Orca terminal",text(&p["pluginKey"])))}
        else{line("warn","agent replies: on in config; install the Orca plugin (wg agents --install) to take replies")});
    Ok(lines)
}
