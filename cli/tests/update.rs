use std::{fs, process::Command};

#[test]
fn unmanaged_use_does_not_create_update_state() {
    let home = tempfile::tempdir().unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_wg-preview"))
        .arg("--version")
        .env("HOME", home.path())
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    assert_eq!(fs::read_dir(home.path()).unwrap().count(), 0);
}

#[test]
fn managed_commands_throttle_failed_checks_and_recover_offline() {
    use ed25519_dalek::{Signer, SigningKey};
    use sha2::{Digest, Sha256};
    use std::{
        os::unix::fs::symlink,
        time::{Duration, Instant},
    };
    let home = tempfile::tempdir().unwrap();
    let root = home.path().join(".local/share/work-graph");
    let bin = home.path().join(".local/bin");
    let target = env!("WG_BUILD_TARGET");
    let key = SigningKey::from_bytes(&[27; 32]);
    let pin: String = key
        .verifying_key()
        .as_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    // Build as the release workflow does, with a synthetic repository and key.
    let project = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let built = Command::new(env!("CARGO"))
        .current_dir(project)
        .args([
            "build",
            "--locked",
            "--target",
            target,
            "--bin",
            "wg-preview",
            "--message-format=json",
        ])
        .env("WG_RELEASE_REPOSITORY", "fixture/release")
        .env("WG_RELEASE_VERSION", "1.2.0")
        .env("WG_RELEASE_PUBLIC_KEY", &pin)
        .output()
        .unwrap();
    assert!(
        built.status.success(),
        "{}",
        String::from_utf8_lossy(&built.stderr)
    );
    let executable = String::from_utf8(built.stdout)
        .unwrap()
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .find_map(|msg| msg["executable"].as_str().map(String::from))
        .unwrap();
    fs::create_dir_all(&bin).unwrap();
    let active = format!("versions/1.2.0-{target}");
    let previous = format!("versions/1.1.0-{target}");
    for (version, relative) in [("1.2.0", &active), ("1.1.0", &previous)] {
        let dir = root.join(relative);
        fs::create_dir_all(dir.join("skills/work-graph")).unwrap();
        fs::create_dir_all(dir.join("orca-plugin")).unwrap();
        fs::copy(&executable, dir.join("wg")).unwrap();
        fs::write(dir.join("skills/work-graph/SKILL.md"), version).unwrap();
        fs::write(dir.join("orca-plugin/orca-plugin.json"), "{}").unwrap();
        let mut files = std::collections::BTreeMap::new();
        for name in [
            "wg",
            "skills/work-graph/SKILL.md",
            "orca-plugin/orca-plugin.json",
        ] {
            files.insert(
                name,
                format!("{:x}", Sha256::digest(fs::read(dir.join(name)).unwrap())),
            );
        }
        let manifest = serde_json::to_vec(&serde_json::json!({"schema":1,"version":version,
            "target":target,"sha256":"a".repeat(64),"commit":"b".repeat(40),"public_key":pin,"files":files})).unwrap();
        fs::write(dir.join("signer"), &pin).unwrap();
        fs::write(dir.join("manifest.sig"), key.sign(&manifest).to_bytes()).unwrap();
        fs::write(dir.join("manifest.json"), manifest).unwrap();
    }
    symlink(&active, root.join("current")).unwrap();
    symlink(&previous, root.join("previous")).unwrap();
    let launcher = bin.join("wg");
    symlink(root.join("current/wg"), &launcher).unwrap();
    let invoke = |args: &[&str]| {
        let mut cmd = Command::new(&launcher);
        cmd.env("HOME", home.path())
            .env_remove("WG_UPDATE")
            .env("WG_UPDATE_PIN", "invalid")
            .args(args);
        cmd
    };
    assert!(
        invoke(&["--version"])
            .env("WG_UPDATE", "off")
            .status()
            .unwrap()
            .success()
    );
    let stamp = root.join("update-check");
    assert!(!stamp.exists());
    let mut starts: Vec<_> = (0..6)
        .map(|_| {
            invoke(&["--version"])
                .stdout(std::process::Stdio::piped())
                .spawn()
                .unwrap()
        })
        .collect();
    for child in starts.drain(..) {
        let out = child.wait_with_output().unwrap();
        assert!(out.status.success());
        assert_eq!(out.stdout, format!("wg 1.2.0 {target}\n").as_bytes());
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    while !stamp.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    let first = stamp.metadata().unwrap().modified().unwrap();
    assert!(
        invoke(&["--wg-background-update"])
            .status()
            .unwrap()
            .success()
    );
    assert_eq!(first, stamp.metadata().unwrap().modified().unwrap());
    fs::write(root.join(&previous).join("extra"), "local").unwrap();
    assert!(
        !invoke(&["update", "rollback"])
            .output()
            .unwrap()
            .status
            .success()
    );
    assert_eq!(
        fs::read_link(root.join("current")).unwrap(),
        std::path::Path::new(&active)
    );
    fs::remove_file(root.join(&previous).join("extra")).unwrap();
    assert!(invoke(&["update", "rollback"]).status().unwrap().success());
    assert_eq!(
        fs::read_link(root.join("current")).unwrap(),
        std::path::Path::new(&previous)
    );
    assert!(root.join("update-hold").exists());
}
