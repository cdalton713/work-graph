use std::process::ExitCode;

const USAGE: &str = "Usage: wg-preview --version";

fn main() -> ExitCode {
    let mut args = std::env::args_os().skip(1);
    match (args.next().as_deref(), args.next()) {
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
