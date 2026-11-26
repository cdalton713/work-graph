use std::process::ExitCode;

const USAGE: &str = "Usage: wg-preview --version";

mod telemetry;

fn main() -> ExitCode {
    telemetry::run(dispatch)
}

fn dispatch(on_io_failure: &dyn Fn(std::io::ErrorKind)) -> ExitCode {
    if std::env::args_os().nth(1).is_some_and(|v| v == "usage") {
        return wg_preview::usage::command(std::env::args().skip(2));
    }
    if std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("setup")) {
        return wg_preview::linear::run_setup(std::env::args_os().skip(2));
    }
    if matches!(
        std::env::args_os()
            .nth(1)
            .as_deref()
            .and_then(|v| v.to_str()),
        Some("login" | "logout" | "join" | "leave" | "share" | "pull")
    ) {
        let Ok(args) = std::env::args_os()
            .skip(1)
            .map(|s| s.into_string())
            .collect::<Result<Vec<_>, _>>()
        else {
            eprintln!("invalid command argument");
            return ExitCode::from(2);
        };
        return match wg_preview::page::preview(&args) {
            Ok(out) => {
                if !out.stdout.is_empty() {
                    println!("{}", out.stdout);
                }
                if !out.stderr.is_empty() {
                    eprintln!("{}", out.stderr);
                }
                ExitCode::from(out.status)
            }
            Err(error) => {
                eprintln!("{error}");
                ExitCode::from(2)
            }
        };
    }
    let mut args = std::env::args_os().skip(1);
    if std::env::args_os().nth(1).is_some_and(|v| {
        matches!(
            v.to_str(),
            Some("check" | "owns" | "log" | "run" | "contract")
        )
    }) {
        return wg_preview::local::command_with_io_handler(
            std::env::args().skip(1).collect(),
            None,
            on_io_failure,
        );
    }
    match (args.next().as_deref(), args.next()) {
        (Some(verb), dir) if verb == "config" && args.next().is_none() => {
            let config = match wg_preview::state::Config::discover() {
                Ok(config) => config,
                Err(e) => {
                    eprintln!("{e}");
                    on_io_failure(e.kind());
                    return ExitCode::FAILURE;
                }
            };
            if dir
                .as_deref()
                .is_some_and(|arg| arg == "--help" || arg == "-h")
            {
                println!(
                    "usage: wg.py config [-h] [dir]\n\npositional arguments:\n  dir\n\noptions:\n  -h, --help  show this help message and exit"
                );
                return ExitCode::SUCCESS;
            }
            match config.report(
                dir.as_deref()
                    .filter(|p| !p.is_empty())
                    .map(std::path::Path::new),
            ) {
                Ok(report) => {
                    if let Err(e) =
                        wg_preview::state::write_pretty_json(std::io::stdout().lock(), &report)
                    {
                        eprintln!("{e}");
                        on_io_failure(e.kind());
                        return ExitCode::FAILURE;
                    }
                }
                Err(e) => {
                    eprintln!("{e}");
                    on_io_failure(e.kind());
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
