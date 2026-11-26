//! Boundaries for configuration, scoped credentials, and blocking HTTP adapters.

use http::{HeaderValue, Request, Response};
use std::fmt;

/// Resolve an adapter's typed settings for the selected workspace.
pub trait ConfigProvider {
    type Settings;
    type Error;

    fn resolve(&self, workspace: &str) -> Result<Self::Settings, Self::Error>;
}

/// A complete authorization header value. Debug output hides its contents.
#[derive(Clone)]
pub struct Credential(HeaderValue);

impl Credential {
    pub fn new(mut value: HeaderValue) -> Self {
        value.set_sensitive(true);
        Self(value)
    }

    pub fn into_header(self) -> HeaderValue {
        self.0
    }
}

impl fmt::Debug for Credential {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Credential([REDACTED])")
    }
}

/// A present but empty source disables authentication for this workspace.
pub enum PageCredential {
    Missing,
    Disabled,
    Token(Credential),
}

impl PageCredential {
    pub fn into_token(self) -> Option<Credential> {
        match self {
            Self::Token(token) => Some(token),
            Self::Missing | Self::Disabled => None,
        }
    }
}

/// Look up a credential for one workspace and service. Missing credentials
/// return Ok(None). Errors must omit secret values.
pub trait CredentialProvider {
    type Error;

    fn credential(&self, workspace: &str, service: &str)
    -> Result<Option<Credential>, Self::Error>;

    fn page_source(&self, workspace: &str) -> Result<PageCredential, Self::Error> {
        Ok(self
            .credential(workspace, "page")?
            .map_or(PageCredential::Missing, PageCredential::Token))
    }
}

/// Send one HTTP request. Return HTTP error statuses as responses so that
/// the calling adapter can apply its retry and mutation rules.
pub trait HttpTransport {
    type Error;

    fn send(&self, request: Request<Vec<u8>>) -> Result<Response<Vec<u8>>, Self::Error>;
}

pub mod linear;
pub mod local;
pub mod page;
pub mod state;

pub mod release;
pub mod usage;

pub mod providers;

pub mod workflow;
pub mod update;
