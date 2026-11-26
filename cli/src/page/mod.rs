//! Hosted page commands. The caller supplies installation settings and the collaboration stores.
mod auth;
mod collaboration;
pub mod link;
pub use auth::page_credential;

use crate::{ConfigProvider, CredentialProvider};
use clap::{Parser, Subcommand};
pub use collaboration::{Collaboration, LocalEffort, LockedEffort, ProjectAccess};
use http::HeaderValue;
use reqwest::blocking::Client;
use serde_json::Value;
use std::{path::PathBuf, time::Duration};
use url::Url;

#[derive(Default, Debug)]
pub struct Output {
    pub stdout: String,
    pub stderr: String,
    pub status: u8,
}
impl Output {
    pub fn success(stdout: String) -> Self {
        Self {
            stdout,
            ..Self::default()
        }
    }
}
pub type Result<T> = std::result::Result<T, String>;

#[derive(Clone)]
pub struct Settings {
    pub page: Option<String>,
    pub human: String,
    pub token_directory: PathBuf,
    pub workspaces: Vec<(String, String, Option<String>)>,
}

#[derive(Parser)]
#[command(name = "wg-preview", infer_long_args = true)]
struct Arguments {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Login {
        page_url: Option<String>,
        #[arg(long)]
        workspace: Option<String>,
        #[arg(long)]
        token_stdin: bool,
    },
    Logout {
        page_url: Option<String>,
    },
    Join {
        page_url: Option<String>,
        #[arg(long)]
        project: Option<String>,
        #[arg(long, default_value = ".")]
        repo: PathBuf,
    },
    Leave {
        dir: PathBuf,
    },
    Share {
        dir: PathBuf,
    },
    Pull {
        dir: PathBuf,
        #[arg(long)]
        force: bool,
        #[arg(long)]
        accept_settings: bool,
    },
}

fn http_builder() -> Result<reqwest::ClientBuilder> {
    let mut builder = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none());
    if let Some(path) = std::env::var_os("SSL_CERT_FILE").filter(|p| !p.is_empty()) {
        let pem = std::fs::read(path).map_err(|_| "cannot read SSL_CERT_FILE")?;
        let roots =
            reqwest::Certificate::from_pem_bundle(&pem).map_err(|_| "invalid SSL_CERT_FILE")?;
        if roots.is_empty() {
            return Err("no certificates in SSL_CERT_FILE".into());
        }
        builder = builder.tls_built_in_root_certs(false);
        for root in roots {
            builder = builder.add_root_certificate(root);
        }
    }
    Ok(builder)
}

struct Page {
    url: Url,
    token: Option<HeaderValue>,
    http: Client,
}
impl Page {
    fn new(settings: &Settings, explicit: Option<&str>) -> Result<Self> {
        let raw = explicit
            .or(settings.page.as_deref())
            .ok_or("give the page URL")?
            .trim_end_matches('/');
        let url = auth::validated_url(raw, settings)?;
        let http = reqwest::blocking::ClientBuilder::from(http_builder()?)
            .timeout(Duration::from_secs(10))
            .build()
            .map_err(|_| "cannot initialize page transport")?;
        Ok(Self {
            url,
            http,
            token: None,
        })
    }
    fn request(&self, method: reqwest::Method, path: &str) -> reqwest::blocking::RequestBuilder {
        let mut req = self.http.request(
            method,
            format!("{}{path}", self.url.as_str().trim_end_matches('/')),
        );
        if let Some(token) = &self.token {
            req = req.header("Authorization", token);
        }
        req
    }
}

fn response(req: reqwest::blocking::RequestBuilder) -> Result<(u16, Vec<u8>)> {
    let res = req.send().map_err(|_| "the page did not answer")?;
    let status = res.status().as_u16();
    let bytes = res.bytes().map_err(|_| "cannot read the page response")?;
    Ok((status, bytes.to_vec()))
}
fn retry_delay(headers: &http::HeaderMap) -> Duration {
    let delay = headers
        .get("Retry-After")
        .and_then(|s| s.to_str().ok())
        .and_then(|s| {
            s.parse::<i64>().ok().map(|n| n.max(0) as u64).or_else(|| {
                httpdate::parse_http_date(s).ok().map(|date| {
                    date.duration_since(std::time::SystemTime::now())
                        .unwrap_or_default()
                        .as_secs()
                })
            })
        })
        .unwrap_or(1);
    Duration::from_secs(delay.min(5))
}
fn token_response(page: &Page, path: &str) -> Result<(u16, Vec<u8>)> {
    for attempt in 0..4 {
        let r = page
            .request(reqwest::Method::GET, path)
            .send()
            .map_err(|_| "the page did not answer")?;
        if attempt < 3 && r.status().as_u16() == 503 {
            let pause = retry_delay(r.headers());
            drop(r);
            std::thread::sleep(pause);
            continue;
        }
        return Ok((
            r.status().as_u16(),
            r.bytes().map_err(|_| "cannot read page response")?.to_vec(),
        ));
    }
    unreachable!()
}
fn token_json(page: &Page, path: &str) -> Result<Value> {
    let (status, bytes) = token_response(page, path)?;
    check(status)?;
    serde_json::from_slice(&bytes).map_err(|_| "invalid token check response".into())
}
fn check(status: u16) -> Result<()> {
    match status {
        200..=299 => Ok(()),
        401 | 403 => Err(format!("the page refused the token (HTTP {status})")),
        412 => Err("plan version conflict (HTTP 412)".into()),
        _ => Err(format!("the page answered HTTP {status}")),
    }
}
fn json_response(req: reqwest::blocking::RequestBuilder) -> Result<Value> {
    let (status, bytes) = response(req)?;
    check(status)?;
    serde_json::from_slice(&bytes).map_err(|_| "the page returned invalid JSON".into())
}

/// Parse the same arguments as the executable. An empty workspace selects the configured default.
/// Credential service "page" refers only to the resolved workspace page.
pub fn run<C, K>(
    args: &[String],
    config: &C,
    credentials: &K,
    stores: Option<&dyn Collaboration>,
) -> Result<Output>
where
    C: ConfigProvider<Settings = Settings, Error = String>,
    K: CredentialProvider<Error = String>,
{
    if args
        .first()
        .is_some_and(|s| matches!(s.as_str(), "join" | "leave"))
        && args.iter().skip(1).any(|arg| {
            let value = if arg.starts_with("--") {
                arg.split_once('=').map_or(arg.as_str(), |(_, v)| v)
            } else {
                arg
            };
            let path = value.split(['?', '#']).next().unwrap_or("");
            percent_encoding::percent_decode_str(path)
                .decode_utf8_lossy()
                .to_lowercase()
                .contains("/join/")
        })
    {
        return Err("Open the collab link in a browser. Give wg join the page URL.".into());
    }
    let cmd = match Arguments::try_parse_from(
        std::iter::once("wg-preview").chain(args.iter().map(String::as_str)),
    ) {
        Ok(parsed) => parsed.command,
        Err(e) if e.kind() == clap::error::ErrorKind::DisplayHelp => {
            return Ok(Output::success(e.to_string()));
        }
        Err(e) => return Err(e.to_string()),
    };
    let workspace = match &cmd {
        Command::Login { workspace, .. } => workspace.as_deref().unwrap_or(""),
        _ => "",
    };
    let settings = config.resolve(workspace)?;
    match cmd {
        Command::Login {
            page_url,
            token_stdin,
            ..
        } => auth::login(&settings, page_url.as_deref(), token_stdin).map(Output::success),
        Command::Logout { page_url } => {
            auth::logout(&settings, page_url.as_deref()).map(Output::success)
        }
        command => collaboration::run(
            command,
            config,
            credentials,
            stores.ok_or("the collaboration providers are unavailable")?,
        ),
    }
}

pub fn preview(args: &[String]) -> Result<Output> {
    let config = auth::Installation::load()?;
    run(args, &config, &config, None)
}
