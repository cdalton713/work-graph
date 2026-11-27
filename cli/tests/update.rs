use std::{fs, process::Command};

#[test]
fn unmanaged_use_does_not_create_update_state() {
    let home = tempfile::tempdir().unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_wg"))
        .arg("--version")
        .env("HOME", home.path())
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    assert_eq!(fs::read_dir(home.path()).unwrap().count(), 0);
}

#[test]
fn managed_two_version_trial() {
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../tests/cli-parity/update_trial.py");
    assert!(
        Command::new("python3")
            .arg("-I")
            .arg(script)
            .arg(env!("CARGO"))
            .arg(env!("WG_BUILD_TARGET"))
            .status()
            .unwrap()
            .success()
    );
}
