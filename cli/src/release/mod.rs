//! Verification of the signed per-target release manifest.
use ed25519_dalek::{Signature, VerifyingKey};
use serde_derive::Deserialize;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, io::Read};

pub const TARGETS: [&str; 4] = [
    "aarch64-apple-darwin",
    "x86_64-apple-darwin",
    "aarch64-unknown-linux-gnu",
    "x86_64-unknown-linux-gnu",
];

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub schema: u32,
    pub version: String,
    pub target: String,
    pub commit: String,
    pub sha256: String,
    /// Public key embedded in the executable in this archive.
    pub public_key: String,
    pub files: BTreeMap<String, String>,
}

fn hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

pub fn public_key(raw: &str) -> Result<VerifyingKey, &'static str> {
    if !hex(raw, 64) {
        return Err("expected a lowercase hexadecimal Ed25519 public key");
    }
    let mut bytes = [0; 32];
    for (i, slot) in bytes.iter_mut().enumerate() {
        *slot = u8::from_str_radix(&raw[2 * i..2 * i + 2], 16).map_err(|_| "invalid key")?;
    }
    let key = VerifyingKey::from_bytes(&bytes).map_err(|_| "invalid Ed25519 key")?;
    if key.is_weak() {
        return Err("weak Ed25519 key");
    }
    Ok(key)
}

pub fn embedded_key() -> Result<VerifyingKey, &'static str> {
    public_key(option_env!("WG_RELEASE_PUBLIC_KEY").ok_or("no embedded release key")?)
}

/// Authenticate the original bytes before using any fields, including the successor key.
pub fn verify_manifest(
    key: &VerifyingKey,
    bytes: &[u8],
    signature: &[u8],
    version: &str,
    target: &str,
) -> Result<Manifest, &'static str> {
    let signature = Signature::from_slice(signature).map_err(|_| "invalid signature length")?;
    key.verify_strict(bytes, &signature)
        .map_err(|_| "release signature mismatch")?;
    let m: Manifest = serde_json::from_slice(bytes).map_err(|_| "invalid release manifest")?;
    if m.schema != 1 || m.version != version || m.target != target || !TARGETS.contains(&target) {
        return Err("unexpected release schema, version or target");
    }
    if !hex(&m.commit, 40) || !hex(&m.sha256, 64) {
        return Err("invalid release digest");
    }
    public_key(&m.public_key)?;
    for required in [
        "wg",
        "skills/work-graph/SKILL.md",
        "orca-plugin/orca-plugin.json",
    ] {
        if !m.files.contains_key(required) {
            return Err("missing release member");
        }
    }
    for (path, digest) in &m.files {
        if !(path == "wg"
            || path.starts_with("skills/work-graph/")
            || path.starts_with("orca-plugin/"))
            || path.contains(['\\', '\0'])
            || path.split('/').any(|p| matches!(p, "" | "." | ".."))
            || !hex(digest, 64)
        {
            return Err("invalid release member");
        }
    }
    Ok(m)
}

/// Use with the authenticated archive digest and each authenticated file digest.
pub fn verify_digest(mut reader: impl Read, expected: &str) -> std::io::Result<()> {
    let mut hash = Sha256::new();
    std::io::copy(&mut reader, &mut hash)?;
    if format!("{:x}", hash.finalize()) != expected {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "release digest mismatch",
        ));
    }
    Ok(())
}
