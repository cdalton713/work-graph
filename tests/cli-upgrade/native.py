"""Exercise the bootstrap, active effort, and consent through the installed binary."""
import hashlib
import json
import os
import shutil
import subprocess
import threading
import sys


def trial(temp, server, repo, target, old, new, latest, initial_pin, recovery_pin,
          discovery, wait_for, trial_timeout):
    home = temp / "native-home"
    home.mkdir()
    installer = temp / "installer"
    subprocess.run(["go", "build", "-o", installer, repo / "packaging/install/install.go"], check=True)
    # These pins come from the key generator and the trusted bootstrap build.
    installer_digest = hashlib.sha256(installer.read_bytes()).digest()
    root = home / ".local/share/work-graph"
    current = root / "current"
    launcher = home / ".local/bin/wg"
    mock = repo / "tests/cli-upgrade/orca.py"
    tools = temp / "native-bin"
    tools.mkdir()
    (tools / "python3").symlink_to(sys.executable)
    env = dict(HOME=str(home), PATH=str(tools),
               ORCA_CLI_COMMAND=str(mock), NO_PROXY="127.0.0.1")

    def bootstrap(version, pin, success=True):
        directory = temp / version
        for suffix, filename in [("json", "manifest.json"), ("sig", "manifest.sig"), ("tar.gz", "bundle.tar.gz")]:
            asset = directory / f"wg-v{version}-{target}.{suffix}"
            if not asset.exists():
                os.link(directory / filename, asset)
        assert hashlib.sha256(installer.read_bytes()).digest() == installer_digest
        p = subprocess.run([installer, "-version", version, "-assets", directory, "-key", pin],
                           env=env, capture_output=True)
        assert (p.returncode == 0) == success, p.stderr

    def wg(*args, code=0, updates=False):
        p = subprocess.run([launcher, *args], env=env if updates else dict(env, WG_UPDATE="off"),
                           capture_output=True, timeout=trial_timeout)
        assert p.returncode == code, (args, p.stdout, p.stderr)
        return p.stderr if code == 2 else p.stdout

    approval = home / "permission.json"
    registered = home / "registration.json"
    plugin = current / "orca-plugin"

    def permissions():
        return [p.read_bytes() if p.exists() else None for p in (approval, registered)]

    def check_generation(version):
        manifest = json.loads((temp / version / "manifest.json").read_bytes())
        assert current.readlink().name == f"{version}-{target}"
        for name, digest in manifest["files"].items():
            assert hashlib.sha256((current / name).read_bytes()).hexdigest() == digest, name

    def approve(version):
        check_generation(version)
        before = permissions()
        prompt = wg("agents", "--install", code=3)
        assert permissions() == before
        fingerprint = prompt.decode().split("wg agents --install --approve ")[1].split()[0]
        assert json.loads((plugin / "orca-plugin.json").read_bytes())["version"] == version
        wg("agents", "--install", "--approve", fingerprint)
        expected = plugin.resolve() if env.get("FIXTURE_CANONICAL") else plugin
        assert json.loads(registered.read_bytes()) == dict(reference=str(expected), contentHash=fingerprint)
        assert approval.read_text() == fingerprint
        assert b"installed and current" in wg("agents", "--install")
        return permissions()

    bootstrap(old, initial_pin)
    approve(old)
    source = json.loads(registered.read_bytes())
    checkout = shutil.copytree(plugin, temp / "checkout-plugin")
    registered.write_text(json.dumps(dict(source, reference=str(checkout))))
    before = permissions()
    fingerprint = source["contentHash"]
    wg("agents", "--install", "--approve", "wrong-fingerprint", code=3)
    assert permissions() == before
    message = wg("agents", "--install", "--approve", fingerprint, code=2)
    assert str(checkout).encode() in message and b"back up" in message
    assert permissions() == before

    # Simulate the operator removing the old registration after backup.
    registered.unlink()
    approval.unlink()
    env["FIXTURE_CANONICAL"] = "1"
    first = approve(old)
    approval.write_text("revoked")
    revoked = permissions()
    wg("agents", "--install", code=3)
    assert permissions() == revoked
    assert approve(old) == first
    effort = shutil.copytree(repo / "tests/cli-parity/fixture", home / "effort")
    wg("run", "set", effort, "a", "state=running")
    state = wg("run", "show", effort, "--json")
    assert b"running" in state
    files = {p: p.read_bytes() for p in effort.iterdir() if p.is_file()}
    server.release_archive.clear()
    assert wg("--version", updates=True) == f"wg {old} {target}\n".encode()
    assert server.archive_requested.wait(trial_timeout)
    assert permissions() == first
    server.release_archive.set()
    wait_for(lambda: current.readlink().name == f"{new}-{target}")
    assert wg("--version") == f"wg {new} {target}\n".encode()
    assert wg("run", "show", effort, "--json") == state
    assert all(p.read_bytes() == data for p, data in files.items())
    assert permissions() == first
    second = approve(new)
    assert second != first

    stamp = root / "update-check"
    previous_discovery = server.responses[discovery]
    server.responses[discovery] = json.dumps(dict(tag_name=f"wg-v{old}", draft=False, prerelease=False)).encode()
    os.utime(stamp, (1, 1))
    wg("--wg-background-update", updates=True)
    assert b"No newer matching stable release" in wg("update", "status")
    assert current.readlink().name == f"{new}-{target}"
    server.responses[discovery] = previous_discovery
    server.resume = threading.Event()
    server.stalled_path = discovery
    os.utime(stamp, (1, 1))
    try:
        wg("--wg-background-update", updates=True)
        assert b"Release service unavailable" in wg("update", "status")
        assert current.readlink().name == f"{new}-{target}"
    finally:
        server.stalled_path = None
        server.resume.set()
    wg("update", "rollback")
    assert permissions() == second
    assert approve(old) == first
    assert wg("run", "show", effort, "--json") == state

    # Operator recovery after key compromise uses a clean installation. Keep
    # the previous installation for inspection and retain the effort and consent.
    root.rename(home / "quarantine")
    launcher.unlink()
    bootstrap(latest, initial_pin, success=False)
    assert not launcher.exists()
    bootstrap(latest, recovery_pin)
    check_generation(latest)
    assert wg("--version") == f"wg {latest} {target}\n".encode()
    assert wg("run", "show", effort, "--json") == state
    assert permissions() == first
    assert b"--approve" in wg("agents", "--install", code=3)
    server.archive_requested.clear()
    server.release_archive.clear()
