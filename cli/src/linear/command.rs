use super::{Client, SystemTiming};
use crate::{ConfigProvider, Credential, CredentialProvider, HttpTransport};
use curl::easy::{Easy, List};
use http::{HeaderMap, HeaderName, HeaderValue, Request, Response};
use serde_json::{Value, json};
use std::{
    env,
    ffi::OsString,
    fs, io,
    path::{Path, PathBuf},
    process::ExitCode,
    time::Duration,
};

pub(super) fn key_env(workspace: &str) -> String {
    format!(
        "LINEAR_{}_API_KEY",
        workspace.to_ascii_uppercase().replace('-', "_")
    )
}
pub struct Installation {
    path: PathBuf,
    home: PathBuf,
    rows: Vec<Value>,
    raw: Value,
}
impl Installation {
    pub fn load() -> Result<Self, String> {
        let home = PathBuf::from(env::var_os("HOME").ok_or("missing home directory")?);
        let path = env::var_os("WG_CONFIG")
            .filter(|p| !p.is_empty())
            .map(PathBuf::from)
            .map(|p| {
                p.strip_prefix("~/")
                    .map(|relative| home.join(relative))
                    .unwrap_or(p)
            })
            .unwrap_or_else(|| home.join(".config/work-graph/config.json"));
        let raw: Value = match fs::read(&path) {
            Ok(data) => serde_json::from_slice(&data).map_err(|e| e.to_string())?,
            Err(e) if e.kind() == io::ErrorKind::NotFound => json!({}),
            Err(e) => return Err(e.to_string()),
        };
        if !raw.is_object() {
            return Err(format!(
                "{}: the config must be a JSON object",
                path.display()
            ));
        }
        if let Some(human) = raw.get("human")
            && !human.as_str().is_some_and(|name| {
                name.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
                    && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b' ')
            })
        {
            return Err(format!(
                "{}: human must be a name of letters, digits and spaces",
                path.display()
            ));
        }
        let mut rows = match raw.get("workspaces") {
            Some(value) => value
                .as_array()
                .cloned()
                .ok_or("workspaces must be an array")?,
            None => Vec::new(),
        };
        if rows.is_empty() {
            rows.push(json!({"id":"default"}));
        }
        let mut ids = std::collections::HashSet::new();
        for row in &rows {
            if row
                .get("team")
                .is_some_and(|team| !team.is_null() && !team.is_string())
            {
                return Err("workspace team must be a string or null".into());
            }
            if let Some(aliases) = row.get("key_env")
                && !aliases
                    .as_array()
                    .is_some_and(|names| names.iter().all(Value::is_string))
            {
                return Err("workspace key_env must be an array of names".into());
            }
            let id = row["id"].as_str().unwrap_or("");
            if id.is_empty()
                || !id
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
                || !ids.insert(id)
            {
                return Err(format!(
                    "{}: each workspace needs a unique id of a-z, 0-9 and -",
                    path.display()
                ));
            }
        }
        Ok(Self {
            path,
            home,
            raw,
            rows,
        })
    }
}
impl ConfigProvider for Installation {
    type Settings = Value;
    type Error = String;
    fn resolve(&self, id: &str) -> Result<Value, String> {
        self.rows
            .iter()
            .find(|row| row["id"] == id)
            .cloned()
            .ok_or_else(|| {
                format!(
                    "unknown workspace {id}: choose one of {}",
                    self.rows
                        .iter()
                        .filter_map(|r| r["id"].as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            })
    }
}
impl CredentialProvider for Installation {
    type Error = String;
    fn credential(&self, id: &str, _service: &str) -> Result<Option<Credential>, String> {
        let row = self.resolve(id)?;
        let defaults = json!(["LINEAR_API_KEY"]);
        let aliases = row
            .get("key_env")
            .unwrap_or(&defaults)
            .as_array()
            .ok_or("invalid key_env")?;
        let key = key_env(id);
        let value = std::iter::once(key.as_str())
            .chain(aliases.iter().filter_map(Value::as_str))
            .filter_map(|name| env::var(name).ok())
            .map(|s| s.trim().to_owned())
            .find(|s| !s.is_empty());
        let value = match value {
            Some(value) => value,
            None => {
                let path = self
                    .home
                    .join(format!(".config/work-graph/{id}-linear-api-key"));
                match fs::read_to_string(&path) {
                    Ok(value) => {
                        #[cfg(unix)]
                        {
                            use std::os::unix::fs::PermissionsExt;
                            if !value.trim().is_empty()
                                && fs::metadata(&path)
                                    .map_err(|e| e.to_string())?
                                    .permissions()
                                    .mode()
                                    & 0o044
                                    != 0
                            {
                                eprintln!(
                                    "warn: {} is readable by group or others; set mode 600",
                                    path.display()
                                );
                            }
                        }
                        value.trim().to_owned()
                    }
                    Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
                    Err(e) => return Err(e.to_string()),
                }
            }
        };
        if value.is_empty() {
            return Ok(None);
        }
        Ok(Some(Credential::new(
            HeaderValue::from_str(&value).map_err(|_| "invalid Linear authorization header")?,
        )))
    }
}

pub struct LinearHttp;
impl HttpTransport for LinearHttp {
    type Error = String;
    fn send(&self, request: Request<Vec<u8>>) -> Result<Response<Vec<u8>>, String> {
        self.post(request).map_err(|e| e.to_string())
    }
}
impl LinearHttp {
    fn post(
        &self,
        request: Request<Vec<u8>>,
    ) -> Result<Response<Vec<u8>>, Box<dyn std::error::Error>> {
        let mut easy = Easy::new();
        easy.url(&request.uri().to_string())?;
        easy.timeout(Duration::from_secs(30))?;
        if let Some(cert) = env::var_os("SSL_CERT_FILE") {
            easy.cainfo(Path::new(&cert))?;
        }
        let mut headers = List::new();
        for (name, value) in request.headers() {
            headers.append(&format!("{name}: {}", value.to_str()?))?;
        }
        easy.http_headers(headers)?;
        easy.post_fields_copy(request.body())?;
        let mut body = Vec::new();
        let mut response_headers = HeaderMap::new();
        let limit = std::cell::Cell::new(usize::MAX);
        let received = {
            let mut transfer = easy.transfer();
            transfer.header_function(|line| {
                if line.starts_with(b"HTTP/") {
                    response_headers.clear();
                    let code = String::from_utf8_lossy(line)
                        .split_whitespace()
                        .nth(1)
                        .and_then(|s| s.parse::<u16>().ok());
                    limit.set(match code {
                        Some(429 | 500..=599) => 500,
                        Some(400..=499) => 65536,
                        _ => usize::MAX,
                    });
                } else if let Some(pos) = line.iter().position(|b| *b == b':')
                    && let (Ok(name), Ok(value)) = (
                        HeaderName::from_bytes(&line[..pos]),
                        HeaderValue::from_bytes(line[pos + 1..].trim_ascii()),
                    )
                {
                    response_headers.insert(name, value);
                }
                true
            })?;
            transfer.write_function(|bytes| {
                body.extend_from_slice(
                    &bytes[..bytes.len().min(limit.get().saturating_sub(body.len()))],
                );
                Ok(if body.len() == limit.get() {
                    0
                } else {
                    bytes.len()
                })
            })?;
            transfer.perform()
        };
        // Once the server has refused a request, a short or unreadable error body
        // must not turn the HTTP status into an ambiguous network failure.
        if easy.response_code()? < 400 {
            received?;
        }
        let mut response = Response::builder()
            .status(easy.response_code()? as u16)
            .body(body)?;
        *response.headers_mut() = response_headers;
        Ok(response)
    }
}

#[derive(Default)]
pub(super) struct Options {
    pub workspace: String,
    pub team: String,
    pub name: String,
    pub parent: String,
    pub private: bool,
    pub apply: bool,
}
pub fn run_setup(args: impl Iterator<Item = OsString>) -> ExitCode {
    match command(args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("{e}");
            ExitCode::from(2)
        }
    }
}
fn command(args: impl Iterator<Item = OsString>) -> Result<(), String> {
    let config = Installation::load()?;
    let mut options = Options {
        workspace: config.rows[0]["id"].as_str().unwrap().into(),
        ..Default::default()
    };
    let mut privacy_flag = None;
    let mut args = args.map(|s| s.into_string().map_err(|_| "invalid argument"));
    while let Some(arg) = args.next() {
        let arg = arg?;
        let (flag, inline) = arg
            .split_once('=')
            .map_or((arg.as_str(), None), |(k, v)| (k, Some(v.to_owned())));
        let target = match flag {
            "--workspace" => &mut options.workspace,
            "--team" => &mut options.team,
            "--name" => &mut options.name,
            "--parent" => &mut options.parent,
            "-h" | "--help" => {
                println!(
                    "usage: wg setup [--workspace WORKSPACE] [--team TEAM] [--name NAME] [--parent KEY] [--private | --no-private] [--apply]"
                );
                return Ok(());
            }
            "--private" | "--no-private" if inline.is_none() => {
                let private = flag == "--private";
                if privacy_flag
                    .replace(private)
                    .is_some_and(|previous| previous != private)
                {
                    return Err("--private and --no-private cannot be used together".into());
                }
                options.private = private;
                continue;
            }
            "--apply" if inline.is_none() => {
                options.apply = true;
                continue;
            }
            _ => return Err(format!("unrecognized argument: {arg}")),
        };
        *target = match inline {
            Some(v) => v,
            None => args
                .next()
                .transpose()?
                .filter(|s| s == "-" || !s.starts_with('-'))
                .ok_or_else(|| format!("{flag}: expected one argument"))?,
        };
    }
    let row = config.resolve(&options.workspace)?;
    if options.team.is_empty() {
        options.team = row["team"].as_str().unwrap_or("").into();
    }
    if options.team.is_empty() {
        return Err(format!(
            "workspace {} has no default team. Supply --team <KEY>.",
            options.workspace
        ));
    }
    options.team = options.team.to_uppercase();
    options.parent = options.parent.to_uppercase();
    let mut client = Client::connect(
        &options.workspace,
        &config,
        &config,
        &LinearHttp,
        &SystemTiming,
    )?;
    // The Python setup command converts the stored JSON value with bool().
    let scoped = match row.get("team_labels") {
        None => true,
        Some(Value::Null) => false,
        Some(Value::Bool(value)) => *value,
        Some(Value::Number(value)) => value.as_f64() != Some(0.0),
        Some(Value::String(value)) => !value.is_empty(),
        Some(Value::Array(value)) => !value.is_empty(),
        Some(Value::Object(value)) => !value.is_empty(),
    };
    super::setup::install(
        &mut client,
        &options,
        config.raw["human"].as_str().unwrap_or("Human"),
        scoped,
    )?;
    let entry = json!({"id":options.workspace,"team":options.team,"team_labels":scoped});
    if !config.rows.iter().any(|r| {
        r["id"] == options.workspace
            && r["team"] == options.team
            && (r["team_labels"] == scoped
                || r["team_labels"].as_f64() == Some(u8::from(scoped) as f64))
    }) {
        println!("Set this entry in workspaces in {}:", config.path.display());
        println!("{}", serde_json::to_string_pretty(&entry).unwrap());
    }
    println!("Next commands\n  wg preflight <plan-dir>\n  wg doctor");
    Ok(())
}
