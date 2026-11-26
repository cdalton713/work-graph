use super::{
    load::{ProjectLabel, sync_label},
    *,
};
use crate::state::{PlanLock, load_keymap};
use std::path::Path;

#[derive(Clone, Copy)]
pub(super) enum Level {
    Autonomy,
    Review,
}

impl Level {
    fn group(self) -> &'static str {
        match self {
            Self::Autonomy => "autonomy",
            Self::Review => "review",
        }
    }
    fn noun(self) -> &'static str {
        match self {
            Self::Autonomy => "autonomy",
            Self::Review => "review effort",
        }
    }
    fn verb(self) -> &'static str {
        match self {
            Self::Autonomy => "autonomy",
            Self::Review => "review-effort",
        }
    }
    fn default(self) -> &'static str {
        match self {
            Self::Autonomy => "standard",
            Self::Review => "thorough",
        }
    }
    fn label(self, level: &str) -> String {
        match self {
            Self::Autonomy => level.into(),
            Self::Review => format!("review:{level}"),
        }
    }
    fn parse_label(self, name: &str) -> Option<&str> {
        match self {
            Self::Autonomy => matches!(name, "full" | "standard" | "supervised").then_some(name),
            Self::Review => {
                let value = name.strip_prefix("review:").unwrap_or(name);
                matches!(value, "thorough" | "standard" | "light").then_some(value)
            }
        }
    }

    fn set(
        self,
        linear: &mut Linear,
        plan: &Value,
        id: &Value,
        scoped: bool,
        level: &str,
    ) -> Result<(), String> {
        let teams = linear.request(
            "query($k:String!){teams(filter:{key:{eq:$k}}){nodes{id}}}",
            json!({"k":plan["effort"]["team"]}),
        )?;
        let tid = teams["teams"]["nodes"][0]["id"]
            .as_str()
            .ok_or("project team not found")?;
        let description = match self {
            Self::Autonomy => {
                "work-graph: the autonomy level of each effort (full, standard, supervised). The coordinator follows it; change it on the work-graph page at any time."
            }
            Self::Review => {
                "work-graph: the review effort of each effort (thorough, standard, light). The coordinator follows it."
            }
        };
        sync_label(
            linear,
            ProjectLabel {
                group: self.group(),
                noun: self.noun(),
                name: &self.label(level),
                description,
            },
            &json!(tid),
            id,
            scoped,
            true,
            &mut Vec::new(),
        )
    }

    pub fn run(
        self,
        dir: &Path,
        installation: &Installation,
        plan: &Value,
        wanted: Option<&str>,
    ) -> Result<(), String> {
        let guard = PlanLock::acquire(dir, None).map_err(|e| e.to_string())?;
        let mut km = load_keymap(dir).map_err(|e| e.to_string())?;
        let id = km["project"]["id"].clone();
        if !id.as_str().is_some_and(|s| !s.is_empty()) {
            return Err(format!(
                "keymap.json has no project; run wg load --apply first, then wg {}",
                self.verb()
            ));
        }
        let mut linear = client(installation, plan)?;
        let scope = workspace(installation, plan)?;
        let scoped = installation
            .workspaces()
            .iter()
            .find(|w| w["id"] == scope)
            .is_none_or(|w| w["team_labels"] != false);
        let r = linear.request(
            "query($id:String!){project(id:$id){labels(first:50){nodes{name parent{name}}}}}",
            json!({"id":id}),
        )?;
        let labels = r["project"]["labels"]["nodes"]
            .as_array()
            .ok_or("missing project labels")?;
        let mut label = labels
            .iter()
            .filter(|v| {
                v["parent"]["name"]
                    .as_str()
                    .is_some_and(|s| s.eq_ignore_ascii_case(self.group()))
            })
            .filter_map(|v| v["name"].as_str())
            .find(|name| self.parse_label(name).is_some())
            .map(str::to_owned);
        if km["run"]["effort"].is_null() {
            km["run"]["effort"] = json!({});
        }
        if km["run"]["nodes"].is_null() {
            km["run"]["nodes"] = json!({});
        }
        let save = |km: &mut Value, before: &Value| -> Result<(), String> {
            crate::page::save_run_keymap(dir, &guard, plan, km)?;
            journal(dir, self.verb(), before, km);
            Ok(())
        };
        if matches!(self, Self::Autonomy)
            && let Some(old) = km["run"]["effort"]["autonomy"]
                .as_str()
                .filter(|s| !s.is_empty())
        {
            if label.is_none() && self.parse_label(old).is_some() {
                self.set(&mut linear, plan, &id, scoped, old)?;
                label = Some(old.into());
            }
            let before = km.clone();
            km["run"]["effort"]
                .as_object_mut()
                .ok_or("invalid effort row")?
                .shift_remove("autonomy");
            save(&mut km, &before)?;
        }
        let current = label
            .as_deref()
            .and_then(|s| self.parse_label(s))
            .unwrap_or(self.default());
        let level = wanted.unwrap_or(current);
        if wanted.is_some() && label.as_deref() != Some(&self.label(level)) {
            self.set(&mut linear, plan, &id, scoped, level)?;
        }
        println!(
            "{} {level}{}",
            self.noun(),
            if current == level {
                String::new()
            } else {
                format!(" (was {current})")
            }
        );
        let before = km.clone();
        km["run"]["effort"][format!("{}_seen", self.group())] = level.into();
        save(&mut km, &before)
    }
}
