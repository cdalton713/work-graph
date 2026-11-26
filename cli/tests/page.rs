use std::process::Command;

#[test]
fn logout_accepts_an_explicit_secure_page() {
    let home = tempfile::tempdir().unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_wg-preview"))
        .env_clear()
        .env("HOME", home.path())
        .args(["logout", "https://page.invalid"])
        .output()
        .unwrap();
    assert!(result.status.success(), "{:?}", result.stderr);
    assert!(
        String::from_utf8(result.stdout)
            .unwrap()
            .contains("no saved token")
    );
}

use http::HeaderValue;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    cell::RefCell,
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use wg_preview::{
    ConfigProvider, Credential, CredentialProvider,
    page::{self, Collaboration, LocalEffort, LockedEffort, Result, Settings},
};

#[derive(Debug)]
struct Request {
    line: String,
    headers: String,
    body: Value,
}
struct Server {
    url: String,
    requests: Arc<Mutex<Vec<Request>>>,
}
impl Server {
    fn new(responses: Vec<(u16, Value)>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&requests);
        thread::spawn(move || {
            for (status, payload) in responses {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut reader = BufReader::new(&socket);
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                let mut headers = String::new();
                loop {
                    let mut h = String::new();
                    reader.read_line(&mut h).unwrap();
                    if h == "\r\n" || h.is_empty() {
                        break;
                    }
                    headers.push_str(&h.to_ascii_lowercase());
                }
                let len = headers
                    .lines()
                    .find_map(|s| s.strip_prefix("content-length: "))
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(0);
                let mut bytes = vec![0; len];
                reader.read_exact(&mut bytes).unwrap();
                captured.lock().unwrap().push(Request {
                    line,
                    headers,
                    body: serde_json::from_slice(&bytes).unwrap_or(Value::Null),
                });
                let body = if matches!(status, 204 | 304) {
                    String::new()
                } else {
                    payload.to_string()
                };
                write!(socket,"HTTP/1.1 {status} fixture\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
            }
        });
        Self { url, requests }
    }
}
#[test]
fn login_checks_token_before_replacing_private_file() {
    let server = Server::new(vec![
        (200, json!({"auth":false})),
        (400, json!({})),
        (403, json!({})),
        (200, json!({"workspaces":[]})),
        (401, json!({})),
    ]);
    let home = tempfile::tempdir().unwrap();
    let config = home.path().join("config.json");
    fs::write(&config, json!({"page_url":server.url}).to_string()).unwrap();
    let invoke = |verb: &str, token: &str| {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_wg-preview"));
        cmd.env_clear()
            .env("HOME", home.path())
            .env("WG_CONFIG", &config)
            .arg(verb);
        if verb == "login" {
            cmd.arg("--token-stdin");
        }
        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(token.as_bytes())
            .unwrap();
        child.wait_with_output().unwrap()
    };
    let result = invoke("login", "secret-one\n");
    assert!(result.status.success(), "{:?}", result.stderr);
    let directory = home.path().join(".config/work-graph/pages");
    let path = directory.join(format!(
        "127.0.0.1_{}-token",
        server.url.rsplit(':').next().unwrap()
    ));
    assert_eq!(
        directory.metadata().unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert_eq!(path.metadata().unwrap().permissions().mode() & 0o777, 0o600);
    let denied = invoke("login", "secret-two\n");
    assert!(!denied.status.success());
    assert!(!String::from_utf8_lossy(&denied.stderr).contains("secret"));
    assert_eq!(fs::read_to_string(&path).unwrap(), "secret-one\n");
    let requests = server.requests.lock().unwrap();
    assert!(
        requests[1]
            .headers
            .contains("authorization: bearer secret-one")
    );
    assert!(!requests[2].headers.contains("authorization"));
    assert!(invoke("logout", "").status.success());
    assert!(!path.exists());
}

fn plan() -> Value {
    json!({"effort":{"name":"Fixture","slug":"fixture","team":"T","workspace":"test","rules":"/owner/rules"},"phases":[{"key":"phase","target":"main"}],"nodes":[{"key":"node","kind":"task","phase":"phase","issue":"T-1"}],"edges":[]})
}
fn mapping() -> Value {
    json!({"project":{"id":"p"},"nodes":{"node":{"id":"issue","identifier":"T-1","card":{"id":"card"}}},"milestones":{"phase":"milestone"},"status_doc":{"id":"doc"}})
}
fn published(version: u64) -> Value {
    json!({"plan":plan(),"keymap":mapping(),"version":version,"writer":"Editor"})
}
fn status() -> Value {
    json!({"human":"Tester","workspaces":[{"id":"shared:abc","name":"Fixture","owner":"Owner","role":"collaborator","projectId":"p"}]})
}

struct Fixture {
    home: tempfile::TempDir,
    page: String,
    deny: RefCell<Option<String>>,
}
impl Fixture {
    fn new(server: &Server) -> Self {
        Self {
            home: tempfile::tempdir().unwrap(),
            page: server.url.clone(),
            deny: RefCell::new(None),
        }
    }
    fn dir(&self) -> &Path {
        self.home.path()
    }
    fn allow(&self, kind: &str) -> Result<()> {
        if self.deny.borrow().as_deref() == Some(kind) {
            Err(format!("denied {kind}"))
        } else {
            Ok(())
        }
    }
    fn run(&self, args: &[&str]) -> Result<String> {
        page::run(
            &args.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
            self,
            self,
            Some(self),
        )
    }
}
impl ConfigProvider for Fixture {
    type Settings = Settings;
    type Error = String;
    fn resolve(&self, _: &str) -> Result<Settings> {
        Ok(Settings {
            page: Some(self.page.clone()),
            human: "Tester".into(),
            token_directory: self.dir().join("tokens"),
            workspaces: vec![("test".into(), "Test".into(), Some(self.page.clone()))],
        })
    }
}
impl CredentialProvider for Fixture {
    type Error = String;
    fn credential(&self, _: &str, service: &str) -> Result<Option<Credential>> {
        assert_eq!(service, "page");
        Ok(Some(Credential::new(HeaderValue::from_static(
            "Bearer fixture",
        ))))
    }
}
struct Files(PathBuf);
impl LockedEffort for Files {
    fn read(&self) -> Result<LocalEffort> {
        let bytes = fs::read(self.0.join("plan.json")).ok();
        let plan = bytes
            .as_deref()
            .map(|b| serde_json::from_slice(b).unwrap())
            .unwrap_or(Value::Null);
        let sha = bytes.map(|b| format!("{:x}", Sha256::digest(b)));
        let keymap = fs::read(self.0.join("keymap.json"))
            .ok()
            .map(|b| serde_json::from_slice(&b).unwrap())
            .unwrap_or_else(|| json!({"nodes":{},"milestones":{}}));
        Ok(LocalEffort { plan, keymap, sha })
    }
    fn save_keymap(&self, km: &Value) -> Result<()> {
        fs::write(self.0.join("keymap.json"), km.to_string()).map_err(|e| e.to_string())
    }
    fn save_pair(
        &self,
        plan: &Value,
        km: &Value,
        prior: Option<&str>,
        heading: Option<&str>,
    ) -> Result<()> {
        assert_eq!(self.read()?.sha.as_deref(), prior);
        let bytes = serde_json::to_vec_pretty(plan).unwrap();
        let mut km = km.clone();
        km["collab"]["plan_sha"] = json!(format!("{:x}", Sha256::digest(&bytes)));
        fs::write(self.0.join("plan.json"), bytes).unwrap();
        self.save_keymap(&km)?;
        if let Some(h) = heading {
            fs::write(self.0.join("PLAN.md"), h).unwrap();
        }
        Ok(())
    }
    fn backup_conflict(&self, sha: &str, plan: &Value) -> Result<()> {
        fs::write(
            self.0.join(format!("plan.conflict-{}.json", &sha[..12])),
            plan.to_string(),
        )
        .map_err(|e| e.to_string())
    }
}
impl Collaboration for Fixture {
    fn lock(&self, _: &Path) -> Result<Box<dyn LockedEffort + '_>> {
        Ok(Box::new(Files(self.dir().into())))
    }
    fn join_worktree(
        &self,
        _: &Path,
        _: &Value,
        _: &str,
    ) -> Result<(PathBuf, Box<dyn LockedEffort + '_>)> {
        self.allow("worktree")?;
        Ok((self.dir().into(), self.lock(self.dir())?))
    }
    fn project_workspace(&self, team: &str, project: &str, name: &str) -> Result<String> {
        assert_eq!((team, project, name), ("T", "p", "Fixture"));
        self.allow("team")?;
        Ok("test".into())
    }
    fn verify_issue(&self, _: &str, project: &str, label: &str, id: Option<&str>) -> Result<()> {
        assert_eq!((project, label), ("p", "T-1"));
        self.allow(if id == Some("issue") {
            "mapping"
        } else {
            "reference"
        })
    }
    fn verify_milestone(&self, _: &str, p: &str, id: &str) -> Result<()> {
        assert_eq!((p, id), ("p", "milestone"));
        self.allow("milestone")
    }
    fn verify_document(&self, _: &str, p: &str, id: &str) -> Result<()> {
        assert_eq!((p, id), ("p", "doc"));
        self.allow("document")
    }
    fn verify_card(&self, _: &str, issue: &str, id: &str) -> Result<()> {
        assert_eq!((issue, id), ("issue", "card"));
        self.allow("card")
    }
    fn normalize_and_check(&self, _: &mut Value) -> Result<()> {
        self.allow("plan")
    }
}

#[test]
fn join_rejects_unverified_data_before_creating_files() {
    for kind in [
        "team",
        "mapping",
        "reference",
        "milestone",
        "document",
        "card",
        "plan",
        "worktree",
    ] {
        let server = Server::new(vec![(200, status()), (200, published(1))]);
        let fixture = Fixture::new(&server);
        *fixture.deny.borrow_mut() = Some(kind.into());
        assert_eq!(
            fixture.run(&["join"]).unwrap_err(),
            format!("denied {kind}")
        );
        assert_eq!(fs::read_dir(fixture.dir()).unwrap().count(), 0);
    }
    for (field, value) in [("role", "viewer"), ("human", "Other")] {
        let mut status = status();
        if field == "role" {
            status["workspaces"][0][field] = json!(value);
        } else {
            status[field] = json!(value);
        }
        let fixture = Fixture::new(&Server::new(vec![(200, status)]));
        assert!(fixture.run(&["join"]).is_err());
        assert_eq!(fs::read_dir(fixture.dir()).unwrap().count(), 0);
    }
}

#[test]
fn collaborator_joins_pulls_and_releases_only_own_claims() {
    let server = Server::new(vec![
        (200, status()),
        (200, published(1)),
        (200, published(2)),
        (304, Value::Null),
        (
            200,
            json!({"claims":[{"node":"mine","mine":true},{"node":"other","mine":false}]}),
        ),
        (204, Value::Null),
    ]);
    let f = Fixture::new(&server);
    f.run(&["join", "--project", "shared:abc"]).unwrap();
    assert_eq!(
        fs::read_to_string(f.dir().join("PLAN.md")).unwrap(),
        "# Fixture by Owner\n"
    );
    let files = Files(f.dir().into());
    assert!(files.read().unwrap().plan["effort"]["rules"].is_null());
    assert!(
        f.run(&["pull", "."])
            .unwrap()
            .contains("kept the local setting")
    );
    assert_eq!(files.read().unwrap().keymap["collab"]["version"], 2);
    assert_eq!(f.run(&["pull", "."]).unwrap(), "plan v2 is current");
    f.run(&["leave", "."]).unwrap();
    assert!(files.read().unwrap().keymap.get("collab").is_none());
    let requests = server.requests.lock().unwrap();
    assert!(requests[2].headers.contains("if-none-match: \"1\""));
    assert!(requests[2].headers.contains("x-workspace: shared:abc"));
    assert!(
        requests[5]
            .line
            .starts_with("DELETE /api/projects/p/claims/mine ")
    );
}

#[test]
fn share_preserves_local_fields_and_uses_conditional_creation() {
    for code in [200, 412, 403] {
        let server = Server::new(vec![(code, json!({"version":1}))]);
        let f = Fixture::new(&server);
        fs::write(f.dir().join("plan.json"), plan().to_string()).unwrap();
        let mut km = mapping();
        km["nodes"]["node"]["dispatch"] = json!("private");
        let files = Files(f.dir().into());
        files.save_keymap(&km).unwrap();
        let answer = f.run(&["share", "."]);
        assert_eq!(answer.is_ok(), code == 200);
        let after = files.read().unwrap().keymap;
        if code == 200 {
            assert_eq!(after["collab"]["version"], 1);
        } else {
            assert_eq!(after, km);
        }
        let requests = server.requests.lock().unwrap();
        assert!(requests[0].line.starts_with("PUT /api/projects/p/plan "));
        assert!(requests[0].headers.contains("if-none-match: *"));
        assert!(
            requests[0].body["keymap"]["nodes"]["node"]
                .get("dispatch")
                .is_none()
        );
    }
}

#[test]
fn pull_keeps_local_edits_and_validates_new_references_even_with_force() {
    let server = Server::new(vec![
        (200, status()),
        (200, published(1)),
        (200, published(2)),
        (200, published(2)),
    ]);
    let f = Fixture::new(&server);
    f.run(&["join"]).unwrap();
    let mut local = Files(f.dir().into()).read().unwrap();
    local.plan["nodes"][0]
        .as_object_mut()
        .unwrap()
        .remove("issue");
    fs::write(f.dir().join("plan.json"), local.plan.to_string()).unwrap();
    let before = fs::read(f.dir().join("keymap.json")).unwrap();
    assert!(
        f.run(&["pull", "."])
            .unwrap_err()
            .contains("save your change")
    );
    *f.deny.borrow_mut() = Some("reference".into());
    assert_eq!(
        f.run(&["pull", ".", "--force"]).unwrap_err(),
        "denied reference"
    );
    assert_eq!(fs::read(f.dir().join("keymap.json")).unwrap(), before);
    assert_eq!(
        fs::read_to_string(f.dir().join("plan.json")).unwrap(),
        local.plan.to_string()
    );
}

#[test]
fn coordinator_replays_state_after_planned_close_and_bounds_idle_wait() {
    use tungstenite::{
        Message,
        protocol::{CloseFrame, frame::coding::CloseCode},
    };
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let page = format!("http://{}", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        for index in 0..2 {
            let stream = listener.accept().unwrap().0;
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut ws = tungstenite::accept(stream).unwrap();
            for kind in ["hello", "state"] {
                let frame: Value =
                    serde_json::from_str(ws.read().unwrap().to_text().unwrap()).unwrap();
                assert_eq!(frame["type"], kind);
                assert_eq!(frame["project"], json!({"workspace":"","id":"p"}));
            }
            if index == 0 {
                ws.close(Some(CloseFrame {
                    code: CloseCode::from(4001),
                    reason: "recycle".into(),
                }))
                .unwrap();
            } else {
                ws.send(Message::text(r#"{"v":1,"type":"ack"}"#)).unwrap();
                thread::sleep(Duration::from_millis(200));
            }
        }
    });
    let settings = Settings {
        page: Some(page.clone()),
        human: "Tester".into(),
        token_directory: PathBuf::new(),
        workspaces: vec![],
    };
    let mut link = page::link::Link::new(
        &settings,
        &page,
        "test",
        "p",
        "session",
        json!({"host":"local"}),
        None,
    )
    .unwrap();
    link.send("state", json!({"nodes":[]})).unwrap();
    assert_eq!(
        link.wait(Duration::from_secs(2)).unwrap().unwrap()["type"],
        "ack"
    );
    let start = Instant::now();
    assert!(link.wait(Duration::from_millis(25)).unwrap().is_none());
    assert!(start.elapsed() < Duration::from_secs(1));
    server.join().unwrap();
}

#[test]
fn preview_refuses_missing_providers_and_invite_links_before_writes() {
    let dir = tempfile::tempdir().unwrap();
    for args in [
        &["pull", "."][..],
        &["join", "https://page.invalid/%6aoin/fixture-secret"],
    ] {
        let result = Command::new(env!("CARGO_BIN_EXE_wg-preview"))
            .env_clear()
            .env("HOME", dir.path())
            .current_dir(dir.path())
            .args(args)
            .output()
            .unwrap();
        assert_eq!(result.status.code(), Some(2));
        let message = String::from_utf8(result.stderr).unwrap();
        assert!(!message.contains("fixture-secret"));
        assert!(message.contains(if args[0] == "join" {
            "browser"
        } else {
            "providers"
        }));
    }
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
}

#[test]
fn unsafe_remote_plans_do_not_create_join_files() {
    for (pointer, bad) in [
        ("/plan/effort/name", "Other"),
        ("/keymap/project/id", "other"),
        ("/plan/effort/slug", "../outside"),
        ("/plan/phases/0/target", "refs/../outside"),
        ("/plan/nodes/0/key", "BAD"),
        ("/keymap/nodes/node/identifier", "malformed"),
    ] {
        let mut remote = published(1);
        *remote.pointer_mut(pointer).unwrap() = json!(bad);
        let f = Fixture::new(&Server::new(vec![(200, status()), (200, remote)]));
        assert!(f.run(&["join"]).is_err(), "{pointer}");
        assert_eq!(fs::read_dir(f.dir()).unwrap().count(), 0);
    }
}

#[test]
fn force_and_accept_settings_are_independent() {
    let server = Server::new(vec![
        (200, status()),
        (200, published(1)),
        (200, published(2)),
        (200, published(2)),
    ]);
    let f = Fixture::new(&server);
    f.run(&["join"]).unwrap();
    let files = Files(f.dir().into());
    let mut edited = files.read().unwrap().plan;
    edited["effort"]["summary"] = json!("local edit");
    fs::write(f.dir().join("plan.json"), edited.to_string()).unwrap();
    assert!(
        f.run(&["pull", ".", "--force"])
            .unwrap()
            .contains("discarded local plan changes")
    );
    let current = files.read().unwrap();
    assert!(current.plan["effort"].get("summary").is_none());
    assert!(current.plan["effort"].get("rules").is_none());
    f.run(&["pull", ".", "--accept-settings"]).unwrap();
    assert_eq!(
        files.read().unwrap().plan["effort"]["rules"],
        "/owner/rules"
    );
}

#[test]
fn current_plan_rebases_pending_mapping_after_conditional_write_conflict() {
    let mut remote = published(2);
    remote["keymap"]["nodes"]["node"]["branch"] = json!("server-branch");
    let server = Server::new(vec![
        (200, status()),
        (200, published(1)),
        (304, Value::Null),
        (412, json!({})),
        (200, remote),
        (200, json!({"version":3})),
    ]);
    let f = Fixture::new(&server);
    f.run(&["join"]).unwrap();
    let files = Files(f.dir().into());
    let mut km = files.read().unwrap().keymap;
    km["collab"]["pending"] = mapping();
    km["nodes"]["node"]["pr"] = json!(123);
    files.save_keymap(&km).unwrap();
    f.run(&["pull", "."]).unwrap();
    let after = files.read().unwrap().keymap;
    assert_eq!(after["collab"]["version"], 3);
    assert!(after["collab"].get("pending").is_none());
    assert_eq!(after["nodes"]["node"]["branch"], "server-branch");
    let requests = server.requests.lock().unwrap();
    assert!(requests[5].headers.contains("if-match: \"2\""));
    assert_eq!(requests[5].body["keymap"]["nodes"]["node"]["pr"], 123);
}
