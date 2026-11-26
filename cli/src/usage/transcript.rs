use super::{Session, epoch};
use regex::Regex;
use serde_json::Value;
use std::{
    collections::HashSet,
    fs::File,
    io::{BufRead, BufReader},
    path::Path,
    sync::LazyLock,
};

static COORD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\bwg(?:\.py)?\s+next\b|work-graph/SKILL\.md").unwrap());

fn records(file: &Path, mut read: impl FnMut(Value)) {
    let Ok(file) = File::open(file) else { return };
    let mut reader = BufReader::new(file);
    let mut line = Vec::new();
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                if let Ok(entry) = serde_json::from_slice(&line) {
                    read(entry);
                }
            }
        }
    }
}

fn numbers<const N: usize>(v: &Value, fields: [&str; N]) -> Option<[u64; N]> {
    v.as_object()?;
    let mut out = [0; N];
    for (n, k) in out.iter_mut().zip(fields) {
        if !v[k].is_null() {
            *n = v[k].as_u64()?;
        }
    }
    Some(out)
}

fn content<'a>(v: &'a Value, kind: &str) -> Option<&'a str> {
    v.as_array()?.iter().find(|b| b["type"] == kind)?["text"].as_str()
}

fn included(stamp: &Value, since: Option<i64>) -> bool {
    since.is_none_or(|t| stamp.as_str().and_then(epoch).is_some_and(|at| at >= t))
}

pub(super) fn claude(
    s: &mut Session,
    file: &Path,
    since: Option<i64>,
    seen: &mut HashSet<String>,
    main: bool,
) {
    records(file, |e| {
        if main && s.cwd.is_none() {
            s.cwd = e["cwd"].as_str().map(str::to_owned);
        }
        let m = &e["message"];
        if e["type"] == "user" && main {
            let text = m["content"]
                .as_str()
                .or_else(|| content(&m["content"], "text"));
            if s.first_message.is_none() && e["isMeta"] != true {
                s.first_message = text.map(str::to_owned);
            }
            s.coordinating |=
                text.is_some_and(|t| t.contains("<command-name>/work-graph</command-name>"));
        }
        if e["type"] != "assistant" {
            return;
        }
        if main
            && !s.coordinating
            && let Some(blocks) = m["content"].as_array()
        {
            s.coordinating = blocks.iter().any(|b| {
                b["type"] == "tool_use"
                    && (COORD.is_match(&b["input"].to_string())
                        || b["name"] == "Skill"
                            && b["input"]["skill"]
                                .as_str()
                                .and_then(|t| t.rsplit(':').next())
                                == Some("work-graph"))
            });
        }
        if m["model"] == "<synthetic>" {
            return;
        }
        let Some([fresh, write, read, out]) = numbers(
            &m["usage"],
            [
                "input_tokens",
                "cache_creation_input_tokens",
                "cache_read_input_tokens",
                "output_tokens",
            ],
        ) else {
            return;
        };
        if let Some(id) = m["id"].as_str().filter(|v| !v.is_empty())
            && !seen.insert(id.to_owned())
        {
            return;
        }
        if !included(&e["timestamp"], since) {
            return;
        }
        s.fresh += fresh;
        s.write += write;
        s.read += read;
        s.output += out;
        s.call(
            &e["timestamp"],
            m["model"].as_str(),
            main.then_some(fresh + write + read),
        );
    });
}

const PREAMBLES: [&str; 6] = [
    "# AGENTS.md instructions",
    "<environment_context",
    "<INSTRUCTIONS",
    "<user_instructions",
    "<permissions instructions",
    "<skills_instructions",
];

pub(super) fn codex(s: &mut Session, file: &Path, since: Option<i64>) {
    let (mut last, mut base, mut end) = (None, [0; 4], None);
    let mut model = None;
    records(file, |e| {
        let p = &e["payload"];
        if e["type"] == "turn_context"
            && let Some(name) = p["model"].as_str()
        {
            model = Some(name.to_owned());
        }
        match p["type"].as_str() {
            Some("function_call" | "custom_tool_call" | "local_shell_call") if !s.coordinating => {
                s.coordinating = ["arguments", "input", "action"]
                    .iter()
                    .any(|k| COORD.is_match(&p[k].to_string()));
            }
            Some("user_message") if s.first_message.is_none() => {
                s.first_message = p["message"].as_str().map(str::to_owned)
            }
            Some("message") if p["role"] == "user" && s.first_message.is_none() => {
                let text = content(&p["content"], "input_text").unwrap_or("");
                if !PREAMBLES.iter().any(|pre| text.starts_with(pre)) {
                    s.first_message = Some(text.to_owned());
                }
            }
            Some("token_count") => {
                let info = &p["info"];
                let Some(v) = numbers(
                    &info["total_token_usage"],
                    [
                        "input_tokens",
                        "cached_input_tokens",
                        "cache_write_input_tokens",
                        "output_tokens",
                    ],
                ) else {
                    return;
                };
                if last == Some(v) {
                    return;
                }
                last = Some(v);
                if !included(&e["timestamp"], since) {
                    base = v;
                    return;
                }
                end = Some(v);
                s.call(
                    &e["timestamp"],
                    model.as_deref(),
                    Some(
                        info["last_token_usage"]["input_tokens"]
                            .as_u64()
                            .unwrap_or(0),
                    ),
                );
            }
            _ => {}
        }
    });
    if let Some(end) = end {
        let [input, read, write, out] = std::array::from_fn(|i| end[i].saturating_sub(base[i]));
        s.fresh = input.saturating_sub(read).saturating_sub(write);
        s.read = read;
        s.write = write;
        s.output = out;
    }
}
