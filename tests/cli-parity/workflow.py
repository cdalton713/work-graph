"""Run the workflow commands against the same independent synthetic issue store."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from services import Handler, fixture_service
from suite import help_flags, run_case


def page(values):
    return {"nodes": list(values), "pageInfo": {"hasNextPage": False, "endCursor": None}}


def scenario(binary, work):
    plan = json.loads((HERE / "fixture/plan.json").read_bytes())
    plan["effort"]["slug"] = "wf"
    plan["nodes"][0]["lane"] = "core"
    plan["nodes"].reverse()
    (work / "plan.json").write_text(json.dumps(plan))
    subprocess.run(["git", "init", "-q", str(work)], check=True)
    states = {s: {"id": s, "name": s} for s in ("Todo", "Ready", "In Progress", "Done", "Merged")}
    issues = {}
    labels = {}
    groups = {}
    active_labels = set()
    links = {}
    archives = []
    mutations = []
    comments = []
    fail_relation_once = True
    claim_reads = []
    refused = set()
    archive_error = None
    paths = {k: work / k for k in ("clean", "dirty", "unrelated", "custom-coordinator-path")}
    for path in paths.values():
        path.mkdir()
        subprocess.run(["git", "init", "-q", str(path)], check=True)
    (paths["dirty"] / "pending").write_text("user data")
    trees = [{"id": k, "path": str(p), "isMainWorktree": False, "branch": k,
              "childWorktreeIds": []} for k, p in paths.items()]
    trees[-1]["branch"] = "refs/heads/wg/wf-core"
    inventory = work / "trees.json"
    inventory.write_text(json.dumps(trees))
    tool = work / "orca"
    tool.write_text(f"#!{sys.executable}\n" + """import json,os,sys
from pathlib import Path
f=Path(os.environ['TREES'])
if sys.argv[1:3]==['worktree','list']:
    print(json.dumps({'result':{'worktrees':json.loads(f.read_text()),'truncated':False}}))
elif sys.argv[1:3]==['worktree','rm']:
    key=sys.argv[4].removeprefix('id:')
    f.write_text(json.dumps([r for r in json.loads(f.read_text()) if r['id']!=key]))
    print('{"result":{}}')
else:
    sys.exit(1)
""")
    tool.chmod(0o755)
    config = work / "config"
    config.write_text(json.dumps({"context_limit": 142000, "coordinator_settings": {"codex": {"features": {"example": True}}}, "workspaces": [{"id": "default", "team": "EX"}]}))
    def get(h):
        if h.headers["Authorization"] != "Bearer page-key" or h.headers["x-workspace"] != "shared:test":
            return h.send_error(403)
        if h.path.endswith("/plan"):
            h.send_response(304)
            h.end_headers()
        elif h.path.endswith("/claims"):
            claim_reads.append(h.path)
            h.reply({"role": "collaborator", "claims": [
                {"node": "a", "holder": "Another", "mine": False, "job": "work"}]})
        else:
            h.send_error(404)

    def post(h):
        nonlocal fail_relation_once
        assert h.headers["Authorization"] == "fixture-key"
        req = json.loads(h.rfile.read(int(h.headers["Content-Length"])))
        q = req["query"].replace(" ", "").replace("\n", "")
        v = req["variables"]
        if "projectLabels(first:" in q:
            assert v["f"] == {"team": {"id": {"eq": "team"}}}
            data = {"projectLabels": page(groups.values())}
        elif "projectLabelCreate(" in q:
            inp = v["i"]
            assert inp["teamId"] == "team"
            uid = str(len(groups) + 1)
            groups[uid] = {"id": uid, "name": inp["name"], "isGroup": inp.get("isGroup", False),
                           "parent": groups.get(inp.get("parentId")), "retiredAt": None}
            data = {"projectLabelCreate": {"projectLabel": {"id": uid}}}
        elif "project(id:" in q and "labels(first:" in q:
            data = {"project": {"labels": page(groups[uid] for uid in active_labels)}}
        elif "projectRemoveLabel(" in q:
            active_labels.remove(v["l"])
            data = {"projectRemoveLabel": {"success": True}}
        elif "projectAddLabel(" in q:
            assert v["id"] == "p" and v["l"] in groups
            active_labels.add(v["l"])
            data = {"projectAddLabel": {"success": True}}
        elif "teams(filter:" in q:
            data = {"teams": page([{"id": "team", "states": page(states.values())}])}
        elif "team(id:" in q and "labels(" in q:
            data = {"team": {"labels": page(labels.values())}}
        elif "projects(first:" in q:
            project = {"id": "p", "name": "Example", "url": "https://example.invalid/p"}
            data = {"team": {"projects": page([project] if issues else [])}}
        elif "project(id:" in q and "issues(first:" in q:
            data = {"project": {"issues": page(issues.values())}}
        elif "project(id:" in q and "projectMilestones(first:" in q:
            data = {"project": {"projectMilestones": page([{"id": "m", "name": "Build"}])}}
        elif "issue(id:" in q and "comments(first:" in q:
            data = {"issue": {"comments": page([])}}
        elif "projectCreate(" in q:
            data = {"projectCreate": {"project": {"id": "p", "url": "https://example.invalid/p"}}}
        elif "projectMilestoneCreate(" in q:
            data = {"projectMilestoneCreate": {"projectMilestone": {"id": "m"}}}
        elif "issueLabelCreate(" in q:
            name = v["i"]["name"]
            labels[name] = {"id": name, "name": name}
            data = {"issueLabelCreate": {"issueLabel": labels[name]}}
        elif "viewer{" in q:
            data = {"viewer": {"id": "viewer"}}
        elif "issueCreate(" in q:
            inp = v["i"]
            uid = str(len(issues) + 1)
            issues[uid] = {"id": uid, "identifier": "EX-" + uid, "title": inp["title"],
                           "state": {"name": inp["stateId"], "type": "unstarted"},
                           "team": {"id": "team"}, "projectMilestone": {"id": "m"},
                           "project": {"id": "p"}, "sortOrder": 0, "archivedAt": None,
                           "labels": page([{"name": "agent:codex", "id": "agent"}])}
            data = {"issueCreate": {"issue": {"id": uid, "identifier": "EX-" + uid}}}
        elif "issues(first:25," in q:
            data = {"issues": page([dict(issues[uid], relations=page(
                {"id": a+b, "type": "blocks", "relatedIssue": {"id": b}}
                for a, b in links if a == uid)) for uid in v["ids"]])}
        elif "commentCreate(" in q:
            comments.append(v["i"]["body"])
            data = {"commentCreate": {"success": True, "comment": {"id": str(len(comments))}}}
        elif "issueRelationCreate(" in q:
            pair = (v["i"]["issueId"], v["i"]["relatedIssueId"])
            assert pair not in links
            links[pair] = True
            if fail_relation_once:
                fail_relation_once = False
                return h.reply({"errors": [{"message": "fixture interrupted after relation creation"}]})
            data = {"issueRelationCreate": {"success": True}}
        elif "issueUpdate(" in q:
            if ("update", v["id"]) in refused:
                return h.reply({"data": {"issueUpdate": {"success": False}}})
            issue = issues[v["id"]]
            if "o" in v:
                issue["sortOrder"] = v["o"]
            else:
                state = v.get("s") or v["i"]["stateId"]
                issue["state"] = {"name": state, "type": "completed" if state == "Done" else "started"}
            data = {"issueUpdate": {"success": True}}
        elif "team(id:" in q and "states(" in q:
            data = {"team": {"states": page(states.values())}}
        elif "organization{" in q:
            data = {"organization": {"subscription": None}}
        elif "issues(first:100," in q:
            data = {"issues": page([i for i in issues.values() if i["state"]["name"] == "Done" and i["id"] not in archives])}
        elif "issueArchive(" in q:
            if ("archive", v["id"]) in refused:
                return h.reply({"data": {"issueArchive": {"success": False}}})
            if archive_error == v["id"]:
                return h.reply({"errors": [{"message": "fixture archive interruption"}]})
            archives.append(v["id"])
            data = {"issueArchive": {"success": True}}
        else:
            raise AssertionError(q)
        if "mutation" in q:
            mutations.append(next(iter(data)))
        h.reply({"data": data})
    outcomes = []
    with patch.object(Handler, "do_POST", post), patch.object(Handler, "do_GET", get), fixture_service() as (settings, _):
        env = dict(settings, HOME=str(work), PATH=os.defpath, WG_CONFIG=str(config),
                   ORCA_CLI_COMMAND=str(tool), TREES=str(inventory), WG_LINK="off", WG_LINK_TOKEN="page-key")
        def run(verb, *args, code=0):
            proc = subprocess.run([*binary, verb, str(work), *args], env=env, cwd=work,
                                  text=True, capture_output=True, timeout=20)
            assert proc.returncode == code, (verb, proc.stdout, proc.stderr)
            outcomes.append((verb, proc.stdout.replace(str(work), "effort"),
                             proc.stderr.replace(str(work), "effort")))
            return proc.stdout
        initial = run("load")
        assert "create project" in initial and not (work / "keymap.json").exists()
        run("load", "--apply", code=2)
        # Both adapters surface the injected GraphQL failure; their transport diagnostics differ.
        interrupted = outcomes.pop()
        if len(binary) == 1:
            assert ": created" not in interrupted[1]
        assert len(links) == 1
        run("load", "--apply")
        assert json.loads((work / ".claude/settings.local.json").read_text())["autoCompactWindow"] == 142000
        assert (work / ".codex/config.toml").exists()
        assert len(links) == 2
        assert [i["title"] for i in sorted(issues.values(), key=lambda n: n["sortOrder"])] == ["Add a file", "Merge", "Ship"]
        before = list(mutations)
        run("load", "--apply")
        assert mutations == before
        assert run("status").splitlines()[0].split("\t")[3] == "agent:codex"
        run("ready", "--apply")
        run("move", "a", "Merged", code=1)
        assert issues["3"]["state"]["name"] == "Ready"
        km = json.loads((work / "keymap.json").read_text())
        km["collab"] = {"project": "p", "page": "https://page.invalid", "workspace": "shared:test",
                        "name": "Example", "version": 1, "settings": {"slug": "wf", "workspace": "default", "team": "EX"},
                        "plan_sha": hashlib.sha256((work / "plan.json").read_bytes()).hexdigest()}
        (work / "keymap.json").write_text(json.dumps(km))
        # Give the shared project the same scoped page identity on both implementations.
        conf = json.loads(config.read_text())
        conf["workspaces"][0]["page_url"] = "https://page.invalid"
        config.write_text(json.dumps(conf))
        env["WG_DEFAULT_LINK_TOKEN"] = "page-key"
        run("move", "a", "Ready to Merge", code=2)
        assert outcomes[-1][2] == "a: Another holds this node now\n" and claim_reads
        del km["collab"]
        (work / "keymap.json").write_text(json.dumps(km))
        for verb, default, levels in [
                ("autonomy", "standard", ["full", "supervised", "standard"]),
                ("review-effort", "thorough", ["light", "standard", "thorough"])]:
            title = verb.replace("-", " ")
            assert run(verb) == f"{title} {default}\n"
            for level in levels:
                run(verb, level)
                before = list(mutations)
                assert run(verb, level) == f"{title} {level}\n"
                assert run(verb) == f"{title} {level}\n"
                assert before == mutations
        assert {groups[uid]["name"] for uid in active_labels} == {"standard", "review:thorough"}
        run("approve", "a", "--quote", "go ahead")
        assert comments[-1].endswith('Their words: "go ahead"')
        for key in ("dirty", "clean"):
            km = json.loads((work / "keymap.json").read_bytes())
            km.setdefault("run", {}).setdefault("nodes", {}).setdefault("a", {})["worktree"] = key
            (work / "keymap.json").write_text(json.dumps(km))
            run("move", "a", "Done", "--force", "fixture")
        assert sorted(r["id"] for r in json.loads(inventory.read_text())) == ["custom-coordinator-path", "dirty", "unrelated"]
        assert (paths["dirty"] / "pending").read_text() == "user data"
        assert archives == ["3"]
        run("archive", "--apply")
        km = json.loads((work / "keymap.json").read_bytes())
        km["nodes"]["old"] = km["nodes"].pop("a")
        (work / "keymap.json").write_text(json.dumps(km))
        stdout = run("load", "--apply", code=2)
        assert "orphan old -> EX-3" in stdout and "conflict a: EX-3" in stdout
        assert not outcomes[-1][2]
        del km["project"]
        (work / "keymap.json").write_text(json.dumps(km))
        stdout = run("load", "--adopt")
        assert stdout.startswith("orphan old -> EX-3\n") and "adopted a -> EX-3" in stdout
        if len(binary) == 1:
            # Exercise native safeguards that deliberately exceed the Python reference.
            original = (work / "keymap.json").read_bytes()
            saved_journal = (work / "journal.jsonl").read_bytes()
            km = json.loads(original)
            km["run"]["nodes"]["a"] = {"path": str(paths["custom-coordinator-path"])}
            (work / "keymap.json").write_text(json.dumps(km))
            run("move", "a", "Done", "--force", "fixture")
            assert "removed worktree" not in outcomes.pop()[1]
            assert not json.loads((work / "keymap.json").read_bytes())["run"]["nodes"]["a"].get("worktree_removed")
            assert sorted(r["id"] for r in json.loads(inventory.read_text())) == ["custom-coordinator-path", "dirty", "unrelated"]
            issues["3"]["state"] = {"name": "Todo", "type": "unstarted"}
            issues["2"]["state"]["name"] = "Ready"
            refused.add(("update", "3"))
            run("ready", "--apply")
            _, _, message = outcomes.pop()
            assert "EX-3: state update failed" in message and "moved EX-3" not in message
            assert issues["2"]["state"]["name"] == "Todo"
            for issue in issues.values():
                issue["state"]["name"] = "Done"
            archives.clear()
            refused.add(("archive", "2"))
            archive_error = "3"
            run("archive", "--apply")
            _, summary, warnings = outcomes.pop()
            assert archives == ["1"] and summary.endswith(": EX-1\n")
            assert "refused to archive EX-2" in warnings and "fixture archive interruption" in warnings
            (work / "keymap.json").write_bytes(original)
            (work / "journal.jsonl").write_bytes(saved_journal)
    def stable(value):
        if isinstance(value, dict):
            return {k: stable(v) for k, v in value.items() if k != "time"}
        if isinstance(value, list):
            return [stable(v) for v in value]
        if isinstance(value, str):
            return re.sub(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", "TIME", value)
        return value
    outcomes.append(("keymap", stable(json.loads((work / "keymap.json").read_text()))))
    outcomes.append(("journal", stable([json.loads(s) for s in (work / "journal.jsonl").read_text().splitlines()])))
    return outcomes


candidate = str(Path(sys.argv[1]).resolve())
frozen = json.loads((HERE / "expected.json").read_bytes())
verbs = {"status", "load", "ready", "approve", "move", "archive", "autonomy", "review-effort"}
# Both parsers indent option definitions. The flag set catches omissions and additions.
for indent in ("  ", "      "):
    definition = indent + "--apply  apply changes (see --ignored)"
    assert help_flags(definition) == ["--apply"]
    assert help_flags("") != ["--apply"]
    assert help_flags(definition + "\n" + indent + "--extra") != ["--apply"]
for verb in sorted(verbs):
    result = run_case([candidate], [verb, "--help"])
    assert result["exit"] == 0 and not result["files"] and not result["stderr"], (verb, result)
    assert help_flags(result["stdout"]) == frozen[f"{verb} --help"], (verb, result)
cases = [case for case in frozen if case.removeprefix("service | ").split()[0] in verbs
         and not case.endswith(" --help")]
assert len(cases) == 9
for case in cases:
    result = run_case([candidate], case.removeprefix("service | ").split(), case.startswith("service | "))
    assert result == frozen[case], (case, result, frozen[case])

with tempfile.TemporaryDirectory() as root:
    results = []
    for name, binary in [("reference", [sys.executable, "-I", str(HERE.parents[1] / "skills/work-graph/scripts/wg.py")]),
                         ("candidate", [str(Path(sys.argv[1]).resolve())])]:
        work = Path(root) / name
        work.mkdir()
        results.append(scenario(binary, work))
    for a,b in zip(*results, strict=True):
        assert a == b, (a,b)
