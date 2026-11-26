use serde_json::json;
use std::{fs, process::Command};

#[test]
fn page_channels_in_status_and_config() {
    let home = tempfile::tempdir().unwrap();
    let dir = home.path();
    fs::write(
        dir.join("plan.json"),
        include_bytes!("../../tests/cli-parity/fixture/plan.json"),
    )
    .unwrap();
    for (channel, error) in [
        (json!({"type":"page"}), None),
        (json!({"type":"page","to":"owner@example.invalid"}), None),
        (
            json!({"type":"page","to":"  "}),
            Some("to must name an owner email"),
        ),
        (
            json!({"type":"page","to":null}),
            Some("to must name an owner email"),
        ),
        (
            json!({"type":"page","url":"unexpected"}),
            Some("a page channel takes only type and an optional to"),
        ),
    ] {
        let config = dir.join("config.json");
        fs::write(
            &config,
            json!({"notify":[channel],"workspaces":[{"id":"default","team":"EX"}]}).to_string(),
        )
        .unwrap();
        for verb in ["config", "status"] {
            let out = Command::new(env!("CARGO_BIN_EXE_wg-preview"))
                .env_clear()
                .env("HOME", dir)
                .env("WG_CONFIG", &config)
                .args([verb, "."])
                .current_dir(dir)
                .output()
                .unwrap();
            let stderr = String::from_utf8_lossy(&out.stderr);
            if let Some(error) = error {
                assert!(!out.status.success());
                assert!(stderr.contains(error), "{stderr}");
            } else {
                assert!(out.status.success(), "{verb}: {stderr}");
            }
        }
    }
}
