use crate::{
    page::{LocalEffort, LockedEffort, Result},
    state::{self, PlanLock},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
};

pub(crate) struct Effort<G = PlanLock> {
    dir: PathBuf,
    guard: G,
}
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn digest(raw: &[u8]) -> String {
    format!("{:x}", Sha256::digest(raw))
}
impl Effort {
    pub fn open(dir: &Path) -> Result<Self> {
        let guard = PlanLock::acquire(dir, None).map_err(err)?;
        Ok(Self {
            dir: dir.into(),
            guard,
        })
    }
}
impl<G: std::borrow::Borrow<PlanLock>> Effort<G> {
    pub(crate) fn borrowed(dir: &Path, guard: G) -> Self {
        Self {
            dir: dir.to_path_buf(),
            guard,
        }
    }
    fn bytes(&self) -> Result<Option<Vec<u8>>> {
        match fs::read(self.dir.join("plan.json")) {
            Ok(v) => Ok(Some(v)),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(err(e)),
        }
    }
    fn finish(&self, km: &mut Value) -> Result<()> {
        let c = &mut km["collab"];
        if let Some(staged) = c.get("pull_pending") {
            let sha = self.bytes()?.map(|b| digest(&b));
            if sha.as_deref() != c["plan_sha"].as_str() {
                if sha.as_deref() != staged["prior"].as_str() {
                    return Err("plan.json changed during an interrupted pull".into());
                }
                self.guard
                    .borrow()
                    .save_plan(&staged["plan"])
                    .map_err(err)?;
            }
            if let Some(heading) = staged["heading"].as_str() {
                self.write_text("PLAN.md", heading.as_bytes())?;
            }
            c.as_object_mut()
                .ok_or("invalid collaboration")?
                .shift_remove("pull_pending");
            self.save_keymap(km)?;
        }
        Ok(())
    }
    fn load(&self, force: bool) -> Result<LocalEffort> {
        let mut keymap = self.keymap()?;
        if keymap.get("collab").is_some() {
            self.finish(&mut keymap)?
        }
        let bytes = self.bytes()?;
        let sha = bytes.as_ref().map(|b| digest(b));
        let plan = match bytes
            .as_deref()
            .map(serde_json::from_slice::<Value>)
            .transpose()
        {
            Ok(Some(p)) if p.is_object() => p,
            _ if force && keymap["collab"]["settings"].is_object() => {
                json!({"effort":keymap["collab"]["settings"]})
            }
            Ok(None) => Value::Null,
            _ => return Err("invalid plan.json".into()),
        };
        Ok(LocalEffort { plan, keymap, sha })
    }
    fn write_text(&self, name: &str, data: &[u8]) -> Result<()> {
        use std::os::unix::fs::PermissionsExt;
        let mut file = tempfile::NamedTempFile::new_in(&self.dir).map_err(err)?;
        file.write_all(data).map_err(err)?;
        file.as_file()
            .set_permissions(fs::Permissions::from_mode(0o644))
            .map_err(err)?;
        file.as_file().sync_all().map_err(err)?;
        file.persist(self.dir.join(name)).map_err(err)?;
        Ok(())
    }
}
impl<G: std::borrow::Borrow<PlanLock>> LockedEffort for Effort<G> {
    fn read(&self) -> Result<LocalEffort> {
        self.load(false)
    }
    fn read_forced(&self) -> Result<LocalEffort> {
        self.load(true)
    }
    fn keymap(&self) -> Result<Value> {
        state::load_keymap(&self.dir).map_err(err)
    }
    fn save_keymap(&self, km: &Value) -> Result<()> {
        self.guard.borrow().save_keymap(km).map_err(err)
    }
    fn save_pair(
        &self,
        plan: &Value,
        keymap: &Value,
        prior: Option<&str>,
        heading: Option<&str>,
    ) -> Result<()> {
        let mut raw = Vec::new();
        state::write_pretty_json(&mut raw, plan).map_err(err)?;
        let mut km = keymap.clone();
        km["collab"]["plan_sha"] = digest(&raw).into();
        km["collab"]["pull_pending"] = json!({"prior":prior,"plan":plan});
        if let Some(heading) = heading {
            km["collab"]["pull_pending"]["heading"] = heading.into();
        }
        self.save_keymap(&km)?;
        self.finish(&mut km)
    }
    fn backup_conflict(&self, sha: &str, plan: &Value) -> Result<()> {
        if !sha.bytes().all(|c| c.is_ascii_hexdigit()) || sha.len() != 64 {
            return Err("invalid digest".into());
        }
        let mut raw = Vec::new();
        state::write_pretty_json(&mut raw, plan).map_err(err)?;
        self.write_text(&format!("plan.conflict-{}.json", &sha[..12]), &raw)
    }
}
