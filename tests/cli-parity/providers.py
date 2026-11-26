"""Exercise both credential scopes and the state transaction through the compiled CLI."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest.mock import patch

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import suite
from services import Handler, fixture_service

BIN = str(Path(sys.argv[1]).resolve())
case = "service | run set effort a branch=wg/example"
expected = json.loads((suite.HERE / "expected.json").read_text())[case]
actual = suite.run_case([BIN], case.split()[2:], service=True)
assert actual == expected, actual


def scenario(root, preflight):
    plan = json.loads((suite.HERE / "fixture/plan.json").read_text())
    plan["effort"]["slug"] = "sample"
    km = json.loads((suite.HERE / "fixture/keymap.json").read_text())
    km["nodes"]["a"]["card"] = {"id": "card"}
    wire = {"version": 1, "writer": "Owner", "plan": plan, "keymap": km}
    membership = {"id": "shared:one", "role": "collaborator", "name": "Example",
                  "owner": "Owner", "projectId": "project"}
    team = {"id": "team"}
    project = {"id": "project", "name": "Example", "teams": {"nodes": [team]}}
    issue = {"id": "issue-a", "identifier": "EX-1", "project": {"id": "project"}}
    requests = []
    updates = []

    def get(h):
        if h.headers.get("Authorization") != "Bearer page-key":
            return h.send_error(401)
        if h.path == "/api/status":
            return h.reply({"human": "Human", "workspaces": [membership]})
        if h.path != "/api/projects/project/plan" or h.headers.get("x-workspace") != "shared:one":
            return h.send_error(403)
        if h.headers.get("If-None-Match") == f'"{wire["version"]}"':
            h.send_response(304)
            h.end_headers()
            return
        h.reply(wire)

    def post(h):
        if h.headers.get("Authorization") != "fixture-key":
            return h.send_error(401)
        req = json.loads(h.rfile.read(int(h.headers["Content-Length"])))
        q = req["query"]
        requests.append(q)
        if "projectMilestones" in q:
            data = {"project": {"projectMilestones": {"nodes": [{"id": "milestone"}],
                                                      "pageInfo": {"hasNextPage": False}}}}
        elif "teams(filter" in q:
            data = {"teams": {"nodes": [team]}, "project": project}
        elif "issue(id:" in q:
            data = {"issue": issue}
        elif "issues(first:" in q:
            data = {"issues": {"nodes": [issue]}}
        elif "comment(id:" in q:
            attached = issue if req["variables"]["id"] == "card" else {"id": "another"}
            data = {"comment": {"issue": attached}}
        elif "commentUpdate(" in q:
            assert req["variables"]["id"] == "card"
            updates.append(req["variables"]["i"]["body"])
            data = {"commentUpdate": {"success": True, "comment": {"id": "card"}}}
        else:
            return h.send_error(400)
        h.reply({"data": data})

    def put(h):
        if (h.path != "/api/projects/project/plan" or h.headers.get("Authorization") != "Bearer page-key"
                or h.headers.get("x-workspace") != "shared:one"):
            return h.send_error(403)
        if h.headers.get("If-Match") != f'"{wire["version"]}"':
            return h.send_error(412)
        body = json.loads(h.rfile.read(int(h.headers["Content-Length"])))
        wire.update(body, version=wire["version"] + 1)
        h.reply({"version": wire["version"]})

    repo = root / "repo"
    work = root / "tree"
    env = {"PATH": os.defpath, "HOME": str(root), "WG_CONFIG": str(root / "config"),
           "WG_DEFAULT_LINK_TOKEN": "page-key", "WG_LINK": "off"}
    def git(*args):
        subprocess.run(["git", *args], cwd=repo, env=env, check=True, capture_output=True)
    repo.mkdir()
    git("init", "-q")
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit",
        "--allow-empty", "-m", "base")
    git("worktree", "add", "-b", "wg/sample-core", str(work))
    (root / "config").write_text(json.dumps({"workspaces": [{"id": "default", "team": "EX",
                                                           "page_url": "https://page.invalid"}]}))
    tools = root / "bin"
    tools.mkdir()
    wg = tools / "wg"
    wg.write_text('#!/bin/sh\n[ "$2" = "$EXPECTED" ] || exit 70\necho "$1" >> "$CALLS"\n'
                  'echo "ran $1"\nif [ "$1" = preflight ]; then exit "$PREFLIGHT"; fi\n')
    wg.chmod(0o755)
    calls = root / "calls"
    env.update(PATH=str(tools) + os.pathsep + os.defpath, EXPECTED=str(work), CALLS=str(calls),
               PREFLIGHT=str(preflight))
    with patch.object(Handler, "do_GET", get), patch.object(Handler, "do_POST", post), patch.object(Handler, "do_PUT", put, create=True), fixture_service() as (settings, _):
        env.update(settings)
        def run(command, *args, code=0):
            p = subprocess.run(command + list(map(str, args)), cwd=repo, env=env, capture_output=True,
                               text=True, timeout=20)
            assert p.returncode == code, (args, p.returncode, p.stdout, p.stderr)
            return p.stdout
        def snapshot():
            return {name: (work / name).read_bytes() for name in ("plan.json", "keymap.json", "PLAN.md")}
        join = ["join", "--repo", repo]
        team["id"] = "other"
        project["teams"] = {"nodes": [{"id": "team"}]}
        run([BIN], *join, code=2)
        assert not (work / "keymap.json").exists()
        team["id"] = "team"
        output = run([BIN], *join, code=preflight)
        assert "ran preflight" in output
        assert calls.read_text().splitlines() == (["preflight"] if preflight else ["preflight", "next"])
        files = snapshot()
        # Run the reference join with the same two post-join commands. The
        # reference normally calls these in-process, after it writes the pair.
        oracle = root / "oracle"
        oracle.mkdir()
        subprocess.run(["git", "clone", "-q", str(repo), str(oracle)], env=env, check=True)
        subprocess.run(["git", "-C", str(oracle), "switch", "wg/sample-core"], env=env,
                       check=True, capture_output=True)
        script = """
import runpy, subprocess, sys
wg = runpy.run_path(sys.argv[1])
main = wg["main"]
def step(cmd, path):
    return subprocess.run(["wg", cmd, str(path)]).returncode
main.__globals__.update(preflight=lambda p, *_: step("preflight", p),
                        next_command=lambda p, *_: step("next", p))
sys.exit(main(sys.argv[1:]))
"""
        env["EXPECTED"] = str(oracle)
        run([sys.executable, "-I", "-c", script, suite.REFERENCE[-1]], "join", "--repo", oracle, code=preflight)
        assert files["plan.json"] == (oracle / "plan.json").read_bytes()
        assert files["PLAN.md"] == (oracle / "PLAN.md").read_bytes()
        assert json.loads(files["keymap.json"]) == json.loads((oracle / "keymap.json").read_text())
        env["EXPECTED"] = str(work)
        collab = json.loads(files["keymap.json"])["collab"]
        assert collab["plan_sha"] == hashlib.sha256(files["plan.json"]).hexdigest()
        assert json.loads(files["keymap.json"])["nodes"]["a"]["card"] == {"id": "card"}
        run([BIN], *join, code=2)
        assert snapshot() == files
        count = len(requests)
        for cmd in ([BIN], suite.REFERENCE):
            assert "current" in run(cmd, "pull", work)
            assert snapshot() == files
        assert len(requests) == count
        wire["version"] = 2
        wire["plan"]["effort"]["summary"] = "Updated"
        wire["keymap"]["nodes"]["a"]["id"] = "outside"
        run([BIN], "pull", work, code=2)
        assert snapshot() == files
        wire["keymap"]["nodes"]["a"]["id"] = "issue-a"
        wire["keymap"]["milestones"]["1"] = "outside"
        run([BIN], "pull", work, code=2)
        assert snapshot() == files
        wire["keymap"]["milestones"]["1"] = "milestone"
        wire["keymap"]["nodes"]["a"]["card"]["id"] = "outside"
        run([BIN], "pull", work, code=2)
        assert snapshot() == files
        wire["keymap"]["nodes"]["a"]["card"]["id"] = "card"
        reference_dir = root / "reference"
        reference_dir.mkdir()
        for name, data in files.items():
            (reference_dir / name).write_bytes(data)
        run(suite.REFERENCE, "pull", reference_dir)
        run([BIN], "pull", work)
        assert json.loads((work / "plan.json").read_text()) == json.loads((reference_dir / "plan.json").read_text())
        assert snapshot()["plan.json"] == (reference_dir / "plan.json").read_bytes()
        assert json.loads((work / "keymap.json").read_text()) == json.loads((reference_dir / "keymap.json").read_text())

        # Restore the exact intermediate record an interrupted Python pull leaves.
        committed = snapshot()
        pending = json.loads(committed["keymap.json"])
        pending["collab"]["pull_pending"] = {
            "plan": json.loads(committed["plan.json"]), "prior": collab["plan_sha"]}
        (work / "keymap.json").write_text(json.dumps(pending))
        (work / "plan.json").write_bytes(files["plan.json"])
        run([BIN], "pull", work)
        assert snapshot() == committed

        run([BIN], "run", "set", work, "a", "branch=wg/sample")
        assert wire["keymap"]["nodes"]["a"]["branch"] == "wg/sample"
        run([BIN], "run", "set", work, "a", "branch=wg/sample")
        assert len(updates) == 1
        run([BIN], "run", "reset", work, "a")
        assert len(updates) == 2
        saved = json.loads((work / "keymap.json").read_text())
        assert "a" not in saved["run"]["nodes"]
        assert saved["nodes"]["a"]["card"] == {
            "id": "card", "sha": hashlib.sha256(updates[-1].encode()).hexdigest()}

for status in (0, 7):
    with tempfile.TemporaryDirectory() as directory:
        scenario(Path(directory).resolve(), status)
