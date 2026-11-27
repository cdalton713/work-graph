use super::{invalid, load_keymap, read_object};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    env, fs, io,
    path::{Path, PathBuf},
};

pub struct Config {
    pub path: PathBuf,
    values: Value,
}

fn expand(path: &Path) -> io::Result<PathBuf> {
    use std::path::Component;
    let mut parts = path.components().filter(|p| *p != Component::CurDir);
    let first = parts.next();
    let mut normalized = match first {
        Some(Component::Normal(part)) if part == "~" => env::home_dir(),
        Some(Component::Normal(part)) if part.to_str().is_some_and(|s| s.starts_with('~')) => {
            let user = &part.to_str().unwrap()[1..];
            nix::unistd::User::from_name(user)?.map(|u| u.dir)
        }
        Some(part) => Some(PathBuf::from(part.as_os_str())),
        None => Some(PathBuf::from(".")),
    }
    .ok_or_else(|| invalid("Could not determine home directory."))?;
    normalized.extend(parts);
    Ok(normalized)
}

fn overlay(base: &mut Value, values: &Value) -> io::Result<()> {
    base.as_object_mut()
        .ok_or_else(|| invalid("expected an object"))?
        .extend(
            values
                .as_object()
                .ok_or_else(|| invalid("expected an object"))?
                .clone(),
        );
    Ok(())
}

const VALUE_ERROR: &str =
    "must be nonempty text with no leading dash, spaces, or control characters";

fn safe_value(value: &Value) -> bool {
    use unicode_general_category::{GeneralCategory::*, get_general_category};
    value.as_str().is_some_and(|s| {
        !s.is_empty()
            && !s.starts_with('-')
            && s.chars().all(|c| {
                !matches!(
                    get_general_category(c),
                    Control
                        | Format
                        | PrivateUse
                        | Surrogate
                        | Unassigned
                        | SpaceSeparator
                        | LineSeparator
                        | ParagraphSeparator
                )
            })
    })
}

pub fn validate_agents(settings: &Value) -> io::Result<()> {
    let mut errors = Vec::new();
    for (role, values) in settings
        .as_object()
        .ok_or_else(|| invalid("agents: must be an object"))?
    {
        let path = format!("agents.{role}");
        if !matches!(role.as_str(), "worker" | "coordinator") {
            errors.push(format!("{path}: unknown role"));
            continue;
        }
        let Some(fields) = values.as_object() else {
            errors.push(format!("{path}: must be an object"));
            continue;
        };
        for (field, value) in fields {
            let message = match field.as_str() {
                "agent" if !matches!(value.as_str(), Some("codex" | "claude")) => {
                    "must be claude or codex"
                }
                "model" | "effort" if !safe_value(value) => VALUE_ERROR,
                "agent" | "model" | "effort" => continue,
                _ => "unknown field",
            };
            errors.push(format!("{path}.{field}: {message}"));
        }
        if has_value(&values["effort"]) && !has_value(&values["model"]) {
            errors.push(format!("{path}.effort: needs a model"));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(invalid(errors.join("; ")))
    }
}

fn has_value(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64() != Some(0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

fn resolved_agents(config: &Value, plan: &Value) -> io::Result<Value> {
    let mut roles = json!({"coordinator":{},"worker":{"agent":"codex"}});
    for role in ["coordinator", "worker"] {
        let result = &mut roles[role];
        if let Some(settings) = config.get(role) {
            overlay(result, settings)?;
        }
        if let Some(settings) = plan.get(role) {
            if has_value(&result["agent"])
                && settings
                    .get("agent")
                    .is_some_and(|agent| *agent != result["agent"])
            {
                *result = json!({});
            }
            overlay(result, settings)?;
        }
        for field in ["model", "effort"] {
            if result.get(field).is_some_and(|v| !safe_value(v)) {
                return Err(invalid(format!("agents.{role}.{field}: {VALUE_ERROR}")));
            }
        }
        if has_value(&result["effort"]) && !has_value(&result["model"]) {
            return Err(invalid(format!("agents.{role}.effort: needs a model")));
        }
    }
    Ok(roles)
}

fn id_ok(s: &str) -> bool {
    !s.is_empty()
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn validate(config: &Value) -> io::Result<()> {
    for (field, source) in std::iter::once(("page_url".to_owned(), config)).chain(
        config["workspaces"]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
            .map(|(i, w)| (format!("workspaces[{i}].page_url"), w)),
    ) {
        if !source["page_url"].is_null()
            && !source["page_url"]
                .as_str()
                .is_some_and(|s| s.starts_with("http://") || s.starts_with("https://"))
        {
            return Err(invalid(format!(
                "{field} must start with http:// or https://"
            )));
        }
    }
    if !config["human"].as_str().is_some_and(|s| {
        s.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
            && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b' ')
    }) {
        return Err(invalid(
            "human must be a name of letters, digits and spaces",
        ));
    }
    if !config["agent_merge"].as_array().is_some_and(|a| {
        a.iter().all(|v| {
            v.as_str().is_some_and(|s| {
                s.split('/').count() <= 2
                    && s.split('/').all(|part| {
                        !part.is_empty()
                            && part
                                .chars()
                                .all(|c| c.is_alphanumeric() || "_.-".contains(c))
                    })
            })
        })
    }) {
        return Err(invalid(
            "agent_merge must be a list of GitHub owners or owner/repo names",
        ));
    }
    if !config["health_interval"]
        .as_f64()
        .is_some_and(|n| (1.0..=168.0).contains(&n))
    {
        return Err(invalid(
            "health_interval must be a number of hours from 1 to 168",
        ));
    }
    if !config["health_agent"].as_str().is_some_and(id_ok) {
        return Err(invalid(
            "health_agent must be an Orca agent id, such as codex or claude",
        ));
    }
    for field in ["worker_settings", "coordinator_settings"] {
        if !config[field].as_object().is_some_and(|m| {
            m.iter()
                .all(|(k, v)| matches!(&**k, "claude" | "codex") && v.is_object())
        }) {
            return Err(invalid(format!(
                "{field} must map claude or codex to a JSON object"
            )));
        }
    }
    if !config["context_limit"]
        .as_u64()
        .is_some_and(|n| n == 0 || n >= 100000)
    {
        return Err(invalid(
            "context_limit must be 0 (off) or a token count of 100000 or more",
        ));
    }
    for (i, channel) in config["notify"]
        .as_array()
        .ok_or_else(|| invalid("notify: must be a list of channels"))?
        .iter()
        .enumerate()
    {
        let problem = match channel["type"].as_str() {
            Some("webhook") => {
                let refs: Vec<_> = ["url_env", "url_file"]
                    .iter()
                    .filter_map(|k| channel.get(k))
                    .collect();
                (channel.get("url").is_some()
                    || refs.is_empty()
                    || refs.iter().any(|v| v.as_str().is_none_or(str::is_empty)))
                .then_some("a webhook needs url_env or url_file (the URL never goes in the config)")
            }
            Some("page") => {
                if channel
                    .as_object()
                    .is_some_and(|fields| fields.keys().any(|k| k != "type" && k != "to"))
                {
                    Some("a page channel takes only type and an optional to")
                } else if channel
                    .get("to")
                    .is_some_and(|v| v.as_str().is_none_or(|s| s.trim().is_empty()))
                {
                    Some("to must name an owner email")
                } else {
                    None
                }
            }
            Some("command") => (!channel["argv"].as_array().is_some_and(|a| {
                !a.is_empty() && a.iter().all(|v| v.as_str().is_some_and(|s| !s.is_empty()))
            }))
            .then_some("a command needs argv, a list of strings"),
            _ => Some("type must be page, webhook or command"),
        };
        if let Some(msg) = problem {
            return Err(invalid(format!("notify: channel {i}: {msg}")));
        }
    }
    Ok(())
}

impl Config {
    pub fn settings(&self) -> &Value {
        &self.values
    }

    pub fn discover() -> io::Result<Self> {
        let path = env::var_os("WG_CONFIG")
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("~/.config/work-graph/config.json"));
        Self::read(expand(&path)?)
    }

    pub fn read(path: PathBuf) -> io::Result<Self> {
        let mut config: Value = serde_json::from_str(include_str!("defaults.json"))?;
        let default = config["workspaces"][0].clone();
        let data = match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes)?,
            Err(e) if e.kind() == io::ErrorKind::NotFound => json!({}),
            Err(e) => return Err(e),
        };
        let problem = |s: &str| invalid(format!("{}: {s}", path.display()));
        if !data.is_object() {
            return Err(problem("the config must be a JSON object"));
        }
        if let Some(settings) = data.get("agents") {
            validate_agents(settings).map_err(|e| problem(&e.to_string()))?;
        }
        if data.get("agent_replies").is_some_and(|v| !v.is_boolean()) {
            return Err(problem("agent_replies must be true or false"));
        }
        overlay(&mut config, &data)?;
        let list = config["workspaces"]
            .as_array_mut()
            .ok_or_else(|| problem("workspaces must be an array"))?;
        if list.is_empty() {
            list.push(default.clone());
        }
        let mut seen = HashSet::new();
        for value in list {
            let mut w = default.clone();
            overlay(&mut w, value)?;
            let id = w["id"].as_str().unwrap_or("");
            if !id_ok(id) || !seen.insert(id.to_owned()) {
                return Err(problem(
                    "each workspace needs a unique id of a-z, 0-9 and -",
                ));
            }
            *value = w;
        }
        validate(&config).map_err(|e| problem(&e.to_string()))?;
        Ok(Self {
            path,
            values: config,
        })
    }

    pub fn load_plan(&self, dir: &Path) -> io::Result<Value> {
        let mut plan = read_object(&dir.join("plan.json")).map_err(|e| {
            if e.kind() == io::ErrorKind::NotFound {
                invalid(format!("no plan.json in {}", dir.display()))
            } else {
                e
            }
        })?;
        let keymap = load_keymap(dir)?;
        self.normalize(&mut plan, &keymap)?;
        Ok(plan)
    }

    pub fn normalize(&self, plan: &mut Value, keymap: &Value) -> io::Result<()> {
        let effort = plan
            .get_mut("effort")
            .filter(|e| e.is_object())
            .ok_or_else(|| invalid("effort must be an object"))?;
        if let Some(settings) = keymap["collab"].get("settings") {
            effort
                .as_object_mut()
                .unwrap()
                .retain(|k, _| matches!(&**k, "name" | "summary"));
            overlay(effort, settings)?;
        }
        let list = self.values["workspaces"].as_array().unwrap();
        let id = effort.get("workspace").unwrap_or(&list[0]["id"]);
        let w = list.iter().find(|w| w["id"] == *id).ok_or_else(|| {
            invalid(format!(
                "effort.workspace must be one of {} ({})",
                list.iter()
                    .filter_map(|w| w["id"].as_str())
                    .collect::<Vec<_>>()
                    .join(", "),
                self.path.display()
            ))
        })?;
        let team = &effort["team"];
        let teams = |w: &Value| w["teams"].as_array().is_some_and(|a| a.contains(team));
        if !team.is_null() {
            if w["teams"].as_array().is_some_and(|a| !a.is_empty()) && !teams(w) {
                return Err(invalid(format!(
                    "{} plans must use team {}",
                    w["id"].as_str().unwrap(),
                    w["teams"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(" or ")
                )));
            }
            if w["team"] != *team
                && !teams(w)
                && let Some(owner) = list
                    .iter()
                    .find(|x| x["id"] != *id && (x["team"] == *team || teams(x)))
            {
                return Err(invalid(format!(
                    "team {} requires effort.workspace {}",
                    team.as_str().unwrap_or(""),
                    owner["id"].as_str().unwrap()
                )));
            }
        }
        if effort.get("team").is_none() {
            if w["team"].as_str().is_none_or(str::is_empty) {
                return Err(invalid(format!(
                    "effort.team is missing, and workspace {} has no default team in {}",
                    w["id"].as_str().unwrap(),
                    self.path.display()
                )));
            }
            effort["team"] = w["team"].clone();
        }
        plan.as_object_mut()
            .unwrap()
            .entry("edges")
            .or_insert_with(|| json!([]));
        Ok(())
    }

    pub fn report(&self, dir: Option<&Path>) -> io::Result<Value> {
        let rules = expand(Path::new(
            self.values["rules"]
                .as_str()
                .ok_or_else(|| invalid("rules must be a path"))?,
        ))?;
        let human = self.values["human"].as_str().unwrap();
        let slug = human
            .split_ascii_whitespace()
            .map(str::to_ascii_lowercase)
            .collect::<Vec<_>>()
            .join("-");
        let plan = dir
            .map(|d| self.load_plan(d))
            .transpose()?
            .unwrap_or(Value::Null);
        Ok(
            json!({"path":self.path,"exists":self.path.exists(),"rules":rules,"rules_exist":rules.exists(),"wait_status":format!("Needs {human}"),"wait_label":format!("needs-{slug}"),"config":self.values,"agents":resolved_agents(&self.values["agents"], &plan["effort"]["agents"])?}),
        )
    }
}

/// Effective settings for one configured workspace.
pub struct Workspace {
    pub settings: Value,
    pub page_url: String,
}

impl crate::ConfigProvider for Config {
    type Settings = Workspace;
    type Error = io::Error;

    fn resolve(&self, workspace: &str) -> io::Result<Workspace> {
        let settings = self.values["workspaces"]
            .as_array()
            .unwrap()
            .iter()
            .find(|w| w["id"] == workspace)
            .ok_or_else(|| {
                invalid(format!(
                    "unknown workspace {workspace}: choose one of {}",
                    self.values["workspaces"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .filter_map(|row| row["id"].as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                ))
            })?;
        let page_url = env::var("WG_UI_URL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| {
                settings["page_url"]
                    .as_str()
                    .or(self.values["page_url"].as_str())
                    .unwrap_or("http://127.0.0.1:4747")
                    .to_owned()
            });
        Ok(Workspace {
            settings: settings.clone(),
            page_url: page_url.trim_end_matches('/').to_owned(),
        })
    }
}
