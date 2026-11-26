use super::*;
use serde_json::json;
use std::collections::VecDeque;

#[derive(Default)]
struct Service {
    refreshes: VecDeque<Result<Refresh, String>>,
    arrivals: VecDeque<Option<Value>>,
    received: Vec<Vec<Value>>,
    events: Vec<String>,
}

impl Coordinator for Service {
    fn receive(&mut self, interval: Duration) -> Result<Option<Value>, String> {
        assert_eq!(interval, Duration::from_secs(60));
        Ok(self.arrivals.pop_front().expect("unexpected wait"))
    }
    fn refresh(&mut self, messages: &[Value]) -> Result<Refresh, String> {
        self.received.push(messages.to_vec());
        self.refreshes.pop_front().expect("extra refresh")
    }
    fn report(&mut self, _: &Refresh, finished: bool) -> Result<(), String> {
        self.events.push(format!("report {finished}"));
        Ok(())
    }
    fn acknowledge(&mut self, ids: &[String]) {
        self.events.push(format!("ack {}", ids.join(",")));
    }
}

fn idle() -> Refresh {
    Refresh {
        complete: false,
        actionable: false,
        claims_unavailable: false,
        settled: vec![],
    }
}

#[test]
fn waits_through_read_error_and_timeout_until_an_answer_is_printed() {
    let change = json!({"type":"changed","id":"a"});
    let answer = json!({"type":"answer","id":"b"});
    let mut service = Service::default();
    service.refreshes.extend([
        Err("read failed".into()),
        Ok(Refresh {
            settled: vec!["a".into()],
            ..idle()
        }),
        Ok(idle()),
        Ok(Refresh {
            actionable: true,
            settled: vec!["b".into()],
            ..idle()
        }),
    ]);
    let interval = Duration::from_secs(60);
    service.arrivals = VecDeque::from([None, Some(change.clone()), Some(answer.clone())]);
    let mut warnings = Vec::new();
    next(
        &mut service,
        true,
        interval,
        vec![change.clone(), change.clone()],
        &mut warnings,
    )
    .unwrap();
    assert_eq!(warnings, b"warn next: read failed\n");
    assert_eq!(
        service.received,
        [vec![change.clone()], vec![change], vec![], vec![answer]]
    );
    assert_eq!(
        service.events,
        [
            "report false",
            "ack a",
            "ack a",
            "report false",
            "report true",
            "ack b"
        ]
    );
}

#[test]
fn single_read_and_terminal_states_exit_without_sleeping() {
    for (wait, refresh) in [
        (false, idle()),
        (
            true,
            Refresh {
                complete: true,
                ..idle()
            },
        ),
        (
            true,
            Refresh {
                claims_unavailable: true,
                ..idle()
            },
        ),
    ] {
        let mut service = Service::default();
        service.refreshes.push_back(Ok(refresh));
        next(
            &mut service,
            wait,
            Duration::from_secs(1),
            vec![],
            &mut Vec::new(),
        )
        .unwrap();
        assert_eq!(service.events, ["report true"]);
    }
}

#[test]
fn one_shot_errors_exit_without_retry() {
    let mut service = Service::default();
    service.refreshes.push_back(Err("snapshot failed".into()));
    let result = next(
        &mut service,
        false,
        Duration::from_secs(1),
        vec![],
        &mut Vec::new(),
    );
    assert_eq!(result, Err("snapshot failed".into()));
}

#[test]
fn health_report_uses_first_fault_drops_early_reviews_and_records_published_update() {
    use super::findings::Findings;
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("report");
    std::fs::write(
        &path,
        json!({"summary":"Example","findings":[
        {"kind":"stale-review","hours":24,"subject":"a","text":"Early"},
        {"kind":"worker","subject":"b","text":"Missing reply","fix":"Read the terminal"},
        {"kind":"worker","subject":"b","text":"Duplicate"}]})
        .to_string(),
    )
    .unwrap();
    let mut report = Findings::read(&path).unwrap();
    assert_eq!(report.value(), "atRisk");
    report
        .include_checks(
            &[("FAIL".into(), "link: disconnected".into())],
            temp.path(),
            100,
            false,
        )
        .unwrap();
    assert_eq!(report.value(), "offTrack");
    let body = report.body(&Default::default(), "now");
    assert!(body.contains("offTrack doctor:link: link: disconnected"));
    assert!(body.contains("Missing reply Fix: Read the terminal"));
    assert!(!body.contains("Duplicate"));
    assert!(body.contains("dropped stale-review a: 24 hours is less than 48"));
    report.save_published(temp.path(), "now", "update").unwrap();
    let row = &crate::state::load_keymap(temp.path()).unwrap()["run"]["effort"];
    assert_eq!(row["health_faults"], "doctor:link,worker:b");
    assert_eq!(row["health_update"], "update");
}

#[test]
fn failed_tick_delivery_survives_retry() {
    let mut record = json!({"members":{"old":"old"}});
    let members = json!({"new":"value"});
    let mut persisted = vec![];
    let result = scheduled::deliver_members(
        &mut record,
        members.as_object().unwrap(),
        |r| {
            persisted.push(r.clone());
            Ok(())
        },
        |_| Err("channel failed".into()),
    );
    assert!(result.is_err());
    let mut restarted = persisted.pop().unwrap();
    assert_eq!(restarted["pending"], members);
    scheduled::deliver_members(
        &mut restarted,
        members.as_object().unwrap(),
        |_| Ok(()),
        |v| {
            assert_eq!(v, [json!("value")]);
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(restarted["pending"], json!({}));
}

#[test]
fn machine_commands_in_private_home() {
    // A separate test process isolates HOME, PATH and the Orca binary from concurrent tests.
    use chrono::{TimeZone, Utc};
    use std::{
        env, fs,
        os::unix::fs::PermissionsExt,
        process::Command,
        time::{Duration, Instant},
    };
    let marker = "WG_FIXTURE_MACHINE_CHILD";
    if env::var_os(marker).is_none() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().canonicalize().unwrap();
        let stub = home.join("orca");
        fs::write(&stub,r#"#!/bin/sh
printf '%s\n' "$*" >> "$HOME/calls"
case "$1 $2" in
  'agent list') printf '{"result":{"agents":[{"orcaSessionId":"s","state":"waiting","agent":"sample","worktreeId":"repo::%s/test-core"}]}}\n' "$HOME";;
  'plugin list') printf '{"ok":true,"result":{"plugins":[]}}\n';;
  'plugin inspect') printf '{"ok":true,"result":{"contentHash":"hash"}}\n';;
  'plugin install') printf '{"ok":false,"error":{"code":"approval_required","data":{"command":"wg agents --install --approve example"}}}\n'; exit 1;;
  *) exit 1;;
esac
"#).unwrap();
        fs::set_permissions(&stub, fs::Permissions::from_mode(0o755)).unwrap();
        let result = Command::new(env::current_exe().unwrap())
            .args([
                "--exact",
                "automation::tests::machine_commands_in_private_home",
                "--nocapture",
            ])
            .env_clear()
            .env("HOME", &home)
            .env("ORCA_CLI_COMMAND", stub)
            .env(marker, "1")
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{} {}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
        return;
    }

    let home = env::home_dir().unwrap();
    let dir = home.join("test-core");
    fs::create_dir(&dir).unwrap();
    let km = json!({"project":{"id":"project"},"nodes":{"a":{"id":"issue"}}});
    fs::write(dir.join("keymap.json"), km.to_string()).unwrap();
    fs::write(dir.join("plan.json"), "{}").unwrap();
    let mut out = vec![];
    let local = || {
        activity::collect(
            std::slice::from_ref(&home),
            true,
            |_| Ok(json!({"effort":{"name":"test"}})),
            |p, _, rows| {
                assert_eq!(rows.len(), 1);
                assert_eq!(rows[0]["role"], "coordinator");
                let mut seen = Default::default();
                assert!(activity::notice_entries(rows, &mut seen).is_empty());
                assert_eq!(activity::notice_entries(rows, &mut seen).len(), 1);
                let mut beat = activity::Heartbeat::default();
                let now = Instant::now();
                assert!(beat.due(rows, now, false));
                beat.sent(rows.to_vec(), now);
                assert!(!beat.due(rows, now, false));
                assert!(beat.due(rows, now + Duration::from_secs(60), false));
                assert!(beat.due(&[], now, false));
                activity::record_send(p)
            },
        )
    };
    activity::monitor(
        true,
        false,
        &env::current_exe().unwrap(),
        local,
        &mut out,
        &mut vec![],
    )
    .unwrap();
    assert_eq!(
        String::from_utf8(out).unwrap(),
        "test: coordinator sample waiting -: \n"
    );
    assert_eq!(
        fs::read_to_string(home.join("calls")).unwrap(),
        "agent list --environment local --json\n"
    );
    let path = home.join(".local/state/work-graph/agents.json");
    let lock = machine::state_lock(&path).unwrap();
    lock.lock().unwrap();
    let mut out = vec![];
    activity::monitor(
        false,
        false,
        &env::current_exe().unwrap(),
        || panic!(),
        &mut out,
        &mut vec![],
    )
    .unwrap();
    assert_eq!(out, b"skipped: wg agents is already running\n");

    struct TestTick;
    impl scheduled::TickServices for TestTick {
        fn refresh(
            &mut self,
            _: &std::path::Path,
            _: &mut Value,
            _: &std::path::Path,
            _: bool,
        ) -> machine::Result<String> {
            Err("fixture timeout".into())
        }
        fn archive(&mut self, paths: &[std::path::PathBuf]) -> machine::Result<()> {
            assert_eq!(paths.len(), 1);
            Ok(())
        }
    }
    let mut tick_output = vec![];
    assert_eq!(
        scheduled::tick(
            std::slice::from_ref(&home),
            false,
            &mut TestTick,
            &mut tick_output
        )
        .unwrap(),
        1
    );
    assert!(
        String::from_utf8(tick_output)
            .unwrap()
            .contains("error: fixture timeout")
    );
    let tick_path = home.join(".local/state/work-graph/tick.json");
    let tick_state = machine::read_state(&tick_path).unwrap();
    assert_eq!(
        tick_state["path-errors"][dir.to_str().unwrap()]["result"],
        "error: fixture timeout"
    );
    assert_eq!(
        fs::metadata(&tick_path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let tick_lock = machine::state_lock(&tick_path).unwrap();
    tick_lock.lock().unwrap();
    let mut tick_output = vec![];
    assert_eq!(
        scheduled::tick(
            std::slice::from_ref(&home),
            false,
            &mut TestTick,
            &mut tick_output
        )
        .unwrap(),
        0
    );
    assert_eq!(tick_output, b"skipped: a tick is already running\n");

    let skip = precheck::wake(&dir, &km, 100., || panic!())
        .unwrap()
        .result();
    assert_eq!(
        skip,
        (1, "skip: a coordinator agent runs in this worktree".into())
    );
    let other = home.join("other");
    fs::create_dir(&other).unwrap();
    for i in 0..3 {
        let result = precheck::wake(&other, &km, 100. + f64::from(i), || {
            Ok(precheck::Decision::Start("pending answer".into()))
        })
        .unwrap();
        assert_eq!(result.result().0, 0);
    }
    assert_eq!(
        precheck::wake(&other, &km, 105., || panic!())
            .unwrap()
            .result()
            .0,
        1
    );
    let wake = home.join(".local/state/work-graph/wake.json");
    assert_eq!(
        fs::metadata(&wake).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        machine::read_state(&wake).unwrap()[other.to_str().unwrap()]
            .as_array()
            .unwrap()
            .len(),
        3
    );

    struct Health;
    impl precheck::HealthReads for Health {
        fn paused(&mut self) -> machine::Result<bool> {
            Ok(false)
        }
        fn complete(&mut self) -> machine::Result<bool> {
            Ok(false)
        }
        fn changed_since(&mut self, _: i64) -> machine::Result<bool> {
            Ok(false)
        }
    }
    let now = Utc.timestamp_opt(1700000000, 0).unwrap();
    assert_eq!(
        precheck::due(&dir, &km, 1., now, &mut Health)
            .unwrap()
            .result(),
        (0, "start: no check yet".into())
    );
    let km = crate::state::load_keymap(&dir).unwrap();
    assert_eq!(
        precheck::due(&dir, &km, 1., now, &mut Health)
            .unwrap()
            .result(),
        (1, "skip: the last check was 0m ago (interval 1h00m)".into())
    );
    fs::write(dir.join("orca-plugin.json"), "{}").unwrap();
    let mut message = vec![];
    let code = activity::plugin(&dir, "fixture", false, None, &mut message).unwrap();
    assert_eq!(code, 3);
    assert!(
        String::from_utf8(message)
            .unwrap()
            .contains("--approve example")
    );
    let error = machine::output(
        Command::new("/bin/sleep").arg("10"),
        Duration::from_millis(10),
    )
    .unwrap_err();
    assert!(error.to_string().contains("timed out"));
}
