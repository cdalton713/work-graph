"""Exercise both credential scopes and the state transaction through the compiled CLI."""
from copy import deepcopy
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
share = suite.run_case([BIN], ["share", "effort"])
assert share == json.loads((suite.HERE / "expected.json").read_text())["share effort"], share


def credential_cases(root, files, run, env, seen):
    # A pull by the owner uses workspace credentials before the saved page token.
    owner = root / "owner"
    owner.mkdir()
    (owner / "plan.json").write_bytes(files["plan.json"])
    km = json.loads(files["keymap.json"])
    km["collab"]["workspace"] = "default"
    (owner / "keymap.json").write_text(json.dumps(km))
    home = root / ".config/work-graph"
    (home / "pages").mkdir(parents=True)
    cached = home / "pages/page.invalid-token"
    cached.write_text("page-key\n")
    cached.chmod(0o600)
    config = root / "config"
    original = config.read_bytes()
    del env["WG_DEFAULT_LINK_TOKEN"]
    for scoped in (True, False):
        row = {"id": "default", "team": "EX"}
        conf = {"workspaces": [row]}
        (row if scoped else conf)["page_url"] = "https://page.invalid"
        config.write_text(json.dumps(conf))
        name = "WG_DEFAULT_LINK_TOKEN" if scoped else "WG_LINK_TOKEN"
        path = home / ("default-link-token" if scoped else "link-token")

        def check(sent):
            for command in ([BIN], suite.REFERENCE):
                start = len(seen)
                run(command, "pull", owner, code=0 if sent else 2)
                assert seen[start:] == (["Bearer " + sent] if sent else [])

        check("page-key")
        env[name] = ""
        check(None)
        env[name] = "env-key"
        check("env-key")
        del env[name]
        path.write_text("file-key\n")
        path.chmod(0o600)
        check("file-key")
        path.chmod(0o640)
        check(None)
        path.chmod(0o600)
        path.write_text("   \n")
        check(None)
        path.unlink()
    cached.unlink()
    config.write_bytes(original)
    env["WG_DEFAULT_LINK_TOKEN"] = "page-key"


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
    seen = []
    reject_put = False

    def get(h):
        auth = h.headers.get("Authorization")
        seen.append(auth)
        if auth not in ("Bearer page-key", "Bearer env-key", "Bearer file-key"):
            return h.send_error(401)
        if h.path == "/api/status":
            return h.reply({"human": "Human", "workspaces": [membership]})
        if h.path != "/api/projects/project/plan" or h.headers.get("x-workspace") not in ("shared:one", "default"):
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
        elif "document(id:" in q:
            owner = "project" if req["variables"]["id"] == "doc" else "outside"
            data = {"document": {"project": {"id": owner}}}
        elif "commentUpdate(" in q:
            assert req["variables"]["id"] == "card"
            updates.append(req["variables"]["i"]["body"])
            data = {"commentUpdate": {"success": True, "comment": {"id": "card"}}}
        else:
            return h.send_error(400)
        h.reply({"data": data})

    def put(h):
        creating = h.headers.get("If-None-Match") == "*"
        scope = "default" if creating else "shared:one"
        if (h.path != "/api/projects/project/plan" or h.headers.get("Authorization") != "Bearer page-key"
                or h.headers.get("x-workspace") != scope):
            return h.send_error(403)
        if reject_put:
            return h.send_error(403)
        if not creating and h.headers.get("If-Match") != f'"{wire["version"]}"':
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
        def run(command, *args, code=0, error=None):
            p = subprocess.run(command + list(map(str, args)), cwd=repo, env=env, capture_output=True,
                               text=True, timeout=20)
            assert p.returncode == code, (args, p.returncode, p.stdout, p.stderr)
            if error is not None:
                assert error in p.stderr, p.stderr
            return p.stdout
        def snapshot():
            return {name: (work / name).read_bytes() for name in ("plan.json", "keymap.json", "PLAN.md")}
        join = ["join", "--repo", repo]
        linear_key = env.pop("LINEAR_DEFAULT_API_KEY")
        run([BIN], *join, code=2)
        assert not requests and not (work / "keymap.json").exists()
        env["LINEAR_DEFAULT_API_KEY"] = linear_key
        team["id"] = "other"
        project["teams"] = {"nodes": [{"id": "team"}]}
        run([BIN], *join, code=2)
        assert not (work / "keymap.json").exists()
        team["id"] = "team"
        preview_bin = root / "preview-bin"
        preview_bin.mkdir()
        (preview_bin / "wg").symlink_to(BIN)
        original_path = env["PATH"]
        env["PATH"] = str(preview_bin) + os.pathsep + original_path
        output = run([BIN], *join, code=preflight)
        env["PATH"] = original_path
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
        wire["keymap"]["status_doc"] = {"id": "outside"}
        run([BIN], "pull", work, code=2)
        assert snapshot() == files
        wire["keymap"]["status_doc"]["id"] = "doc"
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

        original_wire = deepcopy(wire)
        def mapped(cmd, tree):
            wire.clear()
            wire.update(deepcopy(original_wire))
            updates.clear()
            results = []
            for verb, args in [("set", ["branch=wg/sample"]), ("set", ["branch=wg/sample"]), ("reset", [])]:
                stdout = run(cmd, "run", verb, tree, "a", *args)
                results.append((stdout, json.loads((tree / "keymap.json").read_text()), deepcopy(wire), list(updates)))
            assert len(updates) == 2
            assert wire["keymap"]["nodes"]["a"]["branch"] == "wg/sample"
            assert results[-1][1]["nodes"]["a"]["card"] == {
                "id": "card", "sha": hashlib.sha256(updates[-1].encode()).hexdigest()}
            return results
        assert mapped([BIN], work) == mapped(suite.REFERENCE, reference_dir)

        reject_put = True
        run([BIN], "run", "set", work, "a", "branch=wg/retry")
        def keymap():
            return json.loads((work / "keymap.json").read_text())
        pending = keymap()["collab"]["pending"]
        assert pending["nodes"]["a"]["branch"] == "wg/sample"
        assert keymap()["run"]["nodes"]["a"]["branch"] == "wg/retry"
        clean = (work / "plan.json").read_bytes()
        dirty = clean + b"\n"
        (work / "plan.json").write_bytes(dirty)
        reject_put = False
        run([BIN], "pull", work)
        assert (work / "plan.json").read_bytes() == dirty
        assert keymap()["collab"]["pending"] == pending
        assert wire["keymap"]["nodes"]["a"]["branch"] == "wg/sample"
        (work / "plan.json").write_bytes(clean)
        run([BIN], "pull", work)
        assert "pending" not in keymap()["collab"]
        assert wire["keymap"]["nodes"]["a"]["branch"] == "wg/retry"

        if preflight == 0:
            credential_cases(root, snapshot(), run, env, seen)
            local = keymap()
            local["collab"] = {}
            (work / "keymap.json").write_text(json.dumps(local))
            count = len(seen)
            run([BIN], "run", "set", work, "a", "branch=wg/local")
            assert keymap()["collab"] == {}
            assert keymap()["nodes"]["a"]["branch"] == "wg/retry"
            run([BIN], "pull", work, code=2, error="this effort is not shared")
            assert len(seen) == count
            assert "shared plan v" in run([BIN], "share", work)
            assert keymap()["collab"]["workspace"] == "default"
            (root / "config").write_text(json.dumps({"workspaces": [{"id":"default","key_env":False}]}))
            run([BIN], "run", "show", work)

for status in (0, 7):
    with tempfile.TemporaryDirectory() as directory:
        scenario(Path(directory).resolve(), status)
