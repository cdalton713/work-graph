"""Exercise the publication gate in an isolated Git repository with a fixture CLI."""
import base64
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

source = Path(__file__).resolve().parent
root = Path(sys.argv[1])
os.chdir(root)
tag = "wg-v1.2.3"
targets = ("aarch64-apple-darwin", "x86_64-apple-darwin",
           "aarch64-unknown-linux-gnu", "x86_64-unknown-linux-gnu")


def run(*args, success=True, stdin=None, env=None, expected_error=None):
    result = subprocess.run(args, input=stdin, env=env, capture_output=True)
    if (result.returncode == 0) != success:
        raise RuntimeError(f"{args[0]}: {result.returncode}: {result.stderr.decode()}")
    if expected_error and expected_error not in result.stderr.decode():
        raise AssertionError(f"missing error from {args[0]}: {expected_error}")
    return result.stdout


def write(name, content):
    path = Path(name)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)


def sign(output, pin, expected_error=None):
    env = dict(os.environ, WG_SIGNING_KEY=current_private.decode(), WG_CURRENT_PUBLIC_KEY=pin)
    run("bash", source / "sign.sh", tag, "artifacts", output, env=env,
        success=expected_error is None, expected_error=expected_error)


def disposable_key(signer):
    # RFC 8410 PKCS#8 v1 Ed25519 private key with a fresh 32-byte seed.
    der = bytes.fromhex("302e020100300506032b657004220420") + os.urandom(32)
    pem = b"-----BEGIN PRIVATE KEY-----\n" + base64.b64encode(der) + b"\n-----END PRIVATE KEY-----\n"
    public = run(signer, "--public-key", stdin=pem).decode().strip()
    return pem, public


run("git", "init", "-q")
write("skills/work-graph/SKILL.md", "tagged skill\n")
write("orca-plugin/orca-plugin.json", "{}\n")
write("tests/cli-parity/run.sh", 'set -eu\ncase "$1" in /*) ;; *) exit 1 ;; esac\n"$1" parity\n')
Path("packaging/releases").mkdir(parents=True)
shutil.copy(source / "package.py", "packaging/releases/package.py")
run("git", "add", "skills", "orca-plugin", "tests", "packaging")
run("git", "-c", "user.name=Fixture", "-c", "user.email=fixture@invalid",
    "commit", "-qm", "fixture")
run("git", "tag", tag)
write("skills/work-graph/SKILL.md", "dirty working copy\n")
build = run("cargo", "build", "--locked", "--manifest-path", source / "signer/Cargo.toml",
            "--target-dir", root / "build", "--message-format=json")
signer, = [event["executable"] for line in build.splitlines()
           if (event := json.loads(line)).get("executable")]
current_private, current = disposable_key(signer)
_, successor = disposable_key(signer)
os.environ.update(WG_RELEASE_PUBLIC_KEY=successor, WG_RELEASE_SIGNER=signer)
write("root.hex", current)
write("successor.hex", successor)
for target in targets:
    directory = Path("artifacts") / ("release-" + target)
    write("candidate", f"""#!/bin/sh
case "$1" in
  --release-key) echo {successor} ;;
  --version) echo 'wg 1.2.3 {target}' ;;
  parity) exit "${{FIXTURE_EXIT:-0}}" ;;
  *) exit 1 ;;
esac
""")
    command = [sys.executable, "-I", source / "package.py"]
    args = [tag, target, directory]
    run(*command, "build", *args, "--binary", "candidate")
    os.environ["FIXTURE_EXIT"] = "3"
    run(*command, "test", *args, "--extract", "failed-" + target, success=False)
    run(*command, "check", *args, success=False)
    del os.environ["FIXTURE_EXIT"]
    run(*command, "test", *args, "--extract", target)
    assert (Path(target) / "skills/work-graph/SKILL.md").read_text() == "tagged skill\n"

sign("wrong-pin", successor, expected_error="signing key differs from the current public key")
sign("signed", current)
archive = next(directory.glob("*.tar.gz"))
archive.write_bytes(archive.read_bytes() + b"x")
sign("tampered", current, expected_error="manifest differs from the tag, archive, or required member list")
