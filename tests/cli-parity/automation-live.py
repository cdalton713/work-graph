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
    cards = []
    documents = []
    archived = []
    def page(rows):
        return {"nodes": list(rows), "pageInfo": {"hasNextPage": False, "endCursor": None}}


    def post(h):
        assert h.headers["Authorization"] == "fixture-key"
        req = json.loads(h.rfile.read(int(h.headers["Content-Length"])))
        q, v = req["query"], req["variables"]
        if "issues(first:25" in q:
            data = {"issues": {"nodes": [{"id": i, "identifier": "EX-1", "state": {"type": "started", "name": "In Progress"},
                                         "labels": {"nodes": []}} for i in v["ids"]]}}
        elif "issues(first:50,filter:{labels:" in q:
            data = {"issues": page([])}
        elif "project(id:" in q and "issues(first:" in q:
            data = {"project": {"issues": page([])}}
        elif "commentCreate(" in q or "commentUpdate(" in q:
            op = "commentUpdate" if "commentUpdate(" in q else "commentCreate"
            cards.append(v["i"]["body"])
            data = {op: {"success": True, "comment": {"id": "card"}}}
        elif "documentCreate(" in q or "documentUpdate(" in q:
            op = "documentUpdate" if "documentUpdate(" in q else "documentCreate"
            documents.append(v["i"]["content"])
            data = {op: {"success": True, "document": {"id": "doc"}}}
        elif "document(id:" in q:
            data = {"document": {"content": documents[-1]}}
        elif "organization{" in q:
            data = {"organization": {"subscription": None}}
        elif "issues(first:100" in q:
            data = {"issues": page([{"id": "settled", "identifier": "EX-3"}] if not archived else [])}
        elif "issueArchive(" in q:
            archived.append(v["id"])
            data = {"issueArchive": {"success": True}}
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
        keymap = json.loads((plan / "keymap.json").read_text())
        for key in ("merge","ship"):
            keymap["nodes"][key] = {"id": key,"identifier": key}
        (plan / "keymap.json").write_text(json.dumps(keymap))
        result = run("next", plan, "--no-publish")
        assert "phase 1: 1 task" in result and "do reconcile a EX-1: In Progress with no run row" in result, result
        assert not cards and not documents
        assert run("watch", plan, "--wait", "--interval", ".1", "--no-publish") == result
        assert run("wake", plan).startswith("start: reconcile a EX-1")
        run("next", plan)
        assert len(cards) == 3 and len(documents) == 1
        assert "work-graph status" not in cards[0]
        run("tick", "--root", root, "--channel", "none")
        assert len(documents) == 2 and archived == ["settled"]
        assert len(cards) == 3
        assert (root / ".local/state/work-graph/tick.json").is_file()
        if len(sys.argv) > 2:
            keymap = json.loads((plan / "keymap.json").read_text())
            keymap["run"]["nodes"]["a"].update(state="running", job="work", dispatch="d")
            (plan / "keymap.json").write_text(json.dumps(keymap))
            env.update(WG_UI_URL=sys.argv[2], WG_LINK="on")
            settings = json.loads(cfg.read_text())
            settings["page_url"] = sys.argv[2]
            cfg.write_text(json.dumps(settings))
            evidence = plan / "evidence"
            evidence.mkdir(exist_ok=True)
            (evidence / "a.json").write_text(json.dumps({"sha":"1234567890", "exit":0}))
            result = run("next", plan, "--wait", "--no-publish", "--interval", "10")
            assert "do answer a EX-1: fixture answer" in result
            first = run("next", plan, "--all", "--no-publish")
            assert "do answer a EX-1: queued before refresh" in first, first
            assert "dispatch -" not in first
            waited = run("next", plan, "--wait", "--no-publish", "--interval", "10")
            assert waited.startswith("note replied a EX-1: acknowledged\n"), waited
            assert "do answer a EX-1: after reply" in waited, waited





with tempfile.TemporaryDirectory() as tmp:
    scenario(Path(tmp).resolve())
