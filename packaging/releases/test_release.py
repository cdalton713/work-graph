"""Exercise the publication gate in an isolated Git repository with a fixture CLI."""
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


def run(*args, success=True):
    result = subprocess.run(args, capture_output=True)
    if (result.returncode == 0) != success:
        raise RuntimeError(f"{args[0]}: {result.returncode}: {result.stderr.decode()}")
    return result.stdout


def write(name, content):
    path = Path(name)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)


def sign(output, success=True):
    run("bash", source / "sign.sh", tag, "artifacts", output, success=success)


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
run("openssl", "genpkey", "-algorithm", "Ed25519", "-out", "private.pem")
der = run("openssl", "pkey", "-in", "private.pem", "-pubout", "-outform", "DER")
key = der[-32:].hex()
os.environ.update(WG_RELEASE_PUBLIC_KEY=key, WG_CURRENT_PUBLIC_KEY=key,
                  WG_SIGNING_KEY=Path("private.pem").read_text())
write("root.hex", key)
for target in targets:
    directory = Path("artifacts") / ("release-" + target)
    write("candidate", f"""#!/bin/sh
case "$1" in
  --release-key) echo {key} ;;
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

sign("signed")
archive = next(directory.glob("*.tar.gz"))
archive.write_bytes(archive.read_bytes() + b"x")
sign("tampered", success=False)
