#[test]
fn job_commands_at_recorded_boundaries() {
    let status = std::process::Command::new("python3")
        .args([
            "-IB",
            concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/cli-parity/jobs.py"),
            env!("CARGO_BIN_EXE_wg-preview"),
        ])
        .status()
        .expect("start job fixtures");
    assert!(status.success());
}
