use super::*;
use crate::page::DEFAULT_PAGE;
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

#[derive(Default)]
pub(super) struct Hosted {
    pub keys: Lines,
    pub page: Lines,
    pub effort: Lines,
}

fn key(install: &Installation, id: &str, team: Option<&str>) -> Result<Lines> {
    let source = install.diagnostic_key_source(id)?;
    let mut api = workflow::client(install, &json!({"effort":{"workspace":id}}))?.for_diagnostics();
    api.request("{ viewer { id } }", json!({}))?;
    let mut budgets = vec![];
    for name in ["requests", "complexity"] {
        if let Some(left) = api
            .rate_limits
            .get(&format!("{name}-remaining"))
            .and_then(|v| v.parse::<u64>().ok())
        {
            let limit = api
                .rate_limits
                .get(&format!("{name}-limit"))
                .and_then(|v| v.parse::<u64>().ok())
                .map(|v| v.to_string())
                .unwrap_or("?".into());
            budgets.push(format!("{name} {left}/{limit}"));
        }
    }
    let budget = if budgets.is_empty() {
        "no budget headers".into()
    } else {
        format!("{} left", budgets.join(", "))
    };
    let mut lines = vec![line(
        "ok",
        format!("key {id}: accepted ({source}); {budget}"),
    )];
    if let Some(team) = team {
        let mut checks = vec![];
        if let Err(e) = crate::integration::team_checks(
            &mut api,
            team,
            text(&install.config.settings()["human"]),
            "wg setup",
            &mut checks,
        ) {
            lines.push(line(
                "warn",
                format!("{team} could not check the workflow. Run wg setup. {e}"),
            ));
        } else {
            lines.extend(checks.into_iter().map(|(level, msg)| {
                line(
                    if level == "FAIL" { "warn" } else { &level },
                    msg.strip_prefix("linear: ").unwrap_or(&msg),
                )
            }));
        }
    }
    Ok(lines)
}

pub(super) fn inspect(
    dir: Option<&Path>,
    plan: Option<&Value>,
    install: &Installation,
) -> Result<Hosted> {
    let config = &install.config;
    let km = dir
        .filter(|_| plan.is_some())
        .map(state::load_keymap)
        .transpose()?
        .unwrap_or_default();
    let default = install.workspaces()[0]["id"]
        .as_str()
        .ok_or("missing workspace")?;
    let effort_scope = plan.map(|p| p["effort"]["workspace"].as_str().unwrap_or(default));
    let scope = effort_scope.unwrap_or(default);
    let mut settings = PageSettings(install).resolve(scope)?;
    settings.page.get_or_insert_with(|| DEFAULT_PAGE.into());
    let top = config.settings()["page_url"]
        .as_str()
        .unwrap_or(DEFAULT_PAGE)
        .trim_end_matches('/');
    let configured = if effort_scope.is_some() {
        settings.page.as_deref().unwrap_or(top)
    } else {
        top
    };
    let base = std::env::var("WG_UI_URL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or(configured.into());
    let base = base.trim_end_matches('/');
    let mut hosted = Hosted::default();
    for row in install.workspaces() {
        let id = row["id"].as_str().ok_or("missing workspace")?;
        let team = plan
            .filter(|_| Some(id) == effort_scope)
            .and_then(|p| p["effort"]["team"].as_str())
            .or_else(|| row["team"].as_str());
        hosted.keys.extend(
            key(install, id, team).unwrap_or_else(|e| vec![failure(&format!("key {id}"), e)]),
        );
    }
    let page_result = (|| -> Result<(String, String)> {
        let page = if effort_scope.is_some() {
            DiagnosticPage::new(install, scope, base, false)?
        } else {
            DiagnosticPage::top_level(install, base)?
        };
        if page.read("/healthz", None)?["ok"] != true {
            return Ok(line(
                "FAIL",
                format!("page: {base}/healthz did not answer ok"),
            ));
        }
        let expected = format!(
            "{:x}",
            Sha256::digest(include_bytes!("../../../skills/work-graph/contract.json"))
        );
        let ours = &expected[..12];
        let config = page.read("/api/config", None)?;
        if config["contract"] != ours {
            return Ok(line(
                "FAIL",
                format!(
                    "page contract: deploy the page (the server has {}, wg has {ours})",
                    page.safe_field(&config["contract"])
                ),
            ));
        }
        Ok(line("ok", format!("page: {base}, contract {ours}")))
    })();
    let (level, mut message) = page_result.unwrap_or_else(|e| failure("page", e));
    if dir.is_some() && plan.is_none() {
        let dest = if std::env::var("WG_UI_URL").is_ok_and(|v| !v.is_empty()) {
            "the WG_UI_URL override"
        } else {
            "the top-level page"
        };
        message.push_str(&format!(" (plan unavailable, checking {dest})"));
    }
    let lines = &mut hosted.page;
    lines.push((level, message));
    let collab = &km["collab"];
    let membership = collab["workspace"].as_str();
    let shared = membership.is_some_and(|id| id.starts_with("shared:"));
    let mut verified = BTreeSet::new();
    for row in install.workspaces() {
        let id = row["id"].as_str().ok_or("missing workspace")?;
        let settings = PageSettings(install).resolve(id)?;
        let url = settings.page.as_deref().unwrap_or(DEFAULT_PAGE);
        if verified.insert(url.to_owned()) {
            lines.push(checked(&format!("link token for {url}"), || {
                let mut page = DiagnosticPage::new(install, id, url, false)?;
                Ok(if page.verified_account()?.is_some() {
                    "accepted"
                } else {
                    "no token"
                }
                .into())
            }));
        }
    }
    if config.settings()["page_url"].is_string() && verified.insert(top.into()) {
        lines.push(checked(&format!("link token for {top}"), || {
            let mut page = DiagnosticPage::top_level(install, top)?;
            Ok(if page.verified_account()?.is_some() {
                "accepted"
            } else {
                "no token"
            }
            .into())
        }));
    }
    for row in install.workspaces() {
        let id = row["id"].as_str().ok_or("missing workspace")?;
        let settings = PageSettings(install).resolve(id)?;
        let url = settings.page.as_deref().unwrap_or(DEFAULT_PAGE);
        if effort_scope.is_some_and(|scope| id != scope) {
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
                let page = DiagnosticPage::new(install, id, url, shared)?;
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
    if let Some(plan) = plan {
        let lines = &mut hosted.effort;
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
                    base
                };
                let token = page_credential(&settings, page, scope, shared, install)?;
                let project = km["project"]["id"]
                    .as_str()
                    .or_else(|| plan["effort"]["name"].as_str())
                    .ok_or("missing project id")?;
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
                let url = page.replacen("http", "ws", 1);
                Ok(format!(
                    "{}/api/link accepts a connection (the connection only; no hello sent)",
                    url.trim_end_matches('/')
                ))
            }));
        }
        if membership.is_some() {
            let result = (|| -> Result<(String, String)> {
                let page = DiagnosticPage::new(
                    install,
                    scope,
                    collab["page"].as_str().unwrap_or(configured),
                    shared,
                )?;
                let claims = workflow::current_claims(install, plan, &km)
                    .map_err(|e| {
                        e.replacen("the page answered HTTP", "the claims page answered HTTP", 1)
                    })?
                    .ok_or("no current claims")?;
                let mut names = claims["claims"]
                    .as_array()
                    .ok_or("invalid claims")?
                    .iter()
                    .filter(|c| c["mine"] == true)
                    .map(|c| page.safe_field(&c["holder"]))
                    .collect::<BTreeSet<_>>();
                if names.is_empty() {
                    let status = page.read("/api/status", None)?;
                    if status["human"].as_str().is_none_or(str::is_empty) {
                        return Ok(line(
                            "warn",
                            "collaboration human: page status has no account name and this account has no claims",
                        ));
                    }
                    names.insert(page.safe_field(&status["human"]));
                }
                if let Some(name) = names.iter().find(|n| *n != &settings.human) {
                    return Ok(line(
                        "FAIL",
                        format!(
                            "collaboration human: page name '{name}' differs from config human '{}'",
                            settings.human
                        ),
                    ));
                }
                Ok(line(
                    "ok",
                    format!("collaboration human: {} matches the page", settings.human),
                ))
            })();
            lines
                .push(result.unwrap_or_else(|e| line("warn", format!("collaboration human: {e}"))));
        }
    }
    Ok(hosted)
}
