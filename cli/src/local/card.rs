use super::*;
use serde_json::json;
use sha2::{Digest, Sha256};

/// Implementations must surface ambiguous mutation failures without replaying a create.
pub trait CardWriter {
    fn write(&mut self, issue: &str, previous_id: Option<&str>, body: &str) -> io::Result<String>;
}
pub(super) const PLAN_FIELDS: [&str; 5] = ["key", "kind", "phase", "lane", "role"];
pub(super) const RUN_FIELDS: [&str; 11] = [
    "branch",
    "pr",
    "review",
    "merge_review",
    "state",
    "job",
    "started_at",
    "soak_until",
    "code_done",
    "wave",
    "next",
];
pub(super) const PREFIX: &str = "**work-graph node card**";
pub(super) const FOOTER: &str =
    "Generated from plan.json by \x60wg load\x60. Change plan.json, not this comment.";

pub(super) fn render(n: &Value, entry: &Value, row: &Value) -> (Value, String) {
    let mut data = json!({"wg":1});
    let mut marker = format!("\x60{}\x60", val(&n["key"]));
    for f in PLAN_FIELDS {
        if f != "key" && (matches!(f, "kind" | "phase") || truth(&n[f])) {
            marker += &format!(" · {f} \x60{}\x60", val(&n[f]));
        }
        if truth(&n[f]) {
            data[f] = val(&n[f]).into();
        }
    }
    let mut parts = vec![format!("{PREFIX} {marker}")];
    if let Some(a) = n["acceptance"].as_str().filter(|a| !a.is_empty()) {
        parts.push(format!("**Acceptance**\n\n{a}"));
    }
    let mut files = vec![];
    for f in ["owns", "shares"] {
        for g in list(&n[f]) {
            files.push(format!(
                "- {f} \x60{}\x60{}",
                val(g),
                if f == "shares" {
                    " (additive only)"
                } else {
                    ""
                }
            ));
        }
    }
    if !files.is_empty() {
        parts.push(format!("**Files**\n\n{}", files.join("\n")))
    }
    let mut view = row.clone();
    if !text(row, "code_done_head").is_empty() {
        view["code_done"] = "yes".into()
    }
    if !matches!(text(row, "state"), "starting" | "running" | "creating")
        && let Some(o) = view.as_object_mut()
    {
        o.shift_remove("job");
        o.shift_remove("started_at");
    }
    if let Some(published) = entry["published"].as_object() {
        for (k, v) in published {
            view[k] = v.clone();
        }
    }
    for f in RUN_FIELDS {
        if truth(&view[f]) {
            data[f] = view[f].clone()
        }
    }
    parts.push(format!(
        "\x60\x60\x60json\n{}\n\x60\x60\x60",
        compact(&data)
    ));
    parts.push(FOOTER.into());
    (data, parts.join("\n\n"))
}
pub(super) fn refresh(
    n: &Value,
    entry: &mut Value,
    row: &Value,
    writer: &mut dyn CardWriter,
) -> io::Result<()> {
    let (_, body) = render(n, entry, row);
    let sha = format!("{:x}", Sha256::digest(body.as_bytes()));
    if entry["card"]["sha"] != sha {
        let id = writer.write(text(entry, "id"), entry["card"]["id"].as_str(), &body)?;
        entry["card"] = json!({"id":id,"sha":sha});
    }
    Ok(())
}
