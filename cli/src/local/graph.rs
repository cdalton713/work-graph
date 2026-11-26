use super::*;
use std::collections::{HashMap, HashSet};
use std::process::Command;
fn strings<'a>(v: &'a Value, k: &str) -> impl Iterator<Item = &'a str> {
    list(&v[k]).iter().filter_map(Value::as_str)
}
fn prefix(s: &str) -> &str {
    s.split(['*', '?', '[']).next().unwrap_or(s)
}
pub(super) fn owns(mode: &str, p: &Value, args: &[String]) -> Result<u8> {
    let mut bad = 0;
    if mode == "overlap" && !args.is_empty() {
        for k in args {
            if strings(node(p, k)?, "owns").next().is_none() {
                println!("{k}: no owns");
                bad = 1
            }
        }
        for a in args {
            for b in args.iter().filter(|b| *b != a) {
                for ga in strings(node(p, a)?, "owns") {
                    for f in ["owns", "shares"] {
                        if f == "owns" && a > b {
                            continue;
                        }
                        for gb in strings(node(p, b)?, f) {
                            if prefix(ga).starts_with(prefix(gb))
                                || prefix(gb).starts_with(prefix(ga))
                            {
                                println!("{a} owns {ga} <-> {b} {f} {gb}");
                                bad = 1
                            }
                        }
                    }
                }
            }
        }
    } else if let ("diff", [k, base]) = (mode, args) {
        let n = node(p, k)?;
        if list(&n["owns"]).is_empty() {
            println!("{k}: no owns");
            return Ok(1);
        }
        if base.starts_with('-') {
            return Err(invalid("invalid diff base"));
        }
        let o = Command::new("git")
            .args(["diff", "--name-only", &format!("{base}...HEAD")])
            .output()
            .map_err(ioerr)?;
        if !o.status.success() {
            return Err(invalid(String::from_utf8_lossy(&o.stderr).trim()));
        }
        for path in String::from_utf8_lossy(&o.stdout)
            .lines()
            .filter(|s| !s.is_empty())
        {
            let matches = |f| {
                strings(n, f).any(|g| {
                    glob::Pattern::new(&g.replace("**", "*")).is_ok_and(|pat| pat.matches(path))
                })
            };
            if matches("owns") {
                continue;
            }
            if matches("shares") {
                println!("SHARED {path}")
            } else {
                println!("OUT {path}");
                bad = 1
            }
        }
    } else {
        return Err(invalid(
            "usage: wg.py owns overlap <plan-dir> <key>... | owns diff <plan-dir> <key> <base>",
        ));
    }
    Ok(bad)
}
type Deps<'a> = HashMap<&'a str, Vec<&'a str>>;
fn reach<'a>(a: &'a str, b: &str, deps: &Deps<'a>) -> bool {
    let mut seen = HashSet::new();
    let mut stack = vec![a];
    while let Some(k) = stack.pop() {
        if k == b {
            return true;
        }
        if seen.insert(k) {
            stack.extend(deps.get(k).into_iter().flatten().copied())
        }
    }
    false
}
fn cycle<'a>(
    k: &'a str,
    path: &mut Vec<&'a str>,
    done: &mut HashSet<&'a str>,
    deps: &Deps<'a>,
    errors: &mut Vec<String>,
) {
    if path.contains(&k) {
        errors.push(format!("cycle: {} -> {k}", path.join(" -> ")));
        return;
    }
    if !done.insert(k) {
        return;
    }
    path.push(k);
    for d in &deps[k] {
        cycle(d, path, done, deps, errors)
    }
    path.pop();
}
fn quoted(v: &Value) -> String {
    if let Some(s) = v.as_str() {
        format!("'{s}'")
    } else {
        val(v)
    }
}
fn names(keys: &[&str]) -> String {
    format!(
        "[{}]",
        keys.iter()
            .map(|k| format!("'{k}'"))
            .collect::<Vec<_>>()
            .join(", ")
    )
}
pub(super) fn check(p: &Value, cfg: &Value) -> u8 {
    let mut errors = Vec::new();
    let effort = &p["effort"];
    if let Some(settings) = effort.get("agents") {
        if let Some(roles) = settings.as_object() {
            for (role, values) in roles {
                let path = format!("effort.agents.{role}");
                if !matches!(role.as_str(), "worker" | "coordinator") {
                    errors.push(format!("{path}: unknown role"));
                    continue;
                }
                let Some(fields) = values.as_object() else {
                    errors.push(format!("{path}: must be an object"));
                    continue;
                };
                for (k, v) in fields {
                    match k.as_str(){
                        "agent" if !matches!(v.as_str(),Some("claude"|"codex"))=>errors.push(format!("{path}.agent: must be claude or codex")),
                        "model"|"effort" if v.as_str().is_none_or(|s|s.is_empty()||s.starts_with('-')||s.chars().any(|c|c.is_control()||c.is_whitespace()))=>errors.push(format!("{path}.{k}: must be nonempty text with no leading dash, spaces, or control characters")),
                        "model"|"effort"|"agent"=>{},
                        _=>errors.push(format!("{path}.{k}: unknown field"))
                    }
                }
                let inherited = &cfg["agents"][role];
                let resolved = |f: &str| {
                    values
                        .get(f)
                        .or_else(|| {
                            if inherited.get("agent").is_some()
                                && values
                                    .get("agent")
                                    .is_some_and(|v| v != &inherited["agent"])
                            {
                                None
                            } else {
                                inherited.get(f)
                            }
                        })
                        .and_then(Value::as_str)
                        .is_some_and(|v| !v.is_empty())
                };
                if resolved("effort") && !resolved("model") {
                    errors.push(format!("{path}.effort: needs a model"))
                }
            }
        } else {
            errors.push("effort.agents: must be an object".into())
        }
    }
    let phases = list(&p["phases"]);
    let release = text(&cfg["config"], "release_branch");
    for ph in phases {
        if text(ph, "target").trim().is_empty() {
            errors.push(format!("phase {}: no target", val(&ph["key"])))
        }
    }
    if let Some(v) = effort.get("initiative")
        && !v.is_null()
        && v.as_str()
            .is_none_or(|s| s.trim().is_empty() || s.chars().count() > 80)
    {
        errors.push("effort.initiative: a name of 1 to 80 characters".into())
    }
    if effort.get("lint").is_some_and(|v| {
        v.as_array()
            .is_none_or(|a| a.iter().any(|s| !s.is_string()))
    }) {
        errors.push("effort.lint: a list of strings".into())
    }
    if effort.get("rules").is_some_and(|v| !v.is_string()) {
        errors.push("effort.rules: a text".into())
    }
    let mut deps = Deps::new();
    let mut keys = vec![];
    let mut ids = HashMap::new();
    for n in list(&p["nodes"]) {
        let k = text(n, "key");
        if k.is_empty() || deps.contains_key(k) {
            errors.push(format!(
                "node key missing or duplicate: {}",
                quoted(&n["key"])
            ));
            continue;
        }
        keys.push(k);
        deps.insert(k, vec![]);
        let kinds = [
            "decision",
            "merge-point",
            "ops",
            "ship-point",
            "spike",
            "task",
        ];
        if !kinds.contains(&text(n, "kind")) {
            errors.push(format!(
                "{k}: kind {} not in {}",
                quoted(&n["kind"]),
                names(&kinds)
            ))
        }
        if !phases.iter().any(|ph| val(&ph["key"]) == val(&n["phase"])) {
            errors.push(format!("{k}: phase {} not in phases", quoted(&n["phase"])))
        }
        if text(n, "title").is_empty() && text(n, "eng").is_empty() {
            errors.push(format!("{k}: no title"))
        }
        if n["kind"] == "task" && text(n, "lane").is_empty() && n["role"] != "integration" {
            errors.push(format!("{k}: task has no lane"))
        }
        if !matches!(text(n, "role"), "" | "hotfix" | "integration" | "sync") {
            errors.push(format!(
                "{k}: role {} not in ['hotfix', 'integration', 'sync']",
                quoted(&n["role"])
            ))
        }
        if n.get("eng").is_some() && n.get("issue").is_some() {
            errors.push(format!("{k}: cannot have both eng and issue"))
        }
        if let Some(by) = n.get("by") {
            let slug = text(cfg, "wait_label").trim_start_matches("needs-");
            let mut allowed = vec!["coordinator", "human", slug];
            allowed.sort();
            allowed.dedup();
            if n["kind"] != "ops" || !allowed.contains(&text(n, "by")) {
                errors.push(format!(
                    "{k}: by {} needs kind ops and a value in {}",
                    quoted(by),
                    names(&allowed)
                ))
            }
        }
        for f in ["eng", "issue"] {
            if let Some(v) = n.get(f) {
                let id = text(n, f);
                if !id.split_once('-').is_some_and(|(a, b)| {
                    !a.is_empty()
                        && a.bytes().all(|c| c.is_ascii_uppercase())
                        && !b.is_empty()
                        && b.bytes().all(|c| c.is_ascii_digit())
                }) {
                    errors.push(format!("{k}: invalid {f} identifier {}", quoted(v)))
                } else if *ids.entry(id).or_insert(k) != k {
                    errors.push(format!("{k}: issue {id} is also used by {}", ids[id]))
                }
            }
        }
    }
    let mut edges = HashSet::new();
    for e in list(&p["edges"]) {
        let (a, b) = (text(e, "from"), text(e, "to"));
        if !edges.insert((a, b)) {
            errors.push(format!("edge {a} -> {b}: duplicate"))
        } else if !deps.contains_key(a) || !deps.contains_key(b) {
            errors.push(format!("edge {a} -> {b}: unknown key"))
        } else {
            deps.get_mut(a).unwrap().push(b)
        }
    }
    let mut done = HashSet::new();
    for k in &keys {
        cycle(k, &mut vec![], &mut done, &deps, &mut errors)
    }
    let mut prev: Option<(String, String)> = None;
    for phase in phases {
        let ph = val(&phase["key"]);
        let mine: Vec<_> = keys
            .iter()
            .copied()
            .filter(|k| val(&node(p, k).unwrap()["phase"]) == ph)
            .collect();
        let kind = |k| text(node(p, k).unwrap(), "kind");
        let role = |k| text(node(p, k).unwrap(), "role");
        let of = |t| {
            mine.iter()
                .copied()
                .filter(|k| kind(k) == t)
                .collect::<Vec<_>>()
        };
        if let Some((old, sp)) = &prev {
            for &k in &mine {
                if matches!(kind(k), "task" | "ops" | "merge-point" | "ship-point")
                    && !reach(k, sp, &deps)
                {
                    errors.push(format!(
                        "{k}: does not depend on ship point {sp} of phase {old}"
                    ))
                }
            }
        }
        let (mp, sp) = (of("merge-point"), of("ship-point"));
        prev = if sp.len() == 1 {
            Some((ph.clone(), sp[0].to_owned()))
        } else {
            None
        };
        if mp.len() != 1 || sp.len() != 1 {
            errors.push(format!(
                "phase {ph}: needs exactly one merge-point and one ship-point (has {}, {})",
                names(&mp),
                names(&sp)
            ));
            continue;
        }
        let (mp, sp) = (mp[0], sp[0]);
        let post = |k| kind(k) == "task" && matches!(role(k), "integration" | "sync");
        for &k in &mine {
            if (k == sp || kind(k) == "ops" || post(k)) && !reach(k, mp, &deps) {
                errors.push(format!("{k}: not after merge point {mp}"))
            }
        }
        let mut missing: Vec<_> = mine.iter().filter(|k| !reach(sp, k, &deps)).collect();
        missing.sort();
        for k in missing {
            errors.push(format!(
                "phase {ph}: {k} is not reached from ship point {sp}"
            ))
        }
        let mut tasks = of("task");
        for &k in &tasks {
            let t: Vec<_> = deps[k]
                .iter()
                .copied()
                .filter(|d| tasks.contains(d))
                .collect();
            if t.len() > 1 {
                errors.push(format!(
                    "{k}: more than one task dependency in phase {ph}: {}",
                    names(&t)
                ))
            }
            for d in t {
                if node(p, k).unwrap()["lane"] != node(p, d).unwrap()["lane"] {
                    errors.push(format!(
                        "{k} -> {d}: cross-lane edge inside phase {ph} (ordering.md 'Lanes')"
                    ))
                }
            }
        }
        for &k in &tasks {
            let anchor = if post(k) { sp } else { mp };
            if !reach(anchor, k, &deps) {
                errors.push(format!("{k}: not before its anchor {anchor}"))
            }
        }
        let target = text(phase, "target");
        for (needed, active) in [
            ("sync", target == release),
            ("integration", target.starts_with("effort/")),
        ] {
            if active && tasks.iter().filter(|k| role(k) == needed).count() != 1 {
                errors.push(format!(
                    "phase {ph}: {target} needs exactly one {needed} task"
                ))
            }
        }
        tasks.sort();
        for &k in &tasks {
            if target == release && !post(k) {
                if role(k) != "hotfix" {
                    errors.push(format!("{k}: {release} pre-merge task needs role hotfix"))
                }
                if effort["stacked_hotfix"] != true
                    && tasks.iter().any(|d| *d != k && reach(k, d, &deps))
                {
                    errors.push(format!(
                        "{k}: {release} pre-merge task depends on another task"
                    ))
                }
            }
            if target != release && matches!(role(k), "hotfix" | "sync") {
                errors.push(format!("{k}: role {} requires target {release}", role(k)))
            }
            if role(k) == "integration" && !target.starts_with("effort/") {
                errors.push(format!("{k}: role integration requires an effort/ target"))
            }
        }
    }
    for e in &errors {
        println!("{e}")
    }
    u8::from(!errors.is_empty())
}
