"""Test native diagnostics and discovery from an isolated release directory."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from tempfile import TemporaryDirectory
from threading import Thread
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, str(Path(__file__).resolve().parent))
import suite

binary = Path(sys.argv[1]).resolve()
frozen = json.loads((suite.HERE / "expected.json").read_bytes())
for case, expected in frozen.items():
    args = case.split()
    if case != "setup --help" and args[0] not in {"explain", "config", "preflight", "ui", "doctor"}:
        continue
    result = suite.run_case([str(binary)], args)
    if args[-1] == "--help":
        assert not result["exit"] and not result["stderr"] and not result["files"]
        result = suite.help_flags(result["stdout"])
    assert result == expected, (case, result, expected)


class Health(BaseHTTPRequestHandler):
    def do_GET(self):
        assert self.path == "/healthz"
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'{"ok":true}')

    def log_message(self, *_):
        pass


with TemporaryDirectory() as tmp:
    root = Path(tmp).resolve()
    install = root / "version"
    skill = install / "skills/work-graph"
    shutil.copytree(suite.SKILL, skill)
    pkg = install / "orca-plugin"
    pkg.mkdir()
    (pkg / "orca-plugin.json").write_text("{}")
    program = install / "wg"
    shutil.copy2(binary, program)
    tools = root / "bin"
    tools.mkdir()
    env = {"PATH": str(tools), "HOME": tmp, "WG_CONFIG": str(root / "config"),
           "ORCA_CLI_COMMAND": str(tools / "orca")}
    def stub(name, script):
        path = tools / name
        path.write_text("#!/bin/sh\n" + script)
        path.chmod(0o755)
    def run(*args):
        result = subprocess.run([program, *args], cwd=root, env=env, text=True, capture_output=True, timeout=20)
        assert result.returncode == 0, (args, result.stdout, result.stderr)
        return result.stdout
    with (skill / "SKILL.md").open("a") as doc:
        doc.write("\n<!-- explain: dispatch -->\nInstalled dispatch instructions.\n<!-- /explain -->\n")
    assert "Installed dispatch instructions." in run("explain", "dispatch")
    for cmd in ("status", "rollback"):
        assert f"wg update {cmd}" in run("--help")
        assert f"wg update {cmd}" in run("update", cmd, "--help")
    stub("orca", '''case "$2" in
list) echo '{"ok":true,"result":{"plugins":[]}}' ;;
inspect|install) test "$3" = "$EXPECTED_PLUGIN" || exit 1
echo "$2" >> "$HOME/plugin-calls"
echo '{"ok":true,"result":{"pluginKey":"example.wg-agents","contentHash":"fixture"}}' ;;
esac
''')
    env["EXPECTED_PLUGIN"] = str(pkg)
    run("agents", "--install")
    assert (root / "plugin-calls").read_text().splitlines() == ["inspect","install"]

    server = HTTPServer(("127.0.0.1", 0), Health)
    thread = Thread(target=server.serve_forever)
    thread.start()
    try:
        (install / "server").mkdir()
        (install / "server/main.ts").touch()
        stub("open" if sys.platform == "darwin" else "xdg-open", 'echo "$1" > "$HOME/opened"\n')
        port = str(server.server_port)
        url = f"http://127.0.0.1:{port}/?project=A%20B"
        assert url in run("ui", "--port", port, "--project", "A B")
        assert (root / "opened").read_text().strip() == url
    finally:
        server.shutdown()
        thread.join()
        server.server_close()

    (install / "pnpm-lock.yaml").touch()
    stub("pnpm", 'echo "$*" >> "$HOME/build-steps"\n')
    stub("node", 'echo "$*" >> "$HOME/build-steps"\n')
    env["LINEAR_DEFAULT_API_KEY"] = "fixture-key"
    run("ui", "--port", port, "--project", "Example", "--no-open", "--no-tailnet")
    assert (root / "build-steps").read_text().splitlines() == [
        "install --frozen-lockfile", "build",
        f"{install}/server/main.ts --port {port} --project Example --workspace default --no-open --no-tailnet",
    ]
