use std::fmt::Write;
use std::process::ExitCode;

const USAGE: &str = "Usage: wg-preview --version";

// The reference CLI prints JSON with ensure_ascii enabled.
fn print_config(report: &serde_json::Value) {
    let json = serde_json::to_string_pretty(report).expect("JSON value");
    let mut output = String::with_capacity(json.len());
    for ch in json.chars() {
        if ch < '\u{7f}' {
            output.push(ch);
        } else {
            for unit in ch.encode_utf16(&mut [0; 2]) {
                write!(output, "\\u{unit:04x}").expect("write to String");
            }
        }
    }
    println!("{output}");
}

fn main() -> ExitCode {
    let mut args = std::env::args_os().skip(1);
    match (args.next().as_deref(), args.next()) {
        (Some(verb), dir) if verb == "config" && args.next().is_none() => {
            let config = match wg_preview::state::Config::discover() {
                Ok(config) => config,
                Err(e) => {
                    eprintln!("{e}");
                    return ExitCode::FAILURE;
                }
            };
            match config.report(dir.as_deref().map(std::path::Path::new)) {
                Ok(report) => print_config(&report),
                Err(e) => {
                    eprintln!("{e}");
                    return ExitCode::from(2);
                }
            }
        }
        (Some(flag), None) if flag == "--version" => {
            println!(
                "wg-preview {} {}",
                env!("CARGO_PKG_VERSION"),
                env!("WG_BUILD_TARGET")
            );
        }
        (Some(flag), None) if flag == "--help" => println!("{USAGE}"),
        _ => {
            eprintln!("{USAGE}");
            return ExitCode::from(2);
        }
    }
    ExitCode::SUCCESS
}
