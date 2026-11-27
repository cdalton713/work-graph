use std::process::Command;

#[test]
fn usage_matches_reference_on_synthetic_sessions() {
    let status = Command::new("python3")
        .args([
            "-I",
            concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/cli-parity/usage.py"),
            env!("CARGO_BIN_EXE_wg"),
        ])
        .status()
        .expect("start usage parity check");
    assert!(status.success());
}
