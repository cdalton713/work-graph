use std::{fs, process::Command};
use tempfile::tempdir;

#[test]
fn config_matches_python_with_isolated_files() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    let plan = root.join("plan.json");
    fs::write(
        &plan,
        r#"{"effort":{"agents":{"worker":{"agent":"claude"}}}}"#,
    )
    .unwrap();
    let config = root.join("settings.json");
    fs::write(&config, r#"{"human":"Example User","rules":"~/rules","workspaces":[{"team":"EX"}],"agents":{"worker":{"agent":"codex","model":"example"}},"legacy":"café 😀"}"#).unwrap();
    for with_plan in [false, true] {
        let mut python = Command::new("python3");
        python.args([
            "-I",
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../skills/work-graph/scripts/wg.py"
            ),
        ]);
        let mut rust = Command::new(env!("CARGO_BIN_EXE_wg-preview"));
        let outputs = [&mut python, &mut rust].map(|cmd| {
            cmd.env("HOME", root)
                .env("WG_CONFIG", &config)
                .arg("config");
            if with_plan {
                cmd.arg(root);
            }
            cmd.output().unwrap()
        });
        for output in &outputs {
            assert!(output.status.success(), "{:?}", output.stderr);
        }
        assert_eq!(outputs[0].stdout, outputs[1].stdout);
        assert_eq!(outputs[0].stderr, outputs[1].stderr);
    }
}

#[test]
fn interrupted_python_writer_releases_lock_and_preserves_keymap() {
    use std::{
        io::{BufRead, BufReader, ErrorKind},
        os::unix::fs::PermissionsExt,
        process::Stdio,
        time::Duration,
    };
    use wg_preview::state::{PlanLock, load_keymap};
    let root = tempdir().unwrap();
    let path = root.path().join("keymap.json");
    fs::write(&path, r#"{"legacy":"kept"}"#).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    let mut child = Command::new("python3")
        .args([
            "-I",
            "-c",
            r#"
import pathlib, runpy, sys
wg = runpy.run_path(sys.argv[1])
p = pathlib.Path(sys.argv[2])
with wg['plan_lock'](p), wg['atomic_text_file'](p/'keymap.json') as temp:
    temp.write('partial')
    temp.flush()
    print('locked', flush=True)
    sys.stdin.readline()
"#,
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../skills/work-graph/scripts/wg.py"
            ),
        ])
        .arg(root.path())
        .env("WG_CONFIG", root.path().join("absent"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    assert_eq!(line.trim(), "locked");
    let blocked = PlanLock::acquire(root.path(), Some(Duration::ZERO));
    child.kill().unwrap();
    child.wait().unwrap();
    assert_eq!(blocked.err().unwrap().kind(), ErrorKind::TimedOut);
    let lock = PlanLock::acquire(root.path(), Some(Duration::from_secs(1))).unwrap();
    let mut data = load_keymap(root.path()).unwrap();
    assert_eq!(data["legacy"], "kept");
    data["nodes"]["new"] = serde_json::json!({"id":"1"});
    lock.save_keymap(&data).unwrap();
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(load_keymap(root.path()).unwrap(), data);
}

#[test]
fn reads_rotated_and_current_journal_in_order() {
    let dir = tempdir().unwrap();
    let fixture = include_str!("../../tests/cli-parity/fixture/journal.jsonl");
    fs::write(dir.path().join("journal.1.jsonl"), fixture).unwrap();
    fs::write(
        dir.path().join("journal.jsonl"),
        fixture.replace("idle", "ready"),
    )
    .unwrap();
    let (entries, skipped) = wg_preview::state::journal_entries(dir.path()).unwrap();
    assert_eq!(skipped, 2);
    assert_eq!(entries[0]["changes"]["state"][1], "idle");
    assert_eq!(entries[1]["changes"]["state"][1], "ready");
}

// The parent starts this test in a separate process with a kernel file-size
// limit. The limit interrupts the real save while it writes the temporary file.
#[test]
fn save_in_limited_process() {
    let Some(dir) = std::env::var_os("WG_TEST_SAVE_DIR") else {
        return;
    };
    let lock = wg_preview::state::PlanLock::acquire(std::path::Path::new(&dir), None).unwrap();
    lock.save_keymap(&serde_json::json!({"value":"x".repeat(1<<20)}))
        .unwrap();
}

#[test]
fn interrupted_rust_save_keeps_the_last_complete_file() {
    use wg_preview::state::{PlanLock, load_keymap};
    let dir = tempdir().unwrap();
    let original = serde_json::json!({"legacy":1,"nodes":{},"milestones":{}});
    PlanLock::acquire(dir.path(), None)
        .unwrap()
        .save_keymap(&original)
        .unwrap();
    let status = Command::new("python3")
        .args([
            "-I",
            "-c",
            r#"
import os, resource, signal, sys
resource.setrlimit(resource.RLIMIT_CORE,(0,0))
resource.setrlimit(resource.RLIMIT_FSIZE, (4096,4096))
signal.signal(signal.SIGXFSZ, signal.SIG_DFL)
os.execv(sys.argv[1], [sys.argv[1], '--exact', 'save_in_limited_process'])
"#,
        ])
        .arg(std::env::current_exe().unwrap())
        .env("WG_TEST_SAVE_DIR", dir.path())
        .output()
        .unwrap();
    assert!(!status.status.success());
    assert_eq!(load_keymap(dir.path()).unwrap(), original);
    let lock = PlanLock::acquire(dir.path(), Some(std::time::Duration::ZERO)).unwrap();
    lock.save_keymap(&serde_json::json!({"legacy":2})).unwrap();
    assert_eq!(load_keymap(dir.path()).unwrap()["legacy"], 2);
}
