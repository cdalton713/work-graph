mod card;
mod contract;
mod graph;
mod journal;
mod rows;
pub mod time;

use crate::state::{Config, PlanLock};
pub use card::CardWriter;
use serde_json::Value;
use std::{io, path::Path, process::ExitCode};

#[derive(Debug)]
enum Failure {
    Expected(u8),
    Io(u8, io::ErrorKind),
}
type Error = (Failure, String);
type Result<T> = std::result::Result<T, Error>;
fn invalid(s: impl Into<String>) -> Error {
    (Failure::Expected(2), s.into())
}
fn failed(s: impl Into<String>) -> Error {
    (Failure::Expected(1), s.into())
}
fn ioerr(e: io::Error) -> Error {
    (Failure::Io(2, e.kind()), e.to_string())
}
fn list(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or_default()
}
fn truth(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64() != Some(0.0),
        Value::Array(a) => !a.is_empty(),
        Value::String(s) => !s.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}
fn printable(c: char) -> bool {
    use std::sync::LazyLock;
    static HIDDEN: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"[\p{C}\p{Z}]").unwrap());
    c == ' ' || !HIDDEN.is_match(c.encode_utf8(&mut [0; 4]))
}
fn repr_str(s: &str) -> String {
    use std::fmt::Write;
    let quote = if s.contains('\'') && !s.contains('"') {
        '"'
    } else {
        '\''
    };
    let mut out = quote.to_string();
    for c in s.chars() {
        match c {
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c == quote || c == '\\' => {
                out.push('\\');
                out.push(c)
            }
            c if printable(c) => out.push(c),
            c => {
                let n = c as u32;
                if n < 256 {
                    write!(out, "\\x{n:02x}")
                } else if n < 65536 {
                    write!(out, "\\u{n:04x}")
                } else {
                    write!(out, "\\U{n:08x}")
                }
                .unwrap()
            }
        }
    }
    out.push(quote);
    out
}
fn repr(v: &Value) -> String {
    if let Some(s) = v.as_str() {
        repr_str(s)
    } else {
        val(v)
    }
}
fn val(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "None".into(),
        Value::Bool(b) => if *b { "True" } else { "False" }.into(),
        Value::Array(a) => format!("[{}]", a.iter().map(repr).collect::<Vec<_>>().join(", ")),
        Value::Object(o) => format!(
            "{{{}}}",
            o.iter()
                .map(|(k, v)| format!("{}: {}", repr_str(k), repr(v)))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        _ => v.to_string(),
    }
}
fn text<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or_default()
}
fn node<'a>(p: &'a Value, k: &str) -> Result<&'a Value> {
    list(&p["nodes"])
        .iter()
        .find(|n| n["key"] == k)
        .ok_or_else(|| invalid(format!("unknown key {k}")))
}
fn ascii(s: &str) -> String {
    use std::fmt::Write;
    let mut out = String::new();
    for c in s.chars() {
        if c < '\u{7f}' {
            out.push(c)
        } else {
            for u in c.encode_utf16(&mut [0; 2]) {
                write!(out, "\\u{u:04x}").unwrap()
            }
        }
    }
    out
}
fn compact(v: &Value) -> String {
    match v {
        Value::Array(a) => format!("[{}]", a.iter().map(compact).collect::<Vec<_>>().join(", ")),
        Value::Object(o) => format!(
            "{{{}}}",
            o.iter()
                .map(|(k, v)| format!(
                    "{}: {}",
                    ascii(&serde_json::to_string(k).unwrap()),
                    compact(v)
                ))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        _ => ascii(&v.to_string()),
    }
}

pub fn command(args: Vec<String>, cards: Option<&mut dyn CardWriter>) -> ExitCode {
    command_with_io_handler(args, cards, |_| {})
}

pub fn command_with_io_handler(
    args: Vec<String>,
    cards: Option<&mut dyn CardWriter>,
    on_io_failure: impl FnOnce(io::ErrorKind),
) -> ExitCode {
    match execute(&args, cards) {
        Ok(code) => ExitCode::from(code),
        Err((failure, msg)) => {
            eprintln!("{msg}");
            let code = match failure {
                Failure::Expected(code) => code,
                Failure::Io(code, kind) => {
                    on_io_failure(kind);
                    code
                }
            };
            ExitCode::from(code)
        }
    }
}
fn execute(args: &[String], cards: Option<&mut dyn CardWriter>) -> Result<u8> {
    let (verb, args) = args
        .split_first()
        .ok_or_else(|| invalid("missing command"))?;
    if args.iter().any(|s| s == "--help" || s == "-h") {
        let name = if matches!(verb.as_str(), "run" | "owns")
            && args.first().is_some_and(|a| !a.starts_with('-'))
        {
            format!("{verb} {}", args[0])
        } else {
            verb.clone()
        };
        print!(
            "{}",
            match name.as_str() {
                "check" => include_str!("help/check.txt"),
                "owns" => include_str!("help/owns.txt"),
                "owns overlap" => include_str!("help/owns-overlap.txt"),
                "owns diff" => include_str!("help/owns-diff.txt"),
                "log" => include_str!("help/log.txt"),
                "run" => include_str!("help/run.txt"),
                "run show" => include_str!("help/run-show.txt"),
                "run set" => include_str!("help/run-set.txt"),
                "run reset" => include_str!("help/run-reset.txt"),
                "run rebuild" => include_str!("help/run-rebuild.txt"),
                "contract" => include_str!("help/contract.txt"),
                _ => return Err(invalid("unknown command")),
            }
        );
        return Ok(0);
    }
    if verb == "contract" {
        let generated = contract::generate();
        match args {
            [] => print!("{generated}"),
            [s] if s == "--write" => {
                let cwd = std::env::current_dir().map_err(ioerr)?;
                let exe = std::env::current_exe().map_err(ioerr)?;
                let skill = cwd
                    .ancestors()
                    .chain(exe.ancestors())
                    .map(|p| p.join("skills/work-graph"))
                    .find(|p| p.is_dir())
                    .ok_or_else(|| {
                        invalid("cannot locate skills/work-graph for contract --write")
                    })?;
                std::fs::write(skill.join("contract.json"), generated).map_err(ioerr)?;
            }
            _ => return Err(invalid("usage: wg contract [--write]")),
        }
        return Ok(0);
    }
    let (mode, args) = if matches!(verb.as_str(), "run" | "owns") {
        let (m, a) = args.split_first().ok_or_else(|| invalid("missing mode"))?;
        (m.as_str(), a)
    } else {
        ("", args)
    };
    let (dir, args) = args
        .split_first()
        .ok_or_else(|| invalid("missing plan directory"))?;
    let dir = Path::new(dir);
    let lock = if verb == "run" && matches!(mode, "set" | "reset" | "rebuild") {
        Some(PlanLock::acquire(dir, None).map_err(ioerr)?)
    } else {
        None
    };
    let cfg = Config::discover().map_err(|e| (Failure::Io(1, e.kind()), e.to_string()))?;
    if let Some(guard) = &lock {
        use crate::page::LockedEffort;
        let effort = crate::providers::Effort::borrowed(dir, guard);
        if effort.keymap().map_err(failed)?["collab"]
            .get("pull_pending")
            .is_some()
        {
            effort.read().map_err(failed)?;
        }
    }
    let p = cfg.load_plan(dir).map_err(ioerr)?;
    let config = cfg.report(None).map_err(ioerr)?;
    match verb.as_str() {
        "check" if args.is_empty() => Ok(graph::check(&p, &config)),
        "owns" => graph::owns(mode, &p, args),
        "log" => journal::log(dir, &p, args, &config),
        "run" => rows::run(mode, dir, &p, args, lock.as_ref(), cards, &config),
        _ => Err(invalid("invalid command arguments")),
    }
}

pub(crate) fn check_plan(plan: &Value, report: &Value) -> bool {
    graph::check(plan, report) == 0
}

pub(crate) use contract::satisfied;
pub(crate) use graph::findings as plan_findings;
pub(crate) use journal::record_status;

pub(crate) use card::{refresh as refresh_card, render as render_card};

pub(crate) use journal::record_workflow;

pub(crate) use graph::ownership_diff;
pub(crate) use journal::record_claim;
