use super::*;
use crate::{
    ConfigProvider,
    linear::Installation,
    page::{DiagnosticPage, link::Link, page_credential},
    providers::PageSettings,
    workflow,
};
use serde_json::json;
use sha2::{Digest, Sha256};

fn checked(name: &str, check: impl FnOnce() -> Result<String>) -> (String, String) {
    match check() {
        Ok(value) => line("ok", format!("{name}: {value}")),
        Err(e) => failure(name, e),
    }
}

pub(super) fn inspect(dir: Option<&Path>, config: &state::Config) -> Result<Lines> {
    let install = Installation::load()?;
    let plan = dir.map(|p| config.load_plan(p)).transpose()?;
    let km = dir.map(state::load_keymap).transpose()?.unwrap_or_default();
    let mut lines = vec![];
    let default = install.workspaces()[0]["id"]
        .as_str()
        .ok_or("missing workspace")?;
    let effort_scope = plan
        .as_ref()
        .and_then(|p| p["effort"]["workspace"].as_str());
    let scope = effort_scope.unwrap_or(default);
    let mut settings = PageSettings(&install).resolve(scope)?;
    let default_page = "http://127.0.0.1:4747";
    settings.page.get_or_insert_with(|| default_page.into());
    let configured = settings.page.as_deref().unwrap_or(default_page);
    let base = std::env::var("WG_UI_URL").unwrap_or_else(|_| configured.into());
    for row in install.workspaces() {
        let id = row["id"].as_str().ok_or("missing workspace")?;
        lines.push(checked(&format!("key {id}"), || {
            let mut api = workflow::client(&install, &json!({"effort":{"workspace":id}}))?;
            api.request("{ viewer { id } }", json!({}))?;
            Ok("accepted".into())
        }));
    }
    lines.push(checked("page", || {
        let page = DiagnosticPage::new(&install, scope, &base, false)?;
        if page.read("/healthz", None)?["ok"] != true {
            return Err("health check failed".into());
        }
        let expected = format!(
            "{:x}",
            Sha256::digest(include_bytes!("../../../skills/work-graph/contract.json"))
        );
        if page.read("/api/config", None)?["contract"] != expected[..12] {
            return Err("page contract differs; deploy the matching page".into());
        }
        Ok(format!("contract {}", &expected[..12]))
    }));
    let collab = &km["collab"];
    let membership = collab["workspace"].as_str();
    let shared = membership.is_some_and(|id| id.starts_with("shared:"));
    let mut verified = BTreeSet::new();
    for row in install.workspaces() {
        let id = row["id"].as_str().ok_or("missing workspace")?;
        let settings = PageSettings(&install).resolve(id)?;
        let url = settings.page.as_deref().unwrap_or(default_page);
        if verified.insert(url.to_owned()) {
            lines.push(checked(&format!("link token for {url}"), || {
                let mut page = DiagnosticPage::new(&install, id, url, false)?;
                Ok(if page.verified_account()?.is_some() {
                    "accepted"
                } else {
                    "no token"
                }
                .into())
            }));
        }
        if dir.is_some() && id != scope {
            continue;
        }
        for channel in config.settings()["notify"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|c| c["type"] == "page")
        {
            let name = format!("page notices for {id}");
            let url = collab["page"].as_str().unwrap_or(url);
            let result = (|| -> Result<(String, String)> {
                let page = DiagnosticPage::new(&install, id, url, shared)?;
                if !page.authenticated() {
                    return Ok(line(
                        if dir.is_none() { "warn" } else { "FAIL" },
                        format!("{name}: no token"),
                    ));
                }
                let mut path = "/api/push/status".to_string();
                if let Some(to) = channel["to"].as_str() {
                    path.push('?');
                    path.push_str(
                        &url::form_urlencoded::Serializer::new(String::new())
                            .append_pair("recipient", to)
                            .finish(),
                    );
                }
                let result = page.read(&path, membership)?;
                let enabled = result["enabled"]
                    .as_bool()
                    .ok_or("invalid status response")?;
                let devices = result["devices"]
                    .as_i64()
                    .ok_or("invalid status response")?;
                if !enabled {
                    return Err("push is not set up".into());
                }
                if devices < 1 {
                    return Err("register a device on the page".into());
                }
                Ok(line(
                    "ok",
                    format!("{name}: {devices} registered device(s)"),
                ))
            })();
            lines.push(result.unwrap_or_else(|e| failure(&name, e)));
        }
    }
    if let Some(plan) = &plan {
        if std::env::var("WG_LINK")
            .is_ok_and(|s| matches!(s.to_lowercase().as_str(), "off" | "no" | "0"))
        {
            lines.push(line("warn", "link: WG_LINK is off"));
        } else {
            lines.push(checked("link", || {
                let page = if shared {
                    collab["page"]
                        .as_str()
                        .ok_or("shared project has no page")?
                } else {
                    &base
                };
                let token = page_credential(&settings, page, scope, shared, &install)?;
                let project = km["project"]["id"].as_str().ok_or("missing project id")?;
                Link::new(
                    &settings,
                    page,
                    membership.unwrap_or(scope),
                    project,
                    "",
                    Value::Null,
                    token,
                )?
                .probe()?;
                Ok("accepts a connection (the connection only; no hello sent)".into())
            }));
        }
        if membership.is_some() {
            let result = (|| -> Result<String> {
                let claims =
                    workflow::current_claims(&install, plan, &km)?.ok_or("no current claims")?;
                let mine = claims["claims"]
                    .as_array()
                    .ok_or("invalid claims")?
                    .iter()
                    .filter(|c| c["mine"] == true)
                    .collect::<Vec<_>>();
                let matches = if mine.is_empty() {
                    let url = collab["page"].as_str().unwrap_or(configured);
                    DiagnosticPage::new(&install, scope, url, shared)?.read("/api/status", None)?["human"]
                        == settings.human
                } else {
                    mine.iter().all(|c| c["holder"] == settings.human)
                };
                if !matches {
                    return Err("page account differs from config human".into());
                }
                Ok(format!(
                    "collaboration human: {} matches the page",
                    settings.human
                ))
            })();
            lines.push(match result {
                Ok(msg) => line("ok", msg),
                Err(e) => failure("collaboration human", e),
            });
        }
    }
    Ok(lines)
}
