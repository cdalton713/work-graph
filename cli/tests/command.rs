use std::process::Command;

#[test]
fn version_reports_the_build_and_succeeds_without_configuration() {
    let result = Command::new(env!("CARGO_BIN_EXE_wg-preview"))
        .env_clear()
        .arg("--version")
        .output()
        .unwrap();

    assert!(result.status.success());
    assert!(result.stderr.is_empty());
    let line = String::from_utf8(result.stdout).unwrap();
    assert!(line.starts_with(concat!("wg-preview ", env!("CARGO_PKG_VERSION"), " ")));
    assert!(
        line.split_whitespace()
            .last()
            .unwrap()
            .contains(std::env::consts::ARCH)
    );
}

#[test]
fn extra_arguments_fail_with_usage() {
    let result = Command::new(env!("CARGO_BIN_EXE_wg-preview"))
        .args(["--version", "extra"])
        .output()
        .unwrap();
    assert_eq!(result.status.code(), Some(2));
    assert!(result.stdout.is_empty());
    assert!(String::from_utf8_lossy(&result.stderr).contains("Usage:"));
}
