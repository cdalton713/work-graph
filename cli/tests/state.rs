use std::{fs, process::Command};
use tempfile::tempdir;

const REFERENCE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../tests/cli-parity/reference/wg.py"
);

#[test]
fn config_matches_python_with_isolated_files() {
    const DEFAULT: &str = r#"{"human":"Example User","rules":"~/./rules//file","agents":{"worker":{"model":"base"}},"legacy":"café 😀","workspaces":[{"id":"first","team":"EX"},{"id":"second","teams":["B","C"]}]}"#;
    for (config, effort, argument, code) in [
        (None, None, None, 0),
        (Some(DEFAULT), None, Some(""), 0),
        (Some(DEFAULT), Some(r#"{}"#), Some("."), 0),
        (
            Some(DEFAULT),
            Some(r#"{"workspace":"second","team":"B"}"#),
            Some("."),
            0,
        ),
        (
            Some(DEFAULT),
            Some(r#"{"agents":{"reviewer":{"agent":"other"}}}"#),
            Some("."),
            0,
        ),
        (
            Some(DEFAULT),
            Some(r#"{"agents":{"worker":{"foo":"old","effort":"low"}}}"#),
            Some("."),
            0,
        ),
        (
            Some(DEFAULT),
            Some(r#"{"agents":{"worker":{"agent":"gemini","extra":"field"}}}"#),
            Some("."),
            0,
        ),
        (
            Some(DEFAULT),
            Some(r#"{"agents":{"worker":{"agent":"other","effort":"high"}}}"#),
            Some("."),
            2,
        ),
        (
            Some(DEFAULT),
            Some(r#"{"agents":{"worker":{"model":"a\u200bb"}}}"#),
            Some("."),
            2,
        ),
        (
            Some(DEFAULT),
            Some(r#"{"workspace":"missing"}"#),
            Some("."),
            2,
        ),
        (Some(DEFAULT), Some(r#"{"team":"C"}"#), Some("."), 2),
        (
            Some(DEFAULT),
            Some(r#"{"workspace":"second","team":"EX"}"#),
            Some("."),
            2,
        ),
        (Some(DEFAULT), None, Some("."), 2),
        (
            Some(r#"{"agents":{"worker":{"model":"","effort":"","foo":"no"},"reviewer":{}}}"#),
            None,
            None,
            1,
        ),
        (
            Some(r#"{"agents":{"worker":{"agent":"other"}}}"#),
            None,
            None,
            1,
        ),
        (
            Some(r#"{"workspaces":[{"id":"one"},{"id":"one"}]}"#),
            None,
            None,
            1,
        ),
        (Some(r#"{"context_limit":42}"#), None, None, 1),
        (
            Some(r#"{"notify":[{"type":"webhook","url":"bad"}]}"#),
            None,
            None,
            1,
        ),
        (Some(DEFAULT), None, Some("--help"), 0),
    ] {
        let dir = tempdir().unwrap();
        let root = dir.path();
        if let Some(contents) = config {
            fs::write(root.join("c.json"), contents).unwrap();
        }
        if let Some(effort) = effort {
            fs::write(root.join("plan.json"), format!(r#"{{"effort":{effort}}}"#)).unwrap();
        }
        let mut python = Command::new("python3");
        python.args(["-I", REFERENCE]);
        let mut rust = Command::new(env!("CARGO_BIN_EXE_wg-preview"));
        let [py, rs] = [&mut python, &mut rust].map(|cmd| {
            cmd.current_dir(root)
                .env("HOME", root)
                .env_remove("WG_CONFIG")
                .env("PYTHON_COLORS", "0")
                .arg("config");
            if config.is_some() {
                cmd.env("WG_CONFIG", "./c.json");
            }
            cmd.args(argument).output().unwrap()
        });
        let case = format!("{config:?} {effort:?} {argument:?}");
        assert_eq!(
            py.status.code(),
            Some(code),
            "{case}: {}",
            String::from_utf8_lossy(&py.stderr)
        );
        assert_eq!(
            rs.status.code(),
            Some(code),
            "{case}: {}",
            String::from_utf8_lossy(&rs.stderr)
        );
        assert_eq!(
            String::from_utf8(py.stdout).unwrap(),
            String::from_utf8(rs.stdout).unwrap(),
            "{case}"
        );
        assert_eq!(
            String::from_utf8(py.stderr).unwrap(),
            String::from_utf8(rs.stderr).unwrap(),
            "{case}"
        );
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
                "/../tests/cli-parity/reference/wg.py"
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
    let python = Command::new("python3")
        .args([
            "-I",
            "-c",
            r#"
import pathlib, runpy, sys
lock = runpy.run_path(sys.argv[1])['plan_lock']
try:
    with lock(pathlib.Path(sys.argv[2]), wait=0):
        sys.exit("Python acquired the Rust lock")
except TimeoutError:
    pass
"#,
            REFERENCE,
        ])
        .arg(root.path())
        .env("WG_CONFIG", root.path().join("absent"))
        .output()
        .unwrap();
    assert!(
        python.status.success(),
        "{}",
        String::from_utf8_lossy(&python.stderr)
    );
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
    assert_eq!(
        std::os::unix::process::ExitStatusExt::signal(&status.status),
        Some(nix::libc::SIGXFSZ),
        "{}",
        String::from_utf8_lossy(&status.stdout)
    );
    assert_eq!(load_keymap(dir.path()).unwrap(), original);
    let lock = PlanLock::acquire(dir.path(), Some(std::time::Duration::ZERO)).unwrap();
    lock.save_keymap(&serde_json::json!({"legacy":2})).unwrap();
    assert_eq!(load_keymap(dir.path()).unwrap()["legacy"], 2);
}

#[test]
fn resolves_workspace_pages_and_local_shared_plan() {
    use wg_preview::{ConfigProvider, state::Config};
    if let Some(dir) = std::env::var_os("WG_TEST_SHARED_DIR") {
        let config = Config::discover().unwrap();
        let dir = std::path::Path::new(&dir);
        let expected: serde_json::Value =
            serde_json::from_slice(&fs::read(dir.join("expected")).unwrap()).unwrap();
        assert_eq!(config.load_plan(dir).unwrap(), expected["plan"]);
        assert_eq!(config.resolve("other").unwrap().page_url, expected["page"]);
        return;
    }
    let dir = tempdir().unwrap();
    let root = dir.path();
    fs::create_dir_all(root.join(".config/work-graph")).unwrap();
    fs::write(root.join(".config/work-graph/config.json"),r#"{"page_url":"https://global.invalid","workspaces":[{"team":"EX"},{"id":"other","team":"B","page_url":"https://workspace.invalid/"}]}"#).unwrap();
    fs::write(
        root.join("plan.json"),
        r#"{"effort":{"name":"Example","workspace":"old","team":"old"},"legacy":"keep"}"#,
    )
    .unwrap();
    fs::write(
        root.join("keymap.json"),
        r#"{"collab":{"settings":{"workspace":"other","extra":1}}}"#,
    )
    .unwrap();
    for page in [None, Some("https://override.invalid///")] {
        let mut python = Command::new("python3");
        python.args(["-I","-c","import json, runpy, sys; wg=runpy.run_path(sys.argv[1]); print(json.dumps(dict(plan=wg['load_plan']('.'),page=wg['page_base']('other'))))",REFERENCE]);
        let mut rust = Command::new(std::env::current_exe().unwrap());
        rust.args(["--exact", "resolves_workspace_pages_and_local_shared_plan"])
            .env("WG_TEST_SHARED_DIR", root);
        for cmd in [&mut python, &mut rust] {
            cmd.current_dir(root)
                .env("HOME", root)
                .env_remove("WG_CONFIG")
                .env_remove("WG_UI_URL");
            if let Some(url) = page {
                cmd.env("WG_UI_URL", url);
            }
        }
        let result = python.output().unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        fs::write(root.join("expected"), result.stdout).unwrap();
        let result = rust.output().unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stdout)
        );
    }
}

#[test]
fn python_and_rust_keep_the_same_state_file_hashes() {
    use wg_preview::state::{Config, PlanLock, load_keymap};
    let root = tempdir().unwrap();
    let dir = root.path();
    let script = r#"
import pathlib, runpy, sys
wg=runpy.run_path(sys.argv[1])
p=pathlib.Path(sys.argv[2])
value={"café": '😀"\\\b\f\n\r\t'+''.join(map(chr,range(32)))+chr(127),
       "floats":[0.0,-0.0,1e-4,1e-5,1e15,1e16,1e23,5e-324]}
wg['save_json'](p/'plan.json',dict(effort=dict(team='EX'),edges=[],legacy=value))
wg['save_json'](p/'keymap.json',dict(nodes={},milestones={},legacy=value))
print(wg['plan_file_sha'](p))
"#;
    let hashes = |script: &str| {
        let result = Command::new("python3")
            .args(["-I", "-c", script, REFERENCE])
            .arg(dir)
            .env("WG_CONFIG", dir.join("absent"))
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        result.stdout
    };
    let original_hash = hashes(script);
    let paths = ["plan.json", "keymap.json"].map(|f| dir.join(f));
    let original = paths.each_ref().map(|p| fs::read(p).unwrap());
    let lock = PlanLock::acquire(dir, None).unwrap();
    let config = Config::read(dir.join("absent")).unwrap();
    lock.save_plan(&config.load_plan(dir).unwrap()).unwrap();
    lock.save_keymap(&load_keymap(dir).unwrap()).unwrap();
    assert_eq!(original, paths.each_ref().map(|p| fs::read(p).unwrap()));
    assert_eq!(
        original_hash,
        hashes(
            "import pathlib,runpy,sys; print(runpy.run_path(sys.argv[1])['plan_file_sha'](pathlib.Path(sys.argv[2])))"
        )
    );
}
