"""Build and check one release from Git blobs and a native executable."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile

TARGETS = ("x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu",
           "x86_64-apple-darwin", "aarch64-apple-darwin")
NUMBER = r"(?:0|[1-9][0-9]*)"
TAG = re.compile(rf"wg-v{NUMBER}\.{NUMBER}\.{NUMBER}(?:-rc\.{NUMBER})?")


def sha(data):
    return hashlib.sha256(data).hexdigest()


def git(*args):
    return subprocess.check_output(["git", *args])


def resources(commit):
    files = {}
    for row in git("ls-tree", "-rz", commit, "--", "skills/work-graph", "orca-plugin").split(b"\0"):
        if not row:
            continue
        entry, name = row.split(b"\t", 1)
        mode, kind, oid = entry.decode().split()
        if kind != "blob" or mode not in ("100644", "100755"):
            raise ValueError(f"unsupported resource {row!r}")
        files[name.decode()] = (int(mode[-3:], 8), git("cat-file", "blob", oid))
    for name in ("skills/work-graph/SKILL.md", "orca-plugin/orca-plugin.json"):
        if name not in files:
            raise ValueError(f"missing resource {name}")
    return files


def build(archive, manifest, expected, header, binary):
    files = {"wg": (0o755, binary.read_bytes()), **expected}
    with tarfile.open(archive, "w:gz") as tar:
        for name, (mode, data) in files.items():
            member = tarfile.TarInfo(name)
            member.mode, member.size = mode, len(data)
            tar.addfile(member, io.BytesIO(data))
    metadata = dict(header, sha256=sha(archive.read_bytes()),
                    files={name: sha(data) for name, (_, data) in files.items()})
    manifest.write_text(json.dumps(metadata, sort_keys=True, indent=2) + "\n", encoding="utf-8")


def check(archive, manifest, expected, header, destination=None):
    data = archive.read_bytes()
    metadata = json.loads(manifest.read_bytes())
    names = {"wg", *expected}
    if metadata != dict(header, sha256=sha(data), files=metadata["files"]) or set(metadata["files"]) != names:
        raise ValueError("manifest differs from the tag, archive, or required member list")
    seen = set()
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
        for member in tar:
            name = member.name
            if name not in names or name in seen or not member.isfile():
                raise ValueError(f"unexpected member {name}")
            content = tar.extractfile(member).read()
            mode = 0o755 if name == "wg" else expected[name][0]
            if (member.mode != mode or sha(content) != metadata["files"][name]
                    or (name != "wg" and content != expected[name][1])):
                raise ValueError(f"incorrect content or mode for {name}")
            if destination:
                path = destination / name
                path.parent.mkdir(parents=True, exist_ok=True)
                with path.open("xb") as output:
                    output.write(content)
                path.chmod(mode)
            seen.add(name)
    if seen != names:
        raise ValueError("incomplete archive")
    return metadata["sha256"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("build", "test", "check"))
    parser.add_argument("tag")
    parser.add_argument("target", choices=TARGETS)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--binary", type=Path)
    parser.add_argument("--extract", type=Path)
    args = parser.parse_args()
    if not TAG.fullmatch(args.tag):
        parser.error("expected wg-vMAJOR.MINOR.PATCH with optional -rc.N")
    commit = git("rev-parse", "refs/tags/" + args.tag + "^{commit}").decode().strip()
    if commit != git("rev-parse", "HEAD").decode().strip():
        parser.error("checkout differs from release tag")
    version = args.tag.removeprefix("wg-v")
    key = os.environ["WG_RELEASE_PUBLIC_KEY"]
    if not re.fullmatch("[0-9a-f]{64}", key):
        parser.error("expected lowercase hexadecimal public key")
    header = dict(schema=1, version=version, target=args.target, commit=commit, public_key=key)
    prefix = args.directory / f"{args.tag}-{args.target}"
    archive, manifest, result, log = [Path(str(prefix) + suffix)
                                     for suffix in (".tar.gz", ".json", ".parity.json", ".parity.log")]
    expected = resources(commit)
    if args.operation == "build":
        args.directory.mkdir(parents=True, exist_ok=True)
        build(archive, manifest, expected, header, args.binary)
        return
    if args.operation == "test":
        args.extract.mkdir(parents=True, exist_ok=False)
    digest = check(archive, manifest, expected, header, args.extract)
    evidence = dict(target=args.target, commit=commit, sha256=digest)
    if args.operation == "test":
        binary = args.extract.resolve() / "wg"
        for flag, value in [("--release-key", key), ("--version", f"wg {version} {args.target}")]:
            if subprocess.check_output([binary, flag], text=True).strip() != value:
                raise ValueError(f"packaged executable failed {flag}")
        with log.open("wb") as stream:
            run = subprocess.run(["sh", "tests/cli-parity/run.sh", binary],
                                 stdout=stream, stderr=subprocess.STDOUT)
        result.write_text(json.dumps(dict(evidence, exit=run.returncode, log_sha256=sha(log.read_bytes()))) + "\n")
        print(log.read_text(), end="")
        run.check_returncode()
    elif json.loads(result.read_bytes()) != dict(evidence, exit=0, log_sha256=sha(log.read_bytes())):
        raise ValueError("missing or mismatched passing parity result")


if __name__ == "__main__":
    main()
