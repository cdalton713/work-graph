use std::ffi::OsStr;
use std::io::{BufRead, BufReader, Read};
use std::net::{Ipv4Addr, TcpListener};
use std::process::Command;
use std::time::{Duration, Instant};

const PRIVATE: &str = "private-fixture-marker";

fn listener() -> TcpListener {
    TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap()
}

fn command(socket: &TcpListener) -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_wg-preview"));
    let dsn = format!("http://fixture@{}/17", socket.local_addr().unwrap());
    cmd.env_clear()
        .env("WG_SENTRY_DSN", &dsn)
        .env("SENTRY_DSN", dsn)
        .env("HOME", format!("/home/{PRIVATE}"))
        .env("LINEAR_API_KEY", format!("lin_api_{PRIVATE}"))
        .env("WG_COORDINATOR_TOKEN", PRIVATE);
    cmd
}

fn check_event(verb: &OsStr, arg: &OsStr, tag: &str, message: &str, status: i32) {
    let socket = listener();
    // Leave the response pending until the command exits to exercise the flush deadline.
    let start = Instant::now();
    let result = command(&socket).args([verb, arg]).output().unwrap();
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
    assert_eq!(event["release"], env!("CARGO_PKG_VERSION"));
    assert_eq!(event["tags"]["command"], tag);
    assert_eq!(event["message"], message);
}

#[test]
fn fatal_event_omits_unknown_verbs_arguments_and_environment() {
    let details =
        format!(r#"{{"plan":"{PRIVATE}","page_url":"https://fixture.invalid/?token={PRIVATE}"}}"#);
    check_event(
        PRIVATE.as_ref(),
        details.as_ref(),
        "unknown",
        "Command failed",
        2,
    );
}

#[cfg(unix)]
#[test]
fn panic_event_omits_panic_payload_and_preserves_exit() {
    use std::os::unix::ffi::OsStrExt;
    let bytes = [PRIVATE.as_bytes(), &[0xff]].concat();
    check_event(
        "usage".as_ref(),
        OsStr::from_bytes(&bytes),
        "usage",
        "Command panicked",
        101,
    );
}

#[test]
fn no_connection_without_opt_in_or_after_success() {
    let socket = listener();
    assert!(
        !command(&socket)
            .env_remove("WG_SENTRY_DSN")
            .arg(PRIVATE)
            .status()
            .unwrap()
            .success()
    );
    assert!(
        command(&socket)
            .arg("--version")
            .status()
            .unwrap()
            .success()
    );
    socket.set_nonblocking(true).unwrap();
    assert_eq!(
        socket.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
}
