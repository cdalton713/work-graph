"""Compare hosted findings, effort findings, exit codes and preflight guidance in public processes."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from suite import HERE, REFERENCE, SKILL
from services import Handler, fixture_service

binary = str(Path(sys.argv[1]).resolve())
top = "https://page.invalid"
scoped = top + "/workspace"
key = "fixture-key"
token = "private-diagnostic-page-token"
global_token = "private-diagnostic-top-token"
hash_value = hashlib.sha256((SKILL / "contract.json").read_bytes()).hexdigest()[:12]
states = json.loads((SKILL / "contract.json").read_text())["setup"]["statuses"]
states = [
    dict(s, name=s["name"].replace("{name}", "Human"), id=str(i))
    for i, s in enumerate(states)
]
mode = "ok"
retries = []


def page(rows):
    return {"nodes": rows, "pageInfo": {"hasNextPage": False, "endCursor": None}}


def get(h):
    expected = token if h.path.startswith("/workspace/") else global_token
    if h.headers.get("Authorization") != "Bearer " + expected:
        h.send_error(403)
    elif h.path.endswith("/healthz"):
        h.reply({"ok": mode != "down"})
    elif h.path.endswith("/config"):
        h.reply(
            {
                "auth": True,
                "contract": {"bad": "outdated", "echo": token}.get(mode, hash_value),
            }
        )
    elif h.path.endswith("/status"):
        h.reply(
            {}
            if mode == "unnamed"
            else {"human": "Somebody" if mode == "mismatch" else "Human"}
        )
    elif h.path.endswith("/claims"):
        if mode == "unavailable":
            return h.send_error(503)
        h.reply({"claims": [], "role": "collaborator"})
    elif h.path.endswith("/plan"):
        h.send_response(304)
        h.end_headers()
    else:
        h.send_error(404)


def post(h):
    if h.headers.get("Authorization") != key:
        return h.send_error(401)
    q = json.loads(h.rfile.read(int(h.headers["Content-Length"])))["query"].replace(
        " ", ""
    )
    workflow = [
        dict(s)
        for s in states
        if mode != "incomplete" or s["name"] not in ("Todo", "Triage")
    ]
    if mode == "incomplete":
        next(s for s in workflow if s["name"] == "Done")["type"] = "started"
    if "viewer" in q:
        if mode == "linear-secret":
            if not retries:
                retries.append(q)
                h.send_response(429)
                h.send_header("Retry-After", "0")
                h.end_headers()
                h.wfile.write(key.encode())
                return
            return h.reply({"errors": [{"message": key}]})
        data = {"viewer": {"id": "me"}}
    elif "teams(filter" in q:
        data = {
            "teams": page(
                []
                if mode == "missing-team"
                else [{"id": "team", "states": page(workflow)}]
            )
        }
    elif "team(id:" in q and "labels(" in q:
        data = {
            "team": {
                "labels": page(
                    [
                        {"name": "agent:" + a, "id": a}
                        for a in ("codex", "claude", "coordinator")
                    ]
                )
            }
        }
    elif "team(id:" in q and "states(" in q:
        data = {"team": {"states": page(workflow)}}
    else:
        return h.send_error(400)
    payload = json.dumps({"data": data}).encode()
    h.send_response(200)
    if mode != "no-budget":
        h.send_header("X-RateLimit-Requests-Remaining", "23")
        h.send_header("X-RateLimit-Requests-Limit", "50")
    h.send_header("Content-Length", str(len(payload)))
    h.end_headers()
    h.wfile.write(payload)


with tempfile.TemporaryDirectory() as tmp, patch.object(
    Handler, "do_GET", get
), patch.object(Handler, "do_POST", post), fixture_service() as (tls, _):
    root = Path(tmp).resolve()
    effort = root / "effort"
    effort.mkdir()
    tools = root / "bin"
    tools.mkdir()
    for name in ("git", "st", "gh", "orca", "wg"):
        path = tools / name
        path.write_text(
            """#!/bin/sh
case "$*" in
*--show-toplevel*) echo "$HOME" ;;
*ls-remote*) exit 1 ;;
*refs/stax/trunk*) echo trunk ;;
*refs/branch-metadata/*) exit 1 ;;
"plugin list --json") echo '{"ok":true,"result":{"plugins":[]}}' ;;
esac
"""
        )
        path.chmod(0o755)
    link = root / ".agents/skills/work-graph"
    link.parent.mkdir(parents=True)
    link.mkdir()
    plan = (HERE / "fixture/plan.json").read_bytes()
    (effort / "plan.json").write_bytes(plan)
    km = {"nodes": {}, "project": {"id": "p"}}
    km_file = effort / "keymap.json"
    km_file.write_text(json.dumps(km))
    cfg = root / "config"
    cfg.write_text(
        json.dumps(
            {
                "page_url": top,
                "context_limit": 0,
                "tick_roots": [],
                "workspaces": [{"id": "default", "team": "EX", "page_url": scoped}],
            }
        )
    )
    env = dict(
        tls,
        HOME=str(root),
        PATH=str(tools),
        WG_CONFIG=str(cfg),
        ORCA_CLI_COMMAND=str(tools / "orca"),
        WG_LINK_TOKEN=global_token,
        WG_DEFAULT_LINK_TOKEN=token,
        WG_LINK="off",
    )

    def run(cmd, args):
        p = subprocess.run(
            [*cmd, *args], cwd=root, env=env, text=True, capture_output=True, timeout=20
        )
        assert all(
            secret not in p.stdout + p.stderr for secret in [key, token, global_token]
        ), "credential in output"
        return p.returncode, p.stdout

    def compare(args, code):
        results = []
        for cmd in (REFERENCE, [binary]):
            status, out = run(cmd, args)
            assert status == code, (args, status, out)
            platform_only = (
                ("python:", "websockets:", "checkout:")
                if cmd == REFERENCE
                else ("installation:",)
            )
            lines = [
                s
                for s in out.splitlines()
                if not s.partition(" ")[2].startswith(platform_only)
            ]
            results.append(lines)
        assert results[0] == results[1], (args, results)
        return results[0]

    args = ["doctor", str(effort)]
    good = compare(args, 0)
    assert (
        f"ok key default: accepted (LINEAR_DEFAULT_API_KEY); requests 23/50 left"
        in good
    )
    assert f"ok page: {scoped}, contract {hash_value}" in good
    for mode in ("incomplete", "missing-team", "no-budget"):
        compare(args, 0)
    for mode in ("down", "bad"):
        compare(args, 1)
    mode = "ok"
    for override in (False, True):
        if override:
            env["WG_UI_URL"] = top
        missing = compare(["doctor", str(root / "missing")], 1)
        assert any("(plan unavailable, checking " in s for s in missing)
        assert any(s.startswith(f"ok link token for {top}:") for s in missing)
        assert not any("worktrees:" in s for s in missing)
    del env["WG_UI_URL"]

    # The real missing, private and overly permissive file paths match the reference.
    del env["LINEAR_DEFAULT_API_KEY"]
    compare(args, 1)
    keyfile = root / ".config/work-graph/default-linear-api-key"
    keyfile.parent.mkdir(parents=True)
    keyfile.write_text(key)
    keyfile.chmod(0o644)
    compare(args, 1)
    keyfile.chmod(0o600)
    compare(args, 0)

    km["collab"] = {
        "page": scoped,
        "workspace": "default",
        "project": "p",
        "version": 1,
        "plan_sha": hashlib.sha256(plan).hexdigest(),
    }
    km_file.write_text(json.dumps(km))
    for mode, code in [("ok", 0), ("unnamed", 0), ("mismatch", 1), ("unavailable", 0)]:
        rows = compare(args, code)
        assert rows[-1].startswith(("ok ", "warn " if not code else "FAIL "))
    mode = "ok"
    ref = run(REFERENCE, ["preflight", str(effort)])
    actual = run([binary], ["preflight", str(effort)])
    assert (
        actual == ref and actual[0] == 1 and "st get main --parent trunk" in actual[1]
    ), (ref, actual)
    for mode in ("echo", "linear-secret"):
        assert run([binary], args)[0] == 1
    assert retries
