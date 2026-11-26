use super::*;
use reqwest::{Method, blocking::RequestBuilder};
use serde_json::{Map, json};
use sha2::{Digest, Sha256};
use std::path::Path;

pub struct LocalEffort {
    pub plan: Value,
    pub keymap: Value,
    /// SHA-256 of the exact plan.json bytes, before normalization.
    pub sha: Option<String>,
}

/// The state adapter holds the plan directory lock for this object's lifetime.
pub trait LockedEffort {
    /// Recover an interrupted pair first. For a new join reject dirty worktrees and existing plan files.
    fn read(&self) -> Result<LocalEffort>;
    fn save_keymap(&self, keymap: &Value) -> Result<()>;
    /// Journal and replace the plan/keymap pair. Create PLAN.md only for a new join.
    fn save_pair(
        &self,
        plan: &Value,
        keymap: &Value,
        prior: Option<&str>,
        heading: Option<&str>,
    ) -> Result<()>;
    fn backup_conflict(&self, sha: &str, plan: &Value) -> Result<()>;
}

pub trait Collaboration {
    fn lock(&self, dir: &Path) -> Result<Box<dyn LockedEffort + '_>>;
    fn join_worktree(
        &self,
        repo: &Path,
        plan: &Value,
        membership: &str,
    ) -> Result<(PathBuf, Box<dyn LockedEffort + '_>)>;
    /// Resolve team access and verify the project id and name with the user's own Linear credential.
    fn project_workspace(&self, team: &str, project: &str, name: &str) -> Result<String>;
    fn verify_issue(
        &self,
        workspace: &str,
        project: &str,
        identifier: &str,
        id: Option<&str>,
    ) -> Result<()>;
    fn verify_milestone(&self, workspace: &str, project: &str, id: &str) -> Result<()>;
    fn verify_document(&self, workspace: &str, project: &str, id: &str) -> Result<()>;
    fn verify_card(&self, workspace: &str, issue: &str, id: &str) -> Result<()>;
    /// Apply workspace/team defaults and run the same graph checks as wg check.
    fn normalize_and_check(&self, plan: &mut Value) -> Result<()>;
}

fn field<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v[key]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("invalid {key}"))
}
fn obj(v: &Value) -> Result<&Map<String, Value>> {
    v.as_object().ok_or_else(|| "expected an object".into())
}
fn array<'a>(v: &'a Value, key: &str) -> Result<&'a Vec<Value>> {
    v[key].as_array().ok_or_else(|| format!("invalid {key}"))
}
fn select(v: &Value, fields: &[&str]) -> Value {
    Value::Object(
        fields
            .iter()
            .filter_map(|k| Some((k.to_string(), v.get(*k)?.clone())))
            .collect(),
    )
}
fn extend(v: &mut Value, other: &Value) -> Result<()> {
    v.as_object_mut()
        .ok_or("expected an object")?
        .extend(obj(other)?.clone());
    Ok(())
}
fn settings(effort: &Value) -> Result<Value> {
    let mut fields = obj(effort)?.clone();
    fields.remove("name");
    fields.remove("summary");
    Ok(fields.into())
}
fn shared(km: &Value) -> Result<Value> {
    let mut result = select(km, &["project", "milestones"]);
    result["nodes"] = json!({});
    if let Some(id) = km["status_doc"].get("id") {
        result["status_doc"] = json!({"id":id});
    }
    for (key, row) in obj(&km["nodes"])? {
        let mut entry = select(row, &["id", "identifier", "branch", "pr"]);
        if let Some(id) = row["card"].get("id") {
            entry["card"] = json!({"id":id});
        }
        result["nodes"][key] = entry;
    }
    Ok(result)
}
fn merge_keymap(local: &Value, remote: &Value) -> Result<Value> {
    let mut after = local.clone();
    let incoming = shared(remote)?;
    after["project"] = incoming["project"].clone();
    if let Some(m) = incoming.get("milestones") {
        extend(&mut after["milestones"], m)?;
    }
    let mut doc = select(&local["status_doc"], &["sha", "at"]);
    if let Some(id) = incoming["status_doc"].get("id") {
        doc["id"] = id.clone();
    }
    if obj(&doc)?.is_empty() {
        after
            .as_object_mut()
            .ok_or("invalid keymap")?
            .remove("status_doc");
    } else {
        after["status_doc"] = doc;
    }
    for (key, entry) in obj(&incoming["nodes"])? {
        let old = &local["nodes"][key];
        let mut merged = entry.clone();
        if old["id"] == entry["id"] {
            merged = old.clone();
            extend(&mut merged, entry)?;
        }
        if let Some(published) = old.get("published") {
            merged["published"] = published.clone();
        }
        if merged["card"].is_object()
            && merged["card"]["id"] == old["card"]["id"]
            && let Some(sha) = old["card"].get("sha")
        {
            merged["card"]["sha"] = sha.clone();
        }
        after["nodes"][key] = merged;
    }
    Ok(after)
}

fn component(s: &str) -> bool {
    s.len() <= 80
        && s.as_bytes().first().is_some_and(u8::is_ascii_alphanumeric)
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}
fn component_value(value: &Value) -> bool {
    value.as_str().is_some_and(component) || value.as_u64().is_some()
}
fn branch(s: &str) -> bool {
    s.as_bytes().first().is_some_and(u8::is_ascii_alphanumeric)
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-./".contains(&b))
        && !s.contains("..")
        && !s.ends_with('.')
        && s.split('/')
            .all(|p| !p.is_empty() && !p.starts_with('.') && !p.ends_with(".lock"))
}
fn identifier(s: &str) -> bool {
    s.split_once('-').is_some_and(|(team, n)| {
        (1..=10).contains(&team.len())
            && team.as_bytes()[0].is_ascii_uppercase()
            && team
                .bytes()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
            && (1..=9).contains(&n.len())
            && n.bytes().all(|c| c.is_ascii_digit())
    })
}
fn validate(
    stores: &dyn Collaboration,
    workspace: &str,
    collab: &Value,
    plan: &mut Value,
    remote: &Value,
    local: &LocalEffort,
) -> Result<()> {
    let project = field(collab, "project")?;
    if field(&remote["project"], "id")? != project
        || field(&plan["effort"], "name")? != field(collab, "name")?
    {
        return Err("wrong shared project".into());
    }
    if !component(field(&plan["effort"], "slug")?) {
        return Err("unsafe effort.slug".into());
    }
    for phase in array(plan, "phases")? {
        if !component_value(&phase["key"]) || !branch(field(phase, "target")?) {
            return Err("unsafe phase key or target".into());
        }
    }
    for node in array(plan, "nodes")? {
        let key = field(node, "key")?;
        if key.len() > 40
            || !key
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            || (!node["lane"].is_null() && !component_value(&node["lane"]))
        {
            return Err("unsafe node key or lane".into());
        }
        let old = local.plan["nodes"]
            .as_array()
            .and_then(|rows| rows.iter().find(|n| n["key"] == key));
        for k in ["eng", "issue"] {
            if !node[k].is_null() && old.and_then(|n| n.get(k)) != Some(&node[k]) {
                stores.verify_issue(workspace, project, field(node, k)?, None)?;
            }
        }
    }
    if array(plan, "edges")?.iter().any(|e| !e.is_object()) {
        return Err("invalid edges".into());
    }
    stores.normalize_and_check(plan)?;
    for (key, row) in obj(&remote["nodes"])? {
        let id = field(row, "id")?;
        let label = field(row, "identifier")?;
        if !identifier(label)
            || row
                .get("branch")
                .is_some_and(|v| !v.as_str().is_some_and(branch))
            || row.get("pr").is_some_and(|v| {
                let s = v
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| v.to_string());
                s.is_empty() || s.starts_with('0') || !s.bytes().all(|b| b.is_ascii_digit())
            })
        {
            return Err("invalid shared issue mapping".into());
        }
        let old = &local.keymap["nodes"][key];
        if old["id"] != id || old["identifier"] != label {
            stores.verify_issue(workspace, project, label, Some(id))?;
        }
        if let Some(card) = row.get("card") {
            obj(card)?;
            if let Some(value) = card.get("id")
                && (old["card"]["id"] != *value || old["id"] != id)
            {
                stores.verify_card(workspace, id, field(card, "id")?)?;
            }
        }
    }
    if let Some(m) = remote.get("milestones") {
        for (k, v) in obj(m)? {
            let id = v
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or("invalid milestone")?;
            if local.keymap["milestones"][k] != *v {
                stores.verify_milestone(workspace, project, id)?;
            }
        }
    }
    if let Some(doc) = remote.get("status_doc") {
        obj(doc)?;
        if doc.get("id").is_some() && doc["id"] != local.keymap["status_doc"]["id"] {
            stores.verify_document(workspace, project, field(doc, "id")?)?;
        }
    }
    Ok(())
}

fn project_request(
    page: &Page,
    collab: &Value,
    method: Method,
    suffix: &[&str],
) -> Result<RequestBuilder> {
    let mut url = page.url.clone();
    url.path_segments_mut()
        .map_err(|_| "invalid page URL")?
        .pop_if_empty()
        .extend(["api", "projects", field(collab, "project")?])
        .extend(suffix);
    let token = page.token.as_ref().ok_or("no page credential")?.clone();
    Ok(page
        .http
        .request(method, url)
        .header("Authorization", token)
        .header("x-workspace", field(collab, "workspace")?))
}
fn fetch(page: &Page, collab: &Value, force: bool) -> Result<Option<Value>> {
    let mut req = project_request(page, collab, Method::GET, &["plan"])?;
    if !force && let Some(version) = collab["version"].as_u64() {
        req = req.header("If-None-Match", format!("\"{version}\""));
    }
    let (status, body) = response(req)?;
    if status == 304 && !force && collab["version"].is_u64() {
        return Ok(None);
    }
    check(status)?;
    let mut data: Value = serde_json::from_slice(&body).map_err(|_| "invalid remote plan")?;
    data["version"].as_u64().ok_or("invalid remote version")?;
    obj(&data["plan"]["effort"])?;
    for field in ["phases", "nodes", "edges"] {
        if array(&data["plan"], field)?
            .iter()
            .any(|row| !row.is_object())
        {
            return Err("invalid remote plan fields".into());
        }
    }
    if data["keymap"]["project"]["id"] != collab["project"] {
        return Err("wrong shared project".into());
    }
    obj(&data["keymap"])?;
    if data["keymap"].get("nodes").is_none() {
        data["keymap"]["nodes"] = json!({});
    }
    Ok(Some(data))
}
fn connect<K: CredentialProvider<Error = String>>(
    settings: &Settings,
    credentials: &K,
    collab: &Value,
    scope: &str,
) -> Result<Page> {
    let raw = field(collab, "page")?;
    let mut page = Page::new(settings, Some(raw))?;
    auth::authorize(
        &mut page,
        settings,
        raw,
        scope,
        field(collab, "workspace")?.starts_with("shared:"),
        credentials,
    )?;
    Ok(page)
}

pub(super) fn run<
    C: ConfigProvider<Settings = Settings, Error = String>,
    K: CredentialProvider<Error = String>,
>(
    command: Command,
    config: &C,
    credentials: &K,
    stores: &dyn Collaboration,
) -> Result<String> {
    let dir = match &command {
        Command::Join {
            page_url,
            project,
            repo,
        } => {
            return join(
                &config.resolve("")?,
                credentials,
                stores,
                page_url.as_deref(),
                project.as_deref(),
                repo,
            );
        }
        Command::Share { dir } | Command::Leave { dir } | Command::Pull { dir, .. } => dir,
        _ => unreachable!(),
    };
    let lock = stores.lock(dir)?;
    let mut local = lock.read()?;
    let default = config.resolve("")?;
    let scope = local.plan["effort"]["workspace"]
        .as_str()
        .or_else(|| default.workspaces.first().map(|w| w.0.as_str()))
        .ok_or("no default workspace")?
        .to_string();
    let settings = config.resolve(&scope)?;
    let collab = local.keymap["collab"].clone();
    match command {
        Command::Share { .. } => {
            if collab.is_object() {
                return Ok("the effort is already shared".into());
            }
            let project = field(&local.keymap["project"], "id")
                .map_err(|_| "run wg load --apply before wg share")?;
            stores.normalize_and_check(&mut local.plan)?;
            let effort = &local.plan["effort"];
            let mut c = json!({"page":settings.page,"workspace":scope,"project":project,"name":field(effort,"name")?,"settings":self::settings(effort)?});
            let page = connect(&settings, credentials, &c, &scope)?;
            if let Some(rows) = local.keymap["run"]["nodes"].as_object().cloned() {
                for (key, row) in rows {
                    if local.keymap["nodes"].get(&key).is_some() {
                        extend(
                            &mut local.keymap["nodes"][&key],
                            &select(&row, &["branch", "pr"]),
                        )?;
                    }
                }
            }
            let body = json!({"plan":local.plan,"keymap":shared(&local.keymap)?});
            let sha = local.sha.ok_or("missing plan file")?;
            let answer = json_response(
                project_request(&page, &c, Method::PUT, &["plan"])?
                    .header("If-None-Match", "*")
                    .header("Content-Type", "application/json")
                    .body(body.to_string()),
            )?;
            let version = answer["version"].as_u64().ok_or("invalid plan version")?;
            c["version"] = json!(version);
            c["plan_sha"] = json!(sha);
            c["remote_settings"] = c["settings"].clone();
            local.keymap["collab"] = c;
            lock.save_keymap(&local.keymap)?;
            Ok(format!("shared plan v{version}"))
        }
        Command::Leave { .. } => {
            if !collab["workspace"]
                .as_str()
                .is_some_and(|s| s.starts_with("shared:"))
            {
                return Err("This worktree has no collaborator record.".into());
            }
            let claims = (|| {
                let page = connect(&default, credentials, &collab, "")?;
                let answer =
                    json_response(project_request(&page, &collab, Method::GET, &["claims"])?)?;
                for claim in array(&answer, "claims")? {
                    if claim["mine"] == true {
                        let result = response(project_request(
                            &page,
                            &collab,
                            Method::DELETE,
                            &["claims", field(claim, "node")?],
                        )?);
                        if !matches!(result, Ok((204 | 200 | 404, _))) {
                            eprintln!("warn: could not release claim");
                        }
                    }
                }
                Ok::<_, String>(())
            })();
            if claims.is_err() {
                eprintln!("warn: could not list claims");
            }
            local
                .keymap
                .as_object_mut()
                .ok_or("invalid keymap")?
                .remove("collab");
            lock.save_keymap(&local.keymap)?;
            Ok("Removed the local collaboration record. End your membership on the page.".into())
        }
        Command::Pull {
            force,
            accept_settings,
            ..
        } => {
            if !collab.is_object() {
                return Err("this effort is not shared; run wg share first".into());
            }
            let page = connect(&settings, credentials, &collab, &scope)?;
            pull(
                &page,
                stores,
                lock.as_ref(),
                local,
                &scope,
                force,
                accept_settings,
            )
        }
        _ => unreachable!(),
    }
}

fn join<K: CredentialProvider<Error = String>>(
    settings: &Settings,
    credentials: &K,
    stores: &dyn Collaboration,
    explicit: Option<&str>,
    selection: Option<&str>,
    repo: &Path,
) -> Result<String> {
    let raw = explicit
        .or(settings.page.as_deref())
        .ok_or("give wg join the page URL")?
        .trim_end_matches('/');
    let mut page = Page::new(settings, Some(raw))?;
    auth::authorize(&mut page, settings, raw, "", true, credentials)?;
    let status = token_json(&page, "/api/status")?;
    let mut members = vec![];
    for row in array(&status, "workspaces")? {
        let id = field(row, "id")?;
        if let Some(suffix) = id.strip_prefix("shared:") {
            if suffix.is_empty()
                || !suffix
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
            {
                return Err("invalid membership id".into());
            }
            for k in ["name", "role", "owner", "projectId"] {
                field(row, k)?;
            }
            members.push(row);
        }
    }
    if let Some(choice) = selection {
        if members.iter().any(|r| r["id"] == choice) {
            members.retain(|r| r["id"] == choice);
        } else {
            members.retain(|r| {
                r["name"]
                    .as_str()
                    .is_some_and(|s| s.to_lowercase() == choice.to_lowercase())
            });
        }
    }
    let row = match members.as_slice() {
        [row] => *row,
        [] => {
            return Err(
                "no matching shared project; open the collab link and press Join first".into(),
            );
        }
        many => {
            return Err(format!(
                "Select one shared project with --project: {}",
                many.iter()
                    .filter_map(|r| r["id"].as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
    };
    if row["role"] != "collaborator" {
        return Err("A read-only member cannot run wg on this project.".into());
    }
    if status["human"] != settings.human {
        return Err("page account differs from config human".into());
    }
    let project = field(row, "projectId")?;
    let name = field(row, "name")?;
    let membership = field(row, "id")?;
    let mut collab = json!({"page":raw,"workspace":membership,"project":project,"name":name});
    let data = fetch(&page, &collab, true)?.ok_or("missing shared plan")?;
    let mut plan = data["plan"].clone();
    let wire = &data["plan"]["effort"];
    if let Some(id) = wire.get("workspace")
        && !id.as_str().is_some_and(|s| {
            !s.is_empty()
                && s.bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        })
    {
        return Err("invalid shared workspace".into());
    }
    let scope = stores.project_workspace(field(wire, "team")?, project, name)?;
    plan["effort"] = select(wire, &["name", "summary", "slug", "team"]);
    plan["effort"]["workspace"] = json!(scope);
    let empty = LocalEffort {
        plan: Value::Null,
        keymap: json!({"nodes":{},"milestones":{}}),
        sha: None,
    };
    validate(stores, &scope, &collab, &mut plan, &data["keymap"], &empty)?;
    let mut km = merge_keymap(&empty.keymap, &data["keymap"])?;
    collab["settings"] = self::settings(&plan["effort"])?;
    collab["remote_settings"] = self::settings(wire)?;
    collab["version"] = data["version"].clone();
    km["collab"] = collab;
    let (path, lock) = stores.join_worktree(repo, &plan, membership)?;
    let existing = lock.read()?;
    if existing.sha.is_some() {
        return Err("the coordinator worktree already has plan files".into());
    }
    let display = |s: &str| {
        use unicode_general_category::{GeneralCategory::*, get_general_category};
        s.chars()
            .filter(|c| {
                !matches!(
                    get_general_category(*c),
                    Control | Format | Surrogate | LineSeparator | ParagraphSeparator
                )
            })
            .collect::<String>()
            .trim()
            .chars()
            .take(120)
            .collect::<String>()
    };
    lock.save_pair(
        &plan,
        &km,
        None,
        Some(&format!(
            "# {} by {}\n",
            display(name),
            display(field(row, "owner")?)
        )),
    )?;
    Ok(format!(
        "Joined {}\nThe owner keeps merge points, ship points, and deploys.",
        path.display()
    ))
}

fn merge_pending(
    before: Option<&Value>,
    after: Option<&Value>,
    remote: Option<&Value>,
) -> Result<Option<Value>> {
    if before == after {
        return Ok(remote.cloned());
    }
    if let (Some(Value::Object(b)), Some(Value::Object(a)), Some(Value::Object(r))) =
        (before, after, remote)
    {
        let mut result = r.clone();
        for key in b
            .keys()
            .chain(a.keys())
            .collect::<std::collections::BTreeSet<_>>()
        {
            match merge_pending(b.get(key), a.get(key), r.get(key))? {
                Some(value) => {
                    result.insert(key.clone(), value);
                }
                None => {
                    result.remove(key);
                }
            }
        }
        return Ok(Some(result.into()));
    }
    if remote != before && remote != after {
        return Err("the page also changed a pending keymap field".into());
    }
    Ok(after.cloned())
}

// Python json.dumps(sort_keys=True) is part of the saved load_attempt fingerprint.
fn python_json(v: &Value) -> String {
    match v {
        Value::Array(rows) => format!(
            "[{}]",
            rows.iter().map(python_json).collect::<Vec<_>>().join(", ")
        ),
        Value::Object(map) => {
            let sorted: std::collections::BTreeMap<_, _> = map.iter().collect();
            format!(
                "{{{}}}",
                sorted
                    .into_iter()
                    .map(|(k, v)| format!("{}: {}", python_json(&json!(k)), python_json(v)))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        }
        _ => v
            .to_string()
            .chars()
            .map(|c| {
                if c.is_ascii() && c != '\u{7f}' {
                    c.to_string()
                } else {
                    c.encode_utf16(&mut [0; 2])
                        .iter()
                        .map(|n| format!("\\u{n:04x}"))
                        .collect()
                }
            })
            .collect(),
    }
}

fn publish_pending(
    page: &Page,
    lock: &dyn LockedEffort,
    local: &LocalEffort,
    stores: &dyn Collaboration,
    scope: &str,
) -> Result<()> {
    let c = &local.keymap["collab"];
    let Some(base) = c.get("pending") else {
        return Ok(());
    };
    if local.sha.is_none() || local.sha.as_deref() != c["plan_sha"].as_str() {
        return Err("plan.json has local changes; run wg load --apply".into());
    }
    let mut wire = local.plan.clone();
    if let Some(settings) = c.get("remote_settings") {
        wire["effort"] = select(&wire["effort"], &["name", "summary"]);
        extend(&mut wire["effort"], settings)?;
    }
    let new = shared(&local.keymap)?;
    let put = |version: u64, mapping: &Value| -> Result<(u16, Vec<u8>)> {
        response(
            project_request(page, c, Method::PUT, &["plan"])?
                .header("If-Match", format!("\"{version}\""))
                .header("Content-Type", "application/json")
                .body(json!({"plan":wire,"keymap":mapping}).to_string()),
        )
    };
    let mut after = local.keymap.clone();
    let (mut status, mut bytes) = put(c["version"].as_u64().ok_or("invalid version")?, &new)?;
    if status == 412 {
        let remote = fetch(page, c, false)?.ok_or("shared version conflict")?;
        if remote["plan"] != wire {
            return Err("the remote plan has changed".into());
        }
        let mut checked = local.plan.clone();
        validate(stores, scope, c, &mut checked, &remote["keymap"], local)?;
        let incoming = shared(&remote["keymap"])?;
        let merged = merge_pending(Some(base), Some(&new), Some(&incoming))?
            .ok_or("invalid pending mapping")?;
        after = merge_keymap(&after, &merged)?;
        (status, bytes) = put(
            remote["version"].as_u64().ok_or("invalid version")?,
            &shared(&after)?,
        )?;
    }
    check(status)?;
    let reply: Value = serde_json::from_slice(&bytes).map_err(|_| "invalid remote version")?;
    let c = after["collab"]
        .as_object_mut()
        .ok_or("invalid collaboration")?;
    c.insert(
        "version".into(),
        json!(reply["version"].as_u64().ok_or("invalid remote version")?),
    );
    c.remove("pending");
    c.remove("load_attempt");
    lock.save_keymap(&after)
}

fn pull(
    page: &Page,
    stores: &dyn Collaboration,
    lock: &dyn LockedEffort,
    local: LocalEffort,
    scope: &str,
    force: bool,
    accept: bool,
) -> Result<String> {
    let mut c = local.keymap["collab"].clone();
    if !c["settings"].is_object() {
        c["name"] = local.plan["effort"]["name"].clone();
        c["settings"] = settings(&local.plan["effort"])?;
    }
    let Some(data) = fetch(page, &c, force || accept)? else {
        if let Err(e) = publish_pending(page, lock, &local, stores, scope) {
            eprintln!("warn: pending keymap changes: {e}");
        }
        return Ok(format!("plan v{} is current", c["version"]));
    };
    let wire = &data["plan"];
    let version = &data["version"];
    let mut writer = data["writer"].as_str().map(str::to_owned);
    if writer.is_none()
        && let Ok(history) = json_response(project_request(
            page,
            &c,
            Method::GET,
            &["plan", "versions"],
        )?)
    {
        writer = history["versions"]
            .as_array()
            .and_then(|rows| rows.iter().find(|r| r["version"] == *version))
            .and_then(|r| r["writer"].as_str())
            .map(str::to_owned);
    }
    let writer: String = writer
        .as_deref()
        .unwrap_or("an unknown writer")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .filter(|c| !c.is_control())
        .collect();
    let dirty = local.sha.is_none() || local.sha.as_deref() != c["plan_sha"].as_str();
    let saved = local.sha.is_some() && local.sha.as_deref() == c["load_attempt"]["sha"].as_str();
    let recovered = saved
        && c["load_attempt"]["payload"]
            == format!(
                "{:x}",
                Sha256::digest(python_json(
                    &json!({"plan":wire,"keymap":shared(&data["keymap"])?})
                ))
            );
    if dirty && !(force || saved || accept && *version == c["version"]) {
        return Err(format!(
            "the server has plan v{version} by {writer}; save your change before running wg pull --force"
        ));
    }
    let remote_settings = settings(&wire["effort"])?;
    let mut lines = vec![];
    for (key, value) in obj(&remote_settings)? {
        if c["settings"].get(key) != Some(value) {
            lines.push(if accept {
                format!(
                    "note effort.{key} from {writer}: accepted {value} (local value was {})",
                    c["settings"][key]
                )
            } else {
                format!("note effort.{key} from {writer}: kept the local setting")
            });
        }
    }
    if accept {
        extend(&mut c["settings"], &remote_settings)?;
    }
    let mut plan = if dirty && accept && *version == c["version"] && !force {
        local.plan.clone()
    } else {
        wire.clone()
    };
    plan["effort"] = select(&plan["effort"], &["name", "summary"]);
    extend(&mut plan["effort"], &c["settings"])?;
    validate(stores, scope, &c, &mut plan, &data["keymap"], &local)?;
    let mut after = merge_keymap(&local.keymap, &data["keymap"])?;
    if let Some(base) = c.get("pending") {
        let incoming = shared(&after)?;
        let merged = merge_pending(Some(base), Some(&shared(&local.keymap)?), Some(&incoming))?
            .ok_or("invalid pending mapping")?;
        after = merge_keymap(&after, &merged)?;
        c["pending"] = incoming;
    }
    c["remote_settings"] = remote_settings;
    c["version"] = version.clone();
    c.as_object_mut()
        .ok_or("invalid collaboration")?
        .remove("load_attempt");
    after["collab"] = c;
    if dirty && saved && !(force || recovered) {
        lock.backup_conflict(
            local.sha.as_deref().ok_or("missing plan hash")?,
            &local.plan,
        )?;
    }
    lock.save_pair(&plan, &after, local.sha.as_deref(), None)?;
    if after["collab"].get("pending").is_some() {
        let current = lock.read()?;
        if let Err(e) = publish_pending(page, lock, &current, stores, scope) {
            eprintln!("warn: pending keymap changes: {e}");
        }
    }
    if dirty && force && !recovered {
        lines.push("discarded local plan changes".into());
    }
    lines.push(format!("note plan v{version} by {writer}"));
    Ok(lines.join("\n"))
}
