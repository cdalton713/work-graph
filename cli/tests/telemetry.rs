use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::net::{Ipv4Addr, TcpListener};
use std::process::Command;
use std::time::{Duration, Instant};

const PRIVATE: &str = "private-fixture-marker";

fn listener() -> TcpListener {
    TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap()
}

fn command(socket: &TcpListener) -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_wg"));
    let dsn = format!("http://fixture@{}/17", socket.local_addr().unwrap());
    cmd.env_clear()
        .env("WG_SENTRY_DSN", &dsn)
        .env("SENTRY_DSN", dsn)
        .env("HOME", format!("/home/{PRIVATE}"))
        .env("LINEAR_API_KEY", format!("lin_api_{PRIVATE}"))
        .env("WG_COORDINATOR_TOKEN", PRIVATE);
    cmd
}

fn check_event(
    socket: &TcpListener,
    cmd: &mut Command,
    tag: &str,
    message: &str,
    status: i32,
) -> std::process::Output {
    // Leave the response pending until the command exits to exercise the flush deadline.
    let start = Instant::now();
    let result = cmd.output().unwrap();
    assert_eq!(result.status.code(), Some(status));
    assert!(start.elapsed() < Duration::from_secs(3));

    socket.set_nonblocking(true).unwrap();
    let (stream, _) = socket.accept().expect("expected a Sentry envelope");
    let mut request = BufReader::new(stream);
    let mut line = String::new();
    let mut length = None;
    request.read_line(&mut line).unwrap();
    assert!(line.starts_with("POST /api/17/envelope/"));
    loop {
        line.clear();
        assert_ne!(request.read_line(&mut line).unwrap(), 0);
        if line == "\r\n" {
            break;
        }
        assert!(!line.contains(PRIVATE));
        if let Some(value) = line.to_lowercase().strip_prefix("content-length:") {
            length = Some(value.trim().parse::<usize>().unwrap());
        }
    }
    let mut bytes = vec![0; length.unwrap()];
    request.read_exact(&mut bytes).unwrap();
    let body = String::from_utf8(bytes).unwrap();
    assert!(!body.contains(PRIVATE));
    let event: serde_json::Value = serde_json::from_str(body.lines().nth(2).unwrap()).unwrap();
    assert_eq!(
        event["release"],
        option_env!("WG_RELEASE_VERSION").unwrap_or(env!("CARGO_PKG_VERSION"))
    );
    assert_eq!(event["tags"]["command"], tag);
    assert_eq!(event["message"], message);
    result
}

#[cfg(unix)]
#[test]
fn storage_failure_emits_a_generic_event_only_with_opt_in() {
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    let private_dir = dir.path().join(PRIVATE);
    fs::create_dir(&private_dir).unwrap();
    fs::write(private_dir.join("plan.json"), format!(r#"{{"effort":{{"team":"EX","summary":"{PRIVATE}","page_url":"https://fixture.invalid/?token={PRIVATE}"}}}}"#)).unwrap();
    symlink("keymap.json", private_dir.join("keymap.json")).unwrap();
    let socket = listener();
    let run_check = || {
        let mut cmd = command(&socket);
        cmd.arg("check").arg(&private_dir);
        cmd
    };
    let result = run_check().env_remove("WG_SENTRY_DSN").output().unwrap();
    assert_eq!(result.status.code(), Some(2));
    assert!(!result.stderr.is_empty());
    assert_quiet(&socket);
    let reported = check_event(&socket, &mut run_check(), "check", "Command failed", 2);
    assert_eq!(reported.stderr, result.stderr);
    assert_eq!(reported.stdout, result.stdout);
}

#[cfg(unix)]
#[test]
fn panic_event_omits_panic_payload_and_preserves_exit() {
    use std::{ffi::OsStr, os::unix::ffi::OsStrExt};
    let bytes = [PRIVATE.as_bytes(), &[0xff]].concat();
    let socket = listener();
    check_event(
        &socket,
        command(&socket).arg("usage").arg(OsStr::from_bytes(&bytes)),
        "usage",
        "Command panicked",
        101,
    );
}

#[test]
fn normal_command_results_are_silent() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(
        dir.path().join("plan.json"),
        r#"{"effort":{"rules":42,"team":"EX"}}"#,
    )
    .unwrap();
    let socket = listener();
    let dir = dir.path().to_str().unwrap();
    for (args, code) in [
        (vec![PRIVATE], 2),
        (vec!["login", "--unknown-flag"], 2),
        (vec!["config", dir, "extra"], 2),
        (vec!["check", dir], 1),
        (vec!["usage", "--help"], 0),
        (vec!["--version"], 0),
    ] {
        let result = command(&socket).args(&args).output().unwrap();
        assert_eq!(result.status.code(), Some(code), "{args:?}");
        assert_quiet(&socket);
    }
}

fn assert_quiet(socket: &TcpListener) {
    socket.set_nonblocking(true).unwrap();
    assert_eq!(
        socket.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
}
