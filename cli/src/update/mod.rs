//! Managed release updates. WG_UPDATE=off disables checks. WG_UPDATE_PIN
//! restricts checks to one stable version. "wg update rollback" recovers the
//! previous generation and suspends checks until the update-hold file is removed.
use crate::release::{self, Manifest};
use std::{
    collections::BTreeSet,
    env,
    error::Error,
    fs::{self, File},
    io::{Read, Write},
    os::unix::fs::{MetadataExt, PermissionsExt, symlink},
    path::{Path, PathBuf},
    process::{Command, ExitCode, Stdio},
    time::{Duration, SystemTime},
};
use tempfile::{Builder, NamedTempFile};

type Result<T> = std::result::Result<T, Box<dyn Error>>;
const TARGET: &str = env!("WG_BUILD_TARGET");
const METADATA: u64 = 4 << 20;
const ARCHIVE: u64 = 128 << 20;
const LIMIT: u64 = 512 << 20;

fn stable(version: &str) -> Option<Vec<(usize, &str)>> {
    let parts: Vec<_> = version.split('.').collect();
    (parts.len() == 3
        && parts.iter().all(|p| {
            !p.is_empty()
                && p.bytes().all(|b| b.is_ascii_digit())
                && (p.len() == 1 || !p.starts_with('0'))
        }))
    .then(|| parts.into_iter().map(|p| (p.len(), p)).collect())
}

fn generation(version: &str) -> PathBuf {
    PathBuf::from(format!("versions/{version}-{TARGET}"))
}

fn managed(version: &str) -> Result<PathBuf> {
    let home = PathBuf::from(env::var_os("HOME").ok_or("no home")?);
    let root = home.join(".local/share/work-graph");
    if !home.is_absolute() || stable(version).is_none() {
        return Err("not managed".into());
    }
    for dir in [
        ".local",
        ".local/share",
        ".local/share/work-graph",
        ".local/share/work-graph/versions",
        ".local/bin",
    ] {
        if !home.join(dir).symlink_metadata()?.is_dir() {
            return Err("redirected installation".into());
        }
    }
    let active = root.join(generation(version));
    if !active.symlink_metadata()?.is_dir()
        || !active.join("wg").symlink_metadata()?.is_file()
        || fs::read_link(home.join(".local/bin/wg"))? != root.join("current/wg")
        || fs::read_link(root.join("current"))? != generation(version)
        || env::current_exe()?.canonicalize()? != active.join("wg").canonicalize()?
    {
        return Err("not the active installation".into());
    }
    Ok(root)
}

fn atomic(root: &Path, name: &str, data: &[u8]) -> Result<()> {
    let mut file = NamedTempFile::new_in(root)?;
    file.write_all(data)?;
    file.as_file().sync_all()?;
    file.persist(root.join(name))?;
    Ok(())
}

// The installer and updater lock the same root directory. Record the identity
// of the private scratch directory before writing any payload into it.
fn cleanup(root: &Path) -> Result<()> {
    let Ok(record) = read(root, "update-work", 256) else {
        return Ok(());
    };
    let record = std::str::from_utf8(&record)?;
    let fields: Vec<_> = record.split_whitespace().collect();
    if let [name, device, inode] = fields.as_slice()
        && name.strip_prefix(".update-").is_some_and(|suffix| {
            !suffix.is_empty() && suffix.bytes().all(|c| c.is_ascii_alphanumeric())
        })
    {
        let path = root.join(name);
        if let Ok(meta) = path.symlink_metadata()
            && meta.is_dir()
            && meta.dev().to_string() == *device
            && meta.ino().to_string() == *inode
            && read(&path, "owner", 256).ok().as_deref() == Some(record.as_bytes())
        {
            fs::remove_dir_all(path)?;
        }
    }
    Ok(())
}

fn scratch(root: &Path) -> Result<tempfile::TempDir> {
    cleanup(root)?;
    let tmp = Builder::new().prefix(".update-").tempdir_in(root)?;
    let meta = tmp.path().metadata()?;
    let record = format!(
        "{} {} {}",
        tmp.path().file_name().unwrap().to_string_lossy(),
        meta.dev(),
        meta.ino()
    );
    fs::write(tmp.path().join("owner"), &record)?;
    atomic(root, "update-work", record.as_bytes())?;
    Ok(tmp)
}

fn switch(root: &Path, scratch: &Path, name: &str, target: &Path) -> Result<()> {
    let path = scratch.join("link");
    symlink(target, &path)?;
    fs::rename(path, root.join(name))?;
    File::open(root)?.sync_all()?;
    Ok(())
}

fn limited(reader: impl Read, limit: u64) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err("size limit exceeded".into());
    }
    Ok(bytes)
}

fn read(dir: &Path, name: &str, limit: u64) -> Result<Vec<u8>> {
    let path = dir.join(name);
    if !path.symlink_metadata()?.is_file() {
        return Err("unexpected file type".into());
    }
    limited(File::open(path)?, limit)
}

fn inspect(root: &Path, link: &str) -> Result<(PathBuf, Manifest)> {
    let relative = fs::read_link(root.join(link))?;
    let manifest = inspect_generation(root, &relative)?;
    Ok((relative, manifest))
}

fn generation_version(relative: &Path) -> Result<&str> {
    let version = relative
        .to_str()
        .and_then(|s| s.strip_prefix("versions/"))
        .and_then(|s| s.strip_suffix(&format!("-{TARGET}")))
        .ok_or("invalid generation")?;
    stable(version).ok_or("invalid installed version")?;
    Ok(version)
}

fn inspect_generation(root: &Path, relative: &Path) -> Result<Manifest> {
    let version = generation_version(relative)?;
    let dir = root.join(relative);
    if !dir.symlink_metadata()?.is_dir() {
        return Err("redirected generation".into());
    }
    let signer = read(&dir, "signer", 64)?;
    let key = release::public_key(std::str::from_utf8(&signer)?)?;
    let manifest = release::verify_manifest(
        &key,
        &read(&dir, "manifest.json", METADATA)?,
        &read(&dir, "manifest.sig", 64)?,
        version,
        TARGET,
    )?;
    let mut pending = vec![dir.clone()];
    let mut count = 0;
    while let Some(parent) = pending.pop() {
        for entry in fs::read_dir(parent)? {
            let entry = entry?;
            let path = entry.path();
            let name = path
                .strip_prefix(&dir)?
                .to_str()
                .ok_or("invalid file name")?;
            if entry.file_type()?.is_dir() {
                pending.push(path);
            } else if !entry.file_type()?.is_file() {
                return Err("preserve redirected file".into());
            } else if !matches!(name, "signer" | "manifest.json" | "manifest.sig") {
                let digest = manifest.files.get(name).ok_or("preserve added file")?;
                release::verify_digest(File::open(path)?, digest)?;
                count += 1;
            }
        }
    }
    if dir.join("wg").metadata()?.permissions().mode() & 0o100 == 0 {
        return Err("binary is not executable".into());
    }
    if count != manifest.files.len() {
        return Err("incomplete generation".into());
    }
    Ok(manifest)
}

fn extract(dir: &Path, data: &[u8], manifest: &Manifest) -> Result<()> {
    release::verify_digest(data, &manifest.sha256)?;
    let decoder = flate2::read::GzDecoder::new(data);
    let mut tar = tar::Archive::new(decoder.take(LIMIT + 1));
    let mut seen = BTreeSet::new();
    let mut directories = BTreeSet::new();
    for entry in tar.entries()? {
        let mut entry = entry?;
        let name = String::from_utf8(entry.path_bytes().into_owned())?;
        let digest = manifest.files.get(&name).ok_or("unknown archive member")?;
        let mode = entry.header().mode()?;
        if !entry.header().entry_type().is_file()
            || !seen.insert(name.clone())
            || !matches!(mode, 0o644 | 0o755)
            || (name == "wg" && mode != 0o755)
        {
            return Err("invalid archive member".into());
        }
        let path = dir.join(name);
        let parent = path.parent().ok_or("invalid member")?;
        fs::create_dir_all(parent)?;
        directories.extend(
            parent
                .ancestors()
                .take_while(|p| p.starts_with(dir))
                .map(Path::to_owned),
        );
        let mut file = File::create_new(&path)?;
        std::io::copy(&mut entry, &mut file)?;
        release::verify_digest(File::open(&path)?, digest)?;
        file.set_permissions(fs::Permissions::from_mode(mode))?;
        file.sync_all()?;
    }
    if tar.into_inner().limit() == 0 || seen.len() != manifest.files.len() {
        return Err("incomplete archive".into());
    }
    for directory in directories.iter().rev() {
        File::open(directory)?.sync_all()?;
    }
    Ok(())
}

fn fetch(client: &reqwest::blocking::Client, url: String, limit: u64) -> Result<Vec<u8>> {
    limited(client.get(url).send()?.error_for_status()?, limit)
}

fn stable_tag(info: &serde_json::Value) -> Option<&str> {
    if info["draft"] != false || info["prerelease"] != false {
        return None;
    }
    let version = info["tag_name"].as_str()?.strip_prefix("wg-v")?;
    stable(version)?;
    Some(version)
}

struct Candidate {
    prefix: String,
    raw: Vec<u8>,
    signature: Vec<u8>,
    manifest: Manifest,
}

fn authenticate(
    client: &reqwest::blocking::Client,
    assets: &str,
    repo: &str,
    version: &str,
) -> Result<Candidate> {
    let tag = format!("wg-v{version}");
    let prefix = format!("{assets}/{repo}/releases/download/{tag}/{tag}-{TARGET}");
    let raw = fetch(client, format!("{prefix}.json"), METADATA)?;
    let signature = fetch(client, format!("{prefix}.sig"), 64)?;
    let manifest =
        release::verify_manifest(&release::embedded_key()?, &raw, &signature, version, TARGET)?;
    Ok(Candidate {
        prefix,
        raw,
        signature,
        manifest,
    })
}

fn check(root: &Path, version: &str, repo: &str) -> Result<&'static str> {
    let (api, assets) = (
        "https://api.github.com".to_owned(),
        "https://github.com".to_owned(),
    );
    #[cfg(all(debug_assertions, feature = "update-fixture"))]
    let (api, assets) = match option_env!("WG_FIXTURE_PORT") {
        Some(port) => {
            let origin = format!("http://127.0.0.1:{}", port.parse::<u16>()?);
            (origin.clone(), origin)
        }
        None => (api, assets),
    };
    let client = reqwest::blocking::Client::builder()
        .https_only(api.starts_with("https://"))
        .user_agent("wg-updater")
        .timeout(Duration::from_secs(12))
        .build()?;
    let pin = env::var("WG_UPDATE_PIN").ok();
    let endpoint = match &pin {
        Some(v) => {
            stable(v).ok_or("invalid pin")?;
            format!("tags/wg-v{v}")
        }
        None => "latest".to_owned(),
    };
    let bytes = fetch(
        &client,
        format!("{api}/repos/{repo}/releases/{endpoint}"),
        METADATA,
    )?;
    let info: serde_json::Value = serde_json::from_slice(&bytes)?;
    let Some(next) = stable_tag(&info) else {
        return Ok("No stable release selected.");
    };
    if pin.as_deref().is_some_and(|v| v != next) || stable(next) <= stable(version) {
        return Ok("No newer matching stable release.");
    }
    let candidate = match authenticate(&client, &assets, repo, next) {
        Ok(c) => c,
        Err(error) if error.to_string() == "release signature mismatch" && pin.is_none() => {
            // The old pin must authenticate every transition. Bound both the list
            // size and number of manifest requests, in addition to the watchdog.
            let list = fetch(
                &client,
                format!("{api}/repos/{repo}/releases?per_page=100"),
                METADATA,
            )?;
            let releases: Vec<serde_json::Value> = serde_json::from_slice(&list)?;
            let mut versions: Vec<_> = releases
                .iter()
                .filter_map(stable_tag)
                .filter(|v| stable(v) > stable(version) && stable(v) < stable(next))
                .collect();
            versions.sort_unstable_by_key(|v| std::cmp::Reverse(stable(v)));
            versions.dedup();
            versions
                .into_iter()
                .take(8)
                .find_map(|v| {
                    authenticate(&client, &assets, repo, v).ok().filter(|c| {
                        Some(c.manifest.public_key.as_str()) != option_env!("WG_RELEASE_PUBLIC_KEY")
                    })
                })
                .ok_or("no authenticated bridge")?
        }
        Err(e) => return Err(e),
    };
    let Candidate {
        prefix,
        raw,
        signature: sig,
        manifest,
    } = candidate;
    let next = &manifest.version;
    let archive = fetch(&client, format!("{prefix}.tar.gz"), ARCHIVE)?;
    let lock = File::open(root)?;
    lock.try_lock()?;
    managed(version)?;
    if root.join("update-hold").try_exists()? {
        return Ok("Updates are on hold.");
    }
    let scratch = scratch(root)?;
    let stage = scratch.path().join("release");
    fs::create_dir(&stage)?;
    extract(&stage, &archive, &manifest)?;
    for (flag, expected) in [
        ("--version", format!("wg {next} {TARGET}")),
        ("--release-key", manifest.public_key.clone()),
    ] {
        let out = Command::new(stage.join("wg"))
            .arg(flag)
            .env("WG_UPDATE", "off")
            .output()?;
        if !out.status.success() || out.stdout != format!("{expected}\n").as_bytes() {
            return Err("invalid release binary".into());
        }
    }
    let signer = option_env!("WG_RELEASE_PUBLIC_KEY").ok_or("missing key")?;
    for (name, bytes) in [
        ("manifest.json", raw.as_slice()),
        ("manifest.sig", &sig),
        ("signer", signer.as_bytes()),
    ] {
        atomic(&stage, name, bytes)?;
    }
    File::open(&stage)?.sync_all()?;
    let (current, m) = inspect(root, "current").map_err(|_| "active generation modified")?;
    if m.public_key != signer {
        return Err("active key mismatch".into());
    }
    match root.join("previous").symlink_metadata() {
        Ok(_) => {
            generation_version(&fs::read_link(root.join("previous"))?)?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    let dest = generation(next);
    let path = root.join(&dest);
    match path.symlink_metadata() {
        Ok(_) => {
            inspect_generation(root, &dest).map_err(|_| "existing generation modified")?;
            if read(&path, "manifest.json", METADATA)? != raw
                || read(&path, "manifest.sig", 64)? != sig
                || read(&path, "signer", 64)? != signer.as_bytes()
            {
                return Err("preserve existing version".into());
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => fs::rename(stage, &path)?,
        Err(e) => return Err(e.into()),
    }
    File::open(root.join("versions"))?.sync_all()?;
    plugin_notice(root, &m, &manifest)?;
    switch(root, scratch.path(), "previous", &current)?;
    switch(root, scratch.path(), "current", &dest)?;
    Ok("Installed verified release.")
}

fn same_plugin_files(former: &Manifest, next: &Manifest) -> bool {
    former
        .files
        .iter()
        .filter(|(p, _)| p.starts_with("orca-plugin/"))
        .eq(next
            .files
            .iter()
            .filter(|(p, _)| p.starts_with("orca-plugin/")))
}

pub(crate) fn retained_plugin_matches(reference: &Path) -> Result<bool> {
    let version = option_env!("WG_RELEASE_VERSION").ok_or("not a release")?;
    let root = managed(version)?.canonicalize()?;
    let Some(dir) = reference.parent() else {
        return Ok(false);
    };
    if reference.file_name() != Some("orca-plugin".as_ref())
        || dir.parent() != Some(root.join("versions").as_path())
        || reference != reference.canonicalize()?
    {
        return Ok(false);
    }
    let relative = dir.strip_prefix(&root)?;
    let (active_dir, active) = inspect(&root, "current")?;
    if active_dir == relative
        || Some(active.public_key.as_str()) != option_env!("WG_RELEASE_PUBLIC_KEY")
    {
        return Ok(false);
    }
    let retained = inspect_generation(&root, relative)?;
    Ok(same_plugin_files(&retained, &active))
}

fn plugin_notice(root: &Path, former: &Manifest, next: &Manifest) -> Result<()> {
    if !same_plugin_files(former, next) {
        atomic(root,"update-plugin-review", b"Plugin files changed. Run wg agents --install to review the registered plugin and any requested access.")?;
    }
    Ok(())
}

fn rollback(root: &Path, version: &str) -> Result<()> {
    let lock = File::open(root)?;
    lock.try_lock()?;
    managed(version)?;
    let (previous, manifest) = inspect(root, "previous")?;
    let work = scratch(root)?;
    if let Ok((_, active)) = inspect(root, "current") {
        plugin_notice(root, &active, &manifest)?;
    }

    atomic(root, "update-hold", b"rollback\n")?;
    switch(root, work.path(), "current", &previous)
}

fn due(root: &Path) -> Result<bool> {
    if env::var_os("WG_UPDATE").is_some_and(|v| v == "off")
        || root.join("update-hold").try_exists()?
    {
        return Ok(false);
    }
    let stamp = root.join("update-check");
    match stamp.symlink_metadata() {
        Ok(meta)
            if !meta.is_file()
                || SystemTime::now()
                    .duration_since(meta.modified()?)
                    .unwrap_or_default()
                    < Duration::from_secs(86400) =>
        {
            return Ok(false);
        }
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    Ok(true)
}

fn claim(root: &Path, version: &str) -> Result<bool> {
    let lock = File::open(root)?;
    lock.try_lock()?;
    managed(version)?;
    if !due(root)? {
        return Ok(false);
    }
    cleanup(root)?;
    atomic(root, "update-check", b"")?;
    atomic(
        root,
        "update-result",
        b"Check started. If interrupted, the current version remains usable.",
    )?;
    Ok(true)
}

fn schedule(root: &Path, version: &str) -> Result<()> {
    if !due(root)? {
        return Ok(());
    }
    if root.metadata()?.permissions().readonly() {
        return Ok(());
    }
    // Check effective write access (including read-only mounts) before spawning.
    drop(NamedTempFile::new_in(root)?);
    Command::new(root.join(generation(version)).join("wg"))
        .arg("--wg-background-update")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    Ok(())
}

pub fn on_start() -> Option<ExitCode> {
    let version = option_env!("WG_RELEASE_VERSION")?;
    let repo = option_env!("WG_RELEASE_REPOSITORY")?;
    let root = managed(version).ok()?;
    let mut args = env::args_os().skip(1);
    match (args.next().as_deref(), args.next().as_deref(), args.next()) {
        (Some(flag), None, None) if flag == "--wg-background-update" => {
            std::thread::spawn(|| {
                std::thread::sleep(Duration::from_secs(60));
                std::process::exit(1)
            });
            if claim(&root, version).unwrap_or(false) {
                let result = check(&root, version, repo);
                let message = match result {
                    Ok(message) => message,
                    Err(e) if e.is::<reqwest::Error>() => "Release service unavailable.",
                    Err(e) => match e.to_string().as_str() {
                        "active generation modified" => {
                            "Active release has local changes or is incomplete."
                        }
                        "existing generation modified" => {
                            "Existing candidate has local changes or is incomplete."
                        }
                        "no authenticated bridge" => {
                            "No verified key transition found. Pin a verified bridge release."
                        }
                        "invalid pin" => "Invalid release pin.",
                        _ => "Release verification or activation failed.",
                    },
                };
                let _ = atomic(&root, "update-result", message.as_bytes());
            }
            Some(ExitCode::SUCCESS)
        }
        (Some(cmd), Some(arg), None) if cmd == "update" && arg == "status" => {
            println!("Active version {version}");
            if root.metadata().is_ok_and(|m| m.permissions().readonly()) {
                println!("Installation is read-only.");
            }
            if root.join("update-hold").is_file() {
                println!("Updates are on hold.");
            }
            println!(
                "{}",
                String::from_utf8_lossy(
                    &read(&root, "update-result", 256)
                        .unwrap_or_else(|_| b"No recorded check.".to_vec())
                )
            );
            if root.join("update-plugin-review").is_file() {
                println!(
                    "Plugin files changed. Run wg agents --install to review the registered plugin and any requested access."
                );
            }
            Some(ExitCode::SUCCESS)
        }
        (Some(cmd), Some(arg), None) if cmd == "update" && arg == "rollback" => {
            Some(match rollback(&root, version) {
                Ok(()) => ExitCode::SUCCESS,
                Err(e) => {
                    eprintln!("rollback failed: {e}");
                    ExitCode::FAILURE
                }
            })
        }
        _ => {
            let _ = schedule(&root, version);
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    fn archive(names: &[&str]) -> Vec<u8> {
        let mut tar = tar::Builder::new(flate2::write::GzEncoder::new(
            Vec::new(),
            flate2::Compression::fast(),
        ));
        for &name in names {
            let mut header = tar::Header::new_gnu();
            header.set_mode(if name == "wg" { 0o755 } else { 0o644 });
            header.set_size(1);
            tar.append_data(&mut header, name, &b"x"[..]).unwrap();
        }
        tar.into_inner().unwrap().finish().unwrap()
    }

    #[test]
    fn stage_requires_the_complete_authenticated_set() {
        let members = [
            "wg",
            "orca-plugin/orca-plugin.json",
            "skills/work-graph/SKILL.md",
        ];
        let mut manifest = Manifest {
            schema: 1,
            version: "1.1.0".into(),
            target: TARGET.into(),
            commit: String::new(),
            public_key: String::new(),
            sha256: String::new(),
            files: members
                .iter()
                .map(|p| (p.to_string(), format!("{:x}", Sha256::digest(b"x"))))
                .collect(),
        };
        for (names, valid) in [
            (members.to_vec(), true),
            (members[..2].to_vec(), false),
            (vec!["wg", "wg"], false),
            (vec!["unexpected"], false),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let bytes = archive(&names);
            manifest.sha256 = format!("{:x}", Sha256::digest(&bytes));
            assert_eq!(extract(dir.path(), &bytes, &manifest).is_ok(), valid);
        }
        let bytes = archive(&members);
        let dir = tempfile::tempdir().unwrap();
        assert!(extract(dir.path(), &bytes, &manifest).is_err());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
        manifest.sha256 = format!("{:x}", Sha256::digest(&bytes));
        manifest.files.insert("wg".into(), "0".repeat(64));
        assert!(extract(dir.path(), &bytes, &manifest).is_err());
    }
}
