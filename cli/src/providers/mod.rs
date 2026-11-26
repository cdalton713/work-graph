mod collaboration;
mod effort;
pub(crate) use effort::Effort;

use crate::{
    ConfigProvider, Credential,
    linear::{Client, Installation, LinearHttp, SystemTiming},
    local::CardWriter,
    page::Settings,
};
use serde_json::{Value, json};
use std::{
    env, fs, io,
    io::Read,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};

fn field<'a>(value: &'a Value, name: &str) -> Result<&'a str, String> {
    value[name]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("missing {name}"))
}

pub struct PageSettings<'a>(pub &'a Installation);
impl ConfigProvider for PageSettings<'_> {
    type Settings = Settings;
    type Error = String;
    fn resolve(&self, id: &str) -> Result<Settings, String> {
        let home = PathBuf::from(env::var_os("HOME").ok_or("missing home directory")?);
        let mut workspaces = Vec::new();
        for row in self.0.workspaces() {
            let id = field(row, "id")?;
            let page = row["page_url"]
                .as_str()
                .or(self.0.config.settings()["page_url"].as_str())
                .map(str::to_owned);
            workspaces.push((id.to_owned(), field(row, "name")?.to_owned(), page));
        }
        let selected = if id.is_empty() {
            workspaces.first()
        } else {
            workspaces.iter().find(|w| w.0 == id)
        }
        .ok_or("unknown workspace")?;
        Ok(Settings {
            page: selected.2.clone(),
            human: field(self.0.config.settings(), "human")?.into(),
            token_directory: home.join(".config/work-graph/pages"),
            workspaces,
        })
    }
}

pub(crate) fn page_key(home: &Path, row: &Value) -> Result<Option<Credential>, String> {
    let scoped = row["page_url"].as_str().is_some_and(|s| !s.is_empty());
    let id = field(row, "id")?;
    let name = if scoped {
        format!("WG_{}_LINK_TOKEN", id.to_uppercase().replace('-', "_"))
    } else {
        "WG_LINK_TOKEN".into()
    };
    let token = match env::var(&name) {
        Ok(v) => v,
        Err(env::VarError::NotUnicode(_)) => return Err(format!("invalid {name}")),
        Err(env::VarError::NotPresent) => {
            let path = home.join(".config/work-graph").join(if scoped {
                format!("{id}-link-token")
            } else {
                "link-token".into()
            });
            let mut f = match fs::File::open(&path) {
                Ok(f) => f,
                Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
                Err(e) => return Err(e.to_string()),
            };
            if f.metadata()
                .map_err(|e| e.to_string())?
                .permissions()
                .mode()
                & 0o7777
                != 0o600
            {
                return Err(format!("{} must have mode 600", path.display()));
            }
            let mut v = String::new();
            f.read_to_string(&mut v)
                .map_err(|_| "cannot read page token")?;
            if v.ends_with('\n') {
                v.pop();
            }
            v
        }
    };
    if !token.bytes().all(|b| (32..127).contains(&b)) {
        return Err("invalid page token".into());
    }
    if token.trim().is_empty() {
        return Ok(None);
    }
    Ok(Some(Credential::new(
        format!("Bearer {}", token.trim())
            .parse()
            .map_err(|_| "invalid page token")?,
    )))
}

fn request(
    config: &Installation,
    workspace: &str,
    query: &str,
    variables: Value,
) -> Result<Value, String> {
    Client::connect(workspace, config, config, &LinearHttp, &SystemTiming)?
        .request(query, variables)
}

pub(crate) struct LinearCards<'a> {
    workspace: &'a str,
}
impl<'a> LinearCards<'a> {
    pub fn new(workspace: &'a str, report: &'a Value) -> Self {
        Self {
            workspace: if workspace.is_empty() {
                report["config"]["workspaces"][0]["id"]
                    .as_str()
                    .unwrap_or("default")
            } else {
                workspace
            },
        }
    }
}
impl CardWriter for LinearCards<'_> {
    fn write(&mut self, issue: &str, previous: Option<&str>, body: &str) -> io::Result<String> {
        let (op, query, vars) = match previous {
            Some(id) => (
                "commentUpdate",
                "mutation($id:String!,$i:CommentUpdateInput!){commentUpdate(id:$id,input:$i){success comment{id}}}",
                json!({"id":id,"i":{"body":body}}),
            ),
            None => (
                "commentCreate",
                "mutation($i:CommentCreateInput!){commentCreate(input:$i){success comment{id}}}",
                json!({"i":{"issueId":issue,"body":body}}),
            ),
        };
        let config = Installation::load().map_err(io::Error::other)?;
        let result = request(&config, self.workspace, query, vars).map_err(io::Error::other)?;
        if result[op]["success"] != true {
            return Err(io::Error::other("Linear refused the node card"));
        }
        field(&result[op]["comment"], "id")
            .map(str::to_owned)
            .map_err(io::Error::other)
    }
}
