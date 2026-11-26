"""Exercise scheduled commands through the native CLI and local TLS fixture."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from services import Handler, fixture_service

BIN = Path(sys.argv[1]).resolve()


def scenario(root):
    plan = root / "example-core"
    shutil.copytree(HERE / "fixture", plan)
    (plan / "journal.jsonl").unlink()
    km = json.loads((plan / "keymap.json").read_text())
    km["run"] = {"effort": {}, "nodes": {"a": {"path": str(root / "missing")}}}
    (plan / "keymap.json").write_text(json.dumps(km))
    bin_dir = root / "bin"
    bin_dir.mkdir()
    for name in ("orca", "st", "gh"):
        tool = bin_dir / name
        tool.write_text('#!/bin/sh\ncase "$1" in plugin) echo \'{"result":{"plugins":[]}}\';; agent) echo \'{"result":{"agents":[]}}\';; esac\n')
        tool.chmod(0o755)
    cfg = root / "config.json"
    cfg.write_text(json.dumps({"tick_roots": [str(root)], "workspaces": [{"id": "default", "team": "EX"}]}))
    filed = []
    updates = []

    def post(h):
        assert h.headers["Authorization"] == "fixture-key"
        req = json.loads(h.rfile.read(int(h.headers["Content-Length"])))
        q, v = req["query"], req["variables"]
        if "issues(first:25" in q:
            data = {"issues": {"nodes": [{"id": i, "identifier": "EX-1", "state": {"type": "started", "name": "In Progress"},
                                         "labels": {"nodes": []}} for i in v["ids"]]}}
        elif "teams(filter:" in q:
            data = {"teams": {"nodes": [{"id": "team", "states": {"nodes": [{"name": "Triage", "id": "triage"}]}}]}}
        elif "team(id:" in q:
            data = {"team": {"labels": {"nodes": [{"name": "health", "id": "label"}], "pageInfo": {"hasNextPage": False}}}}
        elif "issues(first:5," in q:
            data = {"issues": {"nodes": []}}
        elif "issueCreate(" in q:
            filed.append(v["i"])
            data = {"issueCreate": {"issue": {"id": "health-issue", "identifier": "EX-2"}}}
        elif "projectUpdateCreate(" in q:
            updates.append(v["i"])
            data = {"projectUpdateCreate": {"projectUpdate": {"id": "update", "url": "https://example.invalid/update"}}}
        elif "project(id:" in q and "labels(" in q:
            data = {"project": {"labels": {"nodes": []}}}
        else:
            raise AssertionError(q)
        h.reply({"data": data})

    with patch.object(Handler, "do_POST", post), fixture_service() as (settings, _):
        env = dict(settings, HOME=str(root), PATH=str(bin_dir), WG_CONFIG=str(cfg),
                   ORCA_CLI_COMMAND=str(bin_dir / "orca"), WG_LINK="off")

        def run(*args, code=0):
            proc = subprocess.run([BIN, *args], env=env, cwd=root, text=True, capture_output=True, timeout=30)
            assert proc.returncode == code, (args, proc.stdout, proc.stderr)
            return proc.stdout

        assert "start: no check yet" in run("health", plan, "--due")
        assert "last check was" in run("health", plan, "--due", code=1)
        report = root / "report"
        report.write_text('{"findings":[]}')
        assert "health offTrack: 1 fault(s), 1 issue(s)" in run("health", plan, "--report", report)
        assert "health offTrack: 1 fault(s), 0 issue(s)" in run("health", plan, "--report", report)
        assert len(filed) == 1 and filed[0]["projectId"] == "project" and filed[0]["stateId"] == "triage"
        assert "wg-health-fault: doctor:worktree-a" in filed[0]["description"]
        assert "doctor:worktree-a (EX-2)" in updates[0]["body"]
        (root / "missing").mkdir()
        assert "health onTrack: 0 fault(s)" in run("health", plan, "--report", report)
        row = json.loads((plan / "keymap.json").read_text())["run"]["effort"]
        assert "health_started" not in row and "health_faults" not in row
        assert row["health_update"] == "https://example.invalid/update"


with tempfile.TemporaryDirectory() as tmp:
    scenario(Path(tmp).resolve())
