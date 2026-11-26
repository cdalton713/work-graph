use serde_json::{Value, json};
use std::{
    fs, io,
    path::Path,
    process::{Command, ExitCode},
};
use tempfile::TempDir;
use wg_preview::local::{CardWriter, command};
const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/cli-parity/fixture");
const BIN: &str = env!("CARGO_BIN_EXE_wg-preview");
fn fixture() -> TempDir {
    let root = tempfile::tempdir().unwrap();
    for name in ["journal.jsonl", "plan.json", "keymap.json"] {
        fs::copy(Path::new(FIXTURE).join(name), root.path().join(name)).unwrap();
    }
    root
}
fn km(dir: &Path) -> Value {
    serde_json::from_slice(&fs::read(dir.join("keymap.json")).unwrap()).unwrap()
}

#[test]
fn recorded_local_commands() {
    assert!(
        Command::new("python3")
            .args([
                "-IB",
                concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/cli-parity/local.py"),
                BIN
            ])
            .status()
            .unwrap()
            .success()
    )
}
#[test]
fn mapped_changes_require_a_provider_before_any_write() {
    let root = fixture();
    let dir = root.path();
    let keymap = fs::read(dir.join("keymap.json")).unwrap();
    let journal = fs::read(dir.join("journal.jsonl")).unwrap();
    for (mode, args) in [
        ("set", vec!["a", "branch=wg/example"]),
        ("reset", vec!["a"]),
    ] {
        let o = Command::new(BIN)
            .env("WG_CONFIG", dir.join("config"))
            .args(["run", mode])
            .arg(dir)
            .args(args)
            .output()
            .unwrap();
        assert_eq!(o.status.code(), Some(1));
        assert_eq!(
            o.stderr,
            b"mapped run writes require the Linear card provider\n"
        );
        assert_eq!(fs::read(dir.join("keymap.json")).unwrap(), keymap);
        assert_eq!(fs::read(dir.join("journal.jsonl")).unwrap(), journal);
    }
}
#[test]
fn mapped_card_retry_and_reset() {
    // Isolate config discovery from the developer's installation and other tests.
    let Ok(path) = std::env::var("WG_TEST_CARD_DIR") else {
        let root = fixture();
        assert!(
            Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "mapped_card_retry_and_reset"])
                .env("WG_TEST_CARD_DIR", root.path())
                .env("WG_CONFIG", root.path().join("config"))
                .status()
                .unwrap()
                .success()
        );
        return;
    };
    struct Cards {
        requests: Vec<(Option<String>, String)>,
    }
    impl CardWriter for Cards {
        fn write(&mut self, id: &str, previous: Option<&str>, body: &str) -> io::Result<String> {
            assert_eq!(id, "issue-a");
            self.requests
                .push((previous.map(String::from), body.to_owned()));
            if self.requests.len() == 1 {
                return Err(io::Error::other("temporary read failure"));
            }
            Ok(format!("card-{}", self.requests.len()))
        }
    }
    let dir = Path::new(&path);
    let mut cards = Cards { requests: vec![] };
    let run = |mode: &str, cards: &mut Cards| {
        let mut args = vec!["run", mode, &path, "a"];
        if mode == "set" {
            args.push("branch=wg/example")
        }
        assert_eq!(
            command(args.into_iter().map(String::from).collect(), Some(cards)),
            ExitCode::SUCCESS
        );
    };
    run("set", &mut cards);
    assert!(km(dir)["nodes"]["a"]["card"].is_null());
    assert_eq!(km(dir)["run"]["nodes"]["a"]["branch"], "wg/example");
    run("set", &mut cards);
    assert_eq!(
        km(dir)["nodes"]["a"]["card"],
        json!({"id":"card-2","sha":"4607013abae94fb05e74a79159b6ad5b43f8416f2b9b83703d6620c6be6f9ebb"})
    );
    run("set", &mut cards);
    assert_eq!(cards.requests.len(), 2);
    run("reset", &mut cards);
    assert_eq!(cards.requests[2].0.as_deref(), Some("card-2"));
    assert_eq!(km(dir)["nodes"]["a"]["card"]["id"], "card-3");
    assert!(km(dir)["run"]["nodes"]["a"].is_null());
}
#[test]
fn journal_recovery_and_invalid_graph_match_reference() {
    let roots = [fixture(), fixture()];
    let mut results = vec![];
    for (i, root) in roots.iter().enumerate() {
        let dir = root.path();
        let mut results_for_dir = vec![];
        fs::write(dir.join("journal.1.jsonl"),r#"{"time":"2019-01-01","command":"run set","kind":"baseline","changes":{},"run":{"effort":{"base":"one"},"nodes":{"deleted":{"obsolete":"yes"}}}}"#).unwrap();
        for args in [
            "log . --since 2020-01-01",
            "run rebuild .",
            "run rebuild . --apply",
            "run show . --json",
            "run set . merge branch=two",
            "run reset . merge",
            "log . --times",
            "check .",
        ] {
            if args == "check ." {
                let path = dir.join("plan.json");
                let mut p: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
                p["nodes"][0]["title"] = "".into();
                p["edges"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({"from":"a","to":"merge"}));
                fs::write(path, p.to_string()).unwrap();
            }
            let mut cmd = if i == 0 {
                let mut c = Command::new("python3");
                c.args([
                    "-I",
                    concat!(
                        env!("CARGO_MANIFEST_DIR"),
                        "/../skills/work-graph/scripts/wg.py"
                    ),
                ]);
                c
            } else {
                Command::new(BIN)
            };
            let o = cmd
                .current_dir(dir)
                .env("WG_CONFIG", dir.join("config"))
                .args(args.split_whitespace())
                .output()
                .unwrap();
            results_for_dir.push((args, o.status.code(), o.stdout, o.stderr, km(dir)));
        }
        results.push(results_for_dir);
    }
    for (a, b) in results[0].iter().zip(&results[1]) {
        assert_eq!(a, b)
    }
}

#[test]
fn contract_write_uses_the_selected_checkout() {
    let root = tempfile::tempdir().unwrap();
    let skill = root.path().join("skills/work-graph");
    fs::create_dir_all(&skill).unwrap();
    let o = Command::new(BIN)
        .current_dir(root.path())
        .args(["contract", "--write"])
        .output()
        .unwrap();
    assert!(o.status.success());
    assert!(o.stdout.is_empty());
    assert!(o.stderr.is_empty());
    assert_eq!(
        fs::read(skill.join("contract.json")).unwrap(),
        include_bytes!("../../skills/work-graph/contract.json")
    );
}
