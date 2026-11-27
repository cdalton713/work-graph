//! Coordinator polling and page wakeups.
use crate::page::link::Link;
use serde_json::Value;
use std::{collections::HashSet, io::Write, thread, time::Duration};

/// A successful refresh includes the messages applied by the snapshot and publish operations.
pub struct Refresh {
    pub complete: bool,
    pub actionable: bool,
    pub claims_unavailable: bool,
    pub settled: Vec<String>,
}

pub trait Coordinator {
    fn receive(&mut self, interval: Duration) -> Result<Option<Value>, String>;
    fn refresh(&mut self, messages: &[Value]) -> Result<Refresh, String>;
    /// Print and flush the terminal result (or waiting notes) before acknowledging messages.
    fn report(&mut self, result: &Refresh, finished: bool) -> Result<(), String>;
    fn acknowledge(&mut self, ids: &[String]);
}

/// Wait for a page event, or poll on the configured interval for an unlinked effort.
pub fn wait_for_change(
    link: Option<&mut Link>,
    interval: Duration,
) -> Result<Option<Value>, String> {
    match link {
        Some(link) => link.wait(interval),
        None => {
            thread::sleep(interval);
            Ok(None)
        }
    }
}

/// Drive one-shot next, next --wait, or the watch alias. The link handles reconnects.
pub fn next(
    coordinator: &mut impl Coordinator,
    wait: bool,
    interval: Duration,
    initial: Vec<Value>,
    warnings: &mut impl Write,
) -> Result<(), String> {
    if interval.is_zero() {
        return Err("--interval must be a positive number of seconds".into());
    }
    let mut messages = Vec::new();
    for message in initial {
        enqueue(&mut messages, message);
    }
    let mut handled = HashSet::<String>::new();
    loop {
        match coordinator.refresh(&messages) {
            Ok(result) => {
                let finished =
                    !wait || result.complete || result.actionable || result.claims_unavailable;
                coordinator.report(&result, finished)?;
                if !result.settled.is_empty() {
                    coordinator.acknowledge(&result.settled);
                    handled.extend(result.settled.iter().cloned());
                    messages.retain(|m| !result.settled.iter().any(|id| m["id"] == *id));
                }
                if finished {
                    return Ok(());
                }
            }
            Err(error) if wait => {
                writeln!(warnings, "warn next: {error}").map_err(|e| e.to_string())?
            }
            Err(error) => return Err(error),
        }
        if let Some(message) = coordinator.receive(interval)? {
            if let Some(id) = message["id"].as_str().filter(|id| handled.contains(*id)) {
                coordinator.acknowledge(&[id.to_owned()]);
            } else {
                enqueue(&mut messages, message);
            }
        }
    }
}

fn enqueue(messages: &mut Vec<Value>, message: Value) {
    if let Some(id) = message["id"].as_str() {
        if let Some(previous) = messages.iter_mut().find(|m| m["id"] == id) {
            *previous = message;
        } else {
            messages.push(message);
        }
    }
}

#[cfg(test)]
mod tests;

pub mod arguments;
pub(crate) mod machine;
pub mod manage;
pub mod precheck;
mod production;
pub mod scheduled;
mod sender;

/// Run machine operations that do not need a live effort connection.
pub fn local_command(args: &[std::ffi::OsString]) -> Option<std::process::ExitCode> {
    use arguments::{Arguments, Operation};
    use clap::Parser;
    use std::process::ExitCode;
    if !matches!(
        args.get(1)?.to_str()?,
        "next" | "watch" | "agents" | "tick" | "autostart" | "health" | "wake"
    ) {
        return None;
    }
    let verb = args[1].to_str()?;
    let help = match verb {
        "agents" => include_str!("help/agents.txt"),
        "tick" => include_str!("help/tick.txt"),
        "wake" => include_str!("help/wake.txt"),
        "health" => include_str!("help/health.txt"),
        "next" => include_str!("help/next.txt"),
        "watch" => include_str!("help/watch.txt"),
        "autostart" => include_str!("help/autostart.txt"),
        _ => return None,
    };
    if args[2..]
        .iter()
        .take_while(|s| s.as_os_str() != "--")
        .any(|s| s == "--help" || s == "-h")
    {
        print!("{help}");
        return Some(ExitCode::SUCCESS);
    }
    let parsed = match Arguments::try_parse_from(args) {
        Ok(args) => args.command,
        Err(error) => {
            if error.kind() == clap::error::ErrorKind::ArgumentConflict {
                let modes: &[&str] = match verb {
                    "health" => &["--install", "--uninstall", "--due", "--report"],
                    "agents" => &["--install", "--uninstall", "--once", "--wait"],
                    _ => &["--install", "--uninstall"],
                };
                let mut seen = Vec::new();
                for value in args[2..]
                    .iter()
                    .filter_map(|s| s.to_str())
                    .take_while(|s| *s != "--")
                {
                    let flag = value.split('=').next().unwrap_or(value);
                    if modes.contains(&flag) && !seen.contains(&flag) {
                        seen.push(flag);
                    }
                }
                if let [first, second, ..] = seen.as_slice() {
                    eprintln!(
                        "{}\nwg {verb}: error: argument {second}: not allowed with argument {first}",
                        help.split("\n\n").next().unwrap_or(help)
                    );
                    return Some(ExitCode::from(2));
                }
            }
            let code = error.exit_code();
            let _ = error.print();
            return Some(ExitCode::from(code as u8));
        }
    };
    let result = (|| -> machine::Result<Option<u8>> {
        match parsed {
            Operation::Tick(tick) if tick.install || tick.uninstall => {
                let config = crate::state::Config::discover()?.report(None)?;
                scheduled::tick_schedule(
                    &config["config"],
                    &machine::scheduled_program()?,
                    &tick.root,
                    tick.channel.as_deref(),
                    tick.uninstall,
                    &mut std::io::stdout().lock(),
                )?;
            }
            Operation::Health(health) if !health.due && health.report.is_none() => {
                println!(
                    "{}",
                    manage::health_schedule(
                        &health,
                        &crate::state::Config::discover()?,
                        &machine::scheduled_program()?
                    )?
                );
            }
            Operation::Health(args) => {
                let install = crate::linear::Installation::load()?;
                let mut effort = production::Effort::read(&install, &args.dir)?;
                if let Some(path) = args.report {
                    println!("{}", effort.report(&path)?);
                } else {
                    let km = effort.km.clone();
                    let (code, message) = precheck::due(
                        &args.dir,
                        &km,
                        install.config.settings()["health_interval"]
                            .as_f64()
                            .ok_or("invalid health interval")?,
                        chrono::Utc::now(),
                        &mut effort,
                    )?
                    .result();
                    println!("{message}");
                    return Ok(Some(code));
                }
            }
            Operation::Agents(args) => return Ok(Some(sender::run(&args)?)),
            Operation::Autostart(auto) => {
                println!(
                    "{}",
                    manage::autostart(
                        &auto,
                        &crate::state::Config::discover()?,
                        &machine::scheduled_program()?
                    )?
                );
            }
            Operation::Next(next) | Operation::Watch(next)
                if !next.interval.is_finite() || next.interval <= 0. =>
            {
                return Err("--interval must be a positive number of seconds".into());
            }
            Operation::Next(args) => return Ok(Some(live_loop::next_command(&args, false)?)),
            Operation::Watch(args) => return Ok(Some(live_loop::next_command(&args, true)?)),
            Operation::Wake { dir } => return Ok(Some(live_loop::wake_command(&dir)?)),
            Operation::Tick(args) => return Ok(Some(live_loop::tick_command(&args)?)),
        }
        Ok(Some(0))
    })();
    match result {
        Ok(code) => code.map(ExitCode::from),
        Err(error) => {
            eprintln!("{error}");
            Some(ExitCode::from(2))
        }
    }
}

mod actions;
pub mod activity;
pub mod findings;
mod live_loop;
mod publish;

mod notices;

pub(crate) fn joined_next(path: &std::path::Path) -> crate::page::Result<crate::page::Output> {
    let args = arguments::Next {
        dir: path.into(),
        wait: false,
        interval: 300.0,
        no_publish: true,
        all: false,
    };
    let mut bytes = Vec::new();
    let result = live_loop::next_with_output(
        &args,
        live_loop::Invocation::Join,
        live_loop::NextOutput::Collected(&mut bytes),
    );
    Ok(crate::page::Output {
        stdout: String::from_utf8(bytes)
            .map_err(|e| e.to_string())?
            .trim_end_matches('\n')
            .into(),
        stderr: result
            .as_ref()
            .err()
            .map(ToString::to_string)
            .unwrap_or_default(),
        status: result.unwrap_or(2),
    })
}
