"""Compare public coordinator decisions using one synthetic Linear, page and gh boundary."""

from contextlib import ExitStack
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from services import Handler, fixture_service
from suite import REFERENCE

CANDIDATE = [str(Path(sys.argv[1]).resolve())]


def page(rows):
    return {"nodes": list(rows), "pageInfo": {"hasNextPage": False}}


def write(path, value):
    path.write_text(json.dumps(value))


GH = r"""
import json, os, re, sys
from pathlib import Path
root = Path(os.environ["HOME"])
data = json.loads((root / "prs").read_text())
args = sys.argv[1:]
with (root / "calls").open("a") as log:
    print(json.dumps(args), file=log)
if args[:2] == ["repo","view"]:
    result = {"owner":{"login":"fixture"},"name":"graph","url":"https://fixture.invalid/fixture/graph",
              "nameWithOwner":"fixture/graph"}
elif args[:2] == ["api","graphql"]:
    assert args[2:4] == ["--hostname","fixture.invalid"]
    query = next(arg for arg in args if arg.startswith("query="))
    assert query.count("{") == query.count("}")
    ids = re.findall(r"pr([0-9]+):\s*pullRequest\(", query)
    assert 1 <= len(ids) <= 50
    result = {"data":{"repository":{"pr"+n:data.get(n) for n in ids}}}
elif args[:2] in (["pr","view"], ["pr","checks"]):
    pr = data.get(args[2])
    if pr and args[1]=="checks" and pr.get("denied"):
        sys.exit("fixture access denied")
    if pr and args[1]=="checks" and pr.get("brokenChecks"):
        print("not valid JSON")
        sys.exit(0)
    if not pr:
        sys.exit("fixture read failed")
    result = (dict(pr,comments=pr["comments"]["nodes"],reviews=pr["reviews"]["nodes"])
              if args[1]=="view" else [{"name":"fallback","bucket":"pass"}])
else:
    sys.exit("unexpected gh arguments "+repr(args))
print(json.dumps(result))
"""


class Services:
    def __init__(self, root, settings):
        self.root = root
        self.dir = root / "example-core"
        self.dir.mkdir()
        tools = root / "bin"
        tools.mkdir()
        gh = tools / "gh"
        gh.write_text(f"#!{sys.executable}\n" + GH)
        gh.chmod(0o755)
        orca = tools / "orca"
        orca.write_text("#!/bin/sh\nexit 1\n")
        orca.chmod(0o755)
        self.config = root / "config"
        write(
            self.config,
            {
                "human": "Operator",
                "page_url": "https://page.invalid",
                "agent_merge": ["fixture"],
                "workspaces": [
                    {"id": "default", "team": "EX", "page_url": "https://page.invalid"}
                ],
            },
        )
        self.env = dict(
            settings,
            HOME=str(root),
            PATH=str(tools),
            WG_CONFIG=str(self.config),
            ORCA_CLI_COMMAND=str(orca),
            WG_LINK="off",
            WG_DEFAULT_LINK_TOKEN="page-key",
        )
        self.reset()

    def reset(self):
        self.plan = {
            "effort": {"name": "Example", "workspace": "default", "team": "EX"},
            "phases": [{"key": "1", "target": "main", "name": "Build"}],
            "nodes": [],
            "edges": [],
        }
        self.km = {
            "project": {"id": "project"},
            "nodes": {},
            "run": {"effort": {}, "nodes": {}},
        }
        self.live = {}
        self.prs = {}
        self.claims = []
        self.role = "owner"
        self.refusals = {}
        self.claim_events = []
        self.triage = []
        self.docs = []
        self.cards = []
        self.triage_error = False

    def node(self, key, status="Ready", kind="task", labels=(), lane=None, **row):
        node = {"key": key, "kind": kind, "title": key, "phase": "1"}
        if kind == "task":
            node.update(lane=lane or key, owns=[key + "/*"])
        self.plan["nodes"].append(node)
        self.km["nodes"][key] = {"id": key, "identifier": "EX-" + key}
        if row:
            self.km["run"]["nodes"][key] = row
        self.live[key] = {
            "id": key,
            "identifier": "EX-" + key,
            "title": key,
            "state": {
                "name": status,
                "type": "completed" if status == "Done" else "started",
            },
            "labels": page({"name": l} for l in labels),
        }

    def edge(self, upper, lower):
        self.plan["edges"].append({"from": upper, "to": lower})

    def pr(self, n, **overrides):
        pr = dict(
            state="OPEN",
            headRefOid="a" * 40,
            isDraft=False,
            baseRefName="main",
            mergeable="MERGEABLE",
            mergeCommit=None,
            reviews=page([]),
            comments=page([]),
            commits=page([{"commit": {"statusCheckRollup": None}}]),
        )
        self.prs[str(n)] = pr | overrides
        return {"pr": str(n), "code_done_head": "a" * 40}

    def share(self):
        self.km["collab"] = {
            "project": "project",
            "name": "Example",
            "workspace": "shared:test",
            "page": "https://page.invalid",
            "version": 1,
            "settings": self.plan["effort"].copy(),
            "plan_sha": hashlib.sha256(json.dumps(self.plan).encode()).hexdigest(),
        }

    def get(self, h):
        if h.path.endswith(("/plan", "/claims")):
            assert (
                h.headers["Authorization"] == "Bearer page-key"
                and h.headers["x-workspace"] == "shared:test"
            )
        if h.path.endswith("/plan"):
            h.send_response(304)
            h.end_headers()
        elif h.path.endswith("/claims"):
            h.reply({"role": self.role, "claims": self.claims})
        else:
            h.send_error(404)

    def update(self, h):
        assert (
            h.headers["Authorization"] == "Bearer page-key"
            and h.headers["x-workspace"] == "shared:test"
        )
        key = h.path.rsplit("/", 1)[1]
        if h.path.endswith("/plan"):
            payload = json.loads(h.rfile.read(int(h.headers["Content-Length"])))
            assert payload["keymap"]["project"]["id"] == "project"
            return h.reply({"version": 2})
        if h.command == "PUT":
            assert json.loads(h.rfile.read(int(h.headers["Content-Length"]))) == {
                "job": "work"
            }
        self.claim_events.append((h.command, key))
        status = self.refusals.get(key, 200)
        h.send_response(status)
        h.end_headers()
        payload = {"error": "claim lost"}
        if status == 409:
            payload["claim"] = {
                "holder": "Other",
                "job": "review",
                "leaseUntil": "tomorrow",
            }
        h.wfile.write(json.dumps(payload).encode())

    def post(self, h):
        assert h.headers["Authorization"] == "fixture-key"
        request = json.loads(h.rfile.read(int(h.headers["Content-Length"])))
        query = "".join(request["query"].split())
        v = request["variables"]
        if "issues(first:25" in query:
            result = {"issues": page(self.live[k] for k in v["ids"])}
        elif "labels:{some:" in query:
            result = {"issues": page([])}
        elif "project(id:" in query and "issues(first:" in query:
            if self.triage_error:
                return h.reply({"errors": [{"message": "fixture triage unavailable"}]})
            result = {"project": {"issues": page(self.triage)}}
        elif "project(id:" in query and "labels(first:" in query:
            effort = self.km["run"]["effort"]
            result = {
                "project": {
                    "labels": page(
                        [
                            {
                                "name": effort.get("autonomy_seen", "standard"),
                                "parent": {"name": "autonomy"},
                            },
                            {
                                "name": "review:"
                                + effort.get("review_seen", "thorough"),
                                "parent": {"name": "review"},
                            },
                        ]
                    )
                }
            }
        elif "documentCreate(" in query:
            self.docs.append(v["i"]["content"])
            result = {"documentCreate": {"success": True, "document": {"id": "doc"}}}
        elif "issue(id:" in query and "comments(" in query:
            result = {"issue": {"comments": page([])}}
        elif "commentCreate(" in query:
            self.cards.append(v["i"]["body"])
            result = {"commentCreate": {"success": True, "comment": {"id": "card"}}}
        elif "organization{" in query:
            result = {"organization": {"subscription": {"type": "paid"}}}
        else:
            raise AssertionError(query)
        h.reply({"data": result})

    def execute(self, binary, args, code=0):
        write(self.dir / "plan.json", self.plan)
        write(self.dir / "keymap.json", self.km)
        write(self.root / "prs", self.prs)
        (self.root / "calls").write_text("")
        self.claim_events.clear()
        proc = subprocess.run(
            [*binary, *args],
            cwd=self.root,
            env=self.env,
            capture_output=True,
            text=True,
            timeout=30,
        )
        assert proc.returncode == code, (binary, args, proc.stdout, proc.stderr)
        calls = [
            json.loads(line) for line in (self.root / "calls").read_text().splitlines()
        ]
        return proc, calls

    def compare(self, *options, expected=(), code=0):
        args = ["next", str(self.dir), "--all", "--no-publish", *options]
        ref, _ = self.execute(REFERENCE, args, code)
        events = self.claim_events.copy()
        actual, calls = self.execute(CANDIDATE, args, code)
        # The installed command in a suggested shell line differs between the two runtimes.
        assert actual.stdout == ref.stdout.replace(
            "python3 -I " + REFERENCE[-1] + " evidence", "wg evidence"
        ), (ref.stdout, actual.stdout, actual.stderr)
        assert self.claim_events == events, (events, self.claim_events)
        for line in expected:
            assert line in actual.stdout, (line, actual.stdout)
        return actual, calls


def decisions(f):
    f.node("ship", "Verifying", "ship-point")
    f.node("dispatch", lane="stack")
    f.node("stale", lane="stack")
    f.node("lower", "In Review", lane="stack", **(f.pr(1) | {"code_done_head": "old"}))
    f.edge("stale", "lower")
    f.edge("ship", "lower")
    f.node(
        "draft", "In Review", review_head="old", agent="codex", **f.pr(2, isDraft=True)
    )
    f.node(
        "reviewlimit",
        "In Review",
        review_head="old",
        review_round="2",
        **f.pr(3, isDraft=True),
    )
    f.node("undraft", "In Review", review="clean", **f.pr(4, isDraft=True))
    f.node("thorough", "In Review", **f.pr(5))
    f.node(
        "newreview",
        "In Review",
        merge_review="requested",
        **f.pr(6, reviews=page([{"body": "finding"}])),
    )
    f.node(
        "restack",
        "In Review",
        review="clean",
        gate="thorough",
        **f.pr(7, baseRefName="old"),
    )
    f.node(
        "merged", "In Review", **f.pr(8, state="MERGED", mergeCommit={"oid": "b" * 40})
    )
    f.node("closed", "In Review", **f.pr(9, state="CLOSED"))
    failed = {
        "__typename": "CheckRun",
        "name": "test",
        "status": "COMPLETED",
        "conclusion": "FAILURE",
        "startedAt": "2020",
    }
    passed = dict(failed, conclusion="SUCCESS", startedAt="2021")

    def checks(*contexts):
        return page([{"commit": {"statusCheckRollup": {"contexts": page(contexts)}}}])

    f.node("ci", "In Review", gate="thorough", **f.pr(10, commits=checks(failed)))
    f.node(
        "rerun",
        "In Review",
        gate="thorough",
        **f.pr(11, commits=checks(failed, passed)),
    )
    f.node(
        "fallback",
        "In Review",
        gate="thorough",
        **f.pr(12, comments={"nodes": [], "pageInfo": {"hasNextPage": True}}),
    )
    f.node(
        "receipt",
        "In Progress",
        state="running",
        step="receipt",
        job="work",
        dispatch="dispatch-id",
    )
    f.node("unknown", "Unmapped")
    for i in range(13, 54):
        f.node(str(i), "In Review", gate="thorough", **f.pr(i))
    f.km["run"]["effort"]["wave"] = "dispatch,stale"
    f.triage = [
        {
            "id": "triage",
            "identifier": "EX-T",
            "title": "unexpected task",
            "state": {"name": "Triage"},
        }
    ]
    actual, calls = f.compare(
        expected=[
            "do dispatch dispatch",
            "wait below stale",
            "do review draft EX-draft: #2 round 1, agent claude",
            "wait human reviewlimit",
            "do undraft undraft",
            "do merge-review thorough",
            "read the new review",
            "do restack restack",
            "do merged merged",
            "do closed closed",
            "do verify ci",
            "do ask-merge rerun",
            "do ask-merge fallback",
            "no twin",
            "claim comment is not written",
            "note triage EX-T",
            "wait blockers ship",
        ]
    )
    batches = [a for a in calls if a[:2] == ["api", "graphql"]]
    assert len(batches) == 2 and len(calls) == 5, calls
    assert [(a[1], a[2]) for a in calls if a[0] == "pr"] == [
        ("view", "12"),
        ("checks", "12"),
    ]
    f.km["run"]["effort"]["autonomy_seen"] = "full"
    _, calls = f.compare(expected=["do merge rerun", "do triage EX-T"])
    assert sum(a[-1] == "nameWithOwner" for a in calls) == 1, calls

    f.reset()
    f.node("ship", "Verifying", "ship-point")
    f.node("idle")
    f.node("done", "Merged", pr="4")
    f.km["run"]["effort"]["wave"] = "obsolete"
    p, _ = f.compare(expected=["do wave: pick the next wave from idle"])
    assert "fixture read failed" in p.stderr
    f.node("broken", "In Review", pr="99")
    f.compare(code=2)
    f.triage_error = True
    f.node(
        "checks",
        "In Review",
        gate="thorough",
        **f.pr(
            100,
            reviews={"nodes": [], "pageInfo": {"hasNextPage": True}},
            brokenChecks=True,
        ),
    )
    p, _ = f.compare("--wait", expected=["do wave:", "do ask-merge checks"])
    assert (
        "fixture triage unavailable" in p.stderr and "fixture read failed" in p.stderr
    )

    f.reset()
    f.node("merge", "Ready", "merge-point")
    f.node("ship", "Ready", "ship-point")
    f.edge("ship", "merge")
    f.compare(expected=["do close merge"])
    f.live["merge"]["state"]["name"] = "Done"
    f.compare(expected=["do verifying ship"])
    f.live["ship"]["state"]["name"] = "Verifying"
    f.compare(expected=["do ship ship"])
    f.node("landed", "Merged", **f.pr(1, state="MERGED", mergeCommit={"oid": "b" * 40}))
    f.compare(expected=["do full-suite ship"])


def scheduled(f):
    f.reset()
    f.node("ship", "Ready", "ship-point")
    f.node("ready", "Ready to Merge", gate="thorough", **f.pr(1))
    f.node("other", "Ready to Merge")
    f.node("ask", "Ready", "decision")
    f.km["run"]["effort"]["autonomy_seen"] = "full"
    f.share()
    f.claims = [
        {
            "node": "other",
            "mine": False,
            "holder": "Another",
            "stale": False,
            "job": "work",
        }
    ]
    state = f.root / ".local/state/work-graph/tick.json"
    state.parent.mkdir(parents=True, exist_ok=True)
    for binary in [REFERENCE, CANDIDATE]:
        write(state, {})
        proc, _ = f.execute(
            binary, ["tick", "--root", str(f.root), "--channel", "none"]
        )
        record = json.loads(state.read_text())["default/project"]
        assert record["members"] == {
            "ask": {"issue": "EX-ask", "reason": "do ask: ask"}
        }, (record, proc.stderr)
    f.prs["1"]["comments"]["pageInfo"]["hasNextPage"] = True
    f.prs["1"]["denied"] = True
    proc, _ = f.execute(
        CANDIDATE, ["tick", "--root", str(f.root), "--channel", "none"], code=1
    )
    assert "fixture access denied" in proc.stdout and "EOF" not in proc.stdout, (
        proc.stdout
    )


def publication(f):
    f.reset()
    f.node("ship", "Ready", "ship-point")
    f.node(
        "a",
        "In Progress",
        job="work",
        state="running",
        dispatch="receipt-id",
        step="receipt",
    )
    f.node("b", "In Review", gate="thorough", **f.pr(7))
    f.km["run"]["effort"]["wave"] = "a,b"

    def run(binary):
        f.docs.clear()
        f.cards.clear()
        proc, _ = f.execute(binary, ["next", str(f.dir), "--all"])
        assert len(f.docs) == 1 and len(f.cards) == 3, (proc.stderr, f.docs, f.cards)
        doc = json.loads(f.docs[0].split("```json\n")[1].split("\n```")[0])
        for key in ["at", "ran"]:
            doc.pop(key)
        km = json.loads((f.dir / "keymap.json").read_text())
        return proc.stdout, doc, list(f.cards), km["status_doc"]["sha"]

    expected = run(REFERENCE)
    actual = run(CANDIDATE)
    assert actual == expected, (actual, expected)
    assert any("receipt-id" in line["text"] for line in actual[1]["lines"])
    assert any("do ask-merge: #7" in card for card in actual[2])


def collaboration(f):
    f.reset()
    f.node("mine", "In Progress", state="running")
    f.node("other", "Ready to Merge")
    f.node("local", "In Review", labels=["agent:codex"], agent="codex")
    f.node("needs", "Needs Partner")
    f.node("free")
    f.node("done", "Done")
    f.node("ship", "Ready", "ship-point")
    f.km["run"]["effort"]["wave"] = "free"
    f.share()

    def claim(key, mine=True, **fields):
        return (
            dict(node=key, mine=mine, job="work", holder="Other", stale=False) | fields
        )

    f.claims = [claim("mine"), claim("other", False), claim("absent"), claim("done")]
    for status in [404, 409]:
        f.refusals["mine"] = status
        p, _ = f.compare(
            expected=[
                "do reconcile mine: claim lost",
                "do reconcile absent: this account holds a claim",
                "note human other: waits on Other",
                "do reconcile local: no claim",
                "note human needs: waits on Partner",
                "do dispatch free",
            ]
        )
        assert ("PUT", "mine") in f.claim_events and (
            "DELETE",
            "done",
        ) in f.claim_events
        if status == 409:
            assert "Other, job=review, lease ends tomorrow" in p.stdout
    f.refusals["mine"] = 503
    f.compare(expected=["wait claims page: the claims page answered HTTP 503"])
    f.refusals.clear()
    f.role = "collaborator"
    f.live["ship"]["state"]["name"] = "Needs Lead"
    f.claims[1].update(stale=True, leaseUntil="2999-01-01T00:00:00Z")
    f.compare(
        expected=[
            "note stale other: Other, lease ended 0s ago",
            "note human ship: waits on Lead",
        ]
    )
    f.live["ship"]["state"]["name"] = "Done"
    f.live["mine"]["state"]["name"] = "Done"
    f.claims = [claim("mine"), claim("done")]
    state = f.root / ".local/state/work-graph/tick.json"
    state.parent.mkdir(parents=True, exist_ok=True)
    write(state, {"default/project": {"complete": True}})
    f.execute(CANDIDATE, ["tick", "--root", str(f.root), "--channel", "none"])
    assert f.claim_events == [("DELETE", "mine"), ("DELETE", "done")], f.claim_events


with (
    tempfile.TemporaryDirectory() as tmp,
    fixture_service() as (settings, _),
    ExitStack() as stack,
):
    f = Services(Path(tmp).resolve(), settings)
    for method, handler in [
        ("GET", f.get),
        ("POST", f.post),
        ("PUT", f.update),
        ("DELETE", f.update),
    ]:
        stack.enter_context(
            patch.object(
                Handler, "do_" + method, lambda h, fn=handler: fn(h), create=True
            )
        )
    decisions(f)
    scheduled(f)
    publication(f)
    collaboration(f)
