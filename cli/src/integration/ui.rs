use super::*;
use crate::CredentialProvider;
use serde_json::{Value, json};
use std::{
    env, fs,
    process::Command,
    time::{Duration, SystemTime},
};

fn modified(path: &Path) -> std::io::Result<SystemTime> {
    path.metadata()?.modified()
}

fn newer(path: &Path, built: SystemTime) -> std::io::Result<bool> {
    if !path.exists() {
        return Ok(false);
    }
    if modified(path)? > built {
        return Ok(true);
    }
    if path.is_dir() && !path.is_symlink() {
        for entry in fs::read_dir(path)? {
            if newer(&entry?.path(), built)? {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

pub(super) fn run(
    install: &Installation,
    workspace: Option<String>,
    port: i32,
    project: Option<String>,
    no_open: bool,
    no_tailnet: bool,
) -> Result<Output, String> {
    launch(install, workspace, port, project, no_open, no_tailnet).map_err(|e| e.to_string())
}
fn launch(
    install: &Installation,
    workspace: Option<String>,
    port: i32,
    project: Option<String>,
    no_open: bool,
    no_tailnet: bool,
) -> crate::automation::machine::Result<Output> {
    let default = install.workspaces()[0]["id"]
        .as_str()
        .ok_or("missing workspace id")?;
    let scope = workspace.as_deref().unwrap_or(default);
    if !install.workspaces().iter().any(|w| w["id"] == scope) {
        return Err(format!("unknown workspace {scope}").into());
    }
    let root = match env::var_os("WG_UI_DIR").filter(|s| !s.is_empty()) {
        Some(dir) => crate::automation::machine::expand(Path::new(&dir))?,
        None => super::resources::root()?,
    };
    let server = root.join("server/main.ts");
    if !server.is_file() {
        return Err(format!("no work-graph page at {}: run wg from a checkout of the work-graph repository (or set WG_UI_DIR)",root.display()).into());
    }
    let base = format!("http://127.0.0.1:{port}/");
    let running = reqwest::blocking::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(2))
        .build()?
        .get(format!("{base}healthz"))
        .send()
        .and_then(|r| r.error_for_status())
        .and_then(|r| r.bytes())
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        == Some(json!({"ok":true}));
    if running {
        let mut url = url::Url::parse(&base)?;
        if let Some(p) = project.as_ref().filter(|s| !s.is_empty()) {
            url.query_pairs_mut().append_pair("project", p);
            if scope != default {
                url.query_pairs_mut().append_pair("workspace", scope);
            }
        }
        let url = url.to_string().replace('+', "%20");
        if !no_open {
            Command::new(if cfg!(target_os = "macos") {
                "open"
            } else {
                "xdg-open"
            })
            .arg(&url)
            .status()?;
        }
        return Ok(Output::success(format!(
            "work-graph UI already runs: {url}"
        )));
    }
    if install.credential(scope, "linear")?.is_none() {
        return Err(format!("no Linear key for {scope}").into());
    }
    let marker = root.join("node_modules/.modules.yaml");
    let lock = root.join("pnpm-lock.yaml");
    if (!marker.exists() || modified(&marker)? < modified(&lock)?)
        && !Command::new("pnpm")
            .current_dir(&root)
            .args(["install", "--frozen-lockfile"])
            .status()?
            .success()
    {
        return Err("pnpm install failed".into());
    }
    let built = root.join("dist/index.html");
    let mut build = !built.exists();
    if !build {
        let time = modified(&built)?;
        for name in [
            "index.html",
            "package.json",
            "pnpm-lock.yaml",
            "vite.config.ts",
            "tsconfig.json",
            "src",
        ] {
            if newer(&root.join(name), time)? {
                build = true;
                break;
            }
        }
    }
    if build
        && !Command::new("pnpm")
            .current_dir(&root)
            .arg("build")
            .status()?
            .success()
    {
        return Err("pnpm build failed".into());
    }
    let mut cmd = Command::new("node");
    cmd.current_dir(&root)
        .arg(server.canonicalize()?)
        .arg("--port")
        .arg(port.to_string());
    if let Some(p) = project.filter(|s| !s.is_empty()) {
        cmd.arg("--project").arg(p);
    }
    cmd.args(["--workspace", scope]);
    if no_open {
        cmd.arg("--no-open");
    }
    if no_tailnet {
        cmd.arg("--no-tailnet");
    }
    Ok(Output {
        status: cmd.status()?.code().unwrap_or(1) as u8,
        ..Default::default()
    })
}
