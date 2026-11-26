"""Exercise two real release builds through the managed launcher, entirely offline."""
import concurrent.futures
import http.server
import json
import os
from pathlib import Path
import runpy
import shutil
import subprocess
import sys
import tarfile
import tempfile
import threading
import time

REPO = Path(__file__).resolve().parents[2]
CARGO, TARGET = sys.argv[1:]
OLD, NEW = "1.2.0", "1.3.0"
SKILL, PLUGIN = "skills/work-graph/SKILL.md", "orca-plugin/orca-plugin.json"
DISCOVERY = "/repos/fixture/release/releases/latest"
PREFIX = f"wg-v{NEW}-{TARGET}"
ASSETS = f"/fixture/release/releases/download/wg-v{NEW}/{PREFIX}"


class Service(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.server.requests.append(self.path)
        body = self.server.responses.get(self.path)
        if body is None:
            self.send_error(404)
            return
        if self.path.endswith(".tar.gz"):
            self.server.archive_requested.set()
            if not self.server.release_archive.wait(10):
                self.send_error(503)
                return
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def make_release(directory, key, port, version):
    env = dict(os.environ, WG_RELEASE_REPOSITORY="fixture/release", WG_RELEASE_PUBLIC_KEY=key,
               WG_RELEASE_VERSION=version, WG_FIXTURE_PORT=str(port))
    lines = subprocess.check_output(
        [CARGO, "build", "--locked", "--offline", "--bin", "wg-preview", "--target", TARGET,
         "--features", "update-fixture", "--message-format=json"],
        cwd=REPO / "cli", env=env, text=True).splitlines()
    binary = next(Path(msg["executable"]) for msg in map(json.loads, lines) if msg.get("executable"))
    directory.mkdir()
    archive, manifest = directory / "bundle.tar.gz", directory / "manifest.json"
    resources = {name: (0o644, f"{name} {version}\n".encode()) for name in [SKILL, PLUGIN]}
    pack = runpy.run_path(str(REPO / "packaging/releases/package.py"))["build"]
    pack(archive, manifest, resources, dict(schema=1, version=version, target=TARGET,
         commit="a"*40, public_key=key), binary)
    subprocess.run(["openssl", "pkeyutl", "-sign", "-rawin", "-inkey", directory.parent / "key.pem",
                    "-in", manifest, "-out", directory / "manifest.sig"], check=True)
    (directory / "signer").write_text(key)


def install_generation(release, destination):
    destination.mkdir(parents=True)
    with tarfile.open(release / "bundle.tar.gz") as bundle:
        for member in bundle:
            path = destination / member.name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(bundle.extractfile(member).read())
            path.chmod(member.mode)
    for name in ["manifest.json", "manifest.sig", "signer"]:
        shutil.copyfile(release / name, destination / name)


def wait_for(condition):
    deadline = time.monotonic() + 15
    while not condition():
        if time.monotonic() >= deadline:
            raise AssertionError("timed out waiting for update")
        time.sleep(.03)


def trial(temp, server):
    keyfile = temp / "key.pem"
    subprocess.run(["openssl", "genpkey", "-algorithm", "Ed25519", "-out", keyfile], check=True)
    key = subprocess.check_output(["openssl", "pkey", "-in", keyfile, "-pubout", "-outform", "DER"])[-32:].hex()
    for version in [OLD, NEW]:
        make_release(temp / version, key, server.server_port, version)
    server.responses[DISCOVERY] = json.dumps(dict(tag_name=f"wg-v{NEW}", draft=False, prerelease=False)).encode()
    for suffix, name in [(".json", "manifest.json"), (".sig", "manifest.sig"), (".tar.gz", "bundle.tar.gz")]:
        server.responses[ASSETS + suffix] = (temp / NEW / name).read_bytes()

    home = temp / "home"
    root = home / ".local/share/work-graph"
    old, new = [Path(f"versions/{v}-{TARGET}") for v in [OLD, NEW]]
    install_generation(temp / OLD, root / old)
    current, previous = root / "current", root / "previous"
    current.symlink_to(old)
    inactive = Path(f"versions/1.0.0-{TARGET}")
    (root / inactive).mkdir()
    edit = root / inactive / "local-edit"
    edit.write_text("preserve me")
    previous.symlink_to(inactive)
    launcher = home / ".local/bin/wg"
    launcher.parent.mkdir(parents=True)
    launcher.symlink_to(current / "wg")
    env = dict(os.environ, HOME=str(home), NO_PROXY="127.0.0.1", no_proxy="127.0.0.1")
    for name in ["WG_UPDATE", "WG_UPDATE_PIN"]:
        env.pop(name, None)

    def invoke(*args, **settings):
        p = subprocess.run([launcher, *args], capture_output=True, env=dict(env, **settings), timeout=12)
        return p.returncode, p.stdout, p.stderr

    def assert_version(version):
        assert invoke("--version") == (0, f"wg {version} {TARGET}\n".encode(), b"")
        for name in [SKILL, PLUGIN]:
            assert (current / name).read_bytes() == f"{name} {version}\n".encode()

    stamp = root / "update-check"
    def concurrent_starts():
        with concurrent.futures.ThreadPoolExecutor(6) as pool:
            results = list(pool.map(lambda _: invoke("--version"), range(12)))
        assert results == [(0, f"wg {OLD} {TARGET}\n".encode(), b"")] * 12

    baseline = invoke("invalid-fixture-command", WG_UPDATE="off")
    assert baseline[0] != 0 and not stamp.exists()
    original = server.responses[ASSETS + ".tar.gz"]
    server.responses[ASSETS + ".tar.gz"] = b"damaged"
    assert invoke("invalid-fixture-command") == baseline
    assert server.archive_requested.wait(10)
    concurrent_starts()
    server.release_archive.set()
    # A direct synchronous worker after a failed attempt must also honor the stamp.
    assert invoke("--wg-background-update")[0] == 0
    concurrent_starts()
    assert server.requests.count(DISCOVERY) == 1
    assert_version(OLD)
    assert not (root / new).exists()
    assert previous.readlink() == inactive

    server.responses[ASSETS + ".tar.gz"] = original
    server.archive_requested.clear()
    server.release_archive.clear()
    os.utime(stamp, (1, 1))
    assert invoke("invalid-fixture-command") == baseline
    assert server.archive_requested.wait(10)
    concurrent_starts()
    assert current.readlink() == old
    server.release_archive.set()
    wait_for(lambda: current.readlink() == new)
    assert_version(NEW)
    assert previous.readlink() == old
    assert edit.read_text() == "preserve me"
    assert server.requests == [DISCOVERY, ASSETS+".json", ASSETS+".sig", ASSETS+".tar.gz"] * 2

    old_skill = root / old / SKILL
    saved = old_skill.read_bytes()
    old_skill.write_bytes(b"local change")
    assert invoke("update", "rollback")[0] != 0
    assert_version(NEW)
    assert old_skill.read_bytes() == b"local change"
    old_skill.write_bytes(saved)
    assert invoke("update", "rollback") == (0, b"", b"")
    assert_version(OLD)
    assert (root / "update-hold").is_file()

    # Reconstruct the state left by interruption after the version directory
    # rename. A damaged existing generation must survive a failed retry intact.
    (root / "update-hold").unlink()
    os.utime(stamp, (1, 1))
    staged_plugin = root / new / PLUGIN
    original_plugin = staged_plugin.read_bytes()
    staged_plugin.write_bytes(b"preserved edit")
    assert invoke("--wg-background-update")[0] == 0
    assert_version(OLD)
    assert staged_plugin.read_bytes() == b"preserved edit"
    staged_plugin.write_bytes(original_plugin)
    os.utime(stamp, (1, 1))
    assert invoke("--wg-background-update")[0] == 0
    assert_version(NEW)
    assert previous.readlink() == old
    assert server.requests.count(DISCOVERY) == 4


with tempfile.TemporaryDirectory() as temp, http.server.ThreadingHTTPServer(("127.0.0.1", 0), Service) as service:
    service.requests, service.responses = [], {}
    service.archive_requested, service.release_archive = threading.Event(), threading.Event()
    threading.Thread(target=service.serve_forever, daemon=True).start()
    try:
        trial(Path(temp), service)
    finally:
        service.shutdown()
