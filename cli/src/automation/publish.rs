//! Project status document and node cards published by next and the scheduled refresh.
use super::{actions::Actions, machine::*, production::Effort};
use crate::{
    ConfigProvider,
    providers::PageSettings,
    state::{self, PlanLock},
};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub(super) fn url(e: &Effort) -> Result<String> {
    let scope = e.scope()?;
    let page = std::env::var("WG_UI_URL")
        .ok()
        .or(PageSettings(e.install).resolve(scope)?.page)
        .unwrap_or_else(|| "http://127.0.0.1:4747".into());
    let mut query = url::form_urlencoded::Serializer::new(String::new());
    query.append_pair("project", text(&e.plan["effort"]["name"]));
    if e.install.workspaces()[0]["id"] != scope {
        query.append_pair("workspace", scope);
    }
    Ok(format!(
        "{}/?{}",
        page.trim_end_matches('/'),
        query.finish().replace('+', "%20")
    ))
}
pub(super) fn messages(a: &Actions) -> Vec<Value> {
    a.lines
        .iter()
        .map(|(level, text)| json!({"level":level,"text":text}))
        .collect()
}
// Python's status digest used ASCII JSON with spaces after commas and colons.
fn document_json(value: &Value) -> Result<String> {
    let mut bytes = Vec::new();
    state::write_pretty_json(&mut bytes, value)?;
    let pretty = String::from_utf8(bytes)?;
    let mut out = String::new();
    for line in pretty.lines() {
        if out.ends_with(',') {
            out.push(' ');
        }
        out.push_str(line.trim_start());
    }
    Ok(out)
}
fn data_block(content: &str) -> Option<Value> {
    let block = content.split_once("```json\n")?.1.split_once("\n```")?.0;
    serde_json::from_str(block).ok()
}
pub(super) fn publish(
    e: &Effort,
    a: &Actions,
    interval: Option<f64>,
    scheduled: bool,
) -> Result<Option<String>> {
    let guard = PlanLock::acquire(e.dir, None)?;
    let mut km = state::load_keymap(e.dir)?;
    if scheduled && (e.km != km || e.install.config.load_plan(e.dir)? != e.plan) {
        return Ok(Some("inputs changed".into()));
    }
    let mut client = e.linear()?;
    let doc = km["status_doc"].clone();
    let now = Utc::now();
    if scheduled && let Some(id) = doc["id"].as_str() {
        let d = client.request(
            "query($id:String!){document(id:$id){content}}",
            json!({"id":id}),
        )?;
        if let Some(v) = data_block(text(&d["document"]["content"]))
            && let Some(interval) = v["wait_interval"].as_f64().filter(|s| *s > 0.)
            && let Ok(ran) = DateTime::parse_from_rfc3339(text(&v["ran"]))
            && ((now - ran.to_utc()).num_milliseconds() as f64) < 2000. * interval
        {
            return Ok(Some("coordinator listening".into()));
        }
    }
    let report = e.install.config.report(None)?;
    let wave: Vec<_> = text(&km["run"]["effort"]["wave"])
        .split(',')
        .filter(|key| !key.is_empty())
        .map(str::to_owned)
        .collect();
    let mut writer = crate::providers::LinearCards::new(e.scope()?, &report);
    for node in e.plan["nodes"].as_array().ok_or("missing nodes")? {
        let key = text(&node["key"]);
        let row = km["run"]["nodes"][key].clone();
        let Some(entry) = km["nodes"].get_mut(key) else {
            continue;
        };
        let mut want = json!({});
        if wave.iter().any(|k| k == key) {
            want["wave"] = json!("yes")
        }
        let mut said = vec![];
        for (level, line) in &a.lines {
            let Some((verb, rest)) = line.split_once(' ') else {
                continue;
            };
            if let Some(rest) = rest.strip_prefix(key).and_then(|s| s.strip_prefix(' ')) {
                let detail = rest
                    .split_once(": ")
                    .map(|(_, s)| format!(": {s}"))
                    .unwrap_or_default();
                said.push(format!("{level} {verb}{detail}"));
            }
        }
        if !said.is_empty() {
            want["next"] = json!(said.join("\n"))
        }
        if entry["published"]
            .as_object()
            .is_some_and(|m| !m.is_empty())
            || want != json!({})
        {
            entry["published"] = want;
        }
        let before = e.km["nodes"][key].clone();
        crate::local::refresh_card(node, entry, &row, &mut writer)?;
        if *entry != before {
            crate::page::save_run_keymap(e.dir, &guard, &e.plan, &mut km)?;
        }
    }
    let body = std::iter::once(a.head.clone())
        .chain(std::iter::once(String::new()))
        .chain(a.lines.iter().map(|(l, t)| format!("- `{l}` {t}")))
        .collect::<Vec<_>>()
        .join("\n")
        .trim_end()
        .to_string();
    let mut data = json!({"wg":1,"status":a.head,"wave":wave,"lines":messages(a)});
    let stable = format!("{body}\n\n```json\n{}\n```", document_json(&data)?);
    let sha = format!("{:x}", Sha256::digest(stable));
    let ran = now.format("%Y-%m-%dT%H:%M:%SZ").to_string();
    let at = if doc["sha"] == sha {
        doc["at"].as_str().unwrap_or(&ran)
    } else {
        &ran
    };
    let contract = format!(
        "{:x}",
        Sha256::digest(include_bytes!("../../../skills/work-graph/contract.json"))
    );
    data["at"] = json!(at);
    data["ran"] = json!(ran);
    data["contract"] = json!(&contract[..12]);
    if let Some(i) = interval {
        data["wait_interval"] = json!(i)
    }
    // The agents of this effort (effort.agents in plan.json), for the Agents picker of the page.
    if e.plan["effort"]["agents"]
        .as_object()
        .is_some_and(|a| !a.is_empty())
    {
        data["agents"] = e.plan["effort"]["agents"].clone();
    }
    let data = document_json(&data)?;
    let content = format!(
        "{body}\n\n```json\n{data}\n```\n\nWritten by `wg next` for the page ({}). Do not edit.",
        url(e)?
    );
    let id = if let Some(id) = doc["id"].as_str() {
        let result=client.request("mutation($id:String!,$i:DocumentUpdateInput!){documentUpdate(id:$id,input:$i){success}}",json!({"id":id,"i":{"content":content}}))?;
        if result["documentUpdate"]["success"] != true {
            return Err("could not update the status document".into());
        }
        id.to_owned()
    } else {
        let result = client.request(
            "mutation($i:DocumentCreateInput!){documentCreate(input:$i){success document{id}}}",
            json!({"i":{"title":"work-graph status","content":content,"projectId":e.project()?}}),
        )?;
        if result["documentCreate"]["success"] == false {
            return Err("could not create the status document".into());
        }
        result["documentCreate"]["document"]["id"]
            .as_str()
            .ok_or("could not create the status document")?
            .to_owned()
    };
    km["status_doc"] = json!({"id":id,"sha":sha,"at":at});
    crate::page::save_run_keymap(e.dir, &guard, &e.plan, &mut km)?;
    Ok(None)
}
