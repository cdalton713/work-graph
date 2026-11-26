//! Blocking, workspace-scoped Linear GraphQL client.
mod command;
mod setup;
pub use command::{Installation, LinearHttp, run_setup};

use crate::{ConfigProvider, Credential, CredentialProvider, HttpTransport};
use graphql_parser::query::{Definition, OperationDefinition, parse_query};
use http::{HeaderMap, Request};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashSet},
    fmt::Display,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub trait Timing {
    fn now(&self) -> f64;
    fn jitter(&self) -> f64;
    fn sleep(&self, delay: Duration);
}

pub struct SystemTiming;
impl Timing for SystemTiming {
    fn now(&self) -> f64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs_f64()
    }
    fn jitter(&self) -> f64 {
        fastrand::f64()
    }
    fn sleep(&self, delay: Duration) {
        std::thread::sleep(delay);
    }
}

pub struct Client<'a, S, H, T> {
    pub settings: S,
    pub rate_limits: BTreeMap<String, String>,
    diagnostic: bool,
    credential: Credential,
    transport: &'a H,
    timing: &'a T,
}

const LIMITS: [&str; 4] = [
    "requests",
    "complexity",
    "endpoint-requests",
    "endpoint-complexity",
];

fn reset_wait(headers: &HeaderMap, now: f64) -> Option<f64> {
    let value = |key: &str| headers.get(key)?.to_str().ok();
    let number = |key: &str| value(key)?.parse::<f64>().ok().filter(|n| n.is_finite());
    let mut wait = number("retry-after").or_else(|| {
        let date = httpdate::parse_http_date(value("retry-after")?).ok()?;
        Some(date.duration_since(UNIX_EPOCH).ok()?.as_secs_f64() - now)
    });
    let cost = number("x-complexity");
    let mut complexity: Option<f64> = None;
    let mut requests = None;
    for limit in LIMITS {
        let prefix = format!("x-ratelimit-{limit}");
        let Some(reset) = number(&format!("{prefix}-reset")) else {
            continue;
        };
        let seconds = (if reset > 1e11 { reset / 1000. } else { reset }) - now;
        if limit == "requests" {
            requests = Some(seconds);
        }
        let Some(remaining) = number(&format!("{prefix}-remaining")) else {
            continue;
        };
        if limit.ends_with("complexity") {
            complexity = Some(complexity.map_or(seconds, |w| w.max(seconds)));
        }
        if remaining <= 0.
            || limit.ends_with("complexity") && cost.is_some_and(|cost| remaining < cost)
        {
            wait = Some(wait.map_or(seconds, |w| w.max(seconds)));
        }
    }
    wait.or(complexity).or(requests).map(|w| w.max(0.))
}

fn read_only(doc: &str) -> bool {
    parse_query::<&str>(doc).is_ok_and(|query| {
        query.definitions.iter().all(|def| {
            !matches!(
                def,
                Definition::Operation(
                    OperationDefinition::Mutation(_) | OperationDefinition::Subscription(_)
                )
            )
        })
    })
}

enum Failure {
    Refused,
    Transient,
    Final,
}

fn classify(body: &Value) -> Failure {
    let Some(errors) = body["errors"].as_array() else {
        return Failure::Final;
    };
    if !errors
        .iter()
        .any(|e| e["extensions"]["code"] == "RATELIMITED")
    {
        return Failure::Final;
    }
    if !body["data"].is_null() || errors.iter().any(|e| !e["path"].is_null()) {
        Failure::Transient
    } else {
        Failure::Refused
    }
}

impl<'a, S, H: HttpTransport, T: Timing> Client<'a, S, H, T>
where
    H::Error: Display,
{
    pub fn connect<C, K>(
        workspace: &str,
        config: &C,
        keys: &K,
        transport: &'a H,
        timing: &'a T,
    ) -> Result<Self, String>
    where
        C: ConfigProvider<Settings = S>,
        K: CredentialProvider,
        C::Error: Display,
        K::Error: Display,
    {
        let settings = config.resolve(workspace).map_err(|e| e.to_string())?;
        let credential = keys
            .credential(workspace, "linear")
            .map_err(|e| e.to_string())?
            .ok_or_else(|| {
                format!(
                    "no Linear key for {workspace}: set {}",
                    command::key_env(workspace)
                )
            })?;
        Ok(Self {
            settings,
            diagnostic: false,
            credential,
            transport,
            timing,
            rate_limits: BTreeMap::new(),
        })
    }

    pub(crate) fn for_diagnostics(mut self) -> Self {
        self.diagnostic = true;
        self
    }

    pub fn request(&mut self, doc: &str, variables: Value) -> Result<Value, String> {
        let payload = json!({"query":doc,"variables":variables}).to_string();
        let read = read_only(doc);
        for attempt in 1..=4 {
            let req = Request::post("https://api.linear.app/graphql")
                .header("authorization", self.credential.clone().into_header())
                .header("content-type", "application/json")
                .body(payload.as_bytes().to_vec())
                .map_err(|e| e.to_string())?;
            let (kind, message, wait) = match self.transport.send(req) {
                Err(e) => (
                    Failure::Transient,
                    format!("Linear request failed: {e}"),
                    None,
                ),
                Ok(response) => {
                    let status = response.status().as_u16();
                    for limit in LIMITS {
                        for part in ["limit", "remaining", "reset"] {
                            let key = format!("{limit}-{part}");
                            if let Some(value) = response
                                .headers()
                                .get(format!("x-ratelimit-{key}"))
                                .and_then(|h| h.to_str().ok())
                            {
                                self.rate_limits.insert(key, value.into());
                            }
                        }
                    }
                    let wait = reset_wait(response.headers(), self.timing.now());
                    let bytes = response.body();
                    if !(200..300).contains(&status) {
                        let kind = match status {
                            429 => Failure::Refused,
                            500..=599 => Failure::Transient,
                            _ => classify(
                                &serde_json::from_slice(&bytes[..bytes.len().min(65536)])
                                    .unwrap_or(Value::Null),
                            ),
                        };
                        let detail = String::from_utf8_lossy(&bytes[..bytes.len().min(500)]);
                        (
                            kind,
                            if self.diagnostic {
                                format!("Linear HTTP {status}")
                            } else {
                                format!("Linear HTTP {status}: {detail}")
                            },
                            wait,
                        )
                    } else {
                        let mut body: Value = serde_json::from_slice(bytes)
                            .map_err(|e| format!("Invalid Linear response: {e}"))?;
                        if body["errors"].as_array().is_none_or(Vec::is_empty) {
                            return body
                                .get_mut("data")
                                .map(Value::take)
                                .ok_or_else(|| "Linear response has no data".into());
                        }
                        let detail: String = body["errors"].to_string().chars().take(800).collect();
                        (
                            classify(&body),
                            if self.diagnostic {
                                "Linear query failed".into()
                            } else {
                                format!("Linear error: {detail}")
                            },
                            wait,
                        )
                    }
                }
            };
            let tries = if attempt == 1 {
                "after 1 try".into()
            } else {
                format!("after {attempt} tries")
            };
            if matches!(kind, Failure::Final) || matches!(kind, Failure::Transient) && !read {
                return Err(format!("{message} ({tries})"));
            }
            let delay = match (kind, wait) {
                (Failure::Refused, Some(w)) if w > 60. => {
                    return Err(format!(
                        "{message} ({tries}; Linear accepts it again in {w:.0} s)"
                    ));
                }
                (Failure::Refused, Some(w)) => w + self.timing.jitter(),
                _ => 2f64.powi(attempt - 1) * (0.5 + self.timing.jitter()),
            };
            if attempt == 4 {
                return Err(format!("{message} ({tries})"));
            }
            let reason = message.split_whitespace().collect::<Vec<_>>().join(" ");
            eprintln!(
                "warn linear: {}; try {} of 4 in {delay:.1} s",
                reason.chars().take(200).collect::<String>(),
                attempt + 1
            );
            self.timing.sleep(Duration::from_secs_f64(delay));
        }
        unreachable!()
    }

    /// Read a connection at a JSON pointer, passing each end cursor as $after.
    pub fn pages(
        &mut self,
        doc: &str,
        mut variables: Value,
        pointer: &str,
    ) -> Result<Vec<Value>, String> {
        let mut rows = Vec::new();
        let mut seen = HashSet::new();
        variables["after"] = Value::Null;
        loop {
            let data = self.request(doc, variables.clone())?;
            let page = data.pointer(pointer).ok_or("missing Linear connection")?;
            rows.extend(
                page["nodes"]
                    .as_array()
                    .ok_or("missing Linear nodes")?
                    .iter()
                    .cloned(),
            );
            if !page["pageInfo"]["hasNextPage"]
                .as_bool()
                .ok_or("missing Linear page info")?
            {
                return Ok(rows);
            }
            let cursor = page["pageInfo"]["endCursor"]
                .as_str()
                .ok_or("missing Linear end cursor")?;
            if !seen.insert(cursor.to_owned()) {
                return Err("repeated Linear end cursor".into());
            }
            variables["after"] = json!(cursor);
        }
    }
}
