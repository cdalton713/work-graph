use serde_json::{Value, json};
use std::{net::TcpListener, path::PathBuf, thread, time::Duration};
use wg_preview::page::{Settings, link::Link};

#[test]
fn agents_connection_exchanges_a_reply_without_registering_a_coordinator() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let page = format!("http://{}", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        let stream = listener.accept().unwrap().0;
        stream
            .set_read_timeout(Some(Duration::from_secs(4)))
            .unwrap();
        stream.set_nonblocking(false).unwrap();
        let mut socket = tungstenite::accept(stream).unwrap();
        let first: Value = serde_json::from_str(socket.read().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(first["type"], "agents");
        assert_eq!(
            first["payload"],
            json!({"agents":[],"replies":true,"sender":"s"})
        );
        socket.send(tungstenite::Message::text(json!({"v":1,"project":{"id":"p"},"type":"agent-reply","payload":{"id":"r","body":"fixture"}}).to_string())).unwrap();
        let second: Value =
            serde_json::from_str(socket.read().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(second["type"], "agent-reply-result");
        assert_eq!(
            second["payload"],
            json!({"id":"r","status":"delivered","messageId":"fixture"})
        );
    });
    let settings = Settings {
        page: Some(page.clone()),
        human: "Human".into(),
        token_directory: PathBuf::new(),
        workspaces: vec![],
    };
    let link = Link::new(&settings, &page, "test", "p", "s", json!({}), None).unwrap();
    assert!(
        link.send_agents(json!({"agents":[],"replies":true,"sender":"s"}), |reply| {
            assert_eq!(reply["body"], "fixture");
            json!({"id":reply["id"],"status":"delivered","messageId":"fixture"})
        })
        .unwrap()
    );
    server.join().unwrap();
}

#[test]
fn public_sender_delivers_one_reply_through_local_orca() {
    use std::{fs, os::unix::fs::PermissionsExt, process::Command};
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().canonicalize().unwrap();
    let dir = home.join("test-core");
    fs::create_dir(&dir).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let page = format!("http://{}", listener.local_addr().unwrap());
    fs::write(
        dir.join("plan.json"),
        include_bytes!("../../tests/cli-parity/fixture/plan.json"),
    )
    .unwrap();
    fs::write(
        dir.join("keymap.json"),
        include_bytes!("../../tests/cli-parity/fixture/keymap.json"),
    )
    .unwrap();
    let config = home.join("config");
    fs::write(
        &config,
        json!({"page_url":page,"agent_replies":true,"tick_roots":[home]}).to_string(),
    )
    .unwrap();
    let orca = home.join("orca");
    fs::write(&orca,r#"#!/bin/sh
case "$1 $2" in
'agent list')
    printf '{"result":{"agents":[{"orcaSessionId":"fixture","agent":"codex","state":"done","updatedAt":%s,"kind":"chat","worktreeId":"repo::%s"}]}}\n' "$STAMP" "$PLAN"
    ;;
'orchestration send')
    while [ "$1" != "--body-file" ]; do shift; done
    /bin/cat "$2" >> "$HOME/mail"
    echo '{"ok":true,"result":{"message":{"id":"mail"}}}'
    ;;
*) exit 1;;
esac
"#).unwrap();
    fs::set_permissions(&orca, fs::Permissions::from_mode(0o755)).unwrap();
    listener.set_nonblocking(true).unwrap();
    let server = thread::spawn(move || {
        let end = std::time::Instant::now() + Duration::from_secs(5);
        let stream = loop {
            match listener.accept() {
                Ok((s, _)) => break s,
                Err(e)
                    if e.kind() == std::io::ErrorKind::WouldBlock
                        && std::time::Instant::now() < end =>
                {
                    thread::sleep(Duration::from_millis(10))
                }
                Err(e) => panic!("sender did not connect: {e}"),
            }
        };
        stream
            .set_read_timeout(Some(Duration::from_secs(4)))
            .unwrap();
        stream.set_nonblocking(false).unwrap();
        let mut socket = tungstenite::accept(stream).unwrap();
        let read = |socket: &mut tungstenite::WebSocket<std::net::TcpStream>| {
            serde_json::from_str::<Value>(socket.read().unwrap().to_text().unwrap()).unwrap()
        };
        let first = read(&mut socket);
        assert_eq!(first["type"], "agents");
        assert_eq!(first["payload"]["agents"][0]["id"], "fixture");
        assert_eq!(first["payload"]["replies"], true);
        socket.send(tungstenite::Message::text(json!({"v":1,"project":{"id":"project"},"type":"agent-reply","payload":{"id":"r","body":"hello","agent":"fixture"}}).to_string())).unwrap();
        let ack = read(&mut socket);
        assert_eq!(ack["type"], "agent-reply-result");
        assert_eq!(
            ack["payload"],
            json!({"id":"r","status":"delivered","messageId":"mail"})
        );
    });
    let out = Command::new(env!("CARGO_BIN_EXE_wg-preview"))
        .args(["agents", "--once"])
        .env_clear()
        .env("HOME", &home)
        .env("PATH", &home)
        .env("PLAN", &dir)
        .env("STAMP", chrono::Utc::now().timestamp_millis().to_string())
        .env("WG_CONFIG", config)
        .env("ORCA_AGENT_SESSION_ID", "synthetic")
        .env("ORCA_CLI_COMMAND", &orca)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    server.join().unwrap();
    assert!(String::from_utf8_lossy(&out.stdout).contains("Example: coordinator codex done"));
    assert_eq!(fs::read_to_string(home.join("mail")).unwrap(), "hello");
}
