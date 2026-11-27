use std::process::Command;

#[test]
fn version_reports_the_build_and_succeeds_without_configuration() {
    let result = Command::new(env!("CARGO_BIN_EXE_wg"))
        .env_clear()
        .arg("--version")
        .output()
        .unwrap();

    assert!(result.status.success());
    assert!(result.stderr.is_empty());
    let line = String::from_utf8(result.stdout).unwrap();
    assert!(line.starts_with(concat!("wg ", env!("CARGO_PKG_VERSION"), " ")));
    assert!(
        line.split_whitespace()
            .last()
            .unwrap()
            .contains(std::env::consts::ARCH)
    );
}

#[test]
fn extra_arguments_fail_with_usage() {
    let result = Command::new(env!("CARGO_BIN_EXE_wg"))
        .args(["--version", "extra"])
        .output()
        .unwrap();
    assert_eq!(result.status.code(), Some(2));
    assert!(result.stdout.is_empty());
    let stderr = String::from_utf8_lossy(&result.stderr);
    assert!(stderr.starts_with("usage: wg [-h]"));
    assert!(stderr.contains("wg: error: unrecognized arguments: --version extra"));
}

fn wg(args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_wg"))
        .env_clear()
        .env("HOME", std::env::temp_dir())
        .env("WG_LINK", "off")
        .args(args)
        .output()
        .unwrap()
}

#[test]
fn bare_wg_prints_the_root_usage_and_fails() {
    let result = wg(&[]);
    assert_eq!(result.status.code(), Some(2));
    assert!(result.stdout.is_empty());
    let stderr = String::from_utf8_lossy(&result.stderr);
    assert!(stderr.starts_with("usage: wg [-h]"), "{stderr}");
    assert!(stderr.contains("doctor"), "{stderr}");
    assert!(stderr.contains("wg: error: the following arguments are required: command"));
    assert!(!stderr.contains("wg-preview") && !stderr.contains("wg.py"));
}

#[test]
fn an_unknown_command_names_it_and_fails() {
    let result = wg(&["bogus"]);
    assert_eq!(result.status.code(), Some(2));
    let stderr = String::from_utf8_lossy(&result.stderr);
    assert!(stderr.starts_with("usage: wg [-h]"), "{stderr}");
    assert!(stderr.contains("invalid choice: 'bogus'"), "{stderr}");
}

#[test]
fn help_prints_the_same_root_help_as_the_flag() {
    let help = wg(&["help"]);
    let flag = wg(&["--help"]);
    assert!(help.status.success());
    assert!(help.stderr.is_empty());
    assert_eq!(help.stdout, flag.stdout);
    let stdout = String::from_utf8_lossy(&help.stdout);
    assert!(stdout.starts_with("usage: wg [-h]"), "{stdout}");
    assert!(!stdout.contains("wg.py"));
}

#[test]
fn help_with_a_command_prints_that_command_help() {
    let help = wg(&["help", "doctor"]);
    let flag = wg(&["doctor", "--help"]);
    assert!(help.status.success(), "{:?}", help);
    assert_eq!(help.stdout, flag.stdout);
    assert!(String::from_utf8_lossy(&help.stdout).starts_with("usage: wg doctor"));
}
