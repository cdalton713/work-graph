#[test]
fn workflow_commands_match_reference_services() {
    let result = std::process::Command::new("python3")
        .args([
            "-IB",
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../tests/cli-parity/workflow.py"
            ),
            env!("CARGO_BIN_EXE_wg-preview"),
        ])
        .status()
        .expect("start workflow fixture");
    assert!(result.success());
}
