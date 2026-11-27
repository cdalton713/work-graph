use std::process::Command;

#[test]
fn production_commands_match_reference_services() {
    assert!(
        Command::new("python3")
            .args([
                "-IB",
                concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/../tests/cli-parity/providers.py"
                ),
                env!("CARGO_BIN_EXE_wg")
            ])
            .status()
            .unwrap()
            .success()
    );
}
