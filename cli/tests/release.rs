use ed25519_dalek::{Signer, SigningKey};
use serde_json::json;
use wg_preview::release::{public_key, verify_manifest};

#[test]
fn rotation_requires_a_release_signed_by_the_current_key() {
    let old = SigningKey::from_bytes(&[11; 32]);
    let next = SigningKey::from_bytes(&[22; 32]);
    let key = |signer: &SigningKey| {
        signer
            .verifying_key()
            .to_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    };
    let target = "aarch64-apple-darwin";
    let make = |version: &str| {
        serde_json::to_vec(&json!({
            "schema": 1, "version": version, "target": target, "commit": "a".repeat(40),
            "sha256": "5".repeat(64), "public_key": key(&next),
            "files": {"wg": "6".repeat(64), "skills/work-graph/SKILL.md": "7".repeat(64),
                      "orca-plugin/orca-plugin.json": "8".repeat(64)}
        }))
        .unwrap()
    };
    let bridge = make("1.2.3");
    let signature = old.sign(&bridge).to_bytes();
    let pinned = public_key(&key(&old)).unwrap();
    let manifest = verify_manifest(&pinned, &bridge, &signature, "1.2.3", target).unwrap();
    let successor = public_key(&manifest.public_key).unwrap();
    let self_signed = next.sign(&bridge).to_bytes();
    assert!(verify_manifest(&pinned, &bridge, &self_signed, "1.2.3", target).is_err());
    let mut damaged = signature;
    damaged[0] ^= 1;
    assert!(verify_manifest(&pinned, &bridge, &damaged, "1.2.3", target).is_err());
    let release = make("1.2.4");
    let signed = next.sign(&release).to_bytes();
    assert!(verify_manifest(&successor, &release, &signed, "1.2.4", target).is_ok());
    assert!(verify_manifest(&pinned, &release, &signed, "1.2.4", target).is_err());
    assert!(verify_manifest(&pinned, &bridge, &signature, "1.2.4", target).is_err());
    assert!(verify_manifest(&pinned, &bridge, &signature, "1.2.3", "x86_64-apple-darwin").is_err());
    assert!(
        verify_manifest(
            &pinned,
            &[bridge, vec![10]].concat(),
            &signature,
            "1.2.3",
            target
        )
        .is_err()
    );
}

#[test]
fn publication_checks_native_results_and_signs_the_tested_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../packaging/releases/test_release.py");
    assert!(
        std::process::Command::new("python3")
            .arg("-I")
            .arg(script)
            .arg(dir.path())
            .status()
            .unwrap()
            .success()
    );
    let read = |name: &str| std::fs::read(dir.path().join(name)).unwrap();
    let root = public_key(std::str::from_utf8(&read("root.hex")).unwrap()).unwrap();
    let next = String::from_utf8(read("successor.hex")).unwrap();
    assert_ne!(public_key(&next).unwrap(), root);
    for target in wg_preview::release::TARGETS {
        let prefix = format!("signed/wg-v1.2.3-{target}");
        let manifest = verify_manifest(
            &root,
            &read(&format!("{prefix}.json")),
            &read(&format!("{prefix}.sig")),
            "1.2.3",
            target,
        )
        .unwrap();
        assert_eq!(manifest.public_key, next);
        let binary = dir.path().join(target).join("wg");
        wg_preview::release::verify_digest(
            std::fs::File::open(&binary).unwrap(),
            &manifest.files["wg"],
        )
        .unwrap();
        let output = std::process::Command::new(binary)
            .arg("--release-key")
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8(output.stdout).unwrap().trim(),
            manifest.public_key
        );
        let archive = read(&format!("{prefix}.tar.gz"));
        wg_preview::release::verify_digest(archive.as_slice(), &manifest.sha256).unwrap();
        assert!(wg_preview::release::verify_digest(&b"other"[..], &manifest.sha256).is_err());
    }
}
