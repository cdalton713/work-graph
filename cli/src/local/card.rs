use super::*;
use serde_json::json;
use sha2::{Digest, Sha256};

/// Implementations must surface ambiguous mutation failures without replaying a create.
pub trait CardWriter {
    fn write(&mut self, issue: &str, previous_id: Option<&str>, body: &str) -> io::Result<String>;
}
pub(super) fn refresh(
    n: &Value,
    entry: &mut Value,
    row: &Value,
    writer: &mut dyn CardWriter,
) -> io::Result<()> {
    let mut data = json!({"wg":1});
    let mut marker = format!("\x60{}\x60", text(n, "key"));
    for f in ["key", "kind", "phase", "lane", "role"] {
        if !n[f].is_null() && n[f] != "" {
            let s = val(&n[f]);
            if f != "key" {
                marker += &format!(" · {f} \x60{s}\x60")
            };
            data[f] = s.into();
        }
    }
    let mut parts = vec![format!("**work-graph node card** {marker}")];
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
    for f in [
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
    ] {
        if !view[f].is_null() && view[f] != "" {
            data[f] = view[f].clone()
        }
    }
    parts.push(format!(
        "\x60\x60\x60json\n{}\n\x60\x60\x60",
        compact(&data)
    ));
    parts.push(
        "Generated from plan.json by \x60wg load\x60. Change plan.json, not this comment.".into(),
    );
    let body = parts.join("\n\n");
    let sha = format!("{:x}", Sha256::digest(body.as_bytes()));
    if entry["card"]["sha"] != sha {
        let id = writer.write(text(entry, "id"), entry["card"]["id"].as_str(), &body)?;
        entry["card"] = json!({"id":id,"sha":sha});
    }
    Ok(())
}
