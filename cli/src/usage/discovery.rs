use super::{Session, transcript};
use crate::state;
use serde_json::Value;
use std::{
    collections::HashSet,
    env,
    fs::{self, File},
    io::{self, BufRead, BufReader},
    path::{Path, PathBuf},
};

type Owners = Vec<(PathBuf, Option<String>)>;

fn expand(p: &Path) -> PathBuf {
    if let Ok(rest) = p.strip_prefix("~")
        && let Some(home) = env::var_os("HOME")
    {
        return PathBuf::from(home).join(rest);
    }
    p.into()
}

fn resolve(p: &Path) -> PathBuf {
    let mut result = PathBuf::new();
    for part in std::path::absolute(p)
        .unwrap_or_else(|_| p.into())
        .components()
    {
        if part == std::path::Component::ParentDir {
            result.pop();
        } else {
            result.push(part);
            if let Ok(real) = result.canonicalize() {
                result = real;
            }
        }
    }
    result
}

fn owners(dir: &Path) -> io::Result<Owners> {
    let mut paths = Vec::new();
    let mut add = |value: &str, key: Option<&str>| {
        if value.is_empty() {
            return;
        }
        let path = expand(Path::new(value.split_once("::").map_or(value, |(_, p)| p)));
        for alias in [resolve(&path), path] {
            if !paths.iter().any(|(p, _)| p == &alias) {
                paths.push((alias, key.map(str::to_owned)));
            }
        }
    };
    add(&dir.to_string_lossy(), None);
    let km = state::load_keymap(dir)?;
    if let Some(nodes) = km["run"]["nodes"].as_object() {
        for (key, row) in nodes {
            for field in ["path", "worktree"] {
                if let Some(path) = row[field].as_str() {
                    add(path, Some(key));
                }
            }
        }
    }
    let (entries, skipped) = state::journal_entries(dir)?;
    if skipped > 0 {
        eprintln!("warn: {skipped} damaged journal line(s) skipped");
    }
    for entry in entries {
        let Some(key) = entry["key"].as_str() else {
            continue;
        };
        if key == "@effort" || entry["kind"].as_str().unwrap_or("run") != "run" {
            continue;
        }
        for field in ["path", "worktree"] {
            if let Some(values) = entry["changes"][field].as_array() {
                for p in values.iter().filter_map(Value::as_str) {
                    add(p, Some(key));
                }
            }
        }
    }
    Ok(paths)
}

fn owner<'a>(paths: &'a Owners, cwd: &str) -> Option<&'a Option<String>> {
    let lookup = |path: &Path| paths.iter().find(|(p, _)| p == path).map(|(_, k)| k);
    lookup(Path::new(cwd)).or_else(|| lookup(&resolve(Path::new(cwd))))
}

fn root(var: &str, default: &str) -> PathBuf {
    expand(Path::new(
        &env::var_os(var)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| default.into()),
    ))
}

fn files(dir: &Path, recursive: bool) -> Vec<PathBuf> {
    let mut files = Vec::new();
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if recursive && entry.file_type().is_ok_and(|t| t.is_dir()) {
                files.extend(self::files(&path, true));
            } else if path.extension().is_some_and(|s| s == "jsonl") {
                files.push(path);
            }
        }
    }
    files.sort();
    files
}

fn codex_cwd(file: &Path) -> Option<String> {
    let mut first = Vec::new();
    BufReader::new(File::open(file).ok()?)
        .read_until(b'\n', &mut first)
        .ok()?;
    serde_json::from_slice::<Value>(&first).ok()?["payload"]["cwd"]
        .as_str()
        .map(str::to_owned)
}

pub(super) fn sessions(dir: &Path, since: Option<i64>) -> io::Result<Vec<Value>> {
    let paths = owners(dir)?;
    let projects = root("CLAUDE_CONFIG_DIR", "~/.claude").join("projects");
    let mut seen = HashSet::new();
    let mut done = HashSet::new();
    let mut rows = Vec::new();
    for (path, key) in &paths {
        let slug: String = path
            .to_string_lossy()
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .collect();
        let folders = if slug.len() > 200 {
            let mut matches: Vec<_> = fs::read_dir(&projects)
                .into_iter()
                .flatten()
                .flatten()
                .filter(|e| e.file_name().to_string_lossy().starts_with(&slug[..200]))
                .map(|e| e.path())
                .collect();
            matches.sort();
            matches
        } else {
            vec![projects.join(slug)]
        };
        for folder in folders {
            if !done.insert(folder.clone()) {
                continue;
            }
            for file in files(&folder, false) {
                let mut s = Session::default();
                transcript::claude(&mut s, &file, since, &mut seen, true);
                let key = match &s.cwd {
                    None => key,
                    Some(cwd) => match owner(&paths, cwd) {
                        Some(key) => key,
                        None => continue,
                    },
                };
                for sub in files(&file.with_extension("").join("subagents"), false) {
                    s.subagents += 1;
                    transcript::claude(&mut s, &sub, since, &mut seen, false);
                }
                if s.calls > 0 {
                    rows.push(s.row("claude", &file, key));
                }
            }
        }
    }
    for file in files(&root("CODEX_HOME", "~/.codex").join("sessions"), true) {
        let Some(cwd) = codex_cwd(&file) else {
            continue;
        };
        let Some(key) = owner(&paths, &cwd) else {
            continue;
        };
        let mut s = Session::default();
        transcript::codex(&mut s, &file, since);
        if s.calls > 0 {
            rows.push(s.row("codex", &file, key));
        }
    }
    rows.sort_by(|a, b| {
        b["input"]
            .as_u64()
            .cmp(&a["input"].as_u64())
            .then_with(|| a["first"].as_str().cmp(&b["first"].as_str()))
    });
    Ok(rows)
}
