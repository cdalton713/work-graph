//! The `agents` command of the page: its settings become `effort.agents` in plan.json.
use crate::state::{PlanLock, load_keymap, validate_agents};
use serde_json::{Value, json};
use std::{path::Path, time::Duration};

const ROLES: [&str; 2] = ["coordinator", "worker"];
const FIELDS: [&str; 3] = ["agent", "model", "effort"];

/// `coordinator claude claude-opus-5-5 high; worker default`: the settings of each role, for a line.
pub(super) fn describe(agents: &Value) -> String {
    ROLES
        .iter()
        .map(|role| {
            let parts: Vec<&str> = FIELDS
                .iter()
                .filter_map(|f| agents[role][f].as_str().filter(|s| !s.is_empty()))
                .collect();
            let shown = if parts.is_empty() {
                "default".to_owned()
            } else {
                parts.join(" ")
            };
            format!("{role} {shown}")
        })
        .collect::<Vec<_>>()
        .join("; ")
}

fn has_settings(v: &Value) -> bool {
    v.as_object().is_some_and(|o| !o.is_empty())
}

/// Write the settings and return the line of `wg next`. A new coordinator agent applies to the next
/// coordinator job; an autostart automation keeps its old command until `wg autostart --install`.
/// A shared plan sends the change with `wg load --apply`.
pub(super) fn apply(dir: &Path, agents: &Value) -> (String, String) {
    let not_changed = |error: String| {
        (
            "note".to_owned(),
            format!("agents @effort -: not changed ({error})"),
        )
    };
    if let Err(error) = validate_agents(agents) {
        return not_changed(error.to_string());
    }
    let result = (|| -> std::io::Result<(Value, bool)> {
        let lock = PlanLock::acquire(dir, Some(Duration::from_secs(5)))?;
        let text = std::fs::read_to_string(dir.join("plan.json"))?;
        let mut plan: Value = serde_json::from_str(&text).map_err(std::io::Error::other)?;
        if !plan.is_object() {
            return Err(std::io::Error::other("plan.json is not an object"));
        }
        if !plan["effort"].is_object() {
            plan["effort"] = json!({});
        }
        let old = if has_settings(&plan["effort"]["agents"]) {
            plan["effort"]["agents"].clone()
        } else {
            json!({})
        };
        let effort = plan["effort"].as_object_mut().expect("effort is an object");
        if has_settings(agents) {
            effort.insert("agents".into(), agents.clone());
        } else {
            effort.shift_remove("agents");
        }
        if old != *agents {
            lock.save_plan(&plan)?;
        }
        Ok((old, !load_keymap(dir)?["collab"].is_null()))
    })();
    let (old, shared) = match result {
        Ok(v) => v,
        Err(error) => return not_changed(error.to_string()),
    };
    let text = format!("agents @effort -: set on the page: {}", describe(agents));
    if old == *agents {
        return ("note".into(), format!("{text} (no change)"));
    }
    let shown = dir.display();
    let mut steps = vec![];
    if old["coordinator"] != agents["coordinator"] {
        steps.push(format!(
            "run `wg autostart {shown} --install` if this effort has an autostart automation"
        ));
    }
    if shared {
        steps.push(format!("run `wg load {shown} --apply` to share the plan"));
    }
    if steps.is_empty() {
        ("note".into(), text)
    } else {
        ("do".into(), format!("{text}; {}", steps.join(", then ")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn effort(shared: bool) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("plan.json"),
            "{\"effort\":{\"name\":\"Example\"},\"nodes\":[]}\n",
        )
        .unwrap();
        let km = if shared {
            "{\"collab\":{\"name\":\"Example\"}}"
        } else {
            "{}"
        };
        std::fs::write(dir.path().join("keymap.json"), km).unwrap();
        dir
    }
    fn plan(dir: &Path) -> Value {
        serde_json::from_str(&std::fs::read_to_string(dir.join("plan.json")).unwrap()).unwrap()
    }

    #[test]
    fn agents_from_the_page_go_in_the_plan() {
        let d = effort(false);
        let worker = json!({"worker":{"agent":"codex","model":"gpt-6.1-sol","effort":"high"}});
        assert_eq!(
            apply(d.path(), &worker),
            ("note".into(), "agents @effort -: set on the page: coordinator default; worker codex gpt-6.1-sol high".into())
        );
        assert_eq!(plan(d.path())["effort"]["agents"], worker);
        assert!(apply(d.path(), &worker).1.ends_with("(no change)"));
        let mut both = worker.clone();
        both["coordinator"] = json!({"agent":"claude"});
        let (level, text) = apply(d.path(), &both);
        assert_eq!(level, "do");
        assert!(text.contains(&format!(
            "run `wg autostart {} --install` if this effort has an autostart automation",
            d.path().display()
        )));
        assert_eq!(apply(d.path(), &json!({})).0, "do");
        assert!(plan(d.path())["effort"].get("agents").is_none());
    }

    #[test]
    fn a_shared_plan_asks_for_wg_load() {
        let d = effort(true);
        let (level, text) = apply(d.path(), &json!({"worker":{"agent":"claude"}}));
        assert_eq!(level, "do");
        assert!(text.contains(&format!(
            "run `wg load {} --apply` to share the plan",
            d.path().display()
        )));
    }

    #[test]
    fn invalid_agents_change_nothing() {
        let d = effort(false);
        assert_eq!(
            apply(d.path(), &json!({"worker":{"effort":"high"}})).1,
            "agents @effort -: not changed (agents.worker.effort: needs a model)"
        );
        assert_eq!(
            apply(d.path(), &json!("codex")).1,
            "agents @effort -: not changed (agents: must be an object)"
        );
        assert!(plan(d.path())["effort"].get("agents").is_none());
    }
}
