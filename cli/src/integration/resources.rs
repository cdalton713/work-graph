use super::*;
use std::{env, fs};

pub(crate) fn root() -> Result<PathBuf, String> {
    let exe = env::current_exe().map_err(|e| e.to_string())?;
    let home = env::var_os("HOME").map(PathBuf::from);
    let registrations = [".agents", ".codex", ".claude"]
        .into_iter()
        .filter_map(|base| {
            home.as_ref()?
                .join(base)
                .join("skills/work-graph")
                .canonicalize()
                .ok()
        });
    for path in std::iter::once(exe).chain(registrations) {
        if let Some(root) = path
            .ancestors()
            .skip(1)
            .find(|p| p.join("skills/work-graph/SKILL.md").is_file())
        {
            return Ok(root.to_owned());
        }
    }
    Err("cannot locate the installed work-graph skill".into())
}

pub(super) fn explain(verb: Option<&str>) -> Result<Output, String> {
    let index = include_str!("explain.txt").trim_end();
    let Some(verb) = verb else {
        return Ok(Output::success(index.into()));
    };
    if !index
        .lines()
        .any(|l| l.split_whitespace().next() == Some(verb))
    {
        return Err(format!("unknown verb '{verb}'; wg explain lists the verbs"));
    }
    let base = root()?.join("skills/work-graph");
    let mut files = vec![];
    for entry in fs::read_dir(base.join("references")).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().is_some_and(|x| x == "md") {
            files.push(path)
        }
    }
    files.sort();
    files.insert(0, base.join("SKILL.md"));
    let mut lines = vec![];
    for file in files {
        let mut active = false;
        let mut first = true;
        for line in fs::read_to_string(&file)
            .map_err(|e| e.to_string())?
            .lines()
        {
            let marker = line.trim();
            if let Some(names) = marker
                .strip_prefix("<!-- explain: ")
                .and_then(|s| s.strip_suffix(" -->"))
            {
                active = names.split(',').any(|v| v == verb);
                if active {
                    if !lines.is_empty() {
                        lines.push(String::new())
                    }
                    if first {
                        lines.push(format!("({})", file.strip_prefix(&base).unwrap().display()));
                        first = false
                    }
                }
            } else if marker == "<!-- /explain -->" {
                active = false
            } else if active {
                lines.push(line.into())
            }
        }
    }
    Ok(Output::success(lines.join("\n")))
}
