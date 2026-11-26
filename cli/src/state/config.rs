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

fn expand(path: &Path) -> PathBuf {
    if let Ok(rest) = path.strip_prefix("~")
        && let Some(home) = env::home_dir()
    {
        return if rest.as_os_str().is_empty() {
            home
        } else {
            home.join(rest)
        };
    }
    path.to_owned()
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

fn agent_settings(lower: &Value, higher: &Value) -> io::Result<Value> {
    let mut result = if lower.get("agent").is_some()
        && higher.get("agent").is_some()
        && lower["agent"] != higher["agent"]
    {
        json!({})
    } else {
        lower.clone()
    };
    if let Some(fields) = higher.as_object() {
        for (field, value) in fields {
            let s = value.as_str().unwrap_or_default();
            match field.as_str() {
                "agent" if !matches!(s, "codex" | "claude") => {
                    return Err(invalid("agent: must be claude or codex"));
                }
                "model" | "effort"
                    if s.is_empty()
                        || s.starts_with('-')
                        || s.chars().any(|c| c.is_control() || c.is_whitespace()) =>
                {
                    return Err(invalid(format!(
                        "{field}: must be nonempty text with no leading dash, spaces, or control characters"
                    )));
                }
                "agent" | "model" | "effort" => (),
                _ => return Err(invalid(format!("{field}: unknown field"))),
            }
        }
        overlay(&mut result, higher)?;
    } else {
        return Err(invalid("must be an object"));
    }
    if result.get("effort").is_some() && result.get("model").is_none() {
        return Err(invalid("effort: needs a model"));
    }
    Ok(result)
}

fn agents(base: &Value, overrides: Option<&Value>) -> io::Result<Value> {
    let mut result = base.clone();
    if let Some(settings) = overrides {
        for (role, fields) in settings
            .as_object()
            .ok_or_else(|| invalid("agents: must be an object"))?
        {
            let lower = base
                .get(role)
                .ok_or_else(|| invalid(format!("agents.{role}: unknown role")))?;
            result[role] = agent_settings(lower, fields).map_err(|e| {
                invalid(format!(
                    "agents.{role}{}{e}",
                    if fields.is_object() { "." } else { ": " }
                ))
            })?;
        }
    }
    Ok(result)
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
            Some("command") => (!channel["argv"].as_array().is_some_and(|a| {
                !a.is_empty() && a.iter().all(|v| v.as_str().is_some_and(|s| !s.is_empty()))
            }))
            .then_some("a command needs argv, a list of strings"),
            _ => Some("type must be webhook or command"),
        };
        if let Some(msg) = problem {
            return Err(invalid(format!("notify: channel {i}: {msg}")));
        }
    }
    Ok(())
}

impl Config {
    pub fn discover() -> io::Result<Self> {
        let path = env::var_os("WG_CONFIG")
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("~/.config/work-graph/config.json"));
        Self::read(expand(&path))
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
        agents(
            &json!({"coordinator":{},"worker":{"agent":"codex"}}),
            data.get("agents"),
        )
        .map_err(|e| problem(&e.to_string()))?;
        if data.get("agent_replies").is_some_and(|v| !v.is_boolean()) {
            return Err(problem("agent_replies must be true or false"));
        }
        overlay(&mut config, &data)?;
        let list = config["workspaces"]
            .as_array_mut()
            .ok_or_else(|| problem("workspaces must be a list"))?;
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
        Ok(plan)
    }

    pub fn report(&self, dir: Option<&Path>) -> io::Result<Value> {
        let rules = expand(Path::new(
            self.values["rules"]
                .as_str()
                .ok_or_else(|| invalid("rules must be a path"))?,
        ));
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
        let defaults = agents(
            &json!({"coordinator":{},"worker":{"agent":"codex"}}),
            self.values.get("agents"),
        )?;
        Ok(
            json!({"path":self.path,"exists":self.path.exists(),"rules":rules,"rules_exist":rules.exists(),"wait_status":format!("Needs {human}"),"wait_label":format!("needs-{slug}"),"config":self.values,"agents":agents(&defaults,plan["effort"].get("agents"))?}),
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
            .ok_or_else(|| invalid("unknown workspace"))?;
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
