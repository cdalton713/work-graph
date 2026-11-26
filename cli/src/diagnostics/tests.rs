use super::*;
use crate::automation::findings::Findings;
use serde_json::json;
use std::{env, fs, os::unix::fs::PermissionsExt};

#[test]
fn doctor_findings_change_health_when_a_missing_worker_directory_is_repaired() {
    // Spawn the component in a private home and PATH. No test modifies the process-wide environment.
    const CHILD: &str = "WG_DIAGNOSTICS_FIXTURE";
    if env::var_os(CHILD).is_none() {
        let root = tempfile::tempdir().unwrap();
        let bin = root.path().join("bin");
        fs::create_dir(&bin).unwrap();
        for tool in ["gh", "st", "orca"] {
            let exe = bin.join(tool);
            fs::write(&exe,"#!/bin/sh\ncase \"$1\" in plugin) echo '{\"ok\":true,\"result\":{\"plugins\":[]}}';; esac\nexit 0\n").unwrap();
            fs::set_permissions(exe, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let output=Command::new(env::current_exe().unwrap()).args(["--exact","diagnostics::tests::doctor_findings_change_health_when_a_missing_worker_directory_is_repaired","--nocapture"])
            .env_clear().env("HOME",root.path()).env("PATH",&bin).env("ORCA_CLI_COMMAND",bin.join("orca")).env(CHILD,"1").output().unwrap();
        assert!(
            output.status.success(),
            "{} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }
    let dir = env::home_dir().unwrap().join("sample-core");
    fs::create_dir(&dir).unwrap();
    let worker = dir.join("worker");
    fs::write(dir.join("keymap.json"),json!({"nodes":{"a":{"id":"issue","identifier":"TEST-1"}},"run":{"nodes":{"a":{"path":worker,"state":"running"}}}}).to_string()).unwrap();
    let report = dir.join("report.json");
    fs::write(&report, r#"{"findings":[]}"#).unwrap();
    let check = |status: &str| {
        let mut findings = Findings::read(&report).unwrap();
        findings
            .collect_diagnostics(&dir, &[], 1700000000, false, |_| {
                Ok(BTreeMap::from([(
                    "issue".into(),
                    MappedIssue {
                        status: status.into(),
                        labels: vec![],
                    },
                )]))
            })
            .unwrap();
        findings
    };
    let findings = check("In Progress");
    assert_eq!(findings.value(), "offTrack");
    assert_eq!(findings.faults.len(), 1);
    assert!(findings.body(&BTreeMap::new(), "now").contains(&format!(
        "offTrack doctor:worktree-a: worktree a: {} does not exist",
        worker.display()
    )));
    let settled = check("Merged");
    assert!(settled.faults.contains_key("doctor:keymap-a-TEST-1"));
    assert!(!settled.faults.contains_key("doctor:worktree-a"));

    fs::create_dir(worker).unwrap();
    let repaired = check("In Progress");
    assert_eq!(repaired.value(), "onTrack");
    assert!(repaired.faults.is_empty());
    assert!(
        repaired
            .notes
            .iter()
            .any(|m| m.starts_with("doctor warn: agents: service stopped"))
    );
}
