//! Validate and summarize a status-check report before publishing it.
use super::machine::*;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
};

const KINDS: &[&str] = &[
    "status",
    "connection",
    "stale-human",
    "stale-review",
    "comment",
    "plan-drift",
    "relation",
    "worker",
    "other",
    "doctor-gap",
];
fn clean(v: &Value) -> String {
    text(v).split_whitespace().collect::<Vec<_>>().join(" ")
}
fn problem(index: usize, f: &Value) -> Option<String> {
    let kind = text(&f["kind"]);
    let subject = text(&f["subject"]);
    let problem = if !f.is_object() {
        "not an object".into()
    } else if !KINDS.contains(&kind) {
        format!("kind must be one of {}", KINDS.join(", "))
    } else if !(1..=60).contains(&subject.len())
        || !subject
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.@-".contains(&b))
    {
        "subject must be 1-60 characters of A-Z, a-z, 0-9, _ . @ -".into()
    } else if text(&f["text"]).trim().is_empty() || text(&f["text"]).chars().count() > 2000 {
        "text must be 1-2000 characters".into()
    } else if f.get("fix").is_some_and(|s| !s.is_string()) {
        "fix must be text".into()
    } else if matches!(kind, "stale-human" | "stale-review") && !f["hours"].is_number() {
        format!("a {kind} finding needs hours, a number")
    } else {
        return None;
    };
    Some(format!("finding {index}: {problem}"))
}

pub struct Findings {
    pub summary: String,
    pub faults: BTreeMap<String, Value>,
    pub notes: Vec<String>,
}
impl Findings {
    pub fn read(path: &Path) -> Result<Self> {
        let value: Value = serde_json::from_slice(
            &fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?,
        )
        .map_err(|e| format!("{}: {e}", path.display()))?;
        let rows = value["findings"].as_array().ok_or_else(|| {
            format!(
                "{}: a report is a JSON object with a list `findings`",
                path.display()
            )
        })?;
        let mut faults = BTreeMap::new();
        let mut notes = vec![];
        for (i, row) in rows.iter().enumerate() {
            if let Some(error) = problem(i, row) {
                return Err(format!("{}: {error}", path.display()).into());
            }
            let kind = text(&row["kind"]);
            let subject = text(&row["subject"]);
            let threshold = match kind {
                "stale-human" => 24,
                "stale-review" => 48,
                _ => 0,
            };
            if let Some(hours) = row["hours"]
                .as_f64()
                .filter(|h| threshold > 0 && *h < f64::from(threshold))
            {
                notes.push(format!(
                    "dropped {kind} {subject}: {hours} hours is less than {threshold}"
                ));
                continue;
            }
            let level = match kind {
                "status" | "connection" => Some("offTrack"),
                "doctor-gap" => None,
                _ => Some("atRisk"),
            };
            let id = format!("{kind}:{subject}");
            faults.entry(id.clone()).or_insert_with(||json!({"id":id,"kind":kind,"subject":subject,"text":clean(&row["text"]),"fix":clean(&row["fix"]),"level":level}));
        }
        if value.get("summary").is_some_and(|v| !v.is_string()) {
            return Err(format!("{}: summary must be text", path.display()).into());
        }
        Ok(Self {
            summary: clean(&value["summary"]),
            faults,
            notes,
        })
    }
    pub fn value(&self) -> &'static str {
        if self.faults.values().any(|f| f["level"] == "offTrack") {
            "offTrack"
        } else if self.faults.values().any(|f| f["level"] == "atRisk") {
            "atRisk"
        } else {
            "onTrack"
        }
    }
    pub fn body(&self, issues: &BTreeMap<String, String>, at: &str) -> String {
        let mut lines = vec![
            format!("**work-graph status check: {}**", self.value()),
            String::new(),
        ];
        if !self.summary.is_empty() {
            lines.extend([self.summary.clone(), String::new()]);
        }
        let issue = |id: &str| {
            issues
                .get(id)
                .map(|s| format!(" ({s})"))
                .unwrap_or_default()
        };
        let mut counted = false;
        for level in ["offTrack", "atRisk"] {
            for (id, f) in &self.faults {
                if f["level"] != level {
                    continue;
                }
                counted = true;
                let fix = text(&f["fix"]);
                let fix = if fix.is_empty() {
                    String::new()
                } else {
                    format!(" Fix: {fix}")
                };
                lines.push(format!(
                    "- {level} {id}{}: {}{fix}",
                    issue(id),
                    text(&f["text"])
                ));
            }
        }
        if !counted {
            lines.push("No faults.".into())
        }
        let gaps = self
            .faults
            .iter()
            .filter(|(_, f)| f["level"].is_null())
            .collect::<Vec<_>>();
        if !gaps.is_empty() {
            lines.extend([String::new(), "Checks to add to wg doctor:".into()]);
            for (id, f) in gaps {
                lines.push(format!(
                    "- {}{}: {}",
                    text(&f["subject"]),
                    issue(id),
                    text(&f["text"])
                ))
            }
        }
        if !self.notes.is_empty() {
            lines.extend([String::new(), "Notes:".into()]);
            lines.extend(self.notes.iter().map(|n| format!("- {n}")));
        }
        lines.extend([
            String::new(),
            format!(
                "Checked at {at} by wg health. The status check changes nothing in the effort."
            ),
        ]);
        lines.join("\n")
    }
    pub fn save_published(&self, dir: &Path, at: &str, update: &str) -> Result<()> {
        let keys = self
            .faults
            .keys()
            .map(String::as_str)
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>()
            .join(",");
        save_fields(
            dir,
            &[
                ("health", json!(self.value())),
                ("health_at", json!(at)),
                ("health_update", json!(update)),
                (
                    "health_faults",
                    if keys.is_empty() {
                        Value::Null
                    } else {
                        json!(keys)
                    },
                ),
                ("health_started", Value::Null),
            ],
        )
    }
}

fn changes_effort(entry: &Value) -> bool {
    entry["key"] != "@effort"
        || entry["changes"].as_object().is_some_and(|fields| {
            fields.keys().any(|f| {
                !(f.starts_with("health")
                    || f.starts_with("page_contract")
                    || matches!(f.as_str(), "paused_seen" | "autonomy_seen")
                    || ["notified_", "notify_failed_"].iter().any(|p| {
                        f.strip_prefix(p)
                            .is_some_and(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
                    }))
            })
        })
}
fn timestamp(entry: &Value) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(text(&entry["time"]))
        .ok()
        .map(|t| t.timestamp())
}
pub fn journal_changed(dir: &Path, since: i64) -> Result<bool> {
    Ok(crate::state::journal_entries(dir)?
        .0
        .iter()
        .any(|e| changes_effort(e) && timestamp(e).is_some_and(|t| t > since)))
}

impl Findings {
    pub fn include_checks(
        &mut self,
        doctor: &[(String, String)],
        dir: &Path,
        now: i64,
        complete: bool,
    ) -> Result<()> {
        let invalid = regex::Regex::new("[^A-Za-z0-9_.@-]+")?;
        for (level, message) in doctor {
            if level == "warn" {
                self.notes.push(format!("doctor warn: {message}"));
            }
            if level != "FAIL" {
                continue;
            }
            let subject = invalid.replace_all(message.split(':').next().unwrap_or_default(), "-");
            let subject = subject
                .trim_matches('-')
                .chars()
                .take(60)
                .collect::<String>();
            let subject = if subject.is_empty() {
                "doctor"
            } else {
                &subject
            };
            let id = format!("doctor:{subject}");
            self.faults.entry(id.clone()).or_insert_with(||json!({"id":id,"kind":"doctor","subject":subject,"text":message,"fix":"wg doctor prints the fix","level":"offTrack"}));
        }
        let last = crate::state::journal_entries(dir)?
            .0
            .iter()
            .filter(|e| changes_effort(e))
            .filter_map(timestamp)
            .max();
        if let Some(age) = last
            .map(|t| now - t)
            .filter(|age| *age > 3 * 86400 && !complete)
        {
            self.faults.insert("idle:@effort".into(),json!({"id":"idle:@effort","kind":"idle","subject":"@effort","level":"atRisk","fix":"","text":format!("no journal entry for {} while work is open",super::precheck::duration(age))}));
        }
        Ok(())
    }
}

impl Findings {
    pub fn collect_diagnostics(
        &mut self,
        dir: &Path,
        roots: &[std::path::PathBuf],
        now: i64,
        complete: bool,
        fetch: impl FnOnce(&Value) -> Result<BTreeMap<String, crate::diagnostics::MappedIssue>>,
    ) -> Result<()> {
        let doctor = crate::diagnostics::collect(Some(dir), roots, now, fetch);
        self.include_checks(&doctor, dir, now, complete)
    }
}
