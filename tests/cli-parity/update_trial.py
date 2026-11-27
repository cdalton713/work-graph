"""Exercise two real release builds through the managed launcher, entirely offline."""
import base64
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
OLD, NEW, LATEST = "1.2.0", "1.3.0", "1.4.0"
SKILL, PLUGIN = "skills/work-graph/SKILL.md", "orca-plugin/orca-plugin.json"
DISCOVERY = "/repos/fixture/release/releases/latest"
PREFIX = f"wg-v{NEW}-{TARGET}"
ASSETS = f"/fixture/release/releases/download/wg-v{NEW}/{PREFIX}"


class Service(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.server.requests.append(self.path)
        if self.path == getattr(self.server, "stalled_path", None):
            self.server.resume.wait(30)
            return
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


def disposable_key(signer):
    der = bytes.fromhex("302e020100300506032b657004220420") + os.urandom(32)
    pem = b"-----BEGIN PRIVATE KEY-----\n" + base64.b64encode(der) + b"\n-----END PRIVATE KEY-----\n"
    public = subprocess.check_output([signer, "--public-key"], input=pem).decode().strip()
    return pem, public


def make_release(directory, key, port, version, signer, signing_key):
    env = dict(os.environ, WG_RELEASE_REPOSITORY="fixture/release", WG_RELEASE_PUBLIC_KEY=key,
               WG_RELEASE_VERSION=version, WG_FIXTURE_PORT=str(port))
    lines = subprocess.check_output(
        [CARGO, "rustc", "--locked", "--offline", "--bin", "wg-preview", "--target", TARGET,
         "--features", "update-fixture", "--message-format=json", "--", "-C", "strip=debuginfo"],
        cwd=REPO / "cli", env=env, text=True).splitlines()
    binary = next(Path(msg["executable"]) for msg in map(json.loads, lines) if msg.get("executable"))
    print(f"{TARGET} {version} fixture binary {binary.stat().st_size} bytes", flush=True)
    directory.mkdir()
    archive, manifest = directory / "bundle.tar.gz", directory / "manifest.json"
    resources = {name: (0o644, f"{name} {version}\n".encode()) for name in [SKILL, PLUGIN]}
    plugin = json.loads((REPO / PLUGIN).read_text())
    plugin["version"] = OLD if version == OLD else NEW
    resources[PLUGIN] = (0o644, json.dumps(plugin).encode())
    resources["orca-plugin/src/worker.ts"] = (0o644, b"export default {}")
    script = "skills/work-graph/scripts/wg.py"
    resources[script] = (0o755, (REPO / script).read_bytes())
    pack = runpy.run_path(str(REPO / "packaging/releases/package.py"))["build"]
    pack(archive, manifest, resources, dict(schema=1, version=version, target=TARGET,
         commit="a"*40, public_key=key), binary)
    private, pin = signing_key
    sig = subprocess.check_output([signer, manifest], input=private, env=dict(os.environ, WG_CURRENT_PUBLIC_KEY=pin))
    (directory / "manifest.sig").write_bytes(sig)
    (directory / "signer").write_text(pin)



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
    build = subprocess.check_output([CARGO, "build", "--locked", "--manifest-path",
        REPO / "packaging/releases/signer/Cargo.toml", "--target-dir", REPO / "cli/target/signer-review-fixture", "--message-format=json"], text=True)
    signer, = [msg["executable"] for msg in map(json.loads, build.splitlines()) if msg.get("executable")]
    first, successor = disposable_key(signer), disposable_key(signer)
    for version, embedded, signing in [(OLD, first, first), (NEW, successor, first), (LATEST, successor, successor)]:
        make_release(temp / version, embedded[1], server.server_port, version, signer, signing)
    server.responses[DISCOVERY] = json.dumps(dict(tag_name=f"wg-v{NEW}", draft=False, prerelease=False)).encode()
    for suffix, name in [(".json", "manifest.json"), (".sig", "manifest.sig"), (".tar.gz", "bundle.tar.gz")]:
        server.responses[ASSETS + suffix] = (temp / NEW / name).read_bytes()

    if os.environ.get("WG_NATIVE_UPGRADE_TRIAL") == "1":
        native = runpy.run_path(str(REPO / "tests/cli-upgrade/native.py"))
        native["trial"](temp, server, REPO, TARGET, OLD, NEW, LATEST, first[1], successor[1],
                        DISCOVERY, wait_for)
        server.requests.clear()

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
        assert (current / SKILL).read_text() == f"{SKILL} {version}\n"
        assert json.loads((current / PLUGIN).read_bytes())["version"] == (OLD if version == OLD else NEW)

    stamp = root / "update-check"
    def concurrent_starts():
        with concurrent.futures.ThreadPoolExecutor(6) as pool:
            results = list(pool.map(lambda _: invoke("--version"), range(12)))
        assert results == [(0, f"wg {OLD} {TARGET}\n".encode(), b"")] * 12

    baseline = invoke("invalid-fixture-command", WG_UPDATE="off")
    assert baseline[0] != 0 and not stamp.exists()
    registration = home / "registration.json"
    approval = home / "approval.json"
    mock = REPO / "tests/cli-parity/update_orca_fixture.py"
    def inspect_plugin():
        return subprocess.check_output([sys.executable, mock, "plugin", "inspect", current/"orca-plugin", "--json"], env=env)
    if os.environ.get("ORCA_CLI_COMMAND"):
        env["FIXTURE_INSPECT_CLI"] = os.environ["ORCA_CLI_COMMAND"]
    initial_hash = json.loads(inspect_plugin())["result"]["contentHash"]
    registration.write_text(json.dumps(dict(reference=str(current/"orca-plugin"), contentHash=initial_hash)))
    approval.write_text(json.dumps({"local.wg-agents": initial_hash}))
    choices = registration.read_bytes(), approval.read_bytes()
    def agents(expected, profile=home):
        proc = subprocess.run([sys.executable, "-I", current/"skills/work-graph/scripts/wg.py", "agents", "--install"],
            env=dict(env, HOME=str(profile), ORCA_CLI_COMMAND=str(mock)), capture_output=True)
        assert proc.returncode == expected, (proc.stdout,proc.stderr)
        assert (b"--approve" in proc.stdout) == bool(expected)
        assert choices == (registration.read_bytes(), approval.read_bytes())
    agents(0)
    root.chmod(0o555)
    try:
        assert invoke("invalid-fixture-command") == baseline
        assert b"read-only" in invoke("update", "status")[1]
        assert not stamp.exists() and not server.requests
    finally:
        root.chmod(0o700)
    (root / old / "empty-local-dir").mkdir()
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

    agents(3)
    assert b"wg agents --install" in invoke("update", "status")[1]
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
    agents(0)

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

    def run_check(**settings):
        os.utime(stamp, (1, 1))
        assert invoke("--wg-background-update", **settings)[0] == 0
        return invoke("update", "status")[1]

    def info(tag, prerelease=False):
        return dict(tag_name=tag, draft=False, prerelease=prerelease)

    # Old skipped the bridge. Latest advertises a new key. Only the old
    # embedded key can authenticate the intermediate release.
    assert invoke("update", "rollback")[0] == 0
    (root / "update-hold").unlink()
    last_prefix = ASSETS.replace(NEW, LATEST)
    for ext, file in [(".json","manifest.json"),(".sig","manifest.sig"),(".tar.gz","bundle.tar.gz")]:
        server.responses[last_prefix + ext] = (temp/LATEST/file).read_bytes()
    latest = info(f"wg-v{LATEST}")
    server.responses[DISCOVERY] = json.dumps(latest).encode()
    server.responses["/repos/fixture/release/releases?per_page=100"] = json.dumps([
        latest, info("unrelated"), info("wg-v1.3.8", True), info("wg-v1.3.5-rc.1"), info(f"wg-v{NEW}")]).encode()
    requests = len(server.requests)
    assert b"Invalid release pin" in run_check(WG_UPDATE_PIN="../invalid")
    assert len(server.requests) == requests
    pin_endpoint = "/repos/fixture/release/releases/tags/wg-v" + LATEST
    for tag in [info("unrelated"), info(f"wg-v{LATEST}", True), info(f"wg-v{NEW}")]:
        server.responses[pin_endpoint] = json.dumps(tag).encode()
        assert b"No " in run_check(WG_UPDATE_PIN=LATEST)
        assert_version(OLD)
    old_skill.write_bytes(b"local edit")
    assert b"Active release has local changes" in run_check()
    assert old_skill.read_bytes() == b"local edit"
    old_skill.write_bytes(saved)

    unowned = root / ".update-user"
    unowned.mkdir()
    abandoned = root / ".update-interrupted"
    abandoned.mkdir()
    identity = f"{abandoned.name} {abandoned.stat().st_dev} {abandoned.stat().st_ino}"
    (abandoned / "owner").write_text(identity)
    (root / "update-work").write_text(identity)
    (abandoned / "partial").write_bytes(b"partial")
    assert b"Installed verified release" in run_check()
    assert not abandoned.exists() and unowned.is_dir()
    assert_version(NEW)
    assert all("1.3.8" not in path and "-rc.1" not in path for path in server.requests)
    server.responses[pin_endpoint] = json.dumps(latest).encode()
    bridge_hash = json.loads(inspect_plugin())["result"]["contentHash"]
    # An independent profile already consents to the bridge plugin. This trial
    # never submits an approval through either the updater or the agents CLI.
    second_profile = temp / "second-profile"
    second_profile.mkdir()
    registration2 = second_profile / "registration.json"
    approval2 = second_profile / "approval.json"
    registration2.write_text(json.dumps(dict(reference=str(current/"orca-plugin"), contentHash=bridge_hash)))
    approval2.write_text(json.dumps({"local.wg-agents": bridge_hash}))
    second_choices = registration2.read_bytes(), approval2.read_bytes()
    agents(0, second_profile)
    assert b"Installed verified release" in run_check(WG_UPDATE_PIN=LATEST)
    assert_version(LATEST)
    agents(3)
    assert (current / PLUGIN).read_bytes() == (root / new / PLUGIN).read_bytes()
    # Both releases name the same plugin bytes. Its hash and approval
    # decision stay the same across the binary-only transition.
    after = json.loads(inspect_plugin())["result"]["contentHash"]
    assert after == bridge_hash
    agents(0, second_profile)
    assert second_choices == (registration2.read_bytes(), approval2.read_bytes())
    assert choices == (registration.read_bytes(), approval.read_bytes())
    assert invoke("update", "rollback")[0] == 0
    assert_version(NEW)
    (root / "update-hold").unlink()
    assert b"Installed verified release" in run_check()
    assert_version(LATEST)
    server.shutdown()
    server.server_close()
    assert b"Release service unavailable." in run_check()
    assert_version(LATEST)



with tempfile.TemporaryDirectory() as temp, http.server.ThreadingHTTPServer(("127.0.0.1", 0), Service) as service:
    service.requests, service.responses = [], {}
    service.archive_requested, service.release_archive = threading.Event(), threading.Event()
    threading.Thread(target=service.serve_forever, daemon=True).start()
    try:
        trial(Path(temp), service)
    finally:
        service.shutdown()
