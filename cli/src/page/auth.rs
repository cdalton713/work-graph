use super::*;
use crate::{Credential, PageCredential};
use std::{
    fs,
    io::{self, BufRead, Write},
    net::IpAddr,
    os::unix::fs::{DirBuilderExt, PermissionsExt},
    path::Path,
};

pub(super) fn validated_url(raw: &str, settings: &Settings) -> Result<Url> {
    let error = "use a page URL with HTTPS, or configured HTTP on loopback or a tailnet";
    if raw.contains(['?', '#', '\\']) || raw.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(error.into());
    }
    let uri: http::Uri = raw.parse().map_err(|_| error)?;
    let authority = uri.authority().ok_or(error)?;
    if authority.as_str().contains('@') {
        return Err(error.into());
    }
    let url = Url::parse(raw).map_err(|_| error)?;
    let host = authority
        .host()
        .trim_matches(['[', ']'])
        .to_ascii_lowercase();
    if host.len() > 253
        || !host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".:-".contains(&b))
    {
        return Err(error.into());
    }
    let private = host == "localhost"
        || host.ends_with(".ts.net")
        || host.parse::<IpAddr>().is_ok_and(|ip| {
            ip.is_loopback()
                || match ip {
                    IpAddr::V4(ip) => u32::from(ip) >> 22 == 0x191,
                    IpAddr::V6(ip) => ip.segments()[..3] == [0xfd7a, 0x115c, 0xa1e0],
                }
        });
    let configured = settings
        .workspaces
        .iter()
        .filter_map(|w| w.2.as_deref())
        .chain(settings.page.as_deref())
        .any(|p| p.trim_end_matches('/') == raw);
    if url.scheme() != "https" && !(url.scheme() == "http" && private && configured) {
        return Err(
            "use HTTPS unless the page has a configured HTTP loopback or tailnet URL".into(),
        );
    }
    Ok(url)
}

pub(super) fn token_path(settings: &Settings, raw: &str) -> Result<PathBuf> {
    let uri: http::Uri = raw.parse().map_err(|_| "invalid page URL")?;
    let authority = uri.authority().ok_or("invalid page URL")?;
    let host = authority
        .host()
        .trim_matches(['[', ']'])
        .to_ascii_lowercase();
    let suffix = authority
        .port_u16()
        .map(|p| format!("_{p}"))
        .unwrap_or_default();
    let filename = format!("{host}{suffix}-token");
    if filename.len() > 255 {
        return Err("page host and port too long".into());
    }
    Ok(settings.token_directory.join(filename))
}

fn header(raw: &str) -> Result<(String, HeaderValue)> {
    if !raw.bytes().all(|b| (32..=126).contains(&b)) {
        return Err("the token must contain one line of printable ASCII".into());
    }
    let token = raw.trim();
    if token.is_empty() {
        return Err("the token is empty".into());
    }
    let value = HeaderValue::from_str(&format!("Bearer {token}")).map_err(|_| "invalid token")?;
    Ok((token.into(), Credential::new(value).into_header()))
}

pub(crate) fn page_source(raw: &str) -> Result<PageCredential> {
    if raw.bytes().all(|b| b == b' ') {
        Ok(PageCredential::Disabled)
    } else {
        header(raw).map(|(_, value)| PageCredential::Token(Credential::new(value)))
    }
}

pub(crate) fn read_page_source(path: &Path) -> Result<PageCredential> {
    use std::io::Read;
    let mut file = match fs::File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(PageCredential::Missing),
        Err(_) => return Err("cannot read page token".into()),
    };
    if file
        .metadata()
        .map_err(|_| "cannot inspect token")?
        .permissions()
        .mode()
        & 0o7777
        != 0o600
    {
        return Err(format!("{} must have mode 600", path.display()));
    }
    let mut raw = String::new();
    file.read_to_string(&mut raw)
        .map_err(|_| "cannot read page token")?;
    page_source(raw.strip_suffix('\n').unwrap_or(&raw))
}

/// Resolve the credential for an HTTP or coordinator connection to the specified page.
pub fn page_credential<K: CredentialProvider<Error = String>>(
    settings: &Settings,
    raw: &str,
    scope: &str,
    shared: bool,
    provider: &K,
) -> Result<Option<Credential>> {
    validated_url(raw.trim_end_matches('/'), settings)?;
    let saved = || Ok(read_page_source(&token_path(settings, raw)?)?.into_token());
    if shared {
        if let Some(token) = saved()? {
            return Ok(Some(token));
        }
        for (workspace, _, url) in &settings.workspaces {
            if url
                .as_deref()
                .is_some_and(|p| p.trim_end_matches('/') == raw.trim_end_matches('/'))
                && let Some(token) = provider.page_source(workspace)?.into_token()
            {
                return Ok(Some(token));
            }
        }
        return Ok(None);
    }
    if settings
        .page
        .as_deref()
        .is_some_and(|p| p.trim_end_matches('/') == raw.trim_end_matches('/'))
    {
        match provider.page_source(scope)? {
            PageCredential::Missing => (),
            source => return Ok(source.into_token()),
        }
    }
    saved()
}

fn save(path: &Path, token: &str) -> Result<()> {
    let dir = path.parent().ok_or("invalid token path")?;
    fs::create_dir_all(dir.parent().ok_or("invalid token directory")?)
        .map_err(|_| "cannot create token directory")?;
    fs::DirBuilder::new()
        .mode(0o700)
        .recursive(true)
        .create(dir)
        .map_err(|_| "cannot create token directory")?;
    let meta = dir
        .symlink_metadata()
        .map_err(|_| "cannot inspect token directory")?;
    if !meta.is_dir() || meta.permissions().mode() & 0o7777 != 0o700 {
        return Err("the token directory must have mode 700".into());
    }
    let mut tmp = tempfile::NamedTempFile::new_in(dir).map_err(|_| "cannot create token file")?;
    writeln!(tmp, "{token}").map_err(|_| "cannot write token")?;
    tmp.persist(path).map_err(|_| "cannot save token")?;
    Ok(())
}

pub(super) fn verify_token(page: &mut Page) -> Result<Value> {
    let config = token_json(page, "/api/config")?;
    if !config["auth"]
        .as_bool()
        .ok_or("the page did not report whether sign-in is enabled")?
    {
        let path = "/api/link?role=coordinator";
        let with = token_response(page, path)?.0;
        if with != 400 {
            check(with)?;
        }
        let credential = page.token.take();
        let without = token_response(page, path)?.0;
        page.token = credential;
        if with != 400 || !matches!(without, 401 | 403) {
            return Err("the page did not confirm the token".into());
        }
    }
    token_json(page, "/api/status")
}

pub(super) fn login(settings: &Settings, explicit: Option<&str>, stdin: bool) -> Result<String> {
    let mut page = Page::new(settings, explicit)?;
    let url = explicit
        .or(settings.page.as_deref())
        .ok_or("give the page URL")?
        .trim_end_matches('/');
    let path = token_path(settings, url)?;
    let raw = if stdin {
        let mut line = String::new();
        io::stdin()
            .lock()
            .read_line(&mut line)
            .map_err(|_| "cannot read token")?;
        line.strip_suffix('\n').unwrap_or(&line).to_string()
    } else {
        rpassword::prompt_password("Page coordinator token: ")
            .map_err(|_| "cannot read the token without echo; use --token-stdin")?
    };
    let (token, value) = header(&raw)?;
    page.token = Some(value);
    let status = verify_token(&mut page)?;
    save(&path, &token)?;
    let mut lines = vec![format!("Saved the coordinator token for {url}.")];
    for row in status["workspaces"].as_array().into_iter().flatten() {
        let Some(id) = row["id"].as_str().filter(|s| {
            !s.is_empty()
                && s.bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        }) else {
            continue;
        };
        let name: String = row["name"]
            .as_str()
            .unwrap_or(id)
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .chars()
            .filter(|c| !c.is_control())
            .take(120)
            .collect();
        if settings.workspaces.iter().any(|w| {
            w.0 == id
                && w.2
                    .as_deref()
                    .is_some_and(|s| s.trim_end_matches('/') == url)
        }) {
            lines.push(format!("{id} ({name}): configured"));
        } else {
            lines.push(format!("{id} ({name}): set this entry in workspaces"));
            lines.push(collaboration::display_json(
                &serde_json::json!({"id":id,"name":name,"page_url":url}),
            ));
        }
    }
    Ok(lines.join("\n").replace(&token, "[redacted]"))
}

pub(super) fn logout(settings: &Settings, explicit: Option<&str>) -> Result<String> {
    let url = explicit
        .or(settings.page.as_deref())
        .ok_or("give the page URL")?
        .trim_end_matches('/');
    validated_url(url, settings)?;
    let message = match fs::remove_file(token_path(settings, url)?) {
        Ok(()) => "Removed the saved token",
        Err(e) if e.kind() == io::ErrorKind::NotFound => "There was no saved token",
        Err(_) => return Err("cannot remove saved token".into()),
    };
    Ok(format!(
        "{message} for {url}.\nUse the page settings to revoke the token on the page."
    ))
}
