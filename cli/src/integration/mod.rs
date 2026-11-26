//! Installation diagnostics and resource-backed commands.
use crate::{linear::Installation, page::Output};
use clap::{Parser, Subcommand};
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    process::ExitCode,
};
mod checks;
pub(crate) mod resources;
mod ui;
pub(crate) use checks::preflight;

#[derive(Parser)]
struct Arguments {
    #[command(subcommand)]
    command: Operation,
}
#[derive(Subcommand)]
enum Operation {
    Doctor {
        dir: Option<PathBuf>,
        #[arg(long)]
        fix: bool,
    },
    Preflight {
        dir: PathBuf,
        #[arg(long)]
        phase: Option<String>,
    },
    Explain {
        verb: Option<String>,
    },
    Ui {
        #[arg(long)]
        workspace: Option<String>,
        #[arg(long, default_value_t = 4747, allow_negative_numbers = true)]
        port: i32,
        #[arg(long)]
        project: Option<String>,
        #[arg(long)]
        no_open: bool,
        #[arg(long)]
        no_tailnet: bool,
    },
}

fn run(op: Operation) -> Result<Output, String> {
    let install = Installation::load()?;
    match op {
        Operation::Doctor { dir, fix } => checks::doctor(&install, dir.as_deref(), fix),
        Operation::Preflight { dir, phase } => {
            let plan = install.config.load_plan(&dir).map_err(|e| e.to_string())?;
            preflight(&install, &dir, &plan, phase.as_deref())
        }
        Operation::Explain { verb } => resources::explain(verb.as_deref()),
        Operation::Ui {
            workspace,
            port,
            project,
            no_open,
            no_tailnet,
        } => ui::run(&install, workspace, port, project, no_open, no_tailnet),
    }
}

pub fn command(args: impl Iterator<Item = OsString>) -> Option<ExitCode> {
    let args: Vec<_> = args.collect();
    let root = include_str!("help/root.txt");
    let verb = args.first()?.to_str()?;
    let help = match verb {
        "-h" | "--help" if args.len() == 1 => {
            print!("{root}");
            return Some(ExitCode::SUCCESS);
        }
        "update"
            if args.len() == 3
                && matches!(args[2].to_str(), Some("-h" | "--help"))
                && matches!(args[1].to_str(), Some("status" | "rollback")) =>
        {
            let (cmd, summary) = if args[1] == "status" {
                (
                    "status",
                    "Show the active version and the last managed update check.",
                )
            } else {
                (
                    "rollback",
                    "Activate the previous verified version and put updates on hold.",
                )
            };
            println!("usage: wg update {cmd}\n\n{summary}");
            return Some(ExitCode::SUCCESS);
        }
        "update" if args.get(1).is_some_and(|v| v == "--help" || v == "-h") => {
            println!("usage: wg update {{status,rollback}}");
            return Some(ExitCode::SUCCESS);
        }
        "preflight" => include_str!("help/preflight.txt"),
        "explain" => include_str!("help/explain.txt"),
        "doctor" => include_str!("help/doctor.txt"),
        "ui" => include_str!("help/ui.txt"),
        _ => return None,
    };
    let help = if verb == "ui" {
        let cfg = crate::state::Config::discover().ok()?;
        let names = cfg.settings()["workspaces"]
            .as_array()?
            .iter()
            .filter_map(|v| v["id"].as_str())
            .collect::<Vec<_>>()
            .join(",");
        help.replace("{default}", &format!("{{{names}}}"))
    } else {
        help.to_owned()
    };
    if args
        .iter()
        .skip(1)
        .take_while(|v| v.as_os_str() != "--")
        .any(|v| v == "--help" || v == "-h")
    {
        print!("{help}");
        return Some(ExitCode::SUCCESS);
    }
    let parsed = Arguments::try_parse_from(
        std::iter::once(OsString::from("wg")).chain(args.iter().cloned()),
    );
    let op = match parsed {
        Ok(p) => p.command,
        Err(e) => {
            if e.kind() == clap::error::ErrorKind::UnknownArgument {
                let unknown = e
                    .get(clap::error::ContextKind::InvalidArg)
                    .map(ToString::to_string)
                    .unwrap_or_default();
                eprintln!(
                    "{}\nwg.py: error: unrecognized arguments: {unknown}",
                    include_str!("help/root.txt")
                        .split("\n\n")
                        .next()
                        .unwrap()
                        .replace(",ui,update}", ",ui}")
                );
            } else if verb == "ui" && e.kind() == clap::error::ErrorKind::ValueValidation {
                let value = e
                    .get(clap::error::ContextKind::InvalidValue)
                    .map(ToString::to_string)
                    .unwrap_or_default();
                eprintln!(
                    "{}\nwg.py ui: error: argument --port: invalid int value: '{value}'",
                    help.split("\n\n").next().unwrap()
                );
            } else {
                eprint!("{e}")
            }
            return Some(ExitCode::from(2));
        }
    };
    let out = run(op).unwrap_or_else(|stderr| Output {
        status: 2,
        stderr,
        ..Default::default()
    });
    if !out.stdout.is_empty() {
        println!("{}", out.stdout)
    }
    if !out.stderr.is_empty() {
        eprintln!("{}", out.stderr)
    }
    Some(ExitCode::from(out.status))
}
