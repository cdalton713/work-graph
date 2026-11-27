use std::process::ExitCode;

const ROOT_HELP: &str = include_str!("integration/help/root.txt");

mod telemetry;

fn main() -> ExitCode {
    telemetry::run(dispatch)
}

fn dispatch(on_io_failure: &dyn Fn(std::io::ErrorKind)) -> ExitCode {
    if let Some(status) = wg::update::on_start() {
        return status;
    }
    if let Some(version) = option_env!("WG_RELEASE_VERSION") {
        let mut args = std::env::args_os().skip(1);
        match (args.next().as_deref(), args.next()) {
            (Some(flag), None) if flag == "--release-key" => {
                return match wg::release::embedded_key() {
                    Ok(key) => {
                        for byte in key.as_bytes() {
                            print!("{byte:02x}");
                        }
                        println!();
                        ExitCode::SUCCESS
                    }
                    Err(error) => {
                        eprintln!("{error}");
                        ExitCode::FAILURE
                    }
                };
            }
            (Some(flag), None) if flag == "--version" => {
                println!("wg {version} {}", env!("WG_BUILD_TARGET"));
                return ExitCode::SUCCESS;
            }
            _ => {}
        }
    }
    if let Some(status) = help_command() {
        return status;
    }
    if let Some(status) = wg::integration::command(std::env::args_os().skip(1)) {
        return status;
    }
    if matches!(
        std::env::args_os()
            .nth(1)
            .as_deref()
            .and_then(|s| s.to_str()),
        Some(
            "base" | "cleanup" | "evidence" | "dispatch" | "claim" | "started" | "done" | "verify"
        )
    ) {
        return wg::jobs::command();
    }
    if matches!(
        std::env::args_os()
            .nth(1)
            .as_deref()
            .and_then(|s| s.to_str()),
        Some(
            "archive"
                | "status"
                | "ready"
                | "load"
                | "move"
                | "approve"
                | "autonomy"
                | "review-effort"
        )
    ) {
        return wg::workflow::command();
    }
    if let Some(status) = wg::automation::local_command(&std::env::args_os().collect::<Vec<_>>()) {
        return status;
    }
    if std::env::args_os().nth(1).is_some_and(|v| v == "usage") {
        return wg::usage::command(std::env::args().skip(2));
    }
    if std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("setup")) {
        return wg::linear::run_setup(std::env::args_os().skip(2));
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
        return match wg::page::preview(&args) {
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
        return wg::local::command_with_io_handler(
            std::env::args().skip(1).collect(),
            None,
            on_io_failure,
        );
    }
    match (args.next().as_deref(), args.next()) {
        (Some(verb), dir) if verb == "config" && args.next().is_none() => {
            let config = match wg::state::Config::discover() {
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
                    "usage: wg config [-h] [dir]\n\npositional arguments:\n  dir\n\noptions:\n  -h, --help  show this help message and exit"
                );
                return ExitCode::SUCCESS;
            }
            match config.report(
                dir.as_deref()
                    .filter(|p| !p.is_empty())
                    .map(std::path::Path::new),
            ) {
                Ok(report) => {
                    if let Err(e) = wg::state::write_pretty_json(std::io::stdout().lock(), &report)
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
                "wg {} {}",
                env!("CARGO_PKG_VERSION"),
                env!("WG_BUILD_TARGET")
            );
        }
        _ => {
            eprintln!("{}", unknown_command(std::env::args().skip(1).collect()));
            return ExitCode::from(2);
        }
    }
    ExitCode::SUCCESS
}

fn root_usage() -> &'static str {
    ROOT_HELP.split("\n\n").next().unwrap_or(ROOT_HELP)
}

/// The error for an argument list that no command accepts, with the root usage.
fn unknown_command(args: Vec<String>) -> String {
    let error = match args.first() {
        None => "the following arguments are required: command".to_owned(),
        Some(verb) if !verb.starts_with('-') => {
            format!("argument command: invalid choice: '{verb}' (run 'wg --help' for the commands)")
        }
        Some(_) => format!("unrecognized arguments: {}", args.join(" ")),
    };
    format!("{}\nwg: error: {error}", root_usage())
}

/// `wg help` prints the root help. `wg help VERB...` runs `wg VERB... --help`.
fn help_command() -> Option<ExitCode> {
    let mut args = std::env::args_os().skip(1);
    if args.next()? != "help" {
        return None;
    }
    let rest: Vec<_> = args.collect();
    if rest.is_empty() {
        print!("{ROOT_HELP}");
        return Some(ExitCode::SUCCESS);
    }
    let exe = match std::env::current_exe() {
        Ok(exe) => exe,
        Err(error) => {
            eprintln!("wg help: {error}");
            return Some(ExitCode::FAILURE);
        }
    };
    use std::os::unix::process::CommandExt;
    let error = std::process::Command::new(exe)
        .args(rest)
        .arg("--help")
        .exec();
    eprintln!("wg help: {error}");
    Some(ExitCode::FAILURE)
}
