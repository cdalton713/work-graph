use serde_json::{Value, json};
use std::{net::TcpListener, path::PathBuf, thread, time::Duration};
use wg::page::{Settings, link::Link};

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
    let out = Command::new(env!("CARGO_BIN_EXE_wg"))
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

#[test]
fn public_automation_commands_use_fixture_services_and_files() {
    for script in [
        "automation.py",
        "automation-live.py",
        "automation-decisions.py",
        "automation-parity.py",
    ] {
        let result = std::process::Command::new("python3")
            .arg("-IB")
            .arg(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../tests/cli-parity")
                    .join(script),
            )
            .arg(env!("CARGO_BIN_EXE_wg"))
            .status()
            .unwrap();
        assert!(result.success(), "{script} failed");
    }
}

#[test]
fn public_next_reconnects_replays_state_and_acknowledges_the_wakeup() {
    use tungstenite::{
        Message,
        protocol::{CloseFrame, frame::coding::CloseCode},
    };
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let page = format!("http://{}", listener.local_addr().unwrap());
    listener.set_nonblocking(true).unwrap();
    let server = thread::spawn(move || {
        let deadline = std::time::Instant::now() + Duration::from_secs(50);
        for pass in 0..4 {
            let stream = loop {
                match listener.accept() {
                    Ok((s, _)) => break s,
                    Err(e)
                        if e.kind() == std::io::ErrorKind::WouldBlock
                            && std::time::Instant::now() < deadline =>
                    {
                        thread::sleep(Duration::from_millis(10))
                    }
                    Err(e) => panic!("missing coordinator connection: {e}"),
                }
            };
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(10)))
                .unwrap();
            let mut ws = tungstenite::accept(stream).unwrap();
            let mut kinds = std::collections::BTreeSet::new();
            while kinds.len() < 4 {
                let frame: Value =
                    serde_json::from_str(ws.read().unwrap().to_text().unwrap()).unwrap();
                if kinds.is_empty() {
                    assert_eq!(frame["type"], "hello");
                    match pass {
                        2 => {
                            for message in [
                                json!({"id":"missing-key","type":"command","payload":{"name":"dispatch","issue":"unknown"}}),
                                json!({"id":"queued","type":"answer","payload":{"key":"a","issue":"EX-1","body":"queued before refresh"}})
                            ] {
                                let mut message=message;
                                message["v"]=json!(1);
                                ws.send(Message::text(message.to_string())).unwrap();
                            }
                        },
                        3 => ws.send(Message::text(json!({"v":1,"id":"reply","type":"reply","payload":{"key":"a","issue":"EX-1","ask":"question","body":"acknowledged"}}).to_string())).unwrap(),
                        _=>(),
                    }
                }
                if frame["type"] == "progress" {
                    let nodes = frame["payload"]["nodes"].as_array().unwrap();
                    assert!(nodes.iter().any(|row| row["key"] == "a"
                        && row["job"] == "work"
                        && row["evidence"] == "pass on 1234567"));
                }
                kinds.insert(frame["type"].as_str().unwrap().to_string());
            }
            assert_eq!(
                kinds,
                ["asks", "hello", "progress", "state"]
                    .map(String::from)
                    .into_iter()
                    .collect()
            );
            if pass == 0 {
                ws.close(Some(CloseFrame {
                    code: CloseCode::from(4001),
                    reason: "planned".into(),
                }))
                .unwrap();
                continue;
            }
            let answer = |body: &str| {
                Message::text(json!({"v":1,"id":"wake","type":"answer","payload":{"key":"a","issue":"EX-1","body":body}}).to_string())
            };
            if pass == 1 {
                ws.send(answer("fixture answer")).unwrap();
            }
            loop {
                let frame: Value =
                    serde_json::from_str(ws.read().unwrap().to_text().unwrap()).unwrap();
                if frame["type"] == "ack" {
                    if pass == 3 && frame["payload"]["ids"] == json!(["reply"]) {
                        ws.send(answer("after reply")).unwrap();
                    } else {
                        assert_eq!(
                            frame["payload"]["ids"],
                            if pass == 2 {
                                json!(["missing-key", "queued"])
                            } else {
                                json!(["wake"])
                            }
                        );
                        break;
                    }
                }
            }
        }
    });
    let out = std::process::Command::new("python3")
        .args([
            "-IB",
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../tests/cli-parity/automation-live.py"
            ),
            env!("CARGO_BIN_EXE_wg"),
            &page,
        ])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    server.join().unwrap();
}
