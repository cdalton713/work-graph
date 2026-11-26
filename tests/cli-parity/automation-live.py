"""Exercise scheduled commands through the native CLI and local TLS fixture."""
import base64
import hashlib
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
    (bin_dir / "git").symlink_to(shutil.which("git"))
    subprocess.run(["git","init","-q",str(plan)], check=True)
    for name in ("orca", "st", "gh"):
        tool = bin_dir / name
        tool.write_text('#!/bin/sh\nif [ "$1" = worktree ] && [ "$2" = set ]; then echo renamed >> "$HOME/rename-attempts"; fi\ncase "$1" in plugin) echo \'{"result":{"plugins":[]}}\';; agent) echo \'{"result":{"agents":[]}}\';; esac\n')
        tool.chmod(0o755)
    cfg = root / "config.json"
    cfg.write_text(json.dumps({"tick_roots": [str(root)], "workspaces": [{"id": "default", "team": "EX"}]}))
    config = json.loads(cfg.read_text())
    config["workspaces"][0]["page_url"] = "https://page.invalid"
    cfg.write_text(json.dumps(config))
    contract = hashlib.sha256((HERE.parents[1] / "skills/work-graph/contract.json").read_bytes()).hexdigest()[:12]
    devices = 1
    reads = []
    frames = []
    refuse_link = False
    reject_token = False
    def get(h):
        reads.append(h.path)
        assert h.headers.get("Authorization") == "Bearer diagnostic-token"
        if h.headers.get("Upgrade", "").lower() == "websocket":
            if refuse_link:
                return h.send_error(403)
            key = h.headers["Sec-WebSocket-Key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
            h.protocol_version = "HTTP/1.1"
            h.send_response(101)
            h.send_header("Upgrade","websocket")
            h.send_header("Connection","Upgrade")
            h.send_header("Sec-WebSocket-Accept", base64.b64encode(hashlib.sha1(key.encode()).digest()).decode())
            h.end_headers()
            header = h.rfile.read(2)
            if header:
                frames.append(header[0] & 15)
            h.close_connection = True
            return
        if h.path == "/healthz":
            return h.reply({"ok": True})
        if h.path == "/api/config":
            return h.reply({"contract":contract, "auth":True})
        if h.path == "/api/status" and reject_token:
            return h.send_error(403)
        if h.path == "/api/status":
            return h.reply({"human":"Human"})
        if h.path == "/api/push/status?recipient=owner%40example.invalid":
            return h.reply({"enabled":True, "devices":devices})
        h.send_error(404)

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
        if "viewer" in q:
            data = {"viewer":{"id":"viewer"}}
        elif "issues(first:25" in q:
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

    with patch.object(Handler, "do_GET", get), patch.object(Handler, "do_POST", post), fixture_service() as (settings, _):
        env = dict(settings, HOME=str(root), PATH=str(bin_dir), WG_CONFIG=str(cfg),
                   ORCA_CLI_COMMAND=str(bin_dir / "orca"), WG_LINK="off", WG_DEFAULT_LINK_TOKEN="diagnostic-token")

        def run(*args, code=0):
            proc = subprocess.run([BIN, *args], env=env, cwd=root, text=True, capture_output=True, timeout=30)
            assert proc.returncode == code, (args, proc.stdout, proc.stderr)
            return proc.stdout

        assert "start: no check yet" in run("health", plan, "--due")
        assert "last check was" in run("health", plan, "--due", code=1)
        report = root / "report"
        report.write_text('{"findings":[]}')
        assert f"FAIL worktree a: {root / 'missing'} does not exist" in run("doctor", plan, code=1)
        assert "health offTrack: 1 fault(s), 1 issue(s)" in run("health", plan, "--report", report)
        assert "health offTrack: 1 fault(s), 0 issue(s)" in run("health", plan, "--report", report)
        assert len(filed) == 1 and filed[0]["projectId"] == "project" and filed[0]["stateId"] == "triage"
        assert "wg-health-fault: doctor:worktree-a" in filed[0]["description"]
        assert "doctor:worktree-a (EX-2)" in updates[0]["body"]
        (root / "missing").mkdir()
        assert "ok worktrees: each path in the run rows exists" in run("doctor", plan)
        assert "health onTrack: 0 fault(s)" in run("health", plan, "--report", report)
        # Check a hosted fault on the same effort with healthy local tools.
        config["notify"] = [{"type":"page","to":"owner@example.invalid"}]
        cfg.write_text(json.dumps(config))
        assert "EX-1" in run("status", plan)
        env["WG_LINK"] = "on"
        out = run("doctor", plan)
        assert "ok page notices for default: 1 registered device(s)" in out
        assert "ok link: accepts a connection" in out and frames == [8], (out, frames)
        assert "diagnostic-token" not in out
        refuse_link = True
        reject_token = True
        original_contract, contract = contract, "other"
        out = run("doctor", plan, code=1)
        assert "FAIL link: link answered HTTP 403" in out
        assert "FAIL link token for https://page.invalid" in out
        assert "FAIL page: page contract differs" in out and "diagnostic-token" not in out
        assert frames == [8]
        refuse_link = reject_token = False
        contract = original_contract
        env["WG_LINK"] = "off"
        settings_path = plan / ".claude/settings.local.json"
        assert not settings_path.exists()
        assert "a new session uses it" in run("doctor", plan, "--fix")
        assert not (root / "rename-attempts").exists()
        assert json.loads(settings_path.read_text())["autoCompactWindow"] == 250000
        devices = 0
        assert "FAIL page notices for default: register a device on the page" in run("doctor", plan, code=1)
        assert "health offTrack: 1 fault(s)" in run("health", plan, "--report", report)
        devices = 1
        assert "health onTrack: 0 fault(s)" in run("health", plan, "--report", report)
        assert "/api/push/status?recipient=owner%40example.invalid" in reads
        del config["notify"]
        cfg.write_text(json.dumps(config))
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
            settings["workspaces"][0]["page_url"] = sys.argv[2]
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
