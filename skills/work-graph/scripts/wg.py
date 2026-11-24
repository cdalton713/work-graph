#!/usr/bin/env -S uv run --script --quiet
# /// script
# requires-python = ">=3.11"
# dependencies = ["websockets>=13"]
# ///
"""work-graph helper. The `wg` command on PATH is a link to this file; uv runs it with `websockets`, which
`wg next` uses for its link to the page server. `python3 -I` also runs it: then the link needs `websockets` in
that Python, and without it `wg next` polls Linear.

  wg check     <dir>
  wg preflight <dir> [--phase P]
  wg base      <dir> [--phase P]
  wg load      <dir> [--apply] [--prune] [--adopt]
  wg ready     <dir> [--apply]
  wg status    <dir> [--phase P]
  wg next      <dir> [--wait] [--interval <seconds>] [--no-publish]
  wg approve   <dir> <key>... --quote "<the human's words>"
  wg dispatch  <dir> <key> [--agent codex|claude] [--worktree <path>]
  wg claim     <dir> <key> <dispatch|review|ci|threads|restack> [--agent codex|claude]
  wg started   <dir> <key> dispatch=<id> [<field>=<value>...]
  wg done      <dir> <key> [--dispatch <id>] [--failed "<error>"] [--worktree <path>]
  wg move      <dir> <key> <status> [--note "<text>"] [--force "<reason>"]
  wg archive   <dir> [--apply]      (Linear Free plan: archive completed and canceled issues)
  wg run set   <dir> <key|@effort> <field>=<value>...
  wg run show  <dir> [<key>|@effort] [--json]
  wg run reset <dir> <key>
  wg evidence  <dir> <key|@full-PHASE>
  wg verify    <dir> <key>
  wg owns overlap <dir> <key>...
  wg owns diff    <dir> <key> <base>
  wg tick      [--root <dir>]... [--channel none] [--install | --uninstall]
  wg wake      <dir>
  wg autostart <dir> [--install | --uninstall]
  wg config
  wg contract  [--write]
  wg ui        [--port N] [--project <name>] [--no-open] [--no-tailnet]

Exit codes: 0 clean, 1 findings or a refused action, 2 usage or input error.
Evidence returns the test command's exit code, or 3 for invalid evidence. A node key runs the test tasks that
its diff affects; @full-PHASE runs the repo-wide suite.
"""

import argparse
import contextlib
import contextvars
import copy
import email.utils
import fcntl
import fnmatch
import hashlib
import http.client
import json
import math
import os
import plistlib
import random
import re
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

# ---------------------------------------------------------------- config

# The local config of this machine (README "Config"). No file: one Linear workspace with LINEAR_API_KEY, the
# human "Human", no hosted page, and no default test runner.
CONFIG_PATH = Path(os.environ.get("WG_CONFIG") or Path.home() / ".config/work-graph/config.json").expanduser()
DEFAULT_WORKSPACE = {"id": "default", "name": "Linear", "team": None, "teams": None,
                     "key_env": ["LINEAR_API_KEY"], "team_labels": True}
DEFAULT_CONFIG = {"human": "Human", "page_url": None, "github_user": None, "tick_roots": ["~/Projects"],
                  "tick_label": "dev.work-graph.tick", "test_runner": None, "branch_prefix": "wg/",
                  "release_branch": "release", "rules": "~/.config/work-graph/rules.md",
                  "workspaces": [DEFAULT_WORKSPACE]}


def read_config(path=CONFIG_PATH):
    try:
        data = json.loads(Path(path).read_text())
    except FileNotFoundError:
        data = {}
    if not isinstance(data, dict):
        raise SystemExit(f"{path}: the config must be a JSON object")
    config = DEFAULT_CONFIG | data
    workspaces = [DEFAULT_WORKSPACE | w for w in config["workspaces"]] or [DEFAULT_WORKSPACE]
    ids = [w["id"] for w in workspaces]
    if len(set(ids)) != len(ids) or not all(isinstance(i, str) and re.fullmatch(r"[a-z0-9-]+", i) for i in ids):
        raise SystemExit(f"{path}: each workspace needs a unique id of a-z, 0-9 and -")
    if not isinstance(config["human"], str) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9 ]*", config["human"]):
        raise SystemExit(f"{path}: human must be a name of letters, digits and spaces")
    return config | {"workspaces": workspaces}


CONFIG = read_config()
HUMAN = CONFIG["human"]  # the person who answers, merges and deploys; "wait human" lines wait on this person
WORKSPACES = {w["id"]: w for w in CONFIG["workspaces"]}
DEFAULT_WORKSPACE_ID = CONFIG["workspaces"][0]["id"]  # a plan with no effort.workspace uses the first one
BRANCH_PREFIX = CONFIG["branch_prefix"]  # the prefix of each branch that wg names: <prefix><slug>-core
# The release branch of the HOTFIX and SYNC flow (references/ordering.md): a phase with this target takes
# HOTFIX PRs into it and one SYNC PR from it back to main.
RELEASE_BRANCH = CONFIG["release_branch"]


def show_config():
    """`wg config`: the config that wg uses, with where it came from, and whether the rules file exists.
    A key is never in the config, so nothing secret prints."""
    rules = Path(CONFIG["rules"]).expanduser()
    print(json.dumps({"path": str(CONFIG_PATH), "exists": CONFIG_PATH.exists(), "rules": str(rules),
                      "rules_exist": rules.exists(), "wait_status": WAIT_STATUS, "wait_label": WAIT_LABEL,
                      "config": CONFIG}, indent=2))
    return 0


def human_slug(name):
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


KINDS = {"task", "spike", "decision", "ops", "merge-point", "ship-point"}
KIND_LABEL = {"merge-point": "merge-point", "ship-point": "ship-point", "ops": "ops",
              "decision": "decision", "spike": "spike"}
ROLES = {"hotfix", "sync", "integration"}
# Who runs an ops node: the human (default), or the coordinator where the repository lets the agent deploy and
# verify. A plan can name the human by the slug of the configured name. Sync and integration are post-merge tasks.
OPS_BY = {"human", human_slug(HUMAN), "coordinator"}
REVIEWING = {"In Review", "Ready to Merge"}
WAIT_STATUS = f"Needs {HUMAN}"  # the status of an issue that waits on the human
CD_WRITES = {"Todo", "Ready", "In Progress", WAIT_STATUS, "In Review",
             "Ready to Merge", "Merged", "Verifying", "Done", "Canceled"}
CD_STATUSES = CD_WRITES | {"Triage", "Backlog"}
WAIT_LABEL = f"needs-{human_slug(HUMAN)}"
MERGE_LABEL = "ready-to-merge"
# An ENG workflow has no twin for these statuses. A workspace label marks them on an ENG ticket.
ENG_LABELS = {WAIT_STATUS: WAIT_LABEL, "Ready to Merge": MERGE_LABEL}
REVIEW_OK = {"clean", "accepted"}
MAX_THOROUGH = 2  # thorough reviews of one PR; the second only when a fix needs it
INITIATIVE_GROUP = "initiative"  # the team's single-select project label group; each child label is one initiative
# The autonomy level of each effort (SKILL.md "Autonomy level"): one child label of the single-select project label
# group `autonomy`. No label means AUTONOMY_DEFAULT. The human changes it on the page at any time.
AUTONOMY_GROUP = "autonomy"
AUTONOMY_LEVELS = ("full", "standard", "supervised")
AUTONOMY_DEFAULT = "standard"
# The plain project label that pauses an effort. The page sets it; `wg next` holds each `do` line while it is there.
PAUSED_LABEL = "paused"
# The workspace issue label that marks the human's answer from the page on a Needs <human> issue. `wg next`
# prints `do answer` while it is there; any `wg move` of the issue removes it.
ANSWERED_LABEL = "answered"
REVIEWED_LABEL = "reviewed"  # The human's mark on an issue: they accept its PR as reviewed. wg never sets it.
SETTLED = {"Merged", "Done", "Canceled"}  # the statuses that can satisfy an edge
ENG_WRITES = {"Todo": "Ready for Eng", "Ready": "Ready for Eng", "In Progress": "In Dev",
              "In Review": "In Review", "Ready to Merge": "In Review", "Merged": "Ready for Deploy",
              "Done": "Done", "Canceled": "Canceled"}
MERGED = {"Merged", "Done"}
# The default test runner (config `test_runner`): `run` + targets + `options`, with `suite` as the targets of the
# repo-wide run. A node's evidence runs only the moon test tasks that its diff affects; the suite runs once for
# each phase (@full-PHASE). The runner prints the commit it tests, matched by `commit_marker`. plan.json can
# replace all of it with effort.test (a list of arguments). With no runner, each plan needs effort.test.
TEST_RUNNER = CONFIG["test_runner"]
TEST_RUN = list(TEST_RUNNER["run"]) if TEST_RUNNER else []
TEST_OPTIONS = list(TEST_RUNNER.get("options", [])) if TEST_RUNNER else []
DEFAULT_TEST = [*TEST_RUN, *TEST_RUNNER.get("suite", []), *TEST_OPTIONS] if TEST_RUNNER else None
COMMIT_MARKER = TEST_RUNNER.get("commit_marker") if TEST_RUNNER else None
# ENG workflow names that mean the same as a status of the plan.
ALIAS = {"Ready for Deploy": "Merged", "External QA": "In Review", "In Dev": "In Progress", "Ready for Eng": "Todo"}


def issue_labels(issue):
    return issue.get("labels", {}).get("nodes", [])


def norm(state, labels=()):
    names = {label["name"] for label in labels}
    if WAIT_LABEL in names:
        return WAIT_STATUS
    if state["type"] == "completed":
        return "Done"
    if state["type"] in ("canceled", "duplicate"):
        return "Canceled"
    name = ALIAS.get(state["name"], state["name"])
    return "Ready to Merge" if MERGE_LABEL in names and name == "In Review" else name


def die(msg, code=2):
    print(msg, file=sys.stderr)
    sys.exit(code)


def load_plan(plan_dir, *, strict=False):
    p = Path(plan_dir) / "plan.json"
    try:
        plan = json.loads(p.read_text())
    except FileNotFoundError:
        message = f"no plan.json in {plan_dir}"
        if strict:
            raise FileNotFoundError(message) from None
        die(message)
    plan.setdefault("edges", [])
    workspace = WORKSPACES[plan_workspace(plan)]
    if workspace["team"]:
        plan["effort"].setdefault("team", workspace["team"])
    elif "team" not in plan["effort"]:
        die(f"effort.team is missing, and workspace {workspace['id']} has no default team in {CONFIG_PATH}")
    return plan


LINEAR_WORKSPACE = contextvars.ContextVar("linear_workspace", default=DEFAULT_WORKSPACE_ID)


def plan_workspace(plan):
    """The id of the plan's Linear workspace (config `workspaces`). A team that another workspace names is an error:
    the plan would read the wrong Linear."""
    workspace = plan.get("effort", {}).get("workspace", DEFAULT_WORKSPACE_ID)
    if workspace not in WORKSPACES:
        raise ValueError(f"effort.workspace must be one of {', '.join(WORKSPACES)} ({CONFIG_PATH})")
    team = plan.get("effort", {}).get("team")
    if team is None:
        return workspace
    config = WORKSPACES[workspace]
    if config["teams"] and team not in config["teams"]:  # `teams`: the only teams of this workspace
        raise ValueError(f"{workspace} plans must use team {' or '.join(config['teams'])}")
    owner = next((w["id"] for w in WORKSPACES.values()
                  if w["id"] != workspace and team in {w["team"], *(w["teams"] or [])}), None)
    if owner and team != config["team"] and team not in (config["teams"] or []):
        raise ValueError(f"team {team} requires effort.workspace {owner}")
    return workspace


def plan_team(plan):
    """effort.team, or the default team of the plan's workspace."""
    team = plan["effort"].get("team") or WORKSPACES[plan_workspace(plan)]["team"]
    if not team:
        die(f"effort.team is missing, and workspace {plan_workspace(plan)} has no default team in {CONFIG_PATH}")
    return team


def team_labels(plan):
    """True when the workspace makes project labels per team (Linear's Business plan), else workspace labels."""
    return bool(WORKSPACES[plan_workspace(plan)]["team_labels"])


def linear_key(workspace=None):
    """The key from LINEAR_<ID>_API_KEY, the workspace's `key_env` names, or ~/.config/work-graph/<id>-linear-api-key."""
    if workspace is None:
        workspace = LINEAR_WORKSPACE.get()
    env_name = f"LINEAR_{workspace.upper().replace('-', '_')}_API_KEY"
    key = os.environ.get(env_name, "").strip()
    for name in WORKSPACES.get(workspace, DEFAULT_WORKSPACE)["key_env"]:
        key = key or os.environ.get(name, "").strip()
    if not key:
        path = Path.home() / f".config/work-graph/{workspace}-linear-api-key"
        if path.exists():
            if path.stat().st_mode & 0o044:
                print(f"warn: {path} is readable by group or others; set mode 600", file=sys.stderr)
            key = path.read_text().strip()
    if not key:
        raise ReadError(f"no Linear key for {workspace}: set {env_name}")
    return key


def keymap_path(plan_dir):
    return Path(plan_dir) / "keymap.json"


def load_keymap(plan_dir):
    p = keymap_path(plan_dir)
    km = json.loads(p.read_text()) if p.exists() and p.stat().st_size else {}
    km.setdefault("milestones", {})
    km.setdefault("nodes", {})
    return km


def save_keymap(plan_dir, km):
    save_json(keymap_path(plan_dir), km)


_HELD_LOCKS = contextvars.ContextVar("wg_held_locks", default=frozenset())


@contextlib.contextmanager
def plan_lock(plan_dir):
    """One writer of keymap.json at a time. Without it, two parallel commands lose a run row.

    Reentrant in one context: `wg done` holds it and calls `move`, which cleans up the worktree under it."""
    key = os.path.realpath(plan_dir)
    held = _HELD_LOCKS.get()
    if key in held:
        yield
        return
    fd = os.open(plan_dir, os.O_RDONLY)
    token = None
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        token = _HELD_LOCKS.set(held | {key})
        yield
    finally:
        if token is not None:
            _HELD_LOCKS.reset(token)
        os.close(fd)


def save_json(path, value, mode=None):
    if mode is None:
        try:
            mode = stat.S_IMODE(path.stat().st_mode)
        except FileNotFoundError:
            mode = 0o644
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as f:
        tmp = Path(f.name)
        try:
            json.dump(value, f, indent=2)
            f.write("\n")
            f.close()
            tmp.chmod(mode)
            tmp.replace(path)
        finally:
            tmp.unlink(missing_ok=True)


def post_merge(n):
    return n.get("kind") == "task" and n.get("role") in ("sync", "integration")


# ---------------------------------------------------------------- check

def check(plan):
    errs = []
    phases = {str(p["key"]): p for p in plan.get("phases", [])}
    for ph, phase in phases.items():
        if not isinstance(phase.get("target"), str) or not phase["target"].strip():
            errs.append(f"phase {ph}: no target")
    initiative = plan.get("effort", {}).get("initiative")
    if initiative is not None and (not isinstance(initiative, str) or not initiative.strip() or len(initiative) > 80):
        errs.append("effort.initiative: a name of 1 to 80 characters")
    nodes, issue_keys = {}, {}
    for n in plan.get("nodes", []):
        k = n.get("key")
        if not k or k in nodes:
            errs.append(f"node key missing or duplicate: {k!r}")
            continue
        nodes[k] = n
        if n.get("kind") not in KINDS:
            errs.append(f"{k}: kind {n.get('kind')!r} not in {sorted(KINDS)}")
        if str(n.get("phase")) not in phases:
            errs.append(f"{k}: phase {n.get('phase')!r} not in phases")
        if not n.get("title") and not n.get("eng"):
            errs.append(f"{k}: no title")
        if n.get("kind") == "task" and not n.get("lane") and n.get("role") != "integration":
            errs.append(f"{k}: task has no lane")
        if n.get("role") and n["role"] not in ROLES:
            errs.append(f"{k}: role {n['role']!r} not in {sorted(ROLES)}")
        if "eng" in n and "issue" in n:
            errs.append(f"{k}: cannot have both eng and issue")
        if "by" in n and (n.get("kind") != "ops" or n["by"] not in OPS_BY):
            errs.append(f"{k}: by {n['by']!r} needs kind ops and a value in {sorted(OPS_BY)}")
        for field in ("eng", "issue"):
            if field not in n:
                continue
            identifier = n[field]
            if not isinstance(identifier, str) or not re.fullmatch(r"[A-Z]+-[0-9]+", identifier):
                errs.append(f"{k}: invalid {field} identifier {identifier!r}")
                continue
            other = issue_keys.setdefault(identifier, k)
            if other != k:
                errs.append(f"{k}: issue {identifier} is also used by {other}")
    deps = {k: [] for k in nodes}
    edges = set()
    for e in plan["edges"]:
        a, b = e.get("from"), e.get("to")
        if (a, b) in edges:
            errs.append(f"edge {a} -> {b}: duplicate")
            continue
        edges.add((a, b))
        if a not in nodes or b not in nodes:
            errs.append(f"edge {a} -> {b}: unknown key")
            continue
        deps[a].append(b)

    # cycles
    state = {}

    def visit(k, path):
        if state.get(k) == 1:
            errs.append("cycle: " + " -> ".join(path + [k]))
            return
        if state.get(k) == 2:
            return
        state[k] = 1
        for d in deps[k]:
            visit(d, path + [k])
        state[k] = 2

    for k in nodes:
        visit(k, [])

    prev, prev_sp = None, None
    for ph, phase in phases.items():
        mine = [k for k, n in nodes.items() if str(n.get("phase")) == ph]
        if prev_sp:
            for k in mine:
                if nodes[k].get("kind") in {"task", "ops", "merge-point", "ship-point"}:
                    if not _reaches(k, prev_sp, deps):
                        errs.append(f"{k}: does not depend on ship point {prev_sp} of phase {prev}")
        mps = [k for k in mine if nodes[k].get("kind") == "merge-point"]
        sps = [k for k in mine if nodes[k].get("kind") == "ship-point"]
        if len(mps) != 1 or len(sps) != 1:
            errs.append(f"phase {ph}: needs exactly one merge-point and one ship-point (has {mps}, {sps})")
            prev, prev_sp = ph, sps[0] if len(sps) == 1 else None
            continue
        mp, sp = mps[0], sps[0]
        prev, prev_sp = ph, sp
        for k in mine:
            if (k == sp or nodes[k].get("kind") == "ops" or post_merge(nodes[k])) and not _reaches(k, mp, deps):
                errs.append(f"{k}: not after merge point {mp}")
        # orphans: every node of the phase must be reachable from the ship point
        seen, stack = set(), [sp]
        while stack:
            k = stack.pop()
            if k in seen:
                continue
            seen.add(k)
            stack.extend(deps.get(k, []))
        for k in sorted(set(mine) - seen):
            errs.append(f"phase {ph}: {k} is not reached from ship point {sp}")
        # lane rules
        tasks = {k for k in mine if nodes[k].get("kind") == "task"}
        for k in tasks:
            tdeps = [d for d in deps[k] if d in tasks]
            if len(tdeps) > 1:
                errs.append(f"{k}: more than one task dependency in phase {ph}: {tdeps}")
            for d in tdeps:
                if nodes[d].get("lane") != nodes[k].get("lane"):
                    errs.append(f"{k} -> {d}: cross-lane edge inside phase {ph} (ordering.md 'Lanes')")
        for k in tasks:
            anchor = sp if post_merge(nodes[k]) else mp
            if not _reaches(anchor, k, deps):
                errs.append(f"{k}: not before its anchor {anchor}")
        target = phase.get("target")
        roles = [nodes[k].get("role") for k in tasks]
        if target == RELEASE_BRANCH:
            if roles.count("sync") != 1:
                errs.append(f"phase {ph}: {RELEASE_BRANCH} needs exactly one sync task")
        elif isinstance(target, str) and target.startswith("effort/") and roles.count("integration") != 1:
            errs.append(f"phase {ph}: {target} needs exactly one integration task")
        for k in sorted(tasks):
            role = nodes[k].get("role")
            if target == RELEASE_BRANCH and not post_merge(nodes[k]):
                if role != "hotfix":
                    errs.append(f"{k}: {RELEASE_BRANCH} pre-merge task needs role hotfix")
                # effort.stacked_hotfix: the human allowed one lane of stacked HOTFIX PRs for this effort.
                if not plan["effort"].get("stacked_hotfix") and any(d != k and _reaches(k, d, deps) for d in tasks):
                    errs.append(f"{k}: {RELEASE_BRANCH} pre-merge task depends on another task")
            if target != RELEASE_BRANCH and role in {"hotfix", "sync"}:
                errs.append(f"{k}: role {role} requires target {RELEASE_BRANCH}")
            if role == "integration" and not (isinstance(target, str) and target.startswith("effort/")):
                errs.append(f"{k}: role integration requires an effort/ target")
    return errs


def _reaches(src, dst, deps):
    seen, stack = set(), [src]
    while stack:
        k = stack.pop()
        if k == dst:
            return True
        if k not in seen:
            seen.add(k)
            stack.extend(deps.get(k, []))
    return False


def topo_order(plan):
    """Node keys in run order: phase order, then dependencies (Kahn), then lane, then plan order."""
    nodes = plan["nodes"]
    pos = {n["key"]: i for i, n in enumerate(nodes)}
    phase_rank = {str(p["key"]): i for i, p in enumerate(plan.get("phases", []))}
    lane_rank = {}
    for n in nodes:
        lane_rank.setdefault(n.get("lane"), len(lane_rank))
    deps = {n["key"]: set() for n in nodes}
    for e in plan.get("edges", []):
        if e.get("from") in deps and e.get("to") in deps:
            deps[e["from"]].add(e["to"])
    by_key = {n["key"]: n for n in nodes}

    def rank(k):
        n = by_key[k]
        return (phase_rank.get(str(n.get("phase")), 99), lane_rank[n.get("lane")], pos[k])

    order, done = [], set()
    while len(order) < len(nodes):
        free = [k for k in deps if k not in done and deps[k] <= done]
        if not free:  # a cycle: wg check reports it; append the rest in plan order
            order += sorted((k for k in deps if k not in done), key=pos.get)
            break
        # Take the free node of the earliest phase first, so a later phase never jumps ahead.
        k = min(free, key=rank)
        order.append(k)
        done.add(k)
    return order


# ---------------------------------------------------------------- Linear

class ReadError(Exception):
    pass


# The retry of `gql`. Tests replace the sleep, the clock, and the jitter, so that no test waits.
GQL_TRIES = 4
GQL_DELAY = 1.0          # base delay before the second try; the base doubles for each later try
GQL_RESET_WAIT = 60      # wait for Linear's reset time only when it is at most this many seconds away
gql_sleep = time.sleep
gql_clock = time.time
gql_jitter = random.random
# The last rate limit headers that Linear sent, for reports: header name without "X-RateLimit-" (lower case) -> value.
LINEAR_RATE = {}
RATE_LIMITS = ("Requests", "Complexity", "Endpoint-Requests", "Endpoint-Complexity")


class _GqlFailure(Exception):
    """One failed try. `kind` is "refused" (Linear did not run the request: HTTP 429 or RATELIMITED),
    "transient" (a network error, a timeout, or HTTP 5xx: Linear can have run it), or "final".
    `headers` are the headers of this failed response, or None."""

    def __init__(self, message, kind, cause=None, headers=None):
        super().__init__(message)
        self.kind = kind
        self.cause = cause
        self.headers = headers


def is_mutation(query):
    """True when the first operation of a GraphQL document is a mutation. GraphQL ignores white space,
    commas, a byte order mark, and comments (from # to the end of the line) before the first token."""
    rest = query
    while True:
        stripped = rest.lstrip(" \t\r\n,\ufeff")
        if stripped.startswith("#"):
            newline = re.search(r"[\r\n]", stripped)
            rest = stripped[newline.start():] if newline else ""
            continue
        return re.match(r"mutation(?![_0-9A-Za-z])", stripped) is not None


def _note_rate(headers):
    if headers is None:
        return
    for limit in RATE_LIMITS:
        for part in ("Limit", "Remaining", "Reset"):
            value = headers.get(f"X-RateLimit-{limit}-{part}")
            if value is not None:
                LINEAR_RATE[f"{limit}-{part}".lower()] = value


def _rate_limited(errors):
    return isinstance(errors, list) and any(
        isinstance(e, dict) and isinstance(e.get("extensions"), dict) and e["extensions"].get("code") == "RATELIMITED"
        for e in errors)


def _epoch_seconds(value):
    try:
        at = float(value)
    except (TypeError, ValueError):
        return None
    return at / 1000 if at > 1e11 else at  # Linear gives reset times in milliseconds since the epoch


def _reset_wait(headers):
    """Seconds until Linear accepts the refused request again, from the headers of that refusal: the
    Retry-After header, and the reset time of each limit that is used up (the latest one counts). Without
    these, the reset time of the request limit. None when the refusal gives no time."""
    if headers is None:
        return None
    now = gql_clock()
    waits = []
    retry_after = headers.get("Retry-After")
    if retry_after is not None:
        try:
            waits.append(float(retry_after))
        except ValueError:
            with contextlib.suppress(TypeError, ValueError, IndexError):
                waits.append(email.utils.parsedate_to_datetime(retry_after).timestamp() - now)
    for limit in RATE_LIMITS:
        if headers.get(f"X-RateLimit-{limit}-Remaining") == "0":
            at = _epoch_seconds(headers.get(f"X-RateLimit-{limit}-Reset"))
            if at is not None:
                waits.append(at - now)
    if not waits:
        at = _epoch_seconds(headers.get("X-RateLimit-Requests-Reset"))
        if at is not None:
            waits.append(at - now)
    return max(0.0, max(waits)) if waits else None


def _gql_try(req):
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            headers = getattr(response, "headers", None)
            _note_rate(headers)
            body = json.load(response)
    except urllib.error.HTTPError as e:
        _note_rate(e.headers)
        try:
            detail = e.read().decode(errors="replace")  # all of it: an error code can follow a long message
        except (http.client.HTTPException, OSError) as read_error:  # OSError covers a timeout and a reset
            detail = f"(body not read: {read_error})"
        message = f"Linear HTTP {e.code}: {detail[:500]}"
        if e.code >= 500:
            kind = "transient"
        elif e.code == 429:
            kind = "refused"
        else:
            try:
                errors = json.loads(detail).get("errors")
            except (ValueError, AttributeError):
                errors = None
            kind = "refused" if _rate_limited(errors) else "final"
        raise _GqlFailure(message, kind, e, e.headers) from e
    except (urllib.error.URLError, TimeoutError, http.client.HTTPException, ConnectionError) as e:
        raise _GqlFailure(f"Linear request failed: {e}", "transient", e) from e
    if body.get("errors"):
        message = "Linear error: " + json.dumps(body["errors"])[:800]
        raise _GqlFailure(message, "refused" if _rate_limited(body["errors"]) else "final", headers=headers)
    return body


def gql(query, variables=None):
    """Send one GraphQL request to Linear. A failure for a short time is tried again, at most GQL_TRIES
    tries: a query after a network error, a timeout, HTTP 429, HTTP 5xx, or RATELIMITED; a mutation only
    after HTTP 429 or RATELIMITED, because after a timeout or a 5xx Linear can have applied it."""
    key = linear_key()
    req = urllib.request.Request(
        "https://api.linear.app/graphql",
        data=json.dumps({"query": query, "variables": variables or {}}).encode(),
        headers={"Authorization": key, "Content-Type": "application/json"},
    )
    mutation = is_mutation(query)
    for attempt in range(1, GQL_TRIES + 1):
        try:
            body = _gql_try(req)
            break
        except _GqlFailure as failure:
            tries = f"after {attempt} {'try' if attempt == 1 else 'tries'}"
            if not (failure.kind == "refused" or (failure.kind == "transient" and not mutation)):
                raise ReadError(f"{failure} ({tries})") from failure.cause
            delay = GQL_DELAY * 2 ** (attempt - 1) * (0.5 + gql_jitter())
            if failure.kind == "refused":
                wait = _reset_wait(failure.headers)
                if wait is not None and wait > GQL_RESET_WAIT:
                    raise ReadError(f"{failure} ({tries}; Linear accepts it again in {wait:.0f} s)") from failure.cause
                if wait is not None:
                    delay = wait + gql_jitter()
            if attempt == GQL_TRIES:
                raise ReadError(f"{failure} ({tries})") from failure.cause
            reason = " ".join(str(failure).split())[:200]
            print(f"warn linear: {reason}; try {attempt + 1} of {GQL_TRIES} in {delay:.1f} s",
                  file=sys.stderr, flush=True)
            gql_sleep(delay)
    note_write(query, variables or {}, body.get("data") or {})
    return body["data"]


# The issues that this process changed in Linear, for the `wrote` message of the link (flush_writes).
LINEAR_WRITES = {"any": False, "ids": set()}


def note_write(query, variables, data):
    """Remember a mutation, so the page server hears of it. The status document is left out: the page shows
    the coordinator's state from the link, and `wg next --wait` writes that document at each interval."""
    match = re.match(r"\s*mutation\b[^{]*\{\s*(\w+)", query)
    if not match or match.group(1).startswith("document"):
        return
    LINEAR_WRITES["any"] = True
    ids = LINEAR_WRITES["ids"]
    for value in [variables, *variables.values()]:
        if isinstance(value, dict) and isinstance(value.get("id"), str):
            ids.add(value["id"])
        if isinstance(value, dict) and isinstance(value.get("issueId"), str):
            ids.add(value["issueId"])
    created = (data.get(match.group(1)) or {}).get("issue") if isinstance(data.get(match.group(1)), dict) else None
    if isinstance(created, dict) and isinstance(created.get("id"), str):
        ids.add(created["id"])


def team_info(team_key):
    teams = gql("""query($k:String!){ teams(filter:{key:{eq:$k}}){ nodes{ id
                  states(first:50){nodes{id name}} } } }""", {"k": team_key})["teams"]["nodes"]
    if not teams:
        raise ReadError(f"team {team_key} not found")
    team = teams[0]
    labels, after = {}, None
    while True:
        page = gql("""query($id:String!,$after:String){team(id:$id){ labels(first:100,after:$after){
                       nodes{id name} pageInfo{hasNextPage endCursor} } } }""",
                   {"id": team["id"], "after": after})["team"]["labels"]
        labels.update((label["name"], label["id"]) for label in page["nodes"])
        info = page["pageInfo"]
        if not info["hasNextPage"]:
            return team["id"], {state["name"]: state["id"] for state in team["states"]["nodes"]}, labels
        after = info["endCursor"]


def fetch_nodes(km):
    ids = [v["id"] for v in km["nodes"].values()]
    out = {}
    for i in range(0, len(ids), 25):
        res = gql("""query($ids:[ID!]){ issues(first:25, includeArchived:true, filter:{id:{in:$ids}}){ nodes{ id identifier url sortOrder title team{id} project{id} projectMilestone{id}
                     state{name type} archivedAt labels(first:100){nodes{id name}}
                     relations(first:50,includeArchived:true){nodes{id type relatedIssue{id}} pageInfo{hasNextPage endCursor}} } } }""", {"ids": ids[i:i + 25]})
        for n in res["issues"]["nodes"]:
            out[n["id"]] = n
    return out


# Linear's Free plan holds 250 issues in a workspace; archived issues do not count. On that plan, wg archives
# each completed and canceled issue of the workspace. An archived issue keeps its relations, but Linear lists
# them only with includeArchived, so every relation query of wg and the page passes it.
FREE_PLAN = {}


def free_plan():
    """True when the workspace of this command has no paid Linear subscription."""
    workspace = LINEAR_WORKSPACE.get()
    if workspace not in FREE_PLAN:
        org = gql("query{ organization{ subscription{ type } } }").get("organization") or {}
        FREE_PLAN[workspace] = "subscription" in org and org["subscription"] is None
    return FREE_PLAN[workspace]


def archive_settled(apply=True):
    """Archive each completed or canceled issue of the workspace that is not archived. Returns the identifiers."""
    found, after = [], None
    while True:
        page = gql("""query($after:String){ issues(first:100,after:$after,
                       filter:{state:{type:{in:["completed","canceled"]}}}){
                       nodes{id identifier} pageInfo{hasNextPage endCursor} } }""", {"after": after})["issues"]
        found += page["nodes"]
        if not page["pageInfo"]["hasNextPage"]:
            break
        after = page["pageInfo"]["endCursor"]
    if apply:
        for issue in found:
            gql("mutation($id:String!){ issueArchive(id:$id){ success } }", {"id": issue["id"]})
    return [issue["identifier"] for issue in found]


def archive_free(apply=True):
    """On the Free plan, archive the settled issues and print one line. A failure warns; it stops nothing."""
    try:
        if not free_plan():
            return []
        archived = archive_settled(apply)
    except ReadError as error:
        print(f"warn: archive of settled issues failed: {error}", file=sys.stderr)
        return []
    if archived:
        verb = "archived" if apply else "would archive"
        print(f"{verb} {len(archived)} completed or canceled issues (Linear Free plan, 250 issues): "
              + " ".join(archived[:20]) + (" …" if len(archived) > 20 else ""))
    return archived


def node_marker(n):
    return (f"`{n['key']}` · kind `{n['kind']}` · phase `{n['phase']}`"
            + (f" · lane `{n['lane']}`" if n.get("lane") else "")
            + (f" · role `{n['role']}`" if n.get("role") else ""))


def node_body(n):
    notes = (f"+++ Agent notes\n\nwork-graph node {node_marker(n)}"
             "\n\nThe graph lives in plan.json; change edges there and run `wg.py load`."
             "\n\nAcceptance and files are in the node card comment.\n\n+++")
    return "\n\n".join(filter(None, [n.get("description"), notes]))


EMPTY_CARD = "No acceptance or files in plan.json."  # footer of cards written before the data block
CARD_FOOTER = "Generated from plan.json by `wg load`. Change plan.json, not this comment."
CARD_PLAN_FIELDS = ("key", "kind", "phase", "lane", "role")
# `code_done` comes from `code_done_head`. `wave` and `next` are the last result of `wg next` (see `publish`).
CARD_RUN_FIELDS = ("branch", "pr", "review", "merge_review", "state", "job", "started_at", "soak_until",
                   "code_done", "wave", "next")


def card_data(n, row=None):
    """The machine-readable part of the node card. `wg ui` reads it from Linear."""
    data = {"wg": 1}
    data.update((f, str(n[f])) for f in CARD_PLAN_FIELDS if n.get(f))
    data.update((f, (row or {})[f]) for f in CARD_RUN_FIELDS if (row or {}).get(f))
    return data


def node_card(n, row=None):
    files = [f"- owns `{g}`" for g in n.get("owns", [])]
    files += [f"- shares `{g}` (additive only)" for g in n.get("shares", [])]
    parts = [f"**work-graph node card** {node_marker(n)}"]
    if n.get("acceptance"):
        parts.append("**Acceptance**\n\n" + n["acceptance"])
    if files:
        parts.append("**Files**\n\n" + "\n".join(files))
    parts.append("```json\n" + json.dumps(card_data(n, row)) + "\n```")
    parts.append(CARD_FOOTER)
    return "\n\n".join(parts)


def issue_update(issue_id, fields):
    result = gql("""mutation($id:String!,$i:IssueUpdateInput!){ issueUpdate(id:$id,input:$i){ success } }""",
                 {"id": issue_id, "i": fields})
    if not result["issueUpdate"]["success"]:
        die(f"could not update issue {issue_id}")


def card_row(entry, row):
    """Show code done, the current job and its start time while live, and the last result of `wg next`."""
    view = dict(row or {})
    if view.get("code_done_head"):
        view["code_done"] = "yes"
    if view.get("state") not in LIVE:
        view.pop("job", None)
        view.pop("started_at", None)
    view.update((entry or {}).get("published") or {})
    return view


def sync_card(n, entry, apply, changes, row=None, strict=False):
    card = (entry or {}).get("card")
    body = node_card(n, card_row(entry, row))
    sha = hashlib.sha256(body.encode()).hexdigest()
    if card and card["sha"] == sha:
        return False
    changes.append(f"card {n['key']}: {'update' if card else 'create'}")
    if not apply:
        return False
    if card:
        result = gql("""mutation($id:String!,$i:CommentUpdateInput!){
                        commentUpdate(id:$id,input:$i){ success comment{id} } }""",
                     {"id": card["id"], "i": {"body": body}})["commentUpdate"]
    else:
        result = gql("""mutation($i:CommentCreateInput!){ commentCreate(input:$i){ success comment{id} } }""",
                     {"i": {"issueId": entry["id"], "body": body}})["commentCreate"]
    if (strict and result.get("success") is not True) or result.get("success") is False:
        raise ReadError(f"could not write the node card for {n['key']}")
    entry["card"] = {"id": result["comment"]["id"], "sha": sha}
    return True


def find_project(team_id, name):
    projects = gql("""query($id:String!,$name:String!){ team(id:$id){
                       projects(first:2,includeArchived:true,filter:{name:{eq:$name}}){nodes{id name url}} } }""",
                   {"id": team_id, "name": name})["team"]["projects"]["nodes"]
    matches = [p for p in projects if p["name"] == name]
    if len(matches) > 1:
        die(f"more than one project is named {name!r}")
    return matches[0] if matches else None


def sync_initiative(team_id, project_id, name, apply, changes, team_scoped=True):
    """Put the project in the initiative `name`: a child of the single-select project label group `initiative`."""
    sync_project_label(INITIATIVE_GROUP, "work-graph: the initiative of each project. Each child label is one initiative.",
                       "initiative", team_id, project_id, name, apply, changes, team_scoped)


def sync_project_label(group_name, group_description, noun, team_id, project_id, name, apply, changes, team_scoped=True):
    """Give the project the label `name`: a child of the single-select project label group `group_name`.
    Creates the group and the child label when they are missing, and removes another child of the group from
    the project. With `team_scoped`, the labels belong to the team, so only its members see them. Without it
    (a workspace with `team_labels: false`: Linear's team project labels need the Business plan), they are workspace labels."""
    scope = {"team": {"id": {"eq": team_id}}} if team_scoped else {"team": {"null": True}}
    owner = {"teamId": team_id} if team_scoped else {}
    def labels():
        return gql("""query($f:ProjectLabelFilter!){ projectLabels(first:250, filter:$f){
                      nodes{id name isGroup retiredAt parent{id}} } }""", {"f": scope})["projectLabels"]["nodes"]

    def create(inp, match):
        """Linear can list a new label some seconds after it makes it. A duplicate name means the label exists:
        read the list again until it shows it."""
        try:
            return gql("""mutation($i:ProjectLabelCreateInput!){ projectLabelCreate(input:$i){ projectLabel{id} } }""",
                       {"i": inp})["projectLabelCreate"]["projectLabel"]
        except ReadError as e:
            if "duplicate label name" not in str(e):
                raise
            for _ in range(10):
                time.sleep(1)
                if hit := next((label for label in labels() if match(label)), None):
                    return hit
            raise

    found = labels()
    groups = [label for label in found if label["isGroup"] and label["name"].lower() == group_name]
    group = groups[0] if groups else None
    child = next((label for label in found if group and (label["parent"] or {}).get("id") == group["id"]
                  and label["name"] == name), None)
    if group and group.get("retiredAt"):
        die(f"the project label group {group_name!r} is retired; restore it in Linear")
    if child and child.get("retiredAt"):
        die(f"the {noun} label {name!r} is retired; restore it in Linear or name another {noun}")
    if not group:
        changes.append(f"create project label group {group_name!r}")
        if apply:
            group = create({"name": group_name, **owner, "isGroup": True, "groupType": "singleSelect",
                            "description": group_description},
                           lambda label: label["isGroup"] and label["name"].lower() == group_name)
    if not child:
        known = sorted(label["name"] for label in found if group and (label["parent"] or {}).get("id") == group["id"]
                       and not label.get("retiredAt"))
        changes.append(f"create {noun} {name!r}" + (f" (existing: {', '.join(known)})" if known else ""))
        if apply:
            child = create({"name": name, **owner, "parentId": group["id"]},
                           lambda label: (label["parent"] or {}).get("id") == group["id"] and label["name"] == name)
    on = []
    if project_id:
        on = gql("""query($id:String!){ project(id:$id){ labels(first:50){ nodes{id name parent{id}} } } }""",
                 {"id": project_id})["project"]["labels"]["nodes"]
    others = [label for label in on if group and (label["parent"] or {}).get("id") == group.get("id")
              and label["id"] != (child or {}).get("id")]
    if child and any(label["id"] == child["id"] for label in on) and not others:
        return
    changes.append(f"set {noun} {name!r}" + "".join(f" (was {label['name']!r})" for label in others))
    if apply:
        for label in others:
            gql("""mutation($id:String!,$l:String!){ projectRemoveLabel(id:$id, labelId:$l){ success } }""",
                {"id": project_id, "l": label["id"]})
        gql("""mutation($id:String!,$l:String!){ projectAddLabel(id:$id, labelId:$l){ success } }""",
            {"id": project_id, "l": child["id"]})


def project_autonomy(project_id):
    """The autonomy level label of the project, or None when it has none."""
    on = gql("""query($id:String!){ project(id:$id){ labels(first:50){ nodes{name parent{name}} } } }""",
             {"id": project_id})["project"]["labels"]["nodes"]
    return next((label["name"] for label in on if (label.get("parent") or {}).get("name", "").lower() == AUTONOMY_GROUP
                 and label["name"] in AUTONOMY_LEVELS), None)


def set_project_autonomy(plan, project_id, level):
    """Give the project the autonomy level `level`; returns the changes."""
    team_id = team_info(plan_team(plan))[0]
    changes = []
    sync_project_label(AUTONOMY_GROUP, "work-graph: the autonomy level of each effort (full, standard, supervised). "
                       "The coordinator follows it; change it on the work-graph page at any time.", "autonomy",
                       team_id, project_id, level, True, changes, team_scoped=team_labels(plan))
    return changes


def effort_autonomy(plan_dir, plan, km=None):
    """The level of the effort: the project label. An effort from before the label kept the level in the run row
    (`@effort autonomy`): copy it to the label once, then the row no longer holds it."""
    km = load_keymap(plan_dir) if km is None else km
    project_id = (km.get("project") or {}).get("id")
    if not project_id:
        raise ReadError("keymap.json has no project; run wg load --apply first")
    level = project_autonomy(project_id)
    effort = run_rows(km)["effort"]
    old = effort.get("autonomy")
    if old:
        if not level and old in AUTONOMY_LEVELS:
            set_project_autonomy(plan, project_id, old)
            level = old
        with plan_lock(plan_dir):
            km = load_keymap(plan_dir)
            run_rows(km)["effort"].pop("autonomy", None)
            save_keymap(plan_dir, km)
    return level or AUTONOMY_DEFAULT


def project_paused(project_id):
    """Does the project have the plain label `paused`?"""
    on = gql("""query($id:String!){ project(id:$id){ labels(first:50){ nodes{name parent{name}} } } }""",
             {"id": project_id})["project"]["labels"]["nodes"]
    return any(label["name"] == PAUSED_LABEL and not label.get("parent") for label in on)


def set_project_paused(plan, project_id, paused):
    """Add or remove the plain project label `paused`, made when it is missing (a team label where `team_labels` is true,
    workspace label where `team_labels` is false, as for autonomy)."""
    on = gql("""query($id:String!){ project(id:$id){ labels(first:50){ nodes{id name parent{id}} } } }""",
             {"id": project_id})["project"]["labels"]["nodes"]
    have = next((label for label in on if label["name"] == PAUSED_LABEL and not label.get("parent")), None)
    if not paused:
        if have:
            gql("""mutation($id:String!,$l:String!){ projectRemoveLabel(id:$id, labelId:$l){ success } }""",
                {"id": project_id, "l": have["id"]})
        return
    if have:
        return
    team_id = team_info(plan_team(plan))[0]
    team_scoped = team_labels(plan)
    scope = {"team": {"id": {"eq": team_id}}} if team_scoped else {"team": {"null": True}}
    labels = gql("""query($f:ProjectLabelFilter!){ projectLabels(first:250, filter:$f){
                    nodes{id name isGroup retiredAt parent{id}} } }""", {"f": scope})["projectLabels"]["nodes"]
    found = next((label for label in labels if label["name"] == PAUSED_LABEL and not label["isGroup"]
                  and not label.get("parent")), None)
    if found and found.get("retiredAt"):
        die(f"the project label {PAUSED_LABEL!r} is retired; restore it in Linear")
    label_id = (found or gql("""mutation($i:ProjectLabelCreateInput!){ projectLabelCreate(input:$i){ projectLabel{id} } }""",
                             {"i": {"name": PAUSED_LABEL, **({"teamId": team_id} if team_scoped else {}),
                                    "description": f"work-graph: the coordinator holds each action until {HUMAN} resumes the effort."}}
                             )["projectLabelCreate"]["projectLabel"])["id"]
    gql("""mutation($id:String!,$l:String!){ projectAddLabel(id:$id, labelId:$l){ success } }""",
        {"id": project_id, "l": label_id})


def effort_paused(plan_dir, plan):
    """Is the effort paused? The project label `paused` is the record. An effort paused before the label kept
    `paused=yes` in the run row: copy it to the label once. When Linear cannot be read, the last answer stands."""
    km = load_keymap(plan_dir)
    project_id = (km.get("project") or {}).get("id")
    effort = run_rows(km)["effort"]
    try:
        if not project_id:
            raise ReadError("keymap.json has no project")
        paused = project_paused(project_id)
        if effort.get("paused") == "yes" and not paused:
            set_project_paused(plan, project_id, True)
            paused = True
    except (ReadError, OSError, KeyError, TypeError):
        return effort.get("paused") == "yes" or effort.get("paused_seen") == "yes"
    with plan_lock(plan_dir):
        km = load_keymap(plan_dir)
        effort = run_rows(km)["effort"]
        changed = effort.pop("paused", None) is not None
        seen = "yes" if paused else "no"
        if effort.get("paused_seen") == "yes" and not paused:
            # The human pressed Resume: the next `wg next` tells the coordinator once (`paused_lines`).
            effort["resumed"] = "yes"
            changed = True
        if effort.get("paused_seen") != seen or changed:
            effort["paused_seen"] = seen
            save_keymap(plan_dir, km)
    return paused


def answer_lines(plan_dir):
    """`do answer` for each node issue in Needs <human> with the label `answered`: the human answered on the
    page. The text is the newest comment. This holds after a restart of the page server, which loses its queue."""
    km = load_keymap(plan_dir)
    keys = {entry.get("id"): key for key, entry in km.get("nodes", {}).items()}
    try:
        found = gql("""query($n:String!){ issues(first:50, filter:{labels:{some:{name:{eq:$n}}}}){ nodes{ id identifier
                       state{name type} labels(first:100){nodes{id name}} comments(first:20){nodes{body createdAt}} } } }""",
                    {"n": ANSWERED_LABEL})["issues"]["nodes"]
    except (ReadError, OSError, KeyError, TypeError) as e:
        return [("note", f"answer @effort -: answers not read ({one_line(e, 120)})")]
    lines = []
    for issue in sorted(found, key=lambda i: i["identifier"]):
        key = keys.get(issue["id"])
        if not key or norm(issue["state"], issue_labels(issue)) != WAIT_STATUS:
            continue
        comments = sorted((issue.get("comments") or {}).get("nodes") or [], key=lambda c: c.get("createdAt") or "")
        body = comments[-1]["body"] if comments else "(see the issue)"
        lines.append(("do", f"answer {key} {issue['identifier']}: {one_line(body)}"))
    return lines


def autonomy_command(plan_dir, plan, level):
    """`wg autonomy <plan-dir> [level]`: print the level, or set it as the project label."""
    km = load_keymap(plan_dir)
    project_id = (km.get("project") or {}).get("id")
    if not project_id:
        die("keymap.json has no project; run wg load --apply first, then wg autonomy")
    current = effort_autonomy(plan_dir, plan, km)
    if level:
        if level != current or not project_autonomy(project_id):
            set_project_autonomy(plan, project_id, level)
        print(f"autonomy {level}" + (f" (was {current})" if level != current else ""))
    else:
        level = current
        print(f"autonomy {level}")
    # The coordinator knows this level now: wg next tells it only of a later change.
    with plan_lock(plan_dir):
        km = load_keymap(plan_dir)
        run_rows(km)["effort"]["autonomy_seen"] = level
        save_keymap(plan_dir, km)
    return 0


def autonomy_lines(plan_dir, plan):
    """One line with the effort's level. A level that changed since the coordinator last saw it (the human set it
    on the page or in Linear) is a `do autonomy` line: the coordinator must change how it acts at once."""
    try:
        level = effort_autonomy(plan_dir, plan)
    except (ReadError, OSError, KeyError, TypeError) as e:
        return [("note", f"autonomy @effort -: level not read ({one_line(e, 120)}); keep the last level")]
    with plan_lock(plan_dir):
        km = load_keymap(plan_dir)
        effort = run_rows(km)["effort"]
        seen = effort.get("autonomy_seen")
        if seen != level:
            effort["autonomy_seen"] = level
            save_keymap(plan_dir, km)
    if seen and seen != level:
        return [("do", f"autonomy @effort -: {HUMAN} set the autonomy level to {level} (was {seen}); "
                       f"from now on act as SKILL.md \"Autonomy level\" says for {level}")]
    return [("note", f"autonomy @effort -: {level}")]


def project_entries(project_id, connection, fields):
    after = None
    while True:
        page = gql(f"""query($id:String!,$after:String){{ project(id:$id){{
                       {connection}(first:50,after:$after,includeArchived:true){{
                       nodes{{{fields}}} pageInfo{{hasNextPage endCursor}} }} }} }}""",
                   {"id": project_id, "after": after})["project"][connection]
        yield from page["nodes"]
        if not page["pageInfo"]["hasNextPage"]:
            return
        after = page["pageInfo"]["endCursor"]


def find_issue(identifier):
    team, number = identifier.split("-")
    page = gql("""query($team:String!,$number:Float!){
                   issues(first:1,includeArchived:true,filter:{team:{key:{eq:$team}},number:{eq:$number}}){
                   nodes{id identifier title project{id} projectMilestone{id} team{id}} } }""",
               {"team": team, "number": int(number)})["issues"]["nodes"]
    return page[0] if page else None


def find_card(issue_id, key):
    after = None
    while True:
        page = gql("""query($id:String!,$after:String){issue(id:$id){
                       comments(first:50,after:$after){ nodes{id body} pageInfo{hasNextPage endCursor} } } }""",
                   {"id": issue_id, "after": after})["issue"]["comments"]
        for comment in page["nodes"]:
            body = comment["body"]
            prefix = f"**work-graph node card** `{key}` ·"
            if body and body.startswith(prefix) and body.endswith((CARD_FOOTER, EMPTY_CARD)):
                return {"id": comment["id"], "sha": hashlib.sha256(body.encode()).hexdigest()}
        if not page["pageInfo"]["hasNextPage"]:
            return None
        after = page["pageInfo"]["endCursor"]


def adopt_project(plan_dir, plan, km, project, team_id):
    project_id = project["id"]
    km["project"] = {"id": project_id, "url": project["url"]}
    milestones = {m["name"]: m["id"] for m in project_entries(project_id, "projectMilestones", "id name")}
    km["milestones"] = {str(p["key"]): milestones[p["name"]] for p in plan["phases"]
                        if p["name"] in milestones}
    issues = list(project_entries(project_id, "issues", "id identifier description title"))
    mapped, used = {}, set()
    for n in plan["nodes"]:
        k = n["key"]
        if n.get("eng") or n.get("issue"):
            issue = find_issue(n.get("eng") or n["issue"])
        else:
            matches = [i for i in issues if f"work-graph node `{k}`" in (i.get("description") or "")]
            if len(matches) > 1:
                die(f"more than one issue has the work-graph marker for {k}")
            issue = matches[0] if matches else None
        if issue and n.get("issue") and issue["team"]["id"] != team_id:
            die(f"{n['issue']}: issue is not in team {plan_team(plan)}")
        if issue:
            mapped[k] = issue
            used.add(issue["id"])

    unmapped_titles = Counter(n["title"] for n in plan["nodes"]
                              if n["key"] not in mapped and not (n.get("eng") or n.get("issue")))
    km["nodes"] = {}
    for n in plan["nodes"]:
        k = n["key"]
        issue = mapped.get(k)
        by_title = False
        if not issue and not (n.get("eng") or n.get("issue")) and unmapped_titles[n["title"]] == 1:
            matches = [i for i in issues if i["id"] not in used and i["title"] == n["title"]]
            if len(matches) == 1:
                issue, by_title = matches[0], True
                used.add(issue["id"])
        if not issue:
            print(f"unmapped {k}")
            continue
        entry = {"id": issue["id"], "identifier": issue["identifier"]}
        card = find_card(issue["id"], k)
        if card:
            entry["card"] = card
        km["nodes"][k] = entry
        print(f"adopted {k} -> {issue['identifier']}" + (" (by title)" if by_title else ""))
    save_keymap(plan_dir, km)
    return 0


def load(plan_dir, plan, apply, prune, adopt=False):
    errs = check(plan)
    if errs:
        print("\n".join(errs))
        die("plan.json fails check; fix it first", 1)
    km = load_keymap(plan_dir)
    eff = plan["effort"]
    team_id, states, labels = team_info(plan_team(plan))
    nodes = {n["key"]: n for n in plan["nodes"]}
    changes = []
    rows = run_rows(km)["nodes"]
    orphans = (km["nodes"].keys() | rows.keys()) - nodes.keys()
    for k in sorted(orphans):
        changes.append(f"orphan {k} -> {km['nodes'].get(k, {}).get('identifier', '-')}")

    if adopt and km.get("project"):
        die("--adopt requires a keymap.json with no project")
    existing_project = km.get("project")
    if not existing_project:
        project = find_project(team_id, eff["name"])
        if adopt:
            if not project:
                die(f"project {eff['name']!r} not found in team {plan_team(plan)}")
            for change in changes:
                print(change)
            return adopt_project(plan_dir, plan, km, project, team_id)
        if project:
            die(f"project {eff['name']!r} exists: {project['url']}. "
                f"Run 'wg load {plan_dir} --adopt' to rebuild keymap.json.")
        changes.append(f"create project {eff['name']!r}")
        if apply:
            p = gql("""mutation($i:ProjectCreateInput!){ projectCreate(input:$i){ project{id url} } }""",
                    {"i": {"name": eff["name"], "teamIds": [team_id],
                           "description": eff.get("summary", f"work-graph effort {eff.get('slug', '')}")[:255]}})
            km["project"] = p["projectCreate"]["project"]
            save_keymap(plan_dir, km)
    if eff.get("initiative"):
        sync_initiative(team_id, (km.get("project") or {}).get("id"), eff["initiative"].strip(), apply, changes,
                        team_scoped=team_labels(plan))
    creates = {k: n for k, n in nodes.items() if k not in km["nodes"] and not (n.get("eng") or n.get("issue"))}
    conflicts = set()
    if creates and existing_project:
        mapped_ids = {entry["id"] for k, entry in km["nodes"].items() if k in nodes}
        titles = {}
        for issue in project_entries(km["project"]["id"], "issues", "id identifier title"):
            if issue["id"] not in mapped_ids:
                titles.setdefault(issue["title"], []).append(issue["identifier"])
        for k, n in creates.items():
            for ident in sorted(titles.get(n["title"], [])):
                conflicts.add(k)
                changes.append(f'conflict {k}: {ident} has this title; set "issue": "{ident}" in plan.json')
        if apply and conflicts:
            print("\n".join(changes))
            return 2
    for ph in plan["phases"]:
        k = str(ph["key"])
        if k not in km["milestones"]:
            changes.append(f"create milestone {ph['name']!r}")
            if apply:
                m = gql("""mutation($i:ProjectMilestoneCreateInput!){ projectMilestoneCreate(input:$i){ projectMilestone{id} } }""",
                        {"i": {"name": ph["name"], "projectId": km["project"]["id"],
                               "description": f"target {ph.get('target', 'main')} · ship to {ph.get('ship_env', '?')}"
                                              + (f" · soak {ph['soak']}" if ph.get("soak") else "")}})
                km["milestones"][k] = m["projectMilestoneCreate"]["projectMilestone"]["id"]
                save_keymap(plan_dir, km)
    for lab in sorted(({KIND_LABEL[n["kind"]] for n in nodes.values() if n["kind"] in KIND_LABEL} | {REVIEWED_LABEL})
                      - set(labels)):
        changes.append(f"create label {lab!r}")
        if apply:
            labels[lab] = gql("""mutation($i:IssueLabelCreateInput!){ issueLabelCreate(input:$i){ issueLabel{id} } }""",
                              {"i": {"name": lab, "teamId": team_id}})["issueLabelCreate"]["issueLabel"]["id"]
    me = gql("{ viewer { id } }")["viewer"]["id"] if apply else None
    live = fetch_nodes(km)
    for k, n in nodes.items():
        if k in conflicts:
            continue
        entry = km["nodes"].get(k)
        issue = live.get(entry["id"]) if entry else None
        if not entry and (external := n.get("eng") or n.get("issue")):
            changes.append(f"map {k} -> existing {external}")
            if apply or n.get("issue"):
                issue = find_issue(external) or die(f"{external}: issue not found")
                if n.get("issue") and issue["team"]["id"] != team_id:
                    die(f"{external}: issue is not in team {plan_team(plan)}")
                if apply:
                    entry = {"id": issue["id"], "identifier": issue["identifier"]}
                    km["nodes"][k] = entry
                    save_keymap(plan_dir, km)
        if issue and not n.get("eng"):
            project_id = (km.get("project") or {}).get("id")
            fields = {}
            if n.get("issue") and (not project_id or (issue["project"] or {}).get("id") != project_id):
                changes.append(f"update {k}: project")
                fields["projectId"] = project_id
            if issue["title"] != n["title"]:
                changes.append(f"update {k}: title")
                fields["title"] = n["title"]
            milestone = km["milestones"].get(str(n["phase"]))
            if not milestone or (issue["projectMilestone"] or {}).get("id") != milestone:
                changes.append(f"update {k}: milestone")
                fields["projectMilestoneId"] = milestone
            if fields and apply:
                issue_update(issue["id"], fields)
        if entry or n.get("eng") or n.get("issue"):
            continue
        changes.append(f"create {n['kind']} {k}: {n['title']}")
        if apply:
            inp = {"teamId": team_id, "title": n["title"], "description": node_body(n), "stateId": states["Todo"],
                   "projectId": km["project"]["id"], "projectMilestoneId": km["milestones"][str(n["phase"])],
                   "assigneeId": me, "priority": n.get("priority", 3)}
            if n["kind"] in KIND_LABEL:
                inp["labelIds"] = [labels[KIND_LABEL[n["kind"]]]]
            i = gql("""mutation($i:IssueCreateInput!){ issueCreate(input:$i){ issue{id identifier} } }""",
                    {"i": inp})["issueCreate"]["issue"]
            km["nodes"][k] = {"id": i["id"], "identifier": i["identifier"]}
            save_keymap(plan_dir, km)

    for k, n in nodes.items():
        if k not in conflicts and sync_card(n, km["nodes"].get(k), apply, changes, rows.get(k)):
            save_keymap(plan_dir, km)

    if not apply:
        known = {k for k in nodes if k in km["nodes"]}
        for e in plan["edges"]:
            if {e["from"], e["to"]} & conflicts:
                continue
            if e["from"] not in known or e["to"] not in known:
                changes.append(f"relation {e['to']} blocks {e['from']} (after create)")
        print("\n".join(changes) or "no changes to nodes")
        if known:
            _relations(km, plan, apply=False, prune=prune)
        return 0
    _relations(km, plan, apply=True, prune=prune)
    if prune and orphans:
        for k in orphans:
            km["nodes"].pop(k, None)
            rows.pop(k, None)
        save_keymap(plan_dir, km)
    print("\n".join(changes) or "no changes to nodes")
    _sort(km, plan, nodes)
    return 0


def _sort(km, plan, nodes):
    """Set each plan-team node's manual sort order to its run order. ENG nodes keep their order."""
    live = fetch_nodes(km)
    moved = 0
    for i, k in enumerate(topo_order(plan)):
        v = km["nodes"].get(k)
        if not v or nodes[k].get("eng"):
            continue
        want = float((i + 1) * 1000)
        if live.get(v["id"], {}).get("sortOrder") != want:
            gql("""mutation($id:String!,$o:Float!){ issueUpdate(id:$id, input:{sortOrder:$o}){ success } }""",
                {"id": v["id"], "o": want})
            moved += 1
    print(f"sort order: {moved} issue(s) updated")


def issue_relations(issue_id, page):
    while True:
        yield from page["nodes"]
        info = page.get("pageInfo", {})
        if not info.get("hasNextPage"):
            return
        page = gql("""query($id:String!,$after:String){issue(id:$id){
                       relations(first:50,after:$after,includeArchived:true){nodes{id type relatedIssue{id}}
                       pageInfo{hasNextPage endCursor}} } }""",
                   {"id": issue_id, "after": info["endCursor"]})["issue"]["relations"]


def _relations(km, plan, apply, prune):
    live = fetch_nodes(km)
    uid = {k: v["id"] for k, v in km["nodes"].items()}
    graph_ids = set(uid.values())
    want = {(uid[e["to"]], uid[e["from"]]) for e in plan["edges"] if e["to"] in uid and e["from"] in uid}
    have = {}
    for i, n in live.items():
        for r in issue_relations(i, n["relations"]):
            if r["type"] == "blocks" and r["relatedIssue"]["id"] in graph_ids:
                have[(i, r["relatedIssue"]["id"])] = r["id"]
    ident = {v["id"]: v["identifier"] for v in km["nodes"].values()}
    missing, extra = want - set(have), set(have) - want
    for a, b in sorted(missing):
        print(f"relation {ident[a]} blocks {ident[b]}: {'created' if apply else 'missing'}")
        if apply:
            gql("""mutation($i:IssueRelationCreateInput!){ issueRelationCreate(input:$i){ success } }""",
                {"i": {"issueId": a, "relatedIssueId": b, "type": "blocks"}})
    for a, b in sorted(extra):
        print(f"relation {ident[a]} blocks {ident[b]}: not in plan.json" + (" (deleted)" if apply and prune else ""))
        if apply and prune:
            result = gql("""mutation($id:String!){ issueRelationDelete(id:$id){ success } }""", {"id": have[(a, b)]})
            if not result["issueRelationDelete"]["success"]:
                die(f"could not delete relation {ident[a]} blocks {ident[b]}")


# ---------------------------------------------------------------- ready / status

def satisfied(a, b, state, row=None):
    """Is edge `a depends on b` satisfied, given b's Linear status name and b's run row?

    A lane node stacks on the node below as soon as that node is code done (wg done passed: In Review with a
    code-done head). Its review runs at the same time.
    """
    if state == "Canceled":
        return True
    if a["kind"] == "task" and b["kind"] == "task" and a.get("lane") == b.get("lane") and str(a["phase"]) == str(b["phase"]):
        return state in MERGED or (state in REVIEWING and bool((row or {}).get("code_done_head")))
    if b["kind"] == "task" and (a["kind"] == "merge-point" or (a["kind"] == "ship-point" and post_merge(b))):
        return state in MERGED
    return state == "Done"


# The contract is the same on each machine: it uses the default human, and `human` gives the rule for another name.
CONTRACT_HUMAN = DEFAULT_CONFIG["human"]
CONTRACT_STATUSES = ("Todo", "Ready", "In Progress", f"Needs {CONTRACT_HUMAN}", "In Review", "Ready to Merge",
                      "Merged", "Verifying", "Done", "Canceled")
# The edge types of a graph: (name, the blocker, the node that waits on it). A phase is a key of plan.json.
CONTRACT_EDGES = (
    ("a task of the same lane", {"kind": "task", "lane": "x", "phase": "1"}, {"kind": "task", "lane": "x", "phase": "1"}),
    ("a task of another lane", {"kind": "task", "lane": "x", "phase": "1"}, {"kind": "task", "lane": "y", "phase": "1"}),
    ("a task of the same lane name in another phase", {"kind": "task", "lane": "x", "phase": "1"},
     {"kind": "task", "lane": "x", "phase": "2"}),
    ("a task before its merge point", {"kind": "task", "lane": "x", "phase": "1"}, {"kind": "merge-point", "phase": "1"}),
    ("a post-merge task before its ship point", {"kind": "task", "lane": "sync", "role": "sync", "phase": "1"},
     {"kind": "ship-point", "phase": "1"}),
    ("a pre-merge task before a ship point", {"kind": "task", "lane": "x", "phase": "1"}, {"kind": "ship-point", "phase": "1"}),
    ("a merge point before an ops node", {"kind": "merge-point", "phase": "1"}, {"kind": "ops", "phase": "1"}),
    ("an ops node before a ship point", {"kind": "ops", "phase": "1"}, {"kind": "ship-point", "phase": "1"}),
    ("a ship point before the next phase", {"kind": "ship-point", "phase": "1"}, {"kind": "task", "lane": "x", "phase": "2"}),
    ("a decision before a task", {"kind": "decision", "phase": "1"}, {"kind": "task", "lane": "x", "phase": "1"}),
)
CONTRACT_SAMPLE_ROW = {"branch": "wg/xy-write-00-a", "pr": "7", "review": "clean", "merge_review": "requested",
                       "state": "running", "job": "review", "started_at": "2025-12-31T23:00:00Z",
                       "soak_until": "2026-01-01T00:00:00Z", "code_done_head": "abc"}
CONTRACT_SAMPLE_ENTRY = {"published": {"wave": "yes", "next": "do ask-merge: #7\nwait human: 2 review rounds; accept or ask for a fix"}}


def contract():
    """What the page (the root of this repository) must agree with: names, the node card, and the rule of `satisfied`.

    `contract.json` in the skill holds this value, and the page tests read it. A test of wg.py and a test of the
    page fail when their code and the file disagree.
    """
    cards = []
    for kind in sorted(KINDS):
        n = {"key": "a", "kind": kind, "phase": "1", "title": "A", "acceptance": "Pass."}
        if kind == "task":
            n.update(lane="write", role="sync", owns=["src/a/**"], shares=["pnpm-lock.yaml"])
        row = card_row(CONTRACT_SAMPLE_ENTRY, CONTRACT_SAMPLE_ROW) if kind in ("task", "ship-point") else None
        cards.append({"data": card_data(n, row), "body": node_card(n, row)})
    edges = []
    for name, blocker, node in CONTRACT_EDGES:
        # A task in review is code done: wg moves a task to In Review only when wg done passed.
        clear = [s for s in CONTRACT_STATUSES if satisfied(node, blocker, s, {"code_done_head": "abc"})]
        clear_without_code_done = [s for s in CONTRACT_STATUSES if satisfied(node, blocker, s, {})]
        edges.append({"name": name, "blocker": blocker, "node": node, "clear": clear,
                      "clear_without_code_done": clear_without_code_done})
    return {
        "version": 3,
        "kinds": sorted(KINDS),
        "kind_labels": sorted(KIND_LABEL.values()),
        "status_aliases": ALIAS,
        "human": {"default": CONTRACT_HUMAN, "status": "Needs {name}", "label": "needs-{slug}", "wait": "wait human",
                  "slug": "lowercase; each run of other characters than a-z and 0-9 is one -; no - at the ends"},
        "labels": {"needs_human": f"needs-{human_slug(CONTRACT_HUMAN)}", "ready_to_merge": MERGE_LABEL, "reviewed": REVIEWED_LABEL,
                   "claim_prefix": "agent:", "answered": ANSWERED_LABEL},
        "project_labels": {"initiative_group": INITIATIVE_GROUP, "autonomy_group": AUTONOMY_GROUP,
                           "autonomy_levels": list(AUTONOMY_LEVELS), "autonomy_default": AUTONOMY_DEFAULT,
                           "paused": PAUSED_LABEL},
        "card": {"prefix": "**work-graph node card**", "footers": [CARD_FOOTER, EMPTY_CARD],
                 "fields": [*CARD_PLAN_FIELDS, *CARD_RUN_FIELDS], "samples": cards},
        "status_doc": {"title": STATUS_DOC, "fields": ["status", "wave", "lines", "at", "ran", "wait_interval", "contract"]},
        "statuses": list(CONTRACT_STATUSES),
        "satisfied": edges,
        "link": {"version": LINK_VERSION, "path": "/api/link", "to_coordinator": list(LINK_TO_COORDINATOR),
                 "from_coordinator": list(LINK_FROM_COORDINATOR), "commands": list(LINK_COMMANDS)},
    }


def contract_text():
    return json.dumps(contract(), indent=2) + "\n"


def snapshot(plan_dir, plan, km=None):
    """The keymap, the plan's nodes and edges, the run rows, and each mapped node's live status."""
    km = load_keymap(plan_dir) if km is None else km
    if not km["nodes"]:
        raise ReadError("keymap.json has no nodes; run wg.py load --apply first")
    live = fetch_nodes(km)
    nodes = {n["key"]: n for n in plan["nodes"]}
    st = {k: norm(live[v["id"]]["state"], issue_labels(live[v["id"]])) for k, v in km["nodes"].items() if v["id"] in live}
    deps = {k: [] for k in nodes}
    for e in plan["edges"]:
        deps[e["from"]].append(e["to"])
    return km, live, nodes, st, deps, run_rows(km)["nodes"]


def open_blockers(k, nodes, deps, st, rows):
    return [d for d in deps[k] if not satisfied(nodes[k], nodes[d], st.get(d, "?"), rows.get(d))]


def milestone_blockers(key, nodes, deps, st, rows):
    """The open nodes before a merge point or ship point: its blockers and each task of the phase before it.

    A merge point can reach a task only through another task, so a direct edge is not enough.
    """
    node = nodes[key]
    before = [k for k, n in nodes.items() if n["kind"] == "task" and str(n["phase"]) == str(node["phase"])
              and (node["kind"] == "ship-point" or not post_merge(n))]
    return list(dict.fromkeys(open_blockers(key, nodes, deps, st, rows) + [k for k in before if st.get(k) not in SETTLED]))


def review_count(info):
    """The reviews and comments of a PR that are not a request for the thorough review."""
    items = (info.get("reviews") or []) + (info.get("comments") or [])
    return sum("@claude-thorough" not in (item.get("body") or "") for item in items)


def marked_reviewed(issue):
    """The human put the `reviewed` label on the issue: its PR counts as reviewed, wave review and merge review."""
    return bool(issue) and any(label["name"] == REVIEWED_LABEL for label in issue_labels(issue))


def merge_reviewed(row, head, issue=None):
    """The PR has its merge review. A row of the flow before `merge_review` holds the reviewed head in `verified_head`."""
    return (row.get("merge_review") in REVIEW_OK or (bool(head) and row.get("verified_head") == head)
            or marked_reviewed(issue))


def lane_below(k, nodes, deps):
    """The task below k in its lane, or None. wg check allows one at most."""
    n = nodes[k]
    for d in deps[k]:
        b = nodes[d]
        if b["kind"] == "task" and b.get("lane") == n.get("lane") and str(b["phase"]) == str(n["phase"]):
            return d
    return None


def ready(plan_dir, plan, apply, quiet=False):
    km, _, nodes, st, deps, rows = snapshot(plan_dir, plan)
    states = team_info(plan_team(plan))[1] if apply else {}
    for k in topo_order(plan):
        n = nodes[k]
        s = st.get(k)
        if n["kind"] == "task" and s is not None and s not in CD_STATUSES and not quiet:
            print(f"skipped {k}: status {s}", file=sys.stderr)
        if s not in ("Todo", "Ready"):
            continue
        ok = not open_blockers(k, nodes, deps, st, rows)
        if ok and not quiet:
            print(f"{k}\t{km['nodes'][k]['identifier']}\t{n['kind']}\t{n.get('lane', '-')}")
        want = "Ready" if ok else "Todo"
        if apply and s != want and not n.get("eng"):
            gql("""mutation($id:String!,$s:String!){ issueUpdate(id:$id, input:{stateId:$s}){ success } }""",
                {"id": km["nodes"][k]["id"], "s": states[want]})
            print(f"  moved {km['nodes'][k]['identifier']} {s} -> {want}", file=sys.stderr)
    return 0


def sync_ready(plan_dir, plan):
    """Keep Todo and Ready in step with the blockers after a write that can satisfy an edge."""
    if not load_keymap(plan_dir)["nodes"]:
        return
    try:
        ready(plan_dir, plan, True, quiet=True)
    except ReadError as e:
        print(f"Todo and Ready not synced ({e}); run 'wg ready --apply'", file=sys.stderr)


def status(plan_dir, plan, phase):
    km = load_keymap(plan_dir)
    live = fetch_nodes(km)
    by_key = {n["key"]: n for n in plan["nodes"]}
    for n in (by_key[k] for k in topo_order(plan)):
        if phase and str(n["phase"]) != phase:
            continue
        k = n["key"]
        v = km["nodes"].get(k)
        i = live.get(v["id"], {}) if v else {}
        name = norm(i["state"], issue_labels(i)) if i else ("?" if v else "not loaded")
        claim = [l["name"] for l in issue_labels(i) if l["name"].startswith("agent:")]
        row = run_rows(km)["nodes"].get(k, {})
        extra = [row.get(f) or "-" for f in ("state", "pr", "code_done_head", "review", "dispatch")]
        extra[2] = extra[2][:10]
        print("\t".join([k, v["identifier"] if v else "-", name, ",".join(claim) or "-",
                         n["kind"], f"phase {n['phase']}", n.get("lane") or "-", *extra]))
    return 0


def workspace_labels(names):
    result, after = {}, None
    while True:
        page = gql("""query($names:[String!],$after:String){
                       issueLabels(first:100,after:$after,filter:{name:{in:$names}}){
                       nodes{id name team{id}} pageInfo{hasNextPage endCursor} } }""",
                   {"names": sorted(names), "after": after})["issueLabels"]
        result.update((label["name"], label["id"]) for label in page["nodes"] if not label["team"])
        if not page["pageInfo"]["hasNextPage"]:
            return result
        after = page["pageInfo"]["endCursor"]


def comment(issue_id, body):
    gql("""mutation($i:CommentCreateInput!){ commentCreate(input:$i){ comment{id} } }""",
        {"i": {"issueId": issue_id, "body": body}})


def marker_label_id(name):
    """The id of a workspace marker label for ENG tickets; wg creates the label on first use."""
    label_id = workspace_labels({name}).get(name)
    if not label_id:
        label_id = gql("""mutation($i:IssueLabelCreateInput!){ issueLabelCreate(input:$i){ issueLabel{id} } }""",
                       {"i": {"name": name}})["issueLabelCreate"]["issueLabel"]["id"]
    return label_id


def soak_end(key, until):
    try:
        end = datetime.fromisoformat(until.replace("Z", "+00:00"))
        if end.utcoffset() is None or end.utcoffset().total_seconds() != 0:
            raise ValueError("expected UTC offset")
    except ValueError as e:
        die(f"{key}: invalid soak_until {until!r}: {e}")
    return end


def phase_of(plan, node):
    return next(p for p in plan["phases"] if str(p["key"]) == str(node["phase"]))


def merge_proof(plan_dir, plan, node, nodes, st, rows):
    """Why a merged pre-merge PR of this phase is not in the target on origin (an empty list: all are)."""
    target = phase_of(plan, node)["target"]
    fetch = command("git", "fetch", "--no-tags", "--no-recurse-submodules", "--refmap=", "origin",
                    f"refs/heads/{target}", cwd=plan_dir)
    if fetch.returncode:
        return [f"{node['key']}: cannot fetch origin/{target}: {command_error(fetch).splitlines()[-1]}"]
    tip = command("git", "rev-parse", "--verify", "FETCH_HEAD", cwd=plan_dir).stdout.strip()
    problems = []
    for k, n in nodes.items():
        if n["kind"] != "task" or str(n["phase"]) != str(node["phase"]) or post_merge(n) or st.get(k) not in MERGED:
            continue
        pr = rows.get(k, {}).get("pr")
        if not pr:
            problems.append(f"{k}: no pr in the run row")
            continue
        info = pr_view(pr, "state,mergeCommit", cwd=plan_dir)
        oid = (info.get("mergeCommit") or {}).get("oid")
        if info["state"] != "MERGED" or not oid:
            problems.append(f"{k}: PR #{pr} is {info['state']}, not MERGED")
        elif command("git", "merge-base", "--is-ancestor", oid, tip, cwd=plan_dir).returncode:
            problems.append(f"{k}: merge commit {oid[:10]} of PR #{pr} is not in origin/{target}")
    return problems


def move_guard(plan_dir, plan, km, node, status_name, note, issue=None):
    """Why this move would write a false status (an empty list allows it), and the facts to put in a comment."""
    key, kind = node["key"], node["kind"]
    row = run_row(km, key)
    problems, notes = [], []
    if kind in ("ops", "decision") and status_name == "Done" and not (note or "").strip():
        problems.append(f"{key}: a Done {kind} needs --note with {HUMAN}'s "
                        + ("evidence" if kind == "ops" else "answer"))
    if kind == "task" and status_name in ("Ready to Merge", "Merged", "Done"):
        pr = row.get("pr")
        if not pr:
            problems.append(f"{key}: no pr in the run row")
        else:
            info = pr_view(pr, "state,isDraft,headRefOid,mergeCommit,baseRefName,mergeable", cwd=plan_dir)
            if status_name != "Ready to Merge":
                if info["state"] != "MERGED":
                    problems.append(f"{key}: PR #{pr} is {info['state']}, not MERGED")
                else:
                    notes.append(f"PR #{pr} merged to `{info['baseRefName']}` as `{info['mergeCommit']['oid']}`.")
            else:
                if info["state"] != "OPEN" or info.get("isDraft"):
                    problems.append(f"{key}: PR #{pr} is " + ("a draft" if info["state"] == "OPEN" else info["state"]))
                if not row.get("code_done_head") or info.get("headRefOid") != row["code_done_head"]:
                    problems.append(f"{key}: the PR head is not code done (wg done)")
                if not merge_reviewed(row, info.get("headRefOid"), issue):
                    problems.append(f"{key}: no merge review of this patch: review-and-merge.md \"Merge point\" step 2, "
                                    "then wg run set … merge_review=clean")
                base = bottom_base(node, phase_of(plan, node)["target"])
                if info.get("baseRefName") != base:
                    problems.append(f"{key}: the base of PR #{pr} is {info.get('baseRefName')}, not {base}")
                if info.get("mergeable") == "CONFLICTING":
                    problems.append(f"{key}: PR #{pr} conflicts with {base}")
                checks_ok, detail = pr_checks(pr, plan_dir)
                if not checks_ok:
                    problems.append(f"{key}: a check of PR #{pr} failed: {detail}")
                _, _, nodes, st, deps, rows = snapshot(plan_dir, plan)
                below = lane_below(key, nodes, deps)
                lower_pr = rows.get(below, {}).get("pr") if below else None
                if below and st.get(below) not in SETTLED:
                    problems.append(f"{key}: {below} is below it in the lane and is not merged")
                elif lower_pr and st.get(below) in MERGED and pr_view(lower_pr, "state", cwd=plan_dir)["state"] != "MERGED":
                    problems.append(f"{key}: {below} is below it and its PR #{lower_pr} is not merged")
    if kind in ("merge-point", "ship-point") and status_name in ("Verifying", "Done"):
        _, _, nodes, st, deps, rows = snapshot(plan_dir, plan)
        problems += [f"{key}: blocker {d} is {st.get(d, 'not loaded')}"
                     for d in milestone_blockers(key, nodes, deps, st, rows)]
        if kind == "merge-point" and status_name == "Done" and not problems:
            problems += merge_proof(plan_dir, plan, node, nodes, st, rows)
            if not problems:
                notes.append(f"All pre-merge PRs are merged to `{phase_of(plan, node)['target']}`.")
        if kind == "ship-point" and status_name == "Done":
            for k, n in nodes.items():  # a Merged or Done status that GitHub does not confirm must not ship
                number = rows.get(k, {}).get("pr")
                if n["kind"] != "task" or str(n["phase"]) != str(node["phase"]) or st.get(k) not in MERGED:
                    continue
                if not number:
                    if st.get(k) == "Merged":
                        problems.append(f"{k}: no pr in the run row")
                elif (state := pr_view(number, "state", cwd=plan_dir)["state"]) != "MERGED":
                    problems.append(f"{k}: PR #{number} is {state}, not MERGED")
            soak, until = phase_of(plan, node).get("soak"), row.get("soak_until")
            if until and soak_end(key, until) > utc_now():
                problems.append(f"{key}: the soak ends at {until}")
            elif soak and not until:
                problems.append(f"{key}: the phase has a {soak} soak and the run row has no soak_until")
        if kind == "ship-point" and not problems:  # one repo-wide test run on the merged target
            merges = [(pr_view(number, "mergeCommit", cwd=plan_dir).get("mergeCommit") or {}).get("oid")
                      for _, number in phase_tasks(nodes, st, rows, node)]
            problem = full_suite_problem(plan_dir, plan, node, row, merges) if any(merges) else None
            if problem:
                problems.append(f"{key}: {problem}")
    return problems, notes


def move(plan_dir, plan, key, status_name, note=None, force=None, keep_worktree=False):
    if status_name not in CD_STATUSES:
        die(f"unknown status {status_name}")
    if force is not None and not force.strip():
        die("--force needs the reason")
    node = get_node(plan, key)
    eng = bool(node.get("eng"))
    if eng and status_name not in ENG_WRITES and status_name != WAIT_STATUS:
        die(f"no ENG status for {status_name}: ask {HUMAN}")
    km = load_keymap(plan_dir)
    entry = km["nodes"].get(key) or die(f"{key}: not loaded")
    ident = entry["identifier"]
    issue = fetch_nodes({"nodes": {key: entry}}).get(entry["id"]) or die(f"{ident}: issue not found")
    notes = []
    if force is None:
        problems, notes = move_guard(plan_dir, plan, km, node, status_name, note, issue)
        if problems:
            print("\n".join(f"FAIL {problem}" for problem in problems))
            die(f"{ident}: not moved to {status_name}", 1)
    old = issue["state"]["name"]
    markers = {label["name"]: label["id"] for label in issue_labels(issue) if label["name"] in ENG_LABELS.values()}
    marker = ENG_LABELS.get(status_name) if eng else None
    fields = {}
    want = ENG_WRITES.get(status_name) if eng else status_name
    if want and want != old:
        states = gql("""query($id:String!){ team(id:$id){ states(first:50){nodes{id name}} } }""",
                     {"id": issue["team"]["id"]})["team"]["states"]["nodes"]
        state_id = next((s["id"] for s in states if s["name"] == want), None)
        fields["stateId"] = state_id or die(f"{ident}: workflow has no status {want}")
    if marker and marker not in markers:
        fields["addedLabelIds"] = [marker_label_id(marker)]
    stale = [label_id for name, label_id in markers.items() if name != marker]
    # A move by the coordinator settles the human's answer from the page.
    stale += [label["id"] for label in issue_labels(issue) if label["name"] == ANSWERED_LABEL]
    if stale:
        fields["removedLabelIds"] = stale
    if issue.get("archivedAt") and status_name not in ("Done", "Canceled"):
        gql("mutation($id:String!){ issueUnarchive(id:$id){ success } }", {"id": entry["id"]})
    if fields:
        issue_update(entry["id"], fields)
    before = next((status for status, name in ENG_LABELS.items() if name in markers), old)
    print(f"{ident}: {before} -> {' + '.join(filter(None, [want, marker])) or status_name}")
    if status_name == WAIT_STATUS:
        print(f"page {page_link(plan, ident)}")  # the link to give the human with the question
    if note and note.strip():
        notes.insert(0, {"ops": "Evidence", "decision": "Answer"}.get(node["kind"], "Note") + f": {note.strip()}")
    if force is not None:
        notes.append(f"Moved to {status_name} with `--force`, without the `wg` check: {force.strip()}")
    if notes:
        comment(entry["id"], "\n\n".join(notes))
    if node["kind"] == "ship-point" and status_name == "Done":
        finish_tasks(plan_dir, plan, node)
    if status_name in SETTLED or status_name == "In Review":
        sync_ready(plan_dir, plan)  # code done lets the node above in the lane start
    if status_name in MERGED and not keep_worktree:
        cleanup_worktrees(plan_dir, plan, [key], settled={key: status_name})
    if status_name in ("Done", "Canceled"):
        archive_free()
    return 0


def finish_tasks(plan_dir, plan, ship):
    """The phase shipped: each of its Merged tasks is Done. A task that fails its check stays, with the reason."""
    _, _, nodes, st, _, _ = snapshot(plan_dir, plan)
    for key, node in nodes.items():
        if node["kind"] == "task" and str(node["phase"]) == str(ship["phase"]) and st.get(key) == "Merged":
            try:
                move(plan_dir, plan, key, "Done")
            except SystemExit:
                print(f"{key}: stays Merged; move it with wg move after you fix the cause", file=sys.stderr)


def get_node(plan, key):
    return next((n for n in plan["nodes"] if n["key"] == key), None) or die(f"unknown key {key}")


def run_rows(km):
    run = km.setdefault("run", {})
    run.setdefault("effort", {})
    run.setdefault("nodes", {})
    return run


def run_row(km, key):
    run = run_rows(km)
    return run["effort"] if key == "@effort" else run["nodes"].get(key, {})


def pairs(row):
    return [f"{f}={v}" for f, v in row.items()]


def run_set(plan_dir, plan, key, assignments):
    if key != "@effort":
        get_node(plan, key)
    km = load_keymap(plan_dir)
    run = run_rows(km)
    row = run["effort"] if key == "@effort" else run["nodes"].setdefault(key, {})
    fields = parse_fields(assignments)
    if fields.get("approved"):
        die(f"an approval is recorded with wg approve, with {HUMAN}'s own words", 1)
    if fields.get("soak_until"):
        soak_end(key, fields["soak_until"])
    for field, value in fields.items():
        if value:
            row[field] = value
        else:
            row.pop(field, None)
    # A review result counts only for the patch that the reviewer read.
    for field, started, extra in (("review", "review_dispatch", ()), ("merge_review", "", ("merge_review_seen",))):
        patch_field = f"{field}_patch"
        if fields.get(started) or fields.get(field) == "requested":
            row[patch_field] = row.get("patch", "")
        if field == "merge_review" and fields.get(field) == "requested":
            # The thorough review is costly: one per PR, a second only when a fix needs it.
            count = int(row.get("thorough_count") or 0)
            if count >= MAX_THOROUGH:
                die(f"{key}: {count} thorough reviews ran; check the fix yourself, or {HUMAN} accepts "
                    "it with the label 'reviewed' (review-and-merge.md \"Merge point\" step 2)", 1)
            row["thorough_count"] = str(count + 1)
            row["thorough_head"] = row.get("code_done_head", "")
        if fields.get(field) == "requested" and row.get("pr"):
            try:
                seen = review_count(pr_view(row["pr"], "reviews,comments", cwd=plan_dir))
            except (ReadError, OSError, ValueError) as e:
                seen = 0  # each review that exists then counts as new
                print(f"PR #{row['pr']} not read ({e}): merge_review_seen=0", file=sys.stderr)
            row["merge_review_seen"] = str(seen)
        if fields.get(field) in REVIEW_OK:
            if row.get(patch_field) and row.get("patch") and row[patch_field] != row["patch"]:
                die(f"{key}: the patch changed after the review started; start the review again", 1)
            # The stored patch is the one of the last wg done. A push after it is not reviewed.
            if row.get("pr"):
                head = pr_view(row["pr"], "headRefOid", cwd=plan_dir).get("headRefOid")
                if head != row.get("code_done_head"):
                    die(f"{key}: the PR head {str(head)[:10]} is not code done; run wg done, "
                        "then record a review of that head", 1)
            for stale in (patch_field, started, *extra):
                row.pop(stale, None)
    save_keymap(plan_dir, km)
    print(" ".join(pairs(row)))
    if key != "@effort":
        refresh_card(plan_dir, plan, key)
    return 0


def run_reset(plan_dir, plan, key):
    """Forget the node's branch, jobs, approval, and reviews: its work starts again from nothing."""
    get_node(plan, key)
    km = load_keymap(plan_dir)
    row = run_rows(km)["nodes"].get(key, {})
    if row.get("state") in LIVE:
        die(f"{key}: a job is live (state={row['state']}): end it with wg done first", 1)
    run_rows(km)["nodes"].pop(key, None)
    save_keymap(plan_dir, km)
    refresh_card(plan_dir, plan, key)
    print(f"{key}: run row removed")
    return 0


def run_show(plan_dir, plan, key, as_json):
    if key and key != "@effort":
        get_node(plan, key)
    km = load_keymap(plan_dir)
    run = run_rows(km)
    if as_json:
        print(json.dumps(run_row(km, key) if key else run, indent=2))
    elif key:
        for pair in pairs(run_row(km, key)):
            print(pair)
    else:
        for pair in pairs(run["effort"]):
            print(pair)
        for k in topo_order(plan):
            if k in run["nodes"]:
                print(k + "\t" + " ".join(pairs(run["nodes"][k])))
    return 0


COMMAND_TIMEOUT = contextvars.ContextVar("command_timeout", default=None)


def command(*args, cwd=None):
    return subprocess.run(args, capture_output=True, text=True, cwd=cwd, timeout=COMMAND_TIMEOUT.get())


def command_error(result):
    return result.stderr.strip() or f"command exited {result.returncode}"


def phase_list(plan, phase):
    phases = [p for p in plan["phases"] if phase is None or str(p["key"]) == phase]
    if phase is not None and not phases:
        die(f"unknown phase {phase}")
    return phases


def stax_trunk(plan_dir):
    result = command("git", "cat-file", "-p", "refs/stax/trunk", cwd=plan_dir)
    return result.stdout.strip() if not result.returncode else None


def branch_metadata(plan_dir, branch):
    result = command("git", "cat-file", "-p", f"refs/branch-metadata/{branch}", cwd=plan_dir)
    if result.returncode:
        return None
    try:
        data = json.loads(result.stdout)
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def imported_frozen(metadata):
    return bool(metadata and metadata.get("sourceRemote") and metadata.get("frozen") is True)


def frozen_base_pr_problem(plan_dir, branch, parent):
    """Why a frozen base's open PR does not match the branch, or None.

    Three things name a base: where the branch was cut (git), its stax parent, and its PR
    base on GitHub. When they differ, GitHub shows every foreign commit (2026-11-20: #7701 cut
    from main, PR into the release branch, 518 commits) while each local check passes."""
    result = command("gh", "pr", "list", "--head", branch, "--state", "open",
                     "--json", "number,baseRefName,commits", cwd=plan_dir)
    if result.returncode:
        return f"cannot read the PR of {branch}: {command_error(result)}"
    prs = json.loads(result.stdout or "[]")
    if not prs:
        return None
    pr = prs[0]
    number, base, commits = pr["number"], pr["baseRefName"], len(pr.get("commits") or [])
    if parent and base != parent:
        return (f"PR #{number} of {branch} targets {base}, but its stax parent is {parent}: "
                f"ask {HUMAN} which base is right, then make the branch, its stax parent and the PR base agree")
    try:
        own = int(git_output("rev-list", "--count", f"origin/{base}..origin/{branch}", cwd=plan_dir))
    except (ReadError, OSError, ValueError) as e:
        return f"cannot count the commits of {branch} over origin/{base}: {e}"
    if commits != own:
        return (f"PR #{number} of {branch} carries {commits} commits on GitHub, but the branch has {own} over "
                f"origin/{base}: rebase only its own commits onto origin/{base}")
    stack = command("gh", "api", f"repos/{{owner}}/{{repo}}/pulls/{number}", "--jq", ".stack.number // empty", cwd=plan_dir)
    if stack.returncode == 0 and stack.stdout.strip():
        return f"PR #{number} of {branch} is in native GitHub stack #{stack.stdout.strip()}: st stack unlink it"
    return None


def preflight(plan_dir, plan, phase):
    phases = phase_list(plan, phase)
    failed = False

    def line(level, name, detail):
        nonlocal failed
        print(f"{level} {name}: {detail}")
        failed |= level == "FAIL"

    errors = check(plan)
    line("FAIL" if errors else "ok", "plan", "; ".join(errors) if errors else "valid")
    errors = []
    for args in (("git", "rev-parse", "--git-dir"), ("gh", "auth", "status"), ("st", "--version")):
        try:
            result = command(*args, cwd=plan_dir if args[0] == "git" else None)
            if result.returncode:
                errors.append(f"{args[0]}: {command_error(result)}")
        except OSError as e:
            errors.append(f"{args[0]}: {e.strerror}")
    line("FAIL" if errors else "ok", "tools", "; ".join(errors).replace("\n", " ") or "git, gh, st")
    team = plan_team(plan)
    try:
        gql("{ viewer { id } }")
        _, states, labels = team_info(team)
        agents = {"agent:codex", "agent:claude", "agent:coordinator"}
        found = set(labels)
        if agents - found:
            found.update(workspace_labels(agents - found))
        missing = sorted((CD_WRITES - states.keys()) | (agents - found))
        line("FAIL" if missing else "ok", "linear",
             f"{team} missing " + ", ".join(missing) if missing else f"{team} workflow and agent labels")
    except ReadError as e:
        line("FAIL", "linear", str(e).replace("\n", " "))
    stax_phases = [p for p in phases if p.get("target") != RELEASE_BRANCH]
    trunk = None
    if stax_phases:
        try:
            trunk = stax_trunk(plan_dir)
        except OSError:
            pass  # the tools check already reports missing git
    for p in phases:
        k, target = p["key"], p.get("target")
        phase_target = f"phase {k} targets {target}"
        if target == RELEASE_BRANCH:
            line("ok", "trunk", f"{phase_target}: no stax")
        elif not trunk:
            line("FAIL", "trunk", f"{phase_target}, but the stax trunk is not set")
        elif target == trunk:
            line("ok", "trunk", f"{phase_target}: stax trunk")
        else:
            integration = isinstance(target, str) and target.startswith("effort/")
            branch = "main" if integration else target
            metadata = branch_metadata(plan_dir, branch) if branch and branch != trunk else None
            safe = branch == trunk or imported_frozen(metadata)
            if safe:
                if integration:
                    own = branch_metadata(plan_dir, target)
                    if own is not None and own.get("frozen") is not True:
                        line("FAIL", "trunk", f"{phase_target}: the integration branch is tracked "
                             f"but not frozen (st freeze {target})")
                    else:
                        line("ok", "trunk", f"{phase_target}: integration branch on main")
                else:
                    parent = metadata.get("parentBranchName")
                    suffix = f" under {parent}" if parent else ""
                    line("ok", "trunk", f"{phase_target}: frozen base{suffix}")
                    problem = frozen_base_pr_problem(plan_dir, branch, parent)
                    line("FAIL" if problem else "ok", "base",
                         f"{phase_target}: {problem}" if problem else f"{branch} sits on its PR base")
                continue
            line("FAIL", "trunk", f"{phase_target}, but the stax trunk is {trunk} "
                 f"and {branch} is not an imported, frozen stax branch")
            print(f"  ask {HUMAN} to run, in the checkout that holds {branch}: "
                  f"st get {branch} --parent {trunk} --no-checkout --downstack --no-restack && st freeze {branch}")
    return int(failed)


def base_git_error(result):
    lines = command_error(result).splitlines()
    last = lines[-1]
    first = next((line for line in lines if line.startswith(("error:", "fatal:"))), last)
    return f"{first}; {last}" if first != last else last


@contextlib.contextmanager
def base_lock(plan_dir):
    """One base refresh at a time in a repository. Workers run `wg base` before each submit, often at once."""
    result = command("git", "rev-parse", "--path-format=absolute", "--git-common-dir", cwd=plan_dir)
    if result.returncode:
        raise ReadError(base_git_error(result))
    fd = os.open(Path(result.stdout.strip()) / "wg-base.lock", os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)


def refresh_base(plan_dir, target):
    with base_lock(plan_dir):
        return _refresh_base(plan_dir, target)


def _refresh_base(plan_dir, target):
    def git(*args):
        result = command("git", *args, cwd=plan_dir)
        if result.returncode:
            raise ReadError(base_git_error(result))
        return result.stdout

    ref = f"refs/heads/{target}"
    old = git("rev-parse", "--verify", ref).strip()
    worktree = checkout = None
    for entry in git("worktree", "list", "--porcelain", "-z").split("\0"):
        if entry.startswith("worktree "):
            worktree = entry.removeprefix("worktree ")
        elif entry == f"branch {ref}":
            checkout = worktree
            break
    # Check ancestry before a fetch can change the remote-tracking ref.
    git("fetch", "--no-tags", "--no-recurse-submodules", "--refmap=", "origin", ref)
    # FETCH_HEAD belongs to the plan worktree, so pass its commit to the checkout.
    fetched = git("rev-parse", "--verify", "FETCH_HEAD").strip()
    result = command("git", "merge-base", "--is-ancestor", old, fetched, cwd=plan_dir)
    if result.returncode == 1:
        raise ReadError("Not possible to fast-forward, aborting.")
    if result.returncode:
        raise ReadError(base_git_error(result))

    if checkout:
        git("-C", checkout, "merge", "--ff-only", "--no-autostash", fetched)
        git("update-ref", f"refs/remotes/origin/{target}", fetched)
    else:
        git("fetch", "--no-tags", "--no-recurse-submodules", "origin", f"{ref}:{ref}")
    new = git("rev-parse", "--verify", ref).strip()
    return f"up to date {new[:10]}" if old == new else f"{old[:10]} -> {new[:10]}"


def base(plan_dir, plan, phase):
    targets = dict.fromkeys(p["target"] for p in phase_list(plan, phase))
    trunk = stax_trunk(plan_dir) if set(targets) - {RELEASE_BRANCH} else None
    failed = False
    for target in targets:
        level = "ok"
        try:
            if target == RELEASE_BRANCH:
                detail = "no stax"
            elif target == trunk:
                detail = "stax trunk (st sync refreshes it)"
            elif target.startswith("effort/"):
                detail = "coordinator-owned"
            elif imported_frozen(branch_metadata(plan_dir, target)):
                detail = refresh_base(plan_dir, target)
            else:
                raise ReadError("not an imported, frozen stax branch (run wg preflight)")
        except (OSError, ReadError) as e:
            level, detail, failed = "FAIL", str(e), True
        print(f"{level} base {target}: {detail}")
    return int(failed)


# ---------------------------------------------------------------- owns

def _prefix(g):
    for i, c in enumerate(g):
        if c in "*?[":
            return g[:i]
    return g


def owns(plan, args):
    nodes = {n["key"]: n for n in plan["nodes"]}
    mode = args[0] if args else None
    bad = 0
    if mode == "overlap":
        keys = args[1:]
        for k in keys:
            if k not in nodes:
                die(f"unknown key {k}")
            if not nodes[k].get("owns"):
                print(f"{k}: no owns")
                bad = 1
        for a in keys:
            for b in keys:
                if a == b:
                    continue
                for ga in nodes[a].get("owns", []):
                    for kind in ("owns", "shares"):
                        if kind == "owns" and a > b:
                            continue
                        for gb in nodes[b].get(kind, []):
                            pa, pb = _prefix(ga), _prefix(gb)
                            if pa.startswith(pb) or pb.startswith(pa):
                                print(f"{a} owns {ga} <-> {b} {kind} {gb}")
                                bad = 1
        return bad
    if mode == "diff" and len(args) == 3:
        k, base = args[1], args[2]
        return owns_diff(nodes.get(k) or die(f"unknown key {k}"), base)
    die("usage: wg.py owns overlap <plan-dir> <key>... | owns diff <plan-dir> <key> <base>")


def owns_diff(node, base, cwd=None):
    own, shared = node.get("owns", []), node.get("shares", [])
    if not own:
        print(f"{node['key']}: no owns")
        return 1
    result = command("git", "diff", "--name-only", f"{base}...HEAD", cwd=cwd)
    if result.returncode:
        raise ReadError(command_error(result))
    bad = 0
    for path in filter(None, result.stdout.splitlines()):
        if any(fnmatch.fnmatchcase(path, glob) for glob in own):
            continue
        if any(fnmatch.fnmatchcase(path, glob) for glob in shared):
            print(f"SHARED {path}")
        else:
            print(f"OUT {path}")
            bad = 1
    return bad


# ---------------------------------------------------------------- evidence / verify / watch

def utc_now():
    return datetime.now(timezone.utc)


def evidence_path(plan_dir, key):
    if key in {"", ".", ".."} or Path(key).name != key:
        die(f"invalid evidence key {key}")
    return Path(plan_dir) / "evidence" / f"{key}.json"


def git_output(*args, cwd=None):
    result = command("git", *args, cwd=cwd)
    if result.returncode:
        raise ReadError(command_error(result))
    return result.stdout.strip()


def patch_id(lower, cwd=None):
    """A hash of the branch's own diff: the changed lines with their context, without line numbers.

    A restack with no conflict keeps it. A change of the diff gives a new one: other lines, another place, or
    other white space. A base change within 3 lines of a hunk also gives a new one; that costs a review and
    never keeps a wrong one.
    """
    diff = subprocess.run(["git", "diff", "--binary", "--no-color", "--no-ext-diff", "--no-renames",
                           f"{lower}...HEAD"], capture_output=True, cwd=cwd)
    if diff.returncode:
        raise ReadError(diff.stderr.decode(errors="replace").strip() or f"git diff exited {diff.returncode}")
    digest = hashlib.sha256()
    for line in diff.stdout.splitlines(keepends=True):
        if line.startswith(b"index "):  # blob ids: they change with the base
            continue
        digest.update(b"@@\n" if line.startswith(b"@@ ") else line)  # line numbers change with the base
    return digest.hexdigest()[:40] if diff.stdout.strip() else "empty"


def test_command(plan):
    command = plan["effort"].get("test", DEFAULT_TEST)
    if command is None:
        die(f"no test command: set effort.test in plan.json, or test_runner in {CONFIG_PATH}")
    if not (isinstance(command, list) and command and all(isinstance(arg, str) for arg in command)):
        die("effort.test in plan.json must be a list of strings")
    return command


def full_key(plan, key):
    """The phase of a `@full-<phase>` key. None for a node key."""
    if not key.startswith("@"):
        return None
    phase = key.removeprefix("@full-")
    if phase == key or phase not in {str(p["key"]) for p in plan["phases"]}:
        die(f"unknown key {key}: a node key, or @full-<phase>")
    return phase


def workspace_file(path):
    """A changed file that no project owns and that can change each project: moon's config, or a root file
    that is not a document."""
    return path.startswith(".moon/") or ("/" not in path and not path.endswith(".md"))


def affected_tests(base):
    """The test tasks that the diff from `base` to HEAD affects, with each project that depends on a changed
    project. None: the diff changes a workspace file, so only the repo-wide suite covers it."""
    if any(workspace_file(f) for f in git_output("diff", "--name-only", base, "HEAD").splitlines()):
        return None
    # Without `--downstream deep`, moon leaves out the projects that import a changed package.
    result = subprocess.run(["moon", "query", "tasks", "--affected", "--downstream", "deep"], capture_output=True,
                            text=True, env=os.environ | {"MOON_BASE": base, "MOON_HEAD": "HEAD"})
    if result.returncode:
        raise ReadError(f"moon query tasks --affected: {command_error(result)}")
    tasks = json.loads(result.stdout).get("tasks", {})
    return sorted(f"{project}:test" for project, names in tasks.items() if "test" in names)


def evidence_scope(plan_dir, plan, key):
    """(command, scope, base) of the run for this key at HEAD. An empty command: the diff affects no test task."""
    if "test" in plan["effort"] or DEFAULT_TEST is None:
        return test_command(plan), "custom", None
    if full_key(plan, key):
        return DEFAULT_TEST, "full", None
    lower = run_row(load_keymap(plan_dir), key).get("lower") or die(f"{key}: missing run field lower")
    base = git_output("merge-base", lower, "HEAD")
    targets = affected_tests(base)
    if targets is None:
        return DEFAULT_TEST, "full", base
    return ([*TEST_RUN, *targets, *TEST_OPTIONS] if targets else []), "affected", base


def evidence(plan_dir, plan, key, given=None):
    if not full_key(plan, key):
        get_node(plan, key)
    if given and list(given) != test_command(plan):
        die("wg evidence runs only the effort's test command: " + " ".join(test_command(plan)))
    # The test runner prints the commit that it receives (config `test_runner.commit_marker`). No such line
    # means no proof.
    needs_marker = "test" not in plan["effort"] and bool(COMMIT_MARKER)
    path = evidence_path(plan_dir, key)
    if git_output("status", "--porcelain"):
        die("tree is not clean: commit first, the evidence must match one commit")
    sha = git_output("rev-parse", "HEAD")
    args, scope, base = evidence_scope(plan_dir, plan, key)
    path.parent.mkdir(exist_ok=True)
    log = path.with_name(f"{path.stem}-{sha[:10]}.log")
    started = utc_now().isoformat()
    record = {"key": key, "sha": sha, "command": args, "scope": scope, "base": base, "started": started,
              "log": str(log)}
    if not args:
        note = f"no test task is affected by {base[:10]}..{sha[:10]}\n"
        print(note, end="", flush=True)
        log.write_text(note, encoding="utf-8")
        save_json(path, record | {"exit": 0, "valid": True, "finished": started})
        return 0
    found, uncommitted = None, False
    with log.open("w", encoding="utf-8") as f:
        if scope != "custom":
            note = f"{scope} tests" + (f" over {base[:10]}" if base else "") + ": " + " ".join(args) + "\n"
            print(note, end="", flush=True)
            f.write(note)
        with subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                              text=True, errors="replace") as proc:
            for line in proc.stdout:
                print(line, end="", flush=True)
                f.write(line)
                f.flush()
                match = re.search(COMMIT_MARKER, line) if found is None and COMMIT_MARKER else None
                if match:
                    found = match[1]
                    uncommitted = "with uncommitted changes" in line
            result = proc.wait()
    if result < 0:
        result = 128 - result
    valid = not uncommitted and (found == sha[:10] or (found is None and not needs_marker))
    save_json(path, record | {"exit": result, "valid": valid, "finished": utc_now().isoformat()})
    if uncommitted:
        die("evidence invalid: the command tested uncommitted changes", 3)
    if found is None and needs_marker:
        die("evidence invalid: the command did not print the commit that it tested", 3)
    if not valid:
        die(f"evidence invalid: the command tested {found}, not HEAD {sha[:10]}", 3)
    return result


def evidence_current(plan, record):
    """The record is from the effort's test command: its own command, or an affected or repo-wide default run."""
    if "test" in plan["effort"] or DEFAULT_TEST is None:
        return record.get("command") == test_command(plan)
    return record.get("scope") in ("affected", "full") or record.get("command") == DEFAULT_TEST


def full_suite_problem(plan_dir, plan, ship, row, merges):
    """Why the phase has no passed repo-wide run that holds each merge commit in `merges` (None: it has one)."""
    key = f"@full-{ship['phase']}"
    run = (f"in a clean worktree at origin/{phase_of(plan, ship)['target']}: "
           f"{wg_command()} evidence {shlex.quote(str(Path(plan_dir).resolve()))} {key}")
    try:
        record = json.loads(evidence_path(plan_dir, key).read_text())
    except (OSError, ValueError):
        return f"no repo-wide test run of phase {ship['phase']}; {run}"
    sha = str(record.get("sha"))
    if record.get("valid") is not True or record.get("command") != test_command(plan):
        return f"the repo-wide test run of phase {ship['phase']} is invalid; {run}"
    for oid in merges:
        if command("git", "merge-base", "--is-ancestor", oid, sha, cwd=plan_dir).returncode:
            return f"the repo-wide test run on {sha[:10]} does not hold merge commit {oid[:10]}; {run}"
    accepted = row.get("tests_accepted", "")
    if record.get("exit") == 0 or (accepted.startswith(sha + ":") and accepted.partition(":")[2].strip()):
        return None
    return (f"the repo-wide test run on {sha[:10]} failed (exit {record.get('exit')}): read {record.get('log')}; "
            f"then a fix, or wg run set … {ship['key']} \"tests_accepted={sha}:<reason>\"")


def phase_tasks(nodes, st, rows, ship):
    """(key, PR number) of each merged pre-merge task of the ship point's phase that has a PR."""
    return [(k, rows[k]["pr"]) for k, n in nodes.items()
            if n["kind"] == "task" and str(n["phase"]) == str(ship["phase"]) and not post_merge(n)
            and st.get(k) in MERGED and rows.get(k, {}).get("pr")]


def pr_checks(pr, cwd=None, strict=False):
    """Whether no check of the PR failed, and the detail to print. A pending check does not fail it."""
    result = command("gh", "pr", "checks", pr, "--json", "name,bucket", cwd=cwd)
    if result.stdout.strip():
        checks = json.loads(result.stdout)
        failures = [c["name"] for c in checks if c["bucket"] == "fail"]
        pending = sum(c["bucket"] == "pending" for c in checks)
        known_exit = result.returncode in (0, 1, 8)
        if strict and not (result.returncode == 0 or result.returncode == 1 and failures
                           or result.returncode == 8 and pending):
            raise ReadError(command_error(result))
        passed = "no failed checks" + (f" ({pending} pending)" if pending else "")
        return known_exit and not failures, ", ".join(failures) or (passed if known_exit else command_error(result))
    if result.returncode == 1 and "no checks reported" in result.stderr.lower():
        return True, "no checks"
    if strict and result.returncode:
        raise ReadError(command_error(result))
    return result.returncode == 0, "no checks" if not result.returncode else command_error(result)


def pr_view(pr, fields, cwd=None):
    result = command("gh", "pr", "view", pr, "--json", fields, cwd=cwd)
    if result.returncode:
        raise ReadError(command_error(result))
    return json.loads(result.stdout)


def pr_scope(pr, lower, cwd=None):
    """(ok, name, detail): the PR carries exactly the branch's own commits over `lower`.

    A branch cut from one base (say main) whose PR targets another (the release branch) shows
    hundreds of foreign commits on GitHub while every local check passes on the branch."""
    try:
        commits = len(pr_view(pr, "commits", cwd=cwd)["commits"])
        own = int(git_output("rev-list", "--count", f"{lower}..HEAD", cwd=cwd))
    except (ReadError, OSError, ValueError, KeyError) as e:
        return False, "scope", str(e)
    if commits != own:
        return False, "scope", (f"PR #{pr} carries {commits} commits, the branch has {own} over {lower}: "
                                "the PR base is not the branch's base; rebase the branch onto the PR base")
    return True, "scope", f"PR #{pr} carries the branch's {own} commits over {lower}"


def pr_stack(pr, cwd=None):
    """(ok, name, detail): no native GitHub stack holds the PR. `st submit` registers one and
    retargets its bottom PR to the stax trunk, which silently undoes a lane's base."""
    result = command("gh", "api", f"repos/{{owner}}/{{repo}}/pulls/{pr}", "--jq", ".stack.number // empty", cwd=cwd)
    if result.returncode:
        return False, "stack", command_error(result)
    number = result.stdout.strip()
    if number:
        return False, "stack", (f"PR #{pr} is in native GitHub stack #{number}: run `st stack unlink {number}`, "
                                "then check each PR base; push with git push, never st submit")
    return True, "stack", f"PR #{pr} is in no native stack"


def verify(plan_dir, plan, key, cwd=None):
    """Code done on the PR's current head. `cwd` is the node's worktree; the default is the current directory."""
    node = get_node(plan, key)
    km = load_keymap(plan_dir)
    row = run_row(km, key)
    for field in ("pr", "branch", "parent", "lower"):
        if not row.get(field):
            die(f"{key}: missing run field {field}")
    pr = row["pr"]
    if not re.fullmatch(r"[1-9][0-9]*", pr):
        die(f"{key}: invalid PR number {pr!r}")
    failed = False

    def line(ok, name, detail):
        nonlocal failed
        print(f"{'ok' if ok else 'FAIL'} {name}: {detail}")
        failed |= not ok

    try:
        info = pr_view(pr, "state,baseRefName,headRefName,headRefOid,isDraft", cwd=cwd)
        ok = (info["state"], info["baseRefName"], info["headRefName"]) == ("OPEN", row["parent"], row["branch"])
        line(ok, "pr", f"#{pr} {info['state']} {info['headRefName']} -> {info['baseRefName']}")
    except (ReadError, OSError, ValueError) as e:
        info = {}
        line(False, "pr", str(e))
    if info:
        line(*pr_scope(pr, row["lower"], cwd))
        line(*pr_stack(pr, cwd))
    sha = info.get("headRefOid")
    at_head = False
    try:
        head = git_output("rev-parse", "HEAD", cwd=cwd)
        dirty = bool(git_output("status", "--porcelain", cwd=cwd))
        at_head = head == sha and not dirty
        line(at_head, "head", f"HEAD {head[:10]}, PR {(sha or '?')[:10]}, tree {'dirty' if dirty else 'clean'}")
    except (ReadError, OSError) as e:
        line(False, "head", str(e))
    if at_head:
        # Before the other checks: a changed patch makes its reviews stale, also when a check below fails.
        try:
            track_patch(plan_dir, key, sha, patch_id(row["lower"], cwd))
        except (ReadError, OSError) as e:
            line(False, "patch", str(e))

    path = evidence_path(plan_dir, key)
    try:
        record = json.loads(path.read_text())
        if record.get("valid") is not True or not sha or record.get("sha") != sha:
            line(False, "tests", "invalid evidence or evidence does not match the PR head")
        elif not evidence_current(plan, record):
            line(False, "tests", "the evidence is for another command: run wg evidence again")
        elif record.get("exit") == 0:
            line(True, "tests", f"passed on {sha[:10]}")
        elif record.get("exit") is not None and row.get("tests_accepted", "").startswith(sha + ":"):
            reason = row["tests_accepted"].partition(":")[2]
            line(bool(reason.strip()), "tests", f"accepted: {reason}" if reason.strip() else "acceptance needs a reason")
        else:
            line(False, "tests", f"command exit: {record.get('exit')}")
    except FileNotFoundError:
        line(False, "tests", "no evidence")
    except (OSError, ValueError) as e:
        line(False, "tests", str(e))

    if node.get("role") != "integration" and not node.get("owns"):
        line(False, "owns", "node has no owns")
    elif node.get("role") != "integration":
        try:
            outside = owns_diff(node, row["lower"], cwd)
            line(not outside, "owns", "files outside owns/shares" if outside else "diff stays in owns/shares")
        except (ReadError, OSError) as e:
            line(False, "owns", str(e))

    try:
        checks_ok, detail = pr_checks(pr, cwd)
        line(checks_ok, "checks", detail)
    except (OSError, ValueError) as e:
        line(False, "checks", str(e))

    km = load_keymap(plan_dir)
    if failed:
        # A head that passed before and fails now is no longer code done.
        if sha and run_row(km, key).get("code_done_head") == sha:
            del run_rows(km)["nodes"][key]["code_done_head"]
            save_keymap(plan_dir, km)
            print(f"{key}: {sha[:10]} is no longer code done")
        return 1
    run_rows(km)["nodes"].setdefault(key, {})["code_done_head"] = sha
    save_keymap(plan_dir, km)
    print(f"code done: {key} #{pr} {sha[:10]}")
    return 0


REVIEW_FIELDS = ("review", "merge_review", "merge_review_seen", "merge_review_patch", "verified_head")


def track_patch(plan_dir, key, sha, patch):
    """A review covers one patch. A new head with the same patch keeps the review; a new patch clears it."""
    km = load_keymap(plan_dir)
    row = run_rows(km)["nodes"].setdefault(key, {})
    old, old_head = row.get("patch"), row.get("code_done_head")
    # A row from before the patch field has no id to compare: a new head then counts as a new patch.
    changed = old != patch if old else old_head not in (None, sha)
    reviewed = any(row.get(field) for field in ("review", "merge_review"))
    cleared = []
    if changed:
        if row.get("review") in REVIEW_OK:
            row.pop("review_round", None)  # a new patch after a passed review starts a new review
        cleared = [field for field in REVIEW_FIELDS if row.pop(field, None) is not None]
    row["patch"] = patch
    save_keymap(plan_dir, km)
    if cleared:
        print(f"cleared {', '.join(cleared)}: the patch changed")
    elif reviewed and old_head not in (None, sha):
        print("kept the review: new head, same patch")


# ---------------------------------------------------------------- next

LIVE = {"creating", "starting", "running"}  # run-row states of a worker job that is not over
PR_FIELDS = "state,headRefOid,isDraft,mergeCommit,mergeable,baseRefName,reviews,comments"
COMPLETE = "every ship point is Done or Canceled"


def bottom_base(node, target):
    """The PR base of a node at the bottom of its lane."""
    return "main" if node.get("role") == "sync" else target


def next_lines(plan_dir, plan, tolerant=False, *, inputs=None, triage=None):
    """One status line; then what the coordinator does now (do), waits for (wait), and must know (note).

    It reads Linear, GitHub, and the run rows, and writes nothing, so a new session can start from it.
    """
    km, live, nodes, st, deps, rows = inputs if inputs is not None else snapshot(plan_dir, plan)
    effort = run_rows(km)["effort"]
    wave = [k for k in effort.get("wave", "").split(",") if k]
    order = topo_order(plan)
    tasks = [k for k in order if nodes[k]["kind"] == "task"]
    lines, idle = [], []
    for k, row in rows.items():
        if row.get("soak_until"):
            soak_end(k, row["soak_until"])

    def warn(text):
        print(f"warn next: {text}", file=sys.stderr, flush=True)

    def add(level, verb, k, detail=""):
        ident = km["nodes"].get(k, {}).get("identifier", "-")
        lines.append((level, f"{verb} {k} {ident}" + (f": {detail}" if detail else "")))

    def title(k):
        return nodes[k].get("title") or live[km["nodes"][k]["id"]].get("title", "")

    infos = {}

    def pr_info(k, number, optional=False):
        if k not in infos:
            if not isinstance(number, str) or not re.fullmatch(r"[1-9][0-9]*", number):
                raise ReadError(f"{k}: invalid PR number {number!r}")
            try:
                result = pr_view(number, PR_FIELDS, cwd=plan_dir)
                if not isinstance(result, dict) or result.get("state") not in {"OPEN", "CLOSED", "MERGED"}:
                    raise ReadError(f"{k} #{number}: invalid PR response")
                infos[k] = result
            except (ReadError, OSError, json.JSONDecodeError, subprocess.TimeoutExpired) as e:
                if not tolerant and not optional:
                    raise
                warn(f"{k} #{number}: {e}")
                infos[k] = None
        return infos[k]

    def checks_pass(k, number):
        try:
            return pr_checks(number, plan_dir, **({"strict": True} if inputs is not None else {}))[0]
        except (OSError, ValueError) as e:
            if not tolerant:
                raise ReadError(f"{k} #{number}: {e}") from e
            warn(f"{k} #{number}: {e}")
            return True

    def issue(k):
        return live.get(km["nodes"].get(k, {}).get("id"))

    def code_done(k):
        """wg done passed on the PR's current head. Nothing waits for a review but the merge request of that PR."""
        row = rows.get(k, {})
        if st.get(k) in SETTLED:
            return True
        if not row.get("code_done_head") or not row.get("pr"):
            return False
        info = pr_info(k, row["pr"])
        if not info or info.get("state") != "OPEN":
            return bool(info) and info.get("state") == "MERGED"
        return info.get("headRefOid") == row["code_done_head"]  # a push after the last wg done is not code done

    def reviewed(k):
        """Code done and past the wave review. A PR that left draft is at the merge point: the merge review is its gate."""
        if st.get(k) in SETTLED:
            return True
        if not code_done(k):
            return False
        info = pr_info(k, rows[k]["pr"]) or {}
        return (rows[k].get("review") in REVIEW_OK or info.get("isDraft") is False
                or marked_reviewed(issue(k)))

    def startable(k):
        """The same gates as wg dispatch, so each dispatch line can be done."""
        below = lane_below(k, nodes, deps) if nodes[k]["kind"] == "task" else None
        if k not in wave:
            idle.append(k)
        elif below and stale_push(nodes, rows, st, below, lambda number: (pr_info(below, number) or {}).get("headRefOid")):
            add("wait", "below", k, f"{below} has a push that is not code done")
        else:
            add("do", "dispatch", k)

    def merge(k, s, row, info):
        n, number = nodes[k], row["pr"]
        below = lane_below(k, nodes, deps)
        base = bottom_base(n, phase_of(plan, n)["target"])
        if below and st.get(below) in MERGED and row.get("parent") != base:
            add("do", "restack", k, f"#{number}: the PR below it merged")
        elif info.get("isDraft"):
            if row.get("draft") == "yes":
                add("wait", "human", k, f"mark PR #{number} ready for review")
            else:
                add("do", "undraft" if effort.get("merge_prep", "coordinator") == "coordinator" else "ask-ready", k,
                    f"#{number}")
        elif not merge_reviewed(row, info.get("headRefOid"), issue(k)):
            if row.get("merge_review") != "requested" and row.get("thorough_head"):
                add("do", "merge-review", k, f"#{number}: check the fix since {row['thorough_head'][:10]}, "
                    "no new thorough review")
            elif row.get("merge_review") != "requested":
                add("do", "merge-review", k, f"#{number}: request the thorough review")
            elif review_count(info) > int(row.get("merge_review_seen") or 0):
                add("do", "merge-review", k, f"#{number}: read the new review")
            else:
                add("wait", "review", k, f"#{number}: the thorough review is requested")
        elif below and st.get(below) not in SETTLED:
            add("wait", "below", k, f"#{number} is ready; {below} merges first")
        elif info.get("baseRefName") != base:
            add("do", "restack", k, f"#{number}: its base is {info.get('baseRefName')}, not {base}")
        elif info.get("mergeable") == "CONFLICTING":
            add("do", "restack", k, f"#{number} conflicts with {info.get('baseRefName')}")
        elif not checks_pass(k, number):
            add("do", "verify", k, f"#{number}: a check failed")
        elif s != "Ready to Merge":
            add("do", "ask-merge", k, f"#{number}")
        else:
            add("wait", "human", k, f"merge PR #{number}")

    def task(k, s, row):
        n, number = nodes[k], row.get("pr")
        if s in MERGED:
            # recovery.md "Resume" step 4: reconcile a Merged task if its PR is open or closed.
            if s == "Merged" and number and (info := pr_info(k, number, optional=True)) and info["state"] != "MERGED":
                add("do", "reconcile", k, f"status Merged, but PR #{number} is {info['state']}")
            return
        if s not in CD_STATUSES:
            add("do", "reconcile", k, f"ENG status {s} has no twin")
        elif not number:
            waiting = s in ("Todo", "Ready")
            if waiting and open_blockers(k, nodes, deps, st, rows):
                pass
            elif n.get("role") == "integration":
                add("do", "integration", k)  # the coordinator's own work: no worker, no dispatch
            elif row.get("branch"):
                add("do", "verify", k, "no pr in the run row")
            elif not waiting:
                add("do", "reconcile", k, f"{s} with no run row")
            elif n.get("branch") or n.get("pr"):
                add("do", "adopt", k)
            else:
                startable(k)
        elif (info := pr_info(k, number)) is None:
            pass
        elif info["state"] == "MERGED":
            add("do", "merged", k, f"#{number} {info['mergeCommit']['oid'][:10]}")
        elif info["state"] != "OPEN":
            add("do", "closed", k, f"#{number}")
        elif row.get("code_done_head") != info.get("headRefOid"):
            add("do", "verify", k, f"#{number} head {str(info.get('headRefOid'))[:10]} is not code done")
        elif row.get("review") not in REVIEW_OK and info.get("isDraft") and not marked_reviewed(issue(k)):
            rounds = int(row.get("review_round") or 0)
            if row.get("review_dispatch"):
                add("wait", "reviewer", k, f"#{number} round {rounds or 1}")
            elif rounds >= 2:
                add("wait", "human", k, f"#{number}: 2 review rounds had blocking findings; only this PR is held "
                    f"(label {REVIEWED_LABEL!r} accepts them, or ask for one more fix)")
            else:
                add("do", "review", k, f"#{number} round {rounds + 1}")
        else:
            merge(k, s, row, info)

    def suite_problem(k, n, row):
        """Why the ship point's phase still needs its repo-wide test run. It is due when the merge point is Done."""
        if not any(m["kind"] == "merge-point" and str(m["phase"]) == str(n["phase"]) and st.get(key) == "Done"
                   for key, m in nodes.items()):
            return None
        merges = [((pr_info(t, number) or {}).get("mergeCommit") or {}).get("oid")
                  for t, number in phase_tasks(nodes, st, rows, n)]
        return full_suite_problem(plan_dir, plan, n, row, [m for m in merges if m]) if any(merges) else None

    for k in order:
        n, s, row = nodes[k], st.get(k), rows.get(k, {})
        if k not in km["nodes"]:
            lines.append(("do", f"load {k} -: not in keymap.json"))
            continue
        if s is None:
            add("do", "reconcile", k, "the issue is not in Linear")
            continue
        if s in ("Done", "Canceled", "Backlog", "Triage"):
            continue
        state = row.get("state")
        claims = [label["name"] for label in claim_labels(live[km["nodes"][k]["id"]])]
        if state in ("failed", "blocked", "unknown"):
            add("wait", "human", k, f"state={state}")
        elif state in ("creating", "starting"):
            add("do", "reconcile", k, f"state={state}: no receipt of the job is recorded")
        elif state == "running":
            add("wait", "worker", k, f"job={row.get('job', '?')} dispatch={row.get('dispatch', '?')}")
        elif claims:
            add("do", "reconcile", k, f"{claims[0]} with no job in the run row")
        elif s == WAIT_STATUS:
            add("wait", "human", k, title(k))
        elif n["kind"] == "task":
            task(k, s, row)
        elif n["kind"] == "ship-point" and (problem := suite_problem(k, n, row)):
            add("do", "full-suite", k, problem)
        elif n["kind"] == "ship-point" and s == "Verifying":
            until, soak = row.get("soak_until"), phase_of(plan, n).get("soak")
            blockers = milestone_blockers(k, nodes, deps, st, rows)
            if blockers:
                add("wait", "blockers", k, ", ".join(blockers) + " opened again")
            elif until and soak_end(k, until) > utc_now():
                add("wait", "soak", k, f"until {until}")
            elif until or not soak:
                add("do", "ship", k, f"the soak passed at {until}" if until else "")
            else:
                add("wait", "human", k, f"no soak_until: when did the {soak} soak start?")
        elif n["kind"] == "ops" and n.get("by") == "coordinator" and s == "In Progress":
            add("wait", "coordinator", k, title(k))
        elif n["kind"] == "spike" and s == "In Progress":
            add("do", "reconcile", k, "In Progress with no job in the run row")
        elif s in ("Todo", "Ready") and not open_blockers(k, nodes, deps, st, rows):
            if n["kind"] == "spike":
                startable(k)
            elif n["kind"] == "ops" and n.get("by") == "coordinator":
                add("do", "ops", k, title(k))
            elif n["kind"] in ("decision", "ops"):
                add("do", "ask", k, title(k))
            elif not milestone_blockers(k, nodes, deps, st, rows):
                add("do", "close" if n["kind"] == "merge-point" else "verifying", k)

    def open_in_wave(k):
        if k not in nodes:
            return False
        return not code_done(k) if nodes[k]["kind"] == "task" else st.get(k) not in SETTLED

    if idle and not any(open_in_wave(k) for k in wave):
        lines.append(("do", "wave: pick the next wave from " + ",".join(idle)))
    project = km.get("project") or {}
    if project.get("id"):
        mapped = {entry["id"] for entry in km["nodes"].values()}
        try:
            for found in project_entries(project["id"], "issues", "id identifier title state{name}"):
                if found["state"]["name"] == "Triage" and found["id"] not in mapped:
                    if effort.get("autonomy_seen") == "full":
                        # At level full triage is the coordinator's job: not the human's move on the page.
                        lines.append(("do", f"triage {found['identifier']}: {found['title']}"))
                        continue
                    lines.append(("note", f"triage {found['identifier']}: {found['title']}"))
                    if triage is not None:
                        triage[found["id"]] = {"issue": found["identifier"], "reason": "Triage"}
        except ReadError as e:
            if not tolerant:
                raise
            warn(str(e))
    lines.sort(key=lambda line: ("do", "wait", "note").index(line[0]))

    current = next((p for p in plan["phases"] if any(
        n["kind"] == "ship-point" and str(n["phase"]) == str(p["key"]) and st.get(k) not in ("Done", "Canceled")
        for k, n in nodes.items())), None)
    if not current:
        return COMPLETE, lines
    mine = [t for t in tasks if str(nodes[t]["phase"]) == str(current["key"])]
    counts = (sum(1 for t in mine if st.get(t) in SETTLED or rows.get(t, {}).get("code_done_head")),
              sum(1 for t in mine if reviewed(t)), sum(1 for t in mine if st.get(t) in MERGED))
    head = "phase {}: {} task{}, {} code done, {} reviewed, {} merged".format(
        current["key"], len(mine), "" if len(mine) == 1 else "s", *counts)
    return head + (f"; wave {','.join(wave)}" if wave else ""), lines


PAGE_URL = CONFIG["page_url"] or "http://127.0.0.1:4747"  # the hosted page (config `page_url`), else `wg ui`


def page_link(plan, identifier=None):
    """The link of the effort in the page, or of one of its issues. `WG_UI_URL` names another page."""
    query = {"project": plan["effort"]["name"]}
    if plan_workspace(plan) != DEFAULT_WORKSPACE_ID:
        query["workspace"] = plan_workspace(plan)
    if identifier:
        query["issue"] = identifier
    base = (os.environ.get("WG_UI_URL") or PAGE_URL).rstrip("/")
    return f"{base}/?{urllib.parse.urlencode(query, quote_via=urllib.parse.quote)}"


STATUS_DOC = "work-graph status"  # the title of the effort's record in Linear; the page reads it


def node_next(lines, nodes):
    """What `wg next` says about each node: `do ask-merge: #7`, `wait human: …`. A line names its node as
    `<verb> <key> <identifier>[: <detail>]`."""
    said = {}
    for level, text in lines:
        m = re.match(r"(\S+) (\S+) \S+(?:: (.*))?$", text, re.S)
        if m and m.group(2) in nodes:
            said.setdefault(m.group(2), []).append(f"{level} {m.group(1)}" + (f": {m.group(3)}" if m.group(3) else ""))
    # One line for each thing said: a detail can hold any other mark, a line break it cannot.
    return {key: "\n".join(parts) for key, parts in said.items()}


def status_doc(plan, head, lines, wave, previous, wait_interval=None):
    data = {"wg": 1, "status": head, "wave": wave, "lines": [{"level": level, "text": text} for level, text in lines]}
    body = "\n".join([head, "", *(f"- `{level}` {text}" for level, text in lines)]).strip()
    stable = body + "\n\n```json\n" + json.dumps(data) + "\n```"
    sha = hashlib.sha256(stable.encode()).hexdigest()
    ran = utc_now().strftime("%Y-%m-%dT%H:%M:%SZ")
    at = ran
    if previous.get("sha") == sha:
        at = previous.get("at")
        if not at and previous.get("id"):
            # Older keymaps have the hash. Read the time of the last change from the document.
            try:
                result = gql("query($id:String!){ document(id:$id){ content } }", {"id": previous["id"]})
                content = (result.get("document") or {}).get("content") or ""
                block = re.search(r"^```json\n(.*)\n```$", content, re.MULTILINE)
                if block:
                    old = json.loads(block.group(1))
                    if isinstance(old, dict):
                        at = old.get("at")
            except (ReadError, OSError, json.JSONDecodeError):
                pass
        at = at or ran
    # ran is the time of this run, wait_interval is the polling delay in seconds,
    # and contract is a hash of the page contract.
    data.update(at=at, ran=ran, contract=hashlib.sha256(contract_text().encode()).hexdigest()[:12])
    if wait_interval is not None:
        data["wait_interval"] = wait_interval
    text = (body + "\n\n```json\n" + json.dumps(data) + "\n```\n\n"
            "Written by `wg next` for the page (" + page_link(plan) + "). Do not edit.")
    return sha, at, text


def publish(plan_dir, plan, head, lines, wait_interval=None, *, expected=None):
    """Copy the result of `wg next` to Linear, for the page: `wave` and `next` on each node card, and the status
    line and every line in one document of the project. Writes the document on each run and changes to the
    cards. A failure is a warning. The result on the terminal is the truth."""
    try:
        with plan_lock(plan_dir):
            km = load_keymap(plan_dir)
            doc = km.get("status_doc") or {}
            if expected is not None:
                if load_plan(plan_dir, strict=True) != plan or km != expected:
                    return "inputs changed"
                if doc.get("id") and coordinator_listens(doc["id"]):
                    return "coordinator listening"
            nodes = {n["key"]: n for n in plan["nodes"]}
            # A scheduled publish must preserve the stored run data, even when it is absent.
            run_source = km if expected is None else {"run": copy.deepcopy(km.get("run", {}))}
            run = run_rows(run_source)
            wave = [k for k in run["effort"].get("wave", "").split(",") if k]
            said = node_next(lines, nodes)
            dirty = False
            for key, entry in km["nodes"].items():
                if key not in nodes:
                    continue
                want = {**({"wave": "yes"} if key in wave else {}), **({"next": said[key]} if key in said else {})}
                if (entry.get("published") or {}) != want:
                    entry["published"] = want
                    dirty = True
                card_changed = sync_card(nodes[key], entry, True, [], run["nodes"].get(key, {}), strict=expected is not None)
                dirty = card_changed or dirty
                if expected is not None and dirty:
                    save_keymap(plan_dir, km)
                    dirty = False
            project = (km.get("project") or {}).get("id")
            if project:
                sha, at, text = status_doc(plan, head, lines, wave, doc, wait_interval)
                if doc.get("id"):
                    result = gql("""mutation($id:String!,$i:DocumentUpdateInput!){ documentUpdate(id:$id,input:$i){ success } }""",
                                 {"id": doc["id"], "i": {"content": text}})
                    if not result["documentUpdate"]["success"]:
                        raise ReadError("could not update the status document")
                else:
                    result = gql("""mutation($i:DocumentCreateInput!){ documentCreate(input:$i){ success document{id} } }""",
                                 {"i": {"title": STATUS_DOC, "content": text, "projectId": project}})["documentCreate"]
                    if (expected is not None and result.get("success") is not True) or result.get("success") is False:
                        raise ReadError("could not create the status document")
                    doc = result["document"]
                record = {"id": doc["id"], "sha": sha, "at": at}
                if km.get("status_doc") != record:
                    km["status_doc"] = record
                    dirty = True
            if dirty:
                save_keymap(plan_dir, km)
    except (ReadError, OSError, ValueError, KeyError, TypeError) as e:
        if expected is not None:
            raise
        print(f"warn next: result not copied to Linear for the page ({e})", file=sys.stderr, flush=True)


# ---------------------------------------------------------------- link to the page server

LINK_VERSION = 1  # the protocol `wg-link/1` (src/lib/link.ts of the page)
LINK_OPEN_TIMEOUT = 3
LINK_TO_COORDINATOR = ("changed", "answer", "reply", "command")
LINK_FROM_COORDINATOR = ("hello", "state", "asks", "progress", "ack", "wrote")
LINK_COMMANDS = ("next", "dispatch", "pause", "resume", "autonomy")


# What the server forgets when it restarts, and the coordinator sends again when it connects again.
LINK_REPLAYED = ("state", "asks", "progress")


class Link:
    """The connection of this coordinator to the page server (`/api/link`). The server tells it at once
    about a change on the page or in Linear, and keeps the messages for it while it is busy. Linear stays the
    truth: without a link (`WG_LINK=off`, no `websockets` package, no server), `wg next` polls as before."""

    def __init__(self, url, project, session, hello):
        self.url, self.project, self.session, self.hello = url, project, session, hello
        self.inbox, self.ws, self.reader = [], None, None
        self.cond = __import__("threading").Condition()
        self.retry_at = 0.0
        self.warned = False
        # The last state, asks and progress, sent again after each hello: a restarted server forgets them.
        self.last = {}

    @classmethod
    def open(cls, plan_dir, plan):
        if os.environ.get("WG_LINK", "").lower() in ("off", "0", "no"):
            return None
        try:
            import websockets.sync.client  # noqa: F401  the package comes with `uv run --script`
        except ImportError:
            return None
        url, project, session, hello = link_target(plan_dir, plan)
        link = cls(url, project, session, hello)
        link.connect()
        return link

    def envelope(self, kind, payload):
        return link_envelope(self.session, self.project, kind, payload)

    def connect(self):
        if self.ws or time.monotonic() < self.retry_at:
            return self.ws is not None
        from websockets.sync.client import connect
        try:
            # No Origin header: the server takes a socket with no Origin as a coordinator.
            stack = contextlib.ExitStack()
            self.ws = stack.enter_context(connect(self.url, open_timeout=LINK_OPEN_TIMEOUT, close_timeout=1, max_size=2**22))
            self.ws.stack = stack
            self.ws.send(self.envelope("hello", self.hello))
            for kind, payload in self.last.items():
                self.ws.send(self.envelope(kind, payload))
        except Exception as e:  # any failure only means: poll as before
            self.ws = None
            self.retry_at = time.monotonic() + 30
            if not self.warned:
                print(f"warn link: {self.url.split('?')[0]}: {e}. Polling Linear instead.", file=sys.stderr, flush=True)
                self.warned = True
            return False
        self.warned = False
        ws = self.ws
        self.reader = __import__("threading").Thread(target=self.read, args=(ws,), daemon=True)
        self.reader.start()
        return True

    def read(self, ws):
        try:
            for raw in ws:
                try:
                    message = json.loads(raw)
                except ValueError:
                    continue
                if isinstance(message, dict) and message.get("v") == LINK_VERSION:
                    with self.cond:
                        self.inbox.append(message)
                        self.cond.notify_all()
        except Exception:
            pass
        with self.cond:
            if self.ws is ws:
                self.ws = None
                self.retry_at = time.monotonic() + 5
            self.cond.notify_all()

    def send(self, kind, payload):
        fresh = self.ws is None
        if kind in LINK_REPLAYED:
            self.last[kind] = payload
        if not self.connect():
            return False
        if fresh and kind in LINK_REPLAYED:
            return True  # connect sent it after hello
        try:
            self.ws.send(self.envelope(kind, payload))
            return True
        except Exception:
            self.ws = None
            return False

    def take(self, timeout=0.0):
        """The messages that came, after waiting up to `timeout` seconds for the first one."""
        deadline = time.monotonic() + timeout
        with self.cond:
            while not self.inbox and (left := deadline - time.monotonic()) > 0:
                if self.ws is None:
                    self.cond.wait(min(left, max(0.0, self.retry_at - time.monotonic()) or 1.0))
                    if self.ws is None and time.monotonic() >= self.retry_at:
                        break
                else:
                    self.cond.wait(left)
            taken, self.inbox = self.inbox, []
        return taken

    def wait(self, timeout):
        """Sleep up to `timeout` seconds; wake at once when a message comes. Reconnect while it waits."""
        deadline = time.monotonic() + timeout
        while (left := deadline - time.monotonic()) > 0:
            self.connect()
            taken = self.take(left)
            if taken:
                return taken
            if self.ws is None:
                time.sleep(min(left, max(0.0, self.retry_at - time.monotonic()), 5))
        return []

    def close(self):
        ws, self.ws = self.ws, None
        if ws:
            with contextlib.suppress(Exception):
                ws.stack.close()


def link_target(plan_dir, plan):
    """The link URL of the plan's project, the project, this coordinator's session, and its `hello`."""
    km = load_keymap(plan_dir)
    project = (km.get("project") or {}).get("id") or plan["effort"]["name"]
    base = (os.environ.get("WG_UI_URL") or PAGE_URL).rstrip("/")
    scheme, rest = base.split("://", 1)
    query = urllib.parse.urlencode({"role": "coordinator", "workspace": plan_workspace(plan), "project": project})
    url = f"{'wss' if scheme == 'https' else 'ws'}://{rest}/api/link?{query}"
    host = os.uname().nodename
    here = str(Path(plan_dir).resolve())
    # One session for each plan on each machine: the next `wg next` takes the place of the last one.
    session = hashlib.sha256(f"{host}:{here}".encode()).hexdigest()[:12]
    return url, project, session, {"plan": here, "session": session, "host": host, "wg": contract_hash()}


def link_envelope(session, project, kind, payload):
    return json.dumps({"v": LINK_VERSION, "type": kind, "id": f"{session}-{time.time_ns()}",
                       "project": {"workspace": "", "id": project}, "at": utc_now().isoformat(), "payload": payload})


def flush_writes(plan_dir, plan, link=None):
    """Tell the page server that this process changed Linear (`wrote`), so it forgets its cached graph and the
    open pages load it again at once. It goes on the open link, or on a short connection with no `hello`, which
    the server does not count as a coordinator. Any failure is silent: the server's own check still sees the
    change later."""
    if not LINEAR_WRITES["any"]:
        return False
    ids = {}
    with contextlib.suppress(OSError, ValueError, KeyError, TypeError, AttributeError, SystemExit):
        ids = {e.get("id"): e.get("identifier") for e in load_keymap(plan_dir).get("nodes", {}).values()}
    payload = {"issues": sorted({ids[i] for i in LINEAR_WRITES["ids"] if ids.get(i)})}
    LINEAR_WRITES["any"], LINEAR_WRITES["ids"] = False, set()
    if link:
        return link.send("wrote", payload)
    if os.environ.get("WG_LINK", "").lower() in ("off", "0", "no"):
        return False
    try:
        from websockets.sync.client import connect
        url, project, session, _ = link_target(plan_dir, plan)
        with connect(url, open_timeout=LINK_OPEN_TIMEOUT, close_timeout=1) as ws:
            ws.send(link_envelope(session, project, "wrote", payload))
        return True
    except Exception:  # no package, no server, or an old server: the server's check sees the change later
        return False


def contract_hash():
    return hashlib.sha256(contract_text().encode()).hexdigest()[:12]


def link_lines(messages, keys=None, plan_dir=None):
    """The lines of `wg next` that messages of the page server give, and the ids that these lines settle.
    `changed` gives no line: it makes `wg next` read Linear again at once. `keys` maps identifiers to node keys,
    for an issue whose message names no key."""
    keys = keys or {}
    lines, settled = [], []
    for m in messages:
        kind, payload = m.get("type"), m.get("payload") or {}
        if kind == "changed":
            settled.append(m["id"])
        elif kind == "answer":
            # The human's comment in the page on a `Needs <human>` issue. The full text is the comment in Linear.
            issue = payload.get("issue") or "-"
            lines.append(("do", f"answer {payload.get('key') or keys.get(issue, '-')} {issue}: {one_line(payload.get('body'))}"))
            settled.append(m["id"])
        elif kind == "reply" and plan_dir:
            lines.append(relay_reply(plan_dir, payload))
            settled.append(m["id"])
        elif kind == "command":
            name, key = payload.get("name"), payload.get("key")
            issue = payload.get("issue") or "-"
            if name == "dispatch" and key:
                lines.append(("do", f"dispatch {key} {issue}: {HUMAN} asked for it on the page"))
            elif name in ("pause", "resume") and plan_dir:
                # The page set or removed the project label `paused`; paused_lines reads it.
                lines.append(("note", f"{'paused' if name == 'pause' else 'resumed'} @effort -: on the page"))
            # `next` and `autonomy`: no line here. The message makes `wg next` read Linear again at once, and
            # autonomy_lines gives the `do autonomy` line from the project label that the page set.
            settled.append(m["id"])
    return lines, settled


def progress_nodes(plan_dir):
    """The state of each node's worker job, from the run rows and the evidence files, for the page."""
    km = load_keymap(plan_dir)
    nodes = []
    for key, row in run_rows(km)["nodes"].items():
        if not (row.get("job") or row.get("state")):
            continue
        evidence = None
        with contextlib.suppress(OSError, ValueError, KeyError, TypeError, SystemExit):
            e = json.loads(evidence_path(plan_dir, key).read_text())
            result = "pass" if e["exit"] == 0 else f"fail (exit {e['exit']})"
            evidence = f"{result} on {e['sha'][:7]}"
        nodes.append({"key": key, "issue": (km["nodes"].get(key) or {}).get("identifier"), "job": row.get("job"),
                      "state": row.get("state"), "ci": row.get("ci"), "evidence": evidence, "at": row.get("started_at")})
    return nodes


def paused_lines(plan_dir, plan, lines):
    """While the effort is paused, its `do` lines are not actions: one `wait paused` line stands for them."""
    if not effort_paused(plan_dir, plan):
        with plan_lock(plan_dir):
            km = load_keymap(plan_dir)
            effort = run_rows(km)["effort"]
            resumed = effort.pop("resumed", None) == "yes"
            if resumed:
                save_keymap(plan_dir, km)
        if resumed:
            # A `do` line, so `wg next --wait` wakes the coordinator even when every other line is a wait.
            return [("do", f"resumed @effort -: {HUMAN} resumed this effort on the page; "
                           "acknowledge it and continue the loop")] + lines
        return lines
    held = sum(1 for level, _ in lines if level == "do")
    return [line for line in lines if line[0] != "do"] + [
        ("wait", f"paused @effort -: {HUMAN} paused this effort on the page; {held} action(s) wait for Resume")]


ORCA_APP_CLI = "/Applications/Orca.app/Contents/Resources/bin/orca"


def orca_cli():
    """The Orca CLI. Outside an Orca terminal (an automation's precheck) neither variable nor PATH may have it."""
    return (os.environ.get("ORCA_CLI_COMMAND") or shutil.which("orca")
            or (ORCA_APP_CLI if Path(ORCA_APP_CLI).is_file() else "orca"))


def open_asks(plan_dir):
    """The open questions of the effort's workers, from Orca: each `question` message that is not handled and
    came from the dispatch in a node's run row. A failure of `orca` gives no asks; it never stops `wg next`."""
    km = load_keymap(plan_dir)
    nodes = run_rows(km)["nodes"]
    by_dispatch = {row["dispatch"]: key for key, row in nodes.items() if row.get("dispatch")}
    asks = []
    for run_id in sorted({row["run_id"] for row in nodes.values() if row.get("run_id")}):
        try:
            result = command(orca_cli(), "orchestration", "inbox", "--run", run_id, "--full", "--limit", "100", "--json")
            messages = json.loads(result.stdout)["result"]["messages"] if result.returncode == 0 else []
        except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError):
            continue
        for m in messages:
            payload = m.get("payload") or {}
            if isinstance(payload, str):
                # Orca can give the payload as JSON text.
                try:
                    payload = json.loads(payload)
                except ValueError:
                    payload = {}
            if not isinstance(payload, dict):
                payload = {}
            dispatch = payload.get("dispatchId") or m.get("from")
            if m.get("type") != "question" or m.get("handled") or dispatch not in by_dispatch:
                continue
            key = by_dispatch[dispatch]
            asks.append({"id": m["id"], "key": key, "issue": (km["nodes"].get(key) or {}).get("identifier"),
                         "from": m.get("from", ""), "body": m.get("body", ""), "at": m.get("createdAt") or m.get("at") or "",
                         "run": run_id})
    return asks


def relay_reply(plan_dir, payload):
    """Send the human's reply from the page to the worker that asked, with `orca orchestration reply`. The
    server wrote the reply to Linear. Returns the line for `wg next`."""
    ask, body = payload.get("ask") or "", payload.get("body") or ""
    key, issue = payload.get("key") or "-", payload.get("issue") or "-"
    run_id = payload.get("run") or next((a["run"] for a in open_asks(plan_dir) if a["id"] == ask), None)
    args = [orca_cli(), "orchestration", "reply", "--id", ask, "--body-file", "-", "--json"] + (["--run", run_id] if run_id else [])
    try:
        result = subprocess.run(args, input=body, capture_output=True, text=True, timeout=COMMAND_TIMEOUT.get())
        error = None if result.returncode == 0 else command_error(result)
    except (OSError, subprocess.SubprocessError) as e:
        error = str(e)
    if error:
        return ("do", f"relay {key} {issue}: send this reply to {ask} yourself ({one_line(error, 120)}): {one_line(body)}")
    return ("note", f"replied {key} {issue}: {one_line(body)}")


def one_line(text, limit=300):
    text = " / ".join(part.strip() for part in str(text or "").splitlines() if part.strip())
    return text if len(text) <= limit else text[:limit - 1] + "…"


def next_command(plan_dir, plan, wait, interval, copy=False):
    """Print the next actions. With wait: return only when the coordinator has something to do.

    With copy: also copy each result to Linear for the page, also while it waits (`publish`)."""
    link = Link.open(plan_dir, plan)
    messages = link.take() if link else []
    try:
        while True:
            try:
                keys = {e.get("identifier"): k for k, e in load_keymap(plan_dir).get("nodes", {}).items()}
                extra, settled = link_lines(messages, keys, plan_dir)
                answers = answer_lines(plan_dir)
                # An answer in Linear and its message give one line; the label also holds after a server restart.
                marked = {text.split(":", 1)[0] for level, text in answers if level == "do"}
                extra = answers + [line for line in extra if not (line[0] == "do" and line[1].split(":", 1)[0] in marked)]
                head, lines = next_lines(plan_dir, plan, tolerant=wait)
                lines = paused_lines(plan_dir, plan, extra + lines)
                if head != COMPLETE:
                    lines = autonomy_lines(plan_dir, plan) + lines
                done = not wait or head == COMPLETE or any(level == "do" for level, _ in lines)
                if link:
                    flush_writes(plan_dir, plan, link)
                    link.send("state", {"mode": "working" if done else "waiting", "head": head,
                                        "lines": [{"level": level, "text": text} for level, text in lines]})
                    link.send("asks", {"asks": open_asks(plan_dir)})
                    link.send("progress", {"nodes": progress_nodes(plan_dir)})
                if copy:
                    publish(plan_dir, plan, head, lines, wait_interval=interval if wait else None)
                if done:
                    print(head)
                    for level, text in lines:
                        print(f"{level} {text}", flush=True)
                    if head != COMPLETE:
                        print(f"note page {page_link(plan)}", flush=True)
                    # A message is settled once its line is on the terminal. Before that, the server keeps it.
                    if link and settled:
                        link.send("ack", {"ids": settled})
                    return 0
                if link and settled:  # a `changed` that did not wake the coordinator is still read
                    link.send("ack", {"ids": settled})
            except (ReadError, OSError, json.JSONDecodeError) as e:
                if not wait:
                    raise
                print(f"warn next: {e}", file=sys.stderr, flush=True)
            # Answers and commands wait in `held` until their line is printed; a new message joins them.
            held = [m for m in messages if m["id"] not in settled and m.get("type") != "changed"]
            messages = held + (link.wait(interval) if link else (time.sleep(interval) or []))
    finally:
        if link:
            link.close()


# ---------------------------------------------------------------- autostart (wg wake, wg autostart)

# At most this many coordinator agents run at once across all efforts on this machine.
WAKE_MAX_ALIVE = 2
# At most this many starts for one effort in one hour: a coordinator that ends at once does not loop.
WAKE_MAX_STARTS = 3
WAKE_SCHEDULE = "*/5 * * * *"


def wake_state_path():
    return Path.home() / ".local/state/work-graph/wake.json"


def live_agents():
    """The agents that Orca reports as not done, with the path of their workspace."""
    result = command(orca_cli(), "agent", "list", "--json")
    if result.returncode != 0:
        raise ReadError(f"orca agent list: {command_error(result)}")
    agents = json.loads(result.stdout)["result"]["agents"]
    return [{**a, "path": (a.get("worktreeId") or "").split("::", 1)[-1]} for a in agents if a.get("state") != "done"]


def page_waiting(plan, project_id):
    """How many page messages wait for a coordinator (answer, reply, command). 0 when the server cannot be read."""
    base = (os.environ.get("WG_UI_URL") or PAGE_URL).rstrip("/")
    req = urllib.request.Request(f"{base}/api/projects/{urllib.parse.quote(project_id)}/presence",
                                 headers={"x-workspace": plan_workspace(plan)})
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            return int(json.load(response).get("waiting") or 0)
    except (OSError, ValueError, TypeError, http.client.HTTPException):
        return 0


def wake_reason(plan_dir, plan, now=None):
    """Should `wg autostart` start a coordinator agent for this effort now? Returns (start, reason). It starts one
    only when the effort has work, no coordinator agent runs in its worktree, and the caps allow it."""
    now = now or time.time()
    here = str(Path(plan_dir).resolve())
    km = load_keymap(plan_dir)
    project_id = (km.get("project") or {}).get("id")
    if not project_id or not km.get("nodes"):
        return False, "the plan is not loaded"
    try:
        alive = live_agents()
    except (ReadError, OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as e:
        return False, f"Orca cannot be read ({one_line(e, 120)})"
    if any(a["path"] == here for a in alive):
        return False, "a coordinator agent runs in this worktree"
    coordinators = {a["path"] for a in alive if (Path(a["path"]) / "plan.json").is_file() and (Path(a["path"]) / "keymap.json").is_file()}
    if len(coordinators) >= WAKE_MAX_ALIVE:
        return False, f"{len(coordinators)} coordinator agents run on this machine (limit {WAKE_MAX_ALIVE})"
    state_path = wake_state_path()
    state = json.loads(state_path.read_text()) if state_path.exists() else {}
    starts = [t for t in state.get(here, []) if now - t < 3600]
    if len(starts) >= WAKE_MAX_STARTS:
        return False, f"{len(starts)} starts in the last hour (limit {WAKE_MAX_STARTS}); start one by hand"
    level = effort_autonomy(plan_dir, plan, km)
    if level == "supervised":
        return False, f"autonomy supervised: {HUMAN} starts the coordinator"
    if effort_paused(plan_dir, plan):
        return False, "the effort is paused"
    reason = None
    if waiting := page_waiting(plan, project_id):
        reason = f"{waiting} page message(s) wait for the coordinator"
    elif answers := [text for level_, text in answer_lines(plan_dir) if level_ == "do"]:
        reason = answers[0]
    else:
        seen = run_rows(load_keymap(plan_dir))["effort"].get("autonomy_seen")
        if seen and seen != level:
            reason = f"autonomy changed to {level}"
    if not reason:
        head, lines = next_lines(plan_dir, plan, tolerant=True)
        if head == COMPLETE:
            return False, "the effort is complete"
        reason = next((text for level_, text in lines if level_ == "do"), None)
        if not reason:
            return False, "nothing to do: " + head
    state[here] = starts + [now]
    state_path.parent.mkdir(parents=True, exist_ok=True)
    save_json(state_path, state, mode=0o600)
    return True, reason


def wake_command(plan_dir, plan):
    """`wg wake <plan-dir>`: the precheck of the autostart automation. Exit 0 starts a coordinator agent."""
    start, reason = wake_reason(plan_dir, plan)
    print(f"{'start' if start else 'skip'}: {reason}")
    return 0 if start else 1


def autostart_prompt(plan_dir):
    return (f"You are the work-graph coordinator of the effort in {plan_dir}. `wg autostart` started you: `wg next` has "
            "work and no coordinator was running. Load the work-graph skill, read references/coordinator.md, and run "
            f"its loop: `wg next {plan_dir} --wait`, then act on each line, until the effort is complete or a line "
            f"needs {HUMAN}. Do not ask for the autonomy level: this run uses the project's current level "
            f"(`wg autonomy {plan_dir}`), as SKILL.md \"Autostart\" says.")


def autostart_command(plan_dir, plan, install, uninstall):
    """`wg autostart <plan-dir> [--install | --uninstall]`: an Orca automation that runs `wg wake` every 5 minutes
    and starts a coordinator agent in this worktree when it says start. Without a flag, print its state."""
    here = str(Path(plan_dir).resolve())
    km = load_keymap(plan_dir)
    current = run_rows(km)["effort"].get("autostart")

    def save(value):
        with plan_lock(plan_dir):
            k = load_keymap(plan_dir)
            if value:
                run_rows(k)["effort"]["autostart"] = value
            else:
                run_rows(k)["effort"].pop("autostart", None)
            save_keymap(plan_dir, k)

    def orca(*args):
        result = command(orca_cli(), *args, "--json")
        if result.returncode != 0:
            die(f"orca {' '.join(args[:2])}: {command_error(result)}")
        return json.loads(result.stdout)["result"]

    if uninstall:
        if current:
            orca("automations", "remove", current)
            save(None)
        print("autostart off")
        return 0
    if not install:
        if not current:
            print("autostart off")
            return 0
        shown = orca("automations", "show", current).get("automation") or {}
        print(f"autostart {'on' if shown.get('enabled', True) else 'disabled'}: automation {current}, every 5 minutes")
        return 0
    # A stable uv (a shim or a package-manager link), not a versioned path that the next uv upgrade removes.
    home = Path.home()
    uv = next((str(c) for c in (home / ".proto/shims/uv", home / ".local/bin/uv", home / ".cargo/bin/uv",
                                Path("/opt/homebrew/bin/uv"), Path("/usr/local/bin/uv")) if c.is_file()), None) or shutil.which("uv")
    script = str(Path(__file__).resolve())
    # Orca runs the precheck without the login shell: give it this shell's PATH (git, gh) and the Orca CLI.
    path = os.pathsep.join(d for d in os.environ.get("PATH", "").split(os.pathsep) if d and "/.cache/uv/" not in d)
    env = f"env PATH={shlex.quote(path)} ORCA_CLI_COMMAND={shlex.quote(orca_cli())} "
    precheck = env + (f"{shlex.quote(uv)} run --quiet --script {shlex.quote(script)}" if uv
                      else f"python3 -I {shlex.quote(script)}") + f" wake {shlex.quote(here)}"
    if current:
        # Install again: refresh the precheck and the prompt, and turn the automation on.
        orca("automations", "edit", current, "--precheck", precheck, "--prompt", autostart_prompt(here), "--enabled")
        print(f"autostart on: automation {current}, every 5 minutes (updated)")
        return 0
    worktree = orca("worktree", "show", "--worktree", f"path:{here}")["worktree"]["id"]
    agents = orca("agent", "installed")["agents"]
    agent = next((a["id"] for a in agents if a.get("default")), "claude")
    created = orca("automations", "create", "--name", f"wg coordinator: {plan['effort']['name']}",
                   "--trigger", WAKE_SCHEDULE, "--prompt", autostart_prompt(here), "--provider", agent,
                   "--workspace", f"id:{worktree}", "--precheck", precheck, "--precheck-timeout", "120",
                   "--fresh-session")
    automation = (created.get("automation") or created).get("id")
    if not automation:
        die("orca automations create returned no id")
    save(automation)
    print(f"autostart on: automation {automation}, every 5 minutes, agent {agent}")
    return 0


# ---------------------------------------------------------------- scheduled refresh

TICK_LABEL = CONFIG["tick_label"]  # the launchd label of `wg tick --install`


def discard_notice(page, entries):
    """Acknowledge the digest without delivery."""
    return True


TICK_CHANNELS = {"none": discard_notice}


def coordinator_listens(doc_id):
    result = gql("query($id:String!){ document(id:$id){ content } }", {"id": doc_id})
    content = (result.get("document") or {}).get("content") or ""
    block = re.search(r"^```json\n(.*)\n```$", content, re.MULTILINE)
    if not block:
        return False
    data = json.loads(block.group(1))
    interval = data.get("wait_interval")
    if not isinstance(interval, (int, float)) or not math.isfinite(interval) or interval <= 0:
        return False
    ran = datetime.fromisoformat(data["ran"].replace("Z", "+00:00"))
    return (utc_now() - ran).total_seconds() < 2 * interval


def tick_members(inputs, lines, triage):
    km, live, nodes, statuses, _, _ = inputs
    said = node_next(lines, nodes)
    members = dict(triage)
    for key, status in statuses.items():
        if key not in nodes or status in {"Done", "Canceled"}:
            continue
        entry = km["nodes"][key]
        reasons = [part for part in said.get(key, "").splitlines()
                   if part.split(": ", 1)[0] in {"wait human", "do ask", "do ask-ready", "do ask-merge"}]
        if reasons or status in {WAIT_STATUS, "Ready to Merge", "Triage"}:
            members[entry["id"]] = {
                "issue": live[entry["id"]].get("identifier") or entry["identifier"],
                "reason": " ".join(reasons) or status,
            }
    return members


def tick_refresh(plan_dir, plan, km, record):
    inputs = snapshot(plan_dir, plan, copy.deepcopy(km))
    statuses = inputs[3]
    ships = [node["key"] for node in plan["nodes"] if node["kind"] == "ship-point"]
    for key in ships:
        if key not in statuses:
            raise ReadError(f"{key}: ship point is missing from the keymap or Linear")
    complete = all(statuses[key] in {"Done", "Canceled"} for key in ships)
    if complete and record.get("complete"):
        return "complete", None
    triage = {}
    if complete:
        head, lines, members = COMPLETE, [], {}
    else:
        head, lines = next_lines(plan_dir, plan, inputs=inputs, triage=triage)
        members = tick_members(inputs, lines, triage)
    skipped = publish(plan_dir, plan, head, lines, expected=km)
    if skipped:
        return skipped, None
    record["complete"] = complete
    return None, members


def tick_effort(plan_dir, state, save, sender):
    plan = load_plan(plan_dir, strict=True)
    km = load_keymap(plan_dir)
    project = (km.get("project") or {}).get("id")
    if not project or not km["nodes"]:
        return "skipped: plan is not loaded"
    workspace = plan_workspace(plan)
    record = state.setdefault(f"{workspace}/{project}", {})
    token = LINEAR_WORKSPACE.set(workspace)
    try:
        linear_key()
        skipped, members = tick_refresh(plan_dir, plan, km, record)
        if skipped:
            outcome = f"skipped: {skipped}"
        else:
            previous = record.get("members")
            pending = {key: members[key] for key in record.get("pending", {}) if key in members}
            if previous is not None:
                pending.update({key: members[key] for key in members.keys() - previous.keys()})
            record.update(members=members, pending=pending)
            save()
            if pending:
                if not sender(page_link(plan), [pending[key] for key in sorted(pending)]):
                    raise ReadError("the channel did not accept the notice")
                record["pending"] = {}
            outcome = "ok"
    except TICK_ERRORS as error:
        outcome = tick_error(error)
    finally:
        LINEAR_WORKSPACE.reset(token)
    record["last"] = {"at": utc_now().isoformat(), "result": outcome}
    save()
    return outcome


TICK_ERRORS = (Exception, SystemExit)


def tick_error(error):
    return f"error: {type(error).__name__}: {error}"


def trim_tick_logs(log_dir):
    for name in ("out.log", "error.log"):
        try:
            with (log_dir / name).open("r+b") as log:
                if log.seek(0, os.SEEK_END) <= 1024 * 1024:
                    continue
                log.seek(-200 * 1024, os.SEEK_END)
                tail = log.read()
                # Keep the inode: launchd has already opened the log for this run.
                log.seek(0)
                log.write(tail)
                log.truncate()
        except FileNotFoundError:
            continue


def tick_command(ns):
    if ns.install or ns.uninstall:
        return tick_agent(ns)
    home = Path.home()
    roots = ns.root or [Path(root) for root in CONFIG["tick_roots"]]
    plans = sorted({path.parent.resolve() for root in roots for path in root.expanduser().glob("*-core/plan.json")
                    if path.is_file() and (path.parent / "keymap.json").is_file()})
    state_path = home / ".local/state/work-graph/tick.json"
    state_path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(state_path.with_suffix(".lock"), os.O_CREAT | os.O_RDWR, 0o600)
    token = COMMAND_TIMEOUT.set(60)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("skipped: a tick is already running")
            return 0
        trim_tick_logs(home / "Library/Logs/wg-tick")
        state = json.loads(state_path.read_text()) if state_path.exists() else {}

        def save():
            save_json(state_path, state, mode=0o600)

        failed = False
        for path in plans:
            try:
                outcome = tick_effort(path, state, save, TICK_CHANNELS[ns.channel])
            except TICK_ERRORS as error:
                outcome = tick_error(error)
                state.setdefault("path-errors", {})[str(path)] = {"at": utc_now().isoformat(), "result": outcome}
                save()
            if not outcome.startswith("error:"):
                state.get("path-errors", {}).pop(str(path), None)
            failed |= outcome.startswith("error:")
            print(f"{path}: {' '.join(outcome.splitlines())}", flush=True)
        save()
        for workspace in tick_workspaces(plans):
            selected = LINEAR_WORKSPACE.set(workspace)
            try:
                archive_free()
            finally:
                LINEAR_WORKSPACE.reset(selected)
        return int(failed)
    finally:
        COMMAND_TIMEOUT.reset(token)
        os.close(fd)


def tick_workspaces(plans):
    """The workspaces of the loaded plans, for the archive step of Linear's Free plan."""
    found = set()
    for path in plans:
        try:
            found.add(plan_workspace(load_plan(path)))
        except (SystemExit, OSError, ValueError):
            continue
    return sorted(found)


def tick_agent(ns):
    home = Path.home()
    path = home / "Library/LaunchAgents" / (TICK_LABEL + ".plist")
    domain = f"gui/{os.getuid()}"
    if ns.uninstall:
        print(f"/bin/launchctl bootout {domain}/{TICK_LABEL}")
        path.unlink(missing_ok=True)
        return 0
    gh = shutil.which("gh")
    user = CONFIG["github_user"]  # config `github_user`: the gh login the scheduled job must use
    if not gh:
        raise ReadError("install gh and authenticate it" + (f" as {user}" if user else ""))
    gh = Path(gh).absolute()
    python = Path(sys.executable).absolute()
    token = COMMAND_TIMEOUT.set(60)
    try:
        auth = command("/usr/bin/env", "-u", "GH_TOKEN", "-u", "GITHUB_TOKEN", "-u", "GH_CONFIG_DIR",
                       "GH_PROMPT_DISABLED=1", str(gh), "api", "--hostname", "github.com", "user", "--jq", ".login")
    finally:
        COMMAND_TIMEOUT.reset(token)
    if auth.returncode or (user and auth.stdout.strip() != user):
        raise ReadError("authenticate gh" + (f" as {user}" if user else "") + " for the scheduled user"
                        + (f": {command_error(auth)}" if auth.returncode else ""))
    log = home / "Library/Logs/wg-tick"
    log.mkdir(parents=True, exist_ok=True)
    path.parent.mkdir(parents=True, exist_ok=True)
    args = [str(python), "-I", str(Path(__file__).resolve()), "tick"]
    path_dirs = dict.fromkeys([str(gh.parent), str(python.parent), "/usr/bin", "/bin", "/usr/sbin", "/sbin"])
    for root in ns.root or []:
        args.extend(["--root", str(root.expanduser().resolve())])
    path.write_bytes(plistlib.dumps({
        "Label": TICK_LABEL,
        "ProgramArguments": args,
        "RunAtLoad": True,
        "StartCalendarInterval": [{"Minute": minute} for minute in (0, 15, 30, 45)],
        "EnvironmentVariables": {"PATH": ":".join(path_dirs),
                                 "GH_PROMPT_DISABLED": "1"},
        "StandardOutPath": str(log / "out.log"),
        "StandardErrorPath": str(log / "error.log"),
    }))
    print("Put each Linear key in a private file (mode 600) in ~/.config/work-graph.")
    print("Name each file <workspace id>-linear-api-key: " + ", ".join(f"{w}-linear-api-key" for w in WORKSPACES) + ".")
    print(f"/bin/launchctl bootstrap {domain} {shlex.quote(str(path))}")
    return 0


# ---------------------------------------------------------------- worker jobs

JOBS = ("dispatch", "review", "ci", "threads", "restack")


def wg_command():
    return f"python3 -I {shlex.quote(str(Path(__file__).resolve()))}"


def spec_sections():
    text = (Path(__file__).resolve().parent.parent / "references" / "worker-spec.md").read_text()
    sections, name = {}, None
    for line in text.splitlines():
        if line.startswith("## "):
            name = line[3:].strip()
            sections[name] = []
        elif name:
            sections[name].append(line)
    return {name: "\n".join(body).strip() for name, body in sections.items()}


def render(text, values):
    for name, value in values.items():
        text = text.replace("{" + name + "}", str(value))
    missing = sorted(set(re.findall(r"\{[a-z_]+\}", text)))
    if missing:
        die("worker-spec.md: no value for " + ", ".join(missing))
    return text


def write_spec(plan_dir, name, text):
    path = Path(plan_dir).resolve() / "specs" / f"{name}.md"
    path.parent.mkdir(exist_ok=True)
    path.write_text(text + "\n")
    return path


def spec_values(plan_dir, plan, node, entry, issue, row):
    return {"identifier": entry["identifier"], "url": issue.get("url") or "no URL", "key": node["key"],
            "path": row.get("path", "-"), "branch": row["branch"], "parent": row["parent"], "lower": row["lower"],
            "pr": row.get("pr", "-"), "wg": wg_command(), "plan_dir": shlex.quote(str(Path(plan_dir).resolve())),
            "project": plan["effort"]["name"], "skill": str(Path(__file__).resolve().parent.parent)}


def claim_labels(issue):
    return [label for label in issue_labels(issue) if label["name"].startswith("agent:")]


def take_claim(plan, entry, issue, agent):
    """The only writer of a claim label. An issue holds one claim: one worker job that is not over."""
    held = claim_labels(issue)
    if held:
        die(f"{entry['identifier']}: {held[0]['name']} holds the claim; find its job with wg run show", 1)
    name = f"agent:{agent}"
    label_id = workspace_labels({name}).get(name) or team_info(plan_team(plan))[2].get(name)
    issue_update(entry["id"], {"addedLabelIds": [label_id or die(f"label {name} not found (wg preflight)")]})


def live_jobs(rows, key):
    return sorted(k for k, row in rows.items() if k != key and row.get("state") in LIVE)


def stale_push(nodes, rows, st, below, head_of):
    """True when the PR of the lane node below has a head that wg done did not check: its review is not known."""
    row = rows.get(below, {})
    if st.get(below) not in REVIEWING or not row.get("pr"):
        return False
    return head_of(row["pr"]) != row.get("code_done_head")


def refuse(ident, problems, what):
    print("\n".join(f"FAIL {problem}" for problem in problems))
    die(f"{ident}: {what}", 1)


def refresh_card(plan_dir, plan, key):
    """Copy the run row to the node card for `wg ui`. The row is the checkpoint: a failed copy does not fail it."""
    km = load_keymap(plan_dir)
    entry = km["nodes"].get(key)
    if not entry:
        return
    try:
        if sync_card(get_node(plan, key), entry, True, [], run_row(km, key)):
            save_keymap(plan_dir, km)
    except ReadError as e:
        print(f"node card not updated ({e}); the next 'wg load --apply' updates it", file=sys.stderr)


def start_project(plan_dir):
    """Move the Linear project to In Progress when its first worker starts. A failed move does not fail the dispatch.

    A private team has its own set of project statuses, so the In Progress of the set that holds the
    project's current status is the one to use (the statuses of one set have the same createdAt).
    """
    project_id = load_keymap(plan_dir)["project"]["id"]
    try:
        data = gql("""query($id:String!){ project(id:$id){ status{id type createdAt} }
                      projectStatuses{ nodes{ id name type createdAt } } }""", {"id": project_id})
        current = data["project"]["status"]
        if current["type"] not in ("backlog", "planned"):
            return
        started = [s for s in data["projectStatuses"]["nodes"] if s["type"] == "started" and s["name"] == "In Progress"]
        same_set = [s for s in started if s["createdAt"] == current["createdAt"]]
        target = (same_set or started or [None])[0]
        if not target:
            print("project status not updated (no In Progress project status)", file=sys.stderr)
            return
        result = gql("""mutation($id:String!,$s:String!){ projectUpdate(id:$id,input:{statusId:$s}){ success } }""",
                     {"id": project_id, "s": target["id"]})
        if result["projectUpdate"]["success"]:
            print("project status: In Progress")
    except ReadError as e:
        print(f"project status not updated ({e})", file=sys.stderr)


def branch_kind(plan_dir, node, target):
    """The row of ordering.md "Targets" that refreshes and pushes this node's branch."""
    if node.get("role") in ("hotfix", "sync"):
        return node["role"]
    if target.startswith("effort/"):
        return "integration"
    return "trunk" if target == stax_trunk(plan_dir) else "frozen"


def lane_stack(plan, node):
    """The name of the Orca worktree that a node's worktree nests under (ordering.md "Branches and worktrees")."""
    slug, phase = plan["effort"].get("slug") or die("effort.slug is missing in plan.json"), str(node["phase"])
    if node["kind"] == "spike":
        return f"{slug}-core"
    if node.get("role") == "sync":
        return f"{slug}-p{phase}-sync"
    return f"{slug}-{node['lane']}" if str(plan["phases"][0]["key"]) == phase else f"{slug}-p{phase}-{node['lane']}"


# ---------------------------------------------------------------- worktree cleanup


def orca_result(*args):
    result = command(orca_cli(), *args, "--json")
    if result.returncode != 0:
        raise ReadError(command_error(result))
    return json.loads(result.stdout)["result"]


def orca_worktrees():
    """Each Orca worktree on this machine, by id."""
    found = orca_result("worktree", "list", "--limit", "10000")
    if found.get("truncated"):
        raise ReadError("orca worktree list is truncated")
    return {w["id"]: w for w in found["worktrees"]}


def short_branch(ref):
    return (ref or "").removeprefix("refs/heads/")


def cleanup_worktrees(plan_dir, plan, keys=None, settled=None, dry_run=False):
    """Remove the Orca worktree of each Merged or Done node, then each lane parent whose lane is settled.

    `keys`: only these nodes (None: every node). `settled`: statuses just written, which Linear may not show yet.
    A worktree that is dirty or has a live job stays. A failure is a warning: it never fails the move.
    The branch stays (no --delete-branch): stax and the PR keep it. Returns the number of worktrees that stay."""
    if keys is not None:
        rows = run_rows(load_keymap(plan_dir))["nodes"]
        if not any((rows.get(k) or {}).get(f) for k in keys for f in ("worktree", "path")
                   if not (rows.get(k) or {}).get("worktree_removed")):
            return 0  # no worktree recorded for these nodes: no Orca call
    try:
        _, _, nodes, st, _, rows = snapshot(plan_dir, plan)
        st = dict(st) | dict(settled or {})
        trees = orca_worktrees()
    except (ReadError, OSError, subprocess.SubprocessError, ValueError, KeyError) as e:
        print(f"warning: worktree cleanup skipped: {e}", file=sys.stderr)
        return 1
    by_path = {w.get("path"): w for w in trees.values()}
    verb = "would remove" if dry_run else "removed"
    kept, removed = 0, {}

    def remove(tree, label):
        if dry_run:
            print(f"{verb} worktree {tree['path']} ({label})")
            return True
        try:
            orca_result("worktree", "rm", "--worktree", f"id:{tree['id']}")
        except (ReadError, OSError, subprocess.SubprocessError, ValueError, KeyError) as e:
            print(f"warning: {label}: worktree {tree['path']} stays: {e}", file=sys.stderr)
            return False
        print(f"{verb} worktree {tree['path']} ({label})")
        return True

    for key in sorted(nodes if keys is None else keys):
        row, node = rows.get(key) or {}, nodes.get(key)
        if not node or st.get(key) not in MERGED or row.get("worktree_removed"):
            continue
        tree = trees.get(row.get("worktree")) or by_path.get(row.get("path"))
        if not tree:
            if row.get("worktree") or row.get("path"):
                removed[key] = "gone"  # removed by hand: record it so later runs skip the row
            continue
        if tree.get("isMainWorktree") or Path(tree["path"]).resolve() == Path(plan_dir).resolve():
            continue  # never the repository checkout or the coordinator
        if row.get("state") in LIVE:
            print(f"warning: {key}: worktree {tree['path']} stays: a {row.get('job', '-')} job is live", file=sys.stderr)
            kept += 1
            continue
        dirty = command("git", "status", "--porcelain", cwd=tree["path"])
        if dirty.returncode or dirty.stdout.strip():
            why = "it has uncommitted changes" if not dirty.returncode else command_error(dirty)
            print(f"warning: {key}: worktree {tree['path']} stays: {why}", file=sys.stderr)
            kept += 1
            continue
        if remove(tree, key):
            removed[key] = utc_now().strftime("%Y-%m-%dT%H:%M:%SZ")
            trees.pop(tree["id"], None)
        else:
            kept += 1

    # A lane parent goes when every node of its lane is settled and Orca shows no child under it.
    slug = plan["effort"].get("slug")
    core = f"{slug}-core"
    lanes = {}
    for key, node in nodes.items():
        if slug and node["kind"] == "task" and node.get("role") != "integration":
            lanes.setdefault(lane_stack(plan, node), []).append(key)
    for stack, members in sorted(lanes.items()):
        if stack == core or (keys is not None and not set(members) & set(keys)):
            continue
        if any(st.get(k) not in SETTLED for k in members):
            continue
        parent = next((w for w in trees.values() if short_branch(w.get("branch")) == f"{BRANCH_PREFIX}{stack}"), None)
        if not parent or parent.get("isMainWorktree") or Path(parent["path"]).resolve() == Path(plan_dir).resolve():
            continue
        if [c for c in parent.get("childWorktreeIds") or [] if c in trees]:
            continue  # a child stays (dirty, live, or not settled): keep its parent
        if not remove(parent, f"lane {stack}"):
            kept += 1

    if removed and not dry_run:
        with plan_lock(plan_dir):
            km = load_keymap(plan_dir)
            for key, when in removed.items():
                run_rows(km)["nodes"].setdefault(key, {})["worktree_removed"] = when
            save_keymap(plan_dir, km)
    return kept


def cleanup_command(plan_dir, plan, dry_run):
    kept = cleanup_worktrees(plan_dir, plan, dry_run=dry_run)
    if kept:
        print(f"{kept} worktree(s) stay: see the warnings")
    return int(bool(kept))


def branch_plan(plan, key, nodes, deps, st, rows, recorded=None):
    """The names of a new node's worktree and branch, and the branch that it starts from (ordering.md).

    `recorded` is the run row of a claim that exists: its branch, parent, and lower stay as they are.
    """
    node = nodes[key]
    slug = plan["effort"].get("slug") or die("effort.slug is missing in plan.json")
    phase, target = str(node["phase"]), phase_of(plan, node)["target"]
    if node["kind"] == "spike":
        return {"stack": f"{slug}-core", "child": f"{slug}-spike-{key}", "branch": f"{BRANCH_PREFIX}{slug}-spike-{key}",
                "display": f"spike {key}", "lower": f"origin/{target}", "parent": target, "stax": False}
    stack = lane_stack(plan, node)
    if node.get("role") == "sync":
        return {"stack": stack, "child": f"{stack}-00-sync", "branch": f"sync/{slug}-p{phase}",
                "display": "00 sync", "lower": "origin/main", "parent": "main", "stax": False}
    below = cursor = lane_below(key, nodes, deps)
    index = 0
    while cursor:
        index, cursor = index + 1, lane_below(cursor, nodes, deps)
    names = {"stack": stack, "child": f"{stack}-{index:02d}-{key}", "display": f"{index:02d} {key}"}
    # effort.stacked_hotfix: HOTFIX nodes stack like any lane node (the bottom one starts from the release branch).
    if node.get("role") == "hotfix" and not plan["effort"].get("stacked_hotfix"):
        return names | {"branch": f"hotfix/{slug}-{key}", "lower": f"origin/{RELEASE_BRANCH}",
                        "parent": RELEASE_BRANCH, "stax": False}
    if recorded:
        return names | {"branch": recorded["branch"], "lower": recorded["lower"], "parent": recorded["parent"], "stax": True}
    if below is None or st.get(below) in MERGED:
        lower, parent = f"origin/{target}", target
    elif st.get(below) == "Canceled":
        die(f"{key}: {below} below it in the lane is Canceled (recovery.md Replan, Drop)", 1)
    else:
        lower = parent = rows.get(below, {}).get("branch") or die(f"{key}: {below} below it has no branch in its run row", 1)
    return names | {"branch": f"{BRANCH_PREFIX}{names['child']}", "lower": lower, "parent": parent, "stax": True}


def dispatch(plan_dir, plan, key, agent, worktree):
    """Start a node's first worker. First call: the claim and the Orca commands. With --worktree: the checks and the spec."""
    km, live, nodes, st, deps, rows = snapshot(plan_dir, plan)
    node = nodes.get(key) or die(f"unknown key {key}")
    entry = km["nodes"].get(key) or die(f"{key}: not loaded")
    ident, issue = entry["identifier"], live.get(entry["id"]) or die(f"{key}: issue not found")
    if node["kind"] not in ("task", "spike") or node.get("role") == "integration":
        die(f"{key}: only a task or a spike gets a worker (an integration node: ordering.md)")
    effort, row = run_rows(km)["effort"], rows.setdefault(key, {})
    mine = row.get("job") == "dispatch" and row.get("state") in ("creating", "starting")
    here = shlex.quote(str(Path(plan_dir).resolve()))
    if worktree:
        if not mine:
            die(f"{key}: run 'wg dispatch {plan_dir} {key}' first (state={row.get('state', '-')})", 1)
        path = Path(worktree).resolve()
        problems = worktree_problems(node, row, path)
        if problems:
            save_keymap(plan_dir, km)
            refuse(ident, problems, "no worker spec")
        row.update(state="starting", path=str(path))
        save_keymap(plan_dir, km)
        sections, values = spec_sections(), spec_values(plan_dir, plan, node, entry, issue, row)
        if node["kind"] == "spike":
            text = render(sections["spike"], values)
        else:
            kind = node.get("role") if node.get("role") in ("hotfix", "sync") else "lane"
            text = render(sections["task"], {"submit": sections[f"submit {kind}"]} | values)
        spec = shlex.quote(str(write_spec(plan_dir, key, text)))
        task_title = shlex.quote(f"{ident}: {node.get('title') or issue.get('title', key)}")
        print(f"spec {spec}\nRun these in order. Each <...> is an id from Orca's output:\n"
              f"  orca orchestration worker-start --spec-file {spec} --task-title {task_title} "
              f"--worktree id:<child-id> --agent {row.get('agent', agent)} --json\n"
              f"  {wg_command()} started {here} {key} dispatch=<dispatch_id> task=<task_id> "
              f"worktree=<worktree id> run_id=<run_id>")
        return 0
    # A retry prints the names of the claim, also when the node below merged or was canceled in between.
    names = branch_plan(plan, key, nodes, deps, st, rows, recorded=row if mine else None)
    if not mine:
        problems = []
        if node.get("branch") or node.get("pr"):
            problems.append(f"{key}: its branch or PR exists: adopt it (coordinator.md)")
        if row.get("state") or row.get("branch"):
            problems.append(f"{key}: the run row has state={row.get('state', '-')} branch={row.get('branch', '-')}")
        if st.get(key) not in ("Todo", "Ready"):
            problems.append(f"{key}: the status is {st.get(key)}, not Todo or Ready")
        blockers = open_blockers(key, nodes, deps, st, rows)
        if blockers:
            problems.append(f"{key}: open blockers: {', '.join(blockers)}")
        if key not in effort.get("wave", "").split(","):
            problems.append(f"{key}: not in the wave (wg run set {plan_dir} @effort wave=...)")
        below = lane_below(key, nodes, deps) if node["kind"] == "task" else None
        if below and stale_push(nodes, rows, st, below, lambda number: pr_view(number, "headRefOid", cwd=plan_dir).get("headRefOid")):
            problems.append(f"{key}: {below} below it has a push that is not code done (wg done)")
        if problems:
            refuse(ident, problems, "not dispatched")
        take_claim(plan, entry, issue, agent)
        row.update(state="creating", job="dispatch", agent=agent,
                   branch=names["branch"], parent=names["parent"], lower=names["lower"])
        save_keymap(plan_dir, km)
        print(f"claimed {ident} agent:{agent}")
        if st.get(key) != "In Progress":
            move(plan_dir, plan, key, "In Progress")
        refresh_card(plan_dir, plan, key)
        start_project(plan_dir)
    lane_base = names["lower"] if names["lower"].startswith("origin/") else f"origin/{phase_of(plan, node)['target']}"
    out = [f"branch {names['branch']} on {names['lower']}"
           + (f", stax parent {names['parent']}" if names["stax"] else ", not tracked by stax"),
           "Run these in order. Each <...> is an id or a path from Orca's output:",
           f"  orca worktree list --json    # find the parent worktree {names['stack']}"]
    core = f"{plan['effort']['slug']}-core"
    if names["stack"] != core:
        # A lane parent nests under the coordinator, so each effort is one tree in Orca (ordering.md).
        out[-1] += f" and the coordinator {core}"
        out.append(f"  orca worktree create --name {names['stack']} --branch {BRANCH_PREFIX}{names['stack']} "
                   f"--parent-worktree id:<core-id> --base-branch {lane_base} --setup skip --json"
                   f"    # only when {names['stack']} is missing")
    out += [f"  orca worktree create --name {names['child']} --branch {names['branch']} "
            f"--base-branch {names['lower']} --parent-worktree id:<parent-id> --setup run --json",
            f"  orca worktree set --worktree id:<child-id> --display-name {shlex.quote(names['display'])} --json"]
    if names["stax"]:
        out.append(f"  (cd \"<child-path>\" && st branch track --parent {shlex.quote(names['parent'])})")
    out.append(f"  {wg_command()} dispatch {here} {key} --worktree \"<child-path>\"")
    print("\n".join(out))
    return 0


def worktree_problems(node, row, path):
    """Why a worker must not start in this new worktree yet (an empty list: start it)."""
    key, problems = node["key"], []
    stax = node["kind"] == "task" and node.get("role") not in ("hotfix", "sync")
    try:
        branch = git_output("branch", "--show-current", cwd=path)
        head = git_output("rev-parse", "HEAD", cwd=path)
        dirty = git_output("status", "--porcelain", cwd=path)
    except (ReadError, OSError) as e:
        return [f"{key}: {path}: {e}"]
    if branch != row["branch"]:
        problems.append(f"{key}: the worktree is on {branch or 'a detached HEAD'}, not {row['branch']} "
                        "(Orca adds a number to a taken name)")
    if command("git", "merge-base", "--is-ancestor", row["lower"], "HEAD", cwd=path).returncode:
        problems.append(f"{key}: HEAD does not contain {row['lower']}")
    if dirty:
        problems.append(f"{key}: the new worktree is not clean: " + ", ".join(line[3:] for line in dirty.splitlines()[:5]))
    if stax and (branch_metadata(path, row["branch"]) or {}).get("parentBranchName") != row["parent"]:
        problems.append(f"{key}: stax does not track {row['branch']} on {row['parent']}: "
                        f"(cd {shlex.quote(str(path))} && st branch track --parent {shlex.quote(row['parent'])})")
    return problems


def restack_line(plan_dir, plan, node, row, nodes, deps, st):
    """The pinned target of a restack job. It refreshes a frozen base first."""
    target = phase_of(plan, node)["target"]
    kind = branch_kind(plan_dir, node, target)
    pin = RELEASE_BRANCH if kind in ("hotfix", "sync") else target
    if kind == "frozen":
        refresh_base(plan_dir, target)
        sha = git_output("rev-parse", target, cwd=plan_dir)
        if git_output("rev-parse", f"origin/{target}", cwd=plan_dir) != sha:
            raise ReadError(f"{target} and origin/{target} differ after the base refresh: ask {HUMAN}")
    else:
        git_output("fetch", "--no-tags", "--no-recurse-submodules", "origin",
                   f"+refs/heads/{pin}:refs/remotes/origin/{pin}", cwd=plan_dir)
        sha = git_output("rev-parse", f"origin/{pin}", cwd=plan_dir)
    below = lane_below(node["key"], nodes, deps)
    merged = bool(below) and st.get(below) in MERGED and row["parent"] != bottom_base(node, target)
    return f"target {pin} at {sha}; base: {kind}; parent merged: {'yes' if merged else 'no'}"


def claim(plan_dir, plan, key, job, agent):
    """Start a follow-up job on a node: the checks, the claim, the job header.

    The job `dispatch` continues a node that has a branch and no PR: an adopted node, or a first job that failed.
    """
    km, live, nodes, st, deps, rows = snapshot(plan_dir, plan)
    node = nodes.get(key) or die(f"unknown key {key}")
    entry = km["nodes"].get(key) or die(f"{key}: not loaded")
    ident, issue = entry["identifier"], live.get(entry["id"]) or die(f"{key}: issue not found")
    if node["kind"] != "task":
        die(f"{key}: wg claim is for a task")
    row = rows.setdefault(key, {})
    problems = [f"{key}: missing run field {field}" for field in ("branch", "parent", "lower") if not row.get(field)]
    if job != "dispatch" and not row.get("pr"):
        problems.append(f"{key}: no pr in the run row")
    if job == "dispatch" and row.get("pr"):
        problems.append(f"{key}: it has a PR; send a follow-up job (review, ci, threads, restack)")
    if row.get("state") in LIVE:
        problems.append(f"{key}: a job is live: state={row['state']} job={row.get('job', '-')}")
    running = live_jobs(rows, key)
    restacking = [k for k in running if rows[k].get("job") == "restack"]
    if job == "restack" and restacking:
        problems.append(f"one restack job at a time: {restacking[0]} is live")
    if problems:
        refuse(ident, problems, "not claimed")
    restack = restack_line(plan_dir, plan, node, row, nodes, deps, st) if job == "restack" else ""
    take_claim(plan, entry, issue, agent)
    row.update(state="starting", job=job, agent=agent)
    row.pop("started_at", None)
    if job == "review":  # the fix job replaces the reviewer of this round
        row.pop("review_dispatch", None)
        row.pop("review_patch", None)
    save_keymap(plan_dir, km)
    sections, values = spec_sections(), spec_values(plan_dir, plan, node, entry, issue, row)
    header = render(sections["job"], {"job": job, "restack": f"Restack: `{restack}`." if restack else ""} | values)
    fresh = not row.get("dispatch")
    if fresh:  # a new worker has no contract in its context
        kind = node.get("role") if node.get("role") in ("hotfix", "sync") else "lane"
        header = render(sections["task"], {"submit": sections[f"submit {kind}"]} | values) + "\n\n" + header
    spec = shlex.quote(str(write_spec(plan_dir, f"{key}-{job}", header)))
    here = shlex.quote(str(Path(plan_dir).resolve()))
    print(f"claimed {ident} agent:{agent} for job {job}")
    if restack:
        print(restack)
    print(f"spec {spec}    # add the work of this job at its end, then:")
    if fresh:
        task_title = shlex.quote(f"{ident}: {node.get('title') or issue.get('title', key)}")
        print(f"  orca orchestration worker-start --spec-file {spec} --task-title {task_title} "
              f"--worktree id:<child-id> --agent {agent} --json")
    else:
        subject = shlex.quote(f"{job}: #{row['pr']}" if row.get("pr") else f"{job}: {row['branch']}")
        print(f"  orca orchestration send --to dispatch:{row['dispatch']} --subject {subject} --body \"$(cat {spec})\"")
    print(f"  {wg_command()} started {here} {key} dispatch=<dispatch_id> task=<task_id>"
          + (" worktree=<worktree id> run_id=<run_id>" if fresh else ""))
    refresh_card(plan_dir, plan, key)
    return 0


def parse_fields(assignments):
    fields = {}
    for assignment in assignments:
        field, sep, value = assignment.partition("=")
        if not sep or not re.fullmatch(r"[a-z][a-z0-9_]*", field):
            die(f"invalid run field: {field}")
        fields[field] = value
    return fields


def started(plan_dir, plan, key, assignments):
    """The worker job started: record its Orca ids and comment the claim."""
    get_node(plan, key)
    km = load_keymap(plan_dir)
    entry = km["nodes"].get(key) or die(f"{key}: not loaded")
    run = run_rows(km)
    row = run["nodes"].setdefault(key, {})
    if row.get("state") != "starting":
        die(f"{key}: no job is starting (state={row.get('state', '-')}): use wg dispatch or wg claim first", 1)
    fields = parse_fields(assignments)
    if not fields.get("dispatch"):
        die("wg started needs dispatch=<id>")
    run_id = fields.pop("run_id", None)
    if run_id:
        run["effort"]["run_id"] = run_id
    row.update({field: value for field, value in fields.items() if value})
    row.update(state="running", started_at=utc_now().strftime("%Y-%m-%dT%H:%M:%SZ"))
    save_keymap(plan_dir, km)
    where = row.get("path") or row.get("worktree", "-")
    comment(entry["id"], f"Claimed: dispatch {row['dispatch']}, worktree {where}, job {row.get('job', 'dispatch')}")
    refresh_card(plan_dir, plan, key)
    print(" ".join(pairs(row)))
    return 0


def attach_pr(issue_id, pr, cwd):
    """Add the PR link if the issue does not already have it."""
    url = pr_view(pr, "url", cwd=cwd)["url"]
    after = None
    while True:
        page = gql("""query($id:String!,$after:String){ issue(id:$id){
                       attachments(first:50,after:$after){ nodes{url} pageInfo{hasNextPage endCursor} } } }""",
                   {"id": issue_id, "after": after})["issue"]["attachments"]
        if any(attachment["url"] == url for attachment in page["nodes"]):
            return
        if not page["pageInfo"]["hasNextPage"]:
            break
        after = page["pageInfo"]["endCursor"]

    try:
        result = gql("""mutation($id:String!,$url:String!){
                         attachmentLinkGitHubPR(issueId:$id,url:$url){ success } }""",
                     {"id": issue_id, "url": url})
        if result["attachmentLinkGitHubPR"]["success"]:
            return
    except ReadError:
        pass
    result = gql("""mutation($input:AttachmentCreateInput!){ attachmentCreate(input:$input){ success } }""",
                 {"input": {"issueId": issue_id, "title": f"PR #{pr}", "url": url}})
    if not result["attachmentCreate"]["success"]:
        raise ReadError("Linear did not create the attachment")


def done(plan_dir, plan, key, failed=None, worktree=None, dispatch_id=None):
    """A worker job on this node is over, or its PR head moved: release the claim, then check code done."""
    km, live, nodes, st, deps, rows = snapshot(plan_dir, plan)
    node = nodes.get(key) or die(f"unknown key {key}")
    entry = km["nodes"].get(key) or die(f"{key}: not loaded")
    ident, issue = entry["identifier"], live.get(entry["id"]) or die(f"{key}: issue not found")
    if node["kind"] not in ("task", "spike"):
        die(f"{key}: wg done is for a task or a spike")
    row = rows.setdefault(key, {})
    held = claim_labels(issue)
    if held and row.get("state") not in LIVE:
        die(f"{ident}: {held[0]['name']} has no job in the run row "
            "(recovery.md 'A claim label with no running job')", 1)
    # A late worker_done of an old dispatch must not end the job that runs now, as a success or as a failure.
    if dispatch_id and dispatch_id != row.get("dispatch"):
        die(f"{key}: this worker_done is from {dispatch_id}; the job in the run row is "
            f"{row.get('dispatch', 'not recorded')}. Record a lost receipt with wg started; ignore an old dispatch.", 1)
    if row.get("state") in LIVE and failed is None and not dispatch_id:
        die(f"{key}: a job is live (dispatch {row.get('dispatch', 'not recorded')}): "
            "pass --dispatch <id> of the worker_done, or --failed")
    if held:
        issue_update(entry["id"], {"removedLabelIds": [label["id"] for label in held]})
        print(f"released {held[0]['name']}")
    if failed is not None:
        row["state"] = "failed"
        save_keymap(plan_dir, km)
        comment(entry["id"], f"Job `{row.get('job', '-')}` failed: {failed.strip() or 'no error given'}")
        refresh_card(plan_dir, plan, key)
        print(f"{key}: state=failed")
        return 0
    row.pop("state", None)
    save_keymap(plan_dir, km)
    if node["kind"] == "spike":
        refresh_card(plan_dir, plan, key)
        return move(plan_dir, plan, key, "Done")
    for field in ("branch", "parent", "lower"):
        if not row.get(field):
            die(f"{key}: missing run field {field}")
    cwd = worktree or row.get("path") or row.get("worktree", "").partition("::")[2] or None
    if not row.get("pr"):
        result = command("gh", "pr", "list", "--head", row["branch"], "--state", "open", "--json", "number", cwd=cwd or plan_dir)
        if result.returncode:
            raise ReadError(command_error(result))
        found = json.loads(result.stdout or "[]")
        if len(found) != 1:
            print(f"FAIL pr: {len(found)} open PRs have the head {row['branch']}")
            refresh_card(plan_dir, plan, key)
            return 1
        row["pr"] = str(found[0]["number"])
    try:
        attach_pr(entry["id"], row["pr"], cwd or plan_dir)
    except (ReadError, OSError, ValueError, KeyError, TypeError) as e:
        print(f"Warning: could not attach PR #{row['pr']} to {ident}: {e}", file=sys.stderr)
    below, base = lane_below(key, nodes, deps), bottom_base(node, phase_of(plan, node)["target"])
    if below and st.get(below) in MERGED and row["parent"] != base:
        actual = pr_view(row["pr"], "baseRefName", cwd=cwd or plan_dir).get("baseRefName")
        if actual != base:
            save_keymap(plan_dir, km)
            print(f"FAIL pr: {below} below it merged, but the base of PR #{row['pr']} is {actual}, not {base}: restack it")
            if st.get(key) == "Ready to Merge":
                move(plan_dir, plan, key, "In Review")
            refresh_card(plan_dir, plan, key)
            return 1
        row["parent"], row["lower"] = base, f"origin/{base}"
        print(f"the PR below merged: parent {base}, lower origin/{base}")
    save_keymap(plan_dir, km)
    result = verify(plan_dir, plan, key, cwd=cwd)
    status, row = st.get(key), run_row(load_keymap(plan_dir), key)
    if not result and status in ("Todo", "Ready", "In Progress"):
        move(plan_dir, plan, key, "In Review")
    elif status == "Ready to Merge" and (result or not merge_reviewed(row, row.get("code_done_head"), issue)):
        move(plan_dir, plan, key, "In Review")  # this head has no merge review: it leaves the merge queue
    refresh_card(plan_dir, plan, key)
    return result


def approve(plan_dir, plan, keys, quote):
    """Record the human's approval with their own words. A goal, a hook, or silence is never an approval."""
    quote = " ".join(quote.split())
    if len(quote) < 2:
        die(f"--quote needs {HUMAN}'s own words")
    value = f"{utc_now():%Y-%m-%d}: {quote}"
    km = load_keymap(plan_dir)
    if any(k.startswith("@") for k in keys):
        die("wg approve takes node keys; no gate waits for an approval of the effort", 1)
    entries = [(get_node(plan, k), km["nodes"].get(k) or die(f"{k}: not loaded")) for k in keys]
    live = fetch_nodes({"nodes": {node["key"]: entry for node, entry in entries}})
    for node, entry in entries:
        run_rows(km)["nodes"].setdefault(node["key"], {})["approved"] = value
        save_keymap(plan_dir, km)
        comment(entry["id"], f'**wg approve** {HUMAN}, {value[:10]}. Their words: "{quote}"')
        print(f"approved {node['key']} {entry['identifier']}")
        issue = live.get(entry["id"])
        if issue and norm(issue["state"], issue_labels(issue)) == WAIT_STATUS:
            move(plan_dir, plan, node["key"], "Todo")
    sync_ready(plan_dir, plan)
    return 0


def ui_running(port):
    """Does this port already serve the page? Its health check says so."""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/healthz", timeout=2) as response:
            return json.load(response) == {"ok": True}
    except (OSError, ValueError):
        return False


def ui_needs_install(root):
    """pnpm writes node_modules/.modules.yaml at each install. A newer lockfile needs a new install."""
    marker = root / "node_modules" / ".modules.yaml"
    return not marker.exists() or marker.stat().st_mtime < (root / "pnpm-lock.yaml").stat().st_mtime


def ui_repo_root():
    """The repository root: wg.py is skills/work-graph/scripts/wg.py in it. Symlinks resolve to the checkout."""
    return Path(__file__).resolve().parents[3]


def ui(port, project, no_open, no_tailnet=False, workspace=DEFAULT_WORKSPACE_ID):
    """Build the web app when its sources are newer than the build, then run its server.

    The app is the root of the repository that holds this skill (skills/work-graph/scripts/wg.py), or
    `WG_UI_DIR`. The server also puts the page on the tailnet through Tailscale Serve while it runs.
    `no_tailnet` keeps the page on this machine.
    """
    root = Path(os.environ.get("WG_UI_DIR") or ui_repo_root()).expanduser()
    if not (root / "server" / "main.ts").exists():
        die(f"no work-graph page at {root}: run wg from a checkout of the work-graph repository "
            "(or set WG_UI_DIR)")
    if ui_running(port):
        # A second server cannot take the port. The page that runs is the page that was asked for.
        params = {"project": project} if project else {}
        if project and workspace != DEFAULT_WORKSPACE_ID:
            params["workspace"] = workspace
        url = f"http://127.0.0.1:{port}/" + ("?" + urllib.parse.urlencode(params, quote_via=urllib.parse.quote) if params else "")
        print(f"work-graph UI already runs: {url}")
        if not no_open:
            subprocess.run(["open" if sys.platform == "darwin" else "xdg-open", url], check=False)
        return 0
    linear_key(workspace)
    if ui_needs_install(root):
        subprocess.run(["pnpm", "install", "--frozen-lockfile"], cwd=root, check=True)
    built = root / "dist" / "index.html"
    sources = [root / name for name in ("index.html", "package.json", "pnpm-lock.yaml", "vite.config.ts", "tsconfig.json")]
    sources = [p for p in sources if p.exists()] + list((root / "src").rglob("*"))
    if not built.exists() or built.stat().st_mtime < max(p.stat().st_mtime for p in sources):
        subprocess.run(["pnpm", "build"], cwd=root, check=True)
    args = ["node", str(root / "server" / "main.ts"), "--port", str(port)]
    if project:
        args += ["--project", project]
    args += ["--workspace", workspace]
    if no_open:
        args.append("--no-open")
    if no_tailnet:
        args.append("--no-tailnet")
    try:
        return subprocess.run(args, cwd=root).returncode
    except KeyboardInterrupt:
        return 0


def cli_parser():
    parser = argparse.ArgumentParser(description="Validate and manage a work-graph effort.")
    sub = parser.add_subparsers(dest="cmd", required=True)

    def add(group, name):
        p = group.add_parser(name)
        p.add_argument("dir")
        return p

    add(sub, "check")
    for name in ("preflight", "base", "status"):
        add(sub, name).add_argument("--phase")
    load_parser = add(sub, "load")
    load_parser.add_argument("--apply", action="store_true")
    load_parser.add_argument("--prune", action="store_true")
    load_parser.add_argument("--adopt", action="store_true")
    add(sub, "ready").add_argument("--apply", action="store_true")
    for name in ("next", "watch"):  # watch is the old name; a session with the old text still calls it
        n = add(sub, name)
        n.add_argument("--wait", action="store_true")
        n.add_argument("--interval", type=float, default=300)
        n.add_argument("--no-publish", action="store_true", help="do not copy the result to Linear for the page")
    add(sub, "wake")
    auto = add(sub, "autostart")
    auto_mode = auto.add_mutually_exclusive_group()
    auto_mode.add_argument("--install", action="store_true")
    auto_mode.add_argument("--uninstall", action="store_true")
    a = add(sub, "approve")
    a.add_argument("keys", nargs="+")
    a.add_argument("--quote", required=True)
    d = add(sub, "dispatch")
    d.add_argument("key")
    d.add_argument("--agent", choices=("codex", "claude"), default="codex")
    d.add_argument("--worktree")
    c = add(sub, "claim")
    c.add_argument("key")
    c.add_argument("job", choices=JOBS)
    c.add_argument("--agent", choices=("codex", "claude"), default="codex")
    s = add(sub, "started")
    s.add_argument("key")
    s.add_argument("fields", nargs="+")
    f = add(sub, "done")
    f.add_argument("key")
    f.add_argument("--dispatch", metavar="ID")
    f.add_argument("--failed", metavar="ERROR")
    f.add_argument("--worktree")
    m = add(sub, "move")
    m.add_argument("key")
    m.add_argument("status")
    m.add_argument("--note")
    m.add_argument("--force", metavar="REASON")
    m.add_argument("--keep-worktree", action="store_true", help="at Merged or Done, keep the node's Orca worktree")
    add(sub, "cleanup").add_argument("--dry-run", action="store_true")
    add(sub, "archive").add_argument("--apply", action="store_true")
    r = sub.add_parser("run").add_subparsers(dest="mode", required=True)
    r_set = add(r, "set")
    r_set.add_argument("key")
    r_set.add_argument("fields", nargs="+")
    r_show = add(r, "show")
    r_show.add_argument("key", nargs="?")
    r_show.add_argument("--json", action="store_true")
    add(r, "reset").add_argument("key")
    add(sub, "evidence").add_argument("key")
    add(sub, "autonomy").add_argument("level", nargs="?", choices=AUTONOMY_LEVELS)
    add(sub, "verify").add_argument("key")
    o = sub.add_parser("owns").add_subparsers(dest="mode", required=True)
    add(o, "overlap").add_argument("keys", nargs="+")
    o_diff = add(o, "diff")
    o_diff.add_argument("key")
    o_diff.add_argument("base")
    sub.add_parser("config", help="print the config of this machine (no keys) and the local rules file")
    c = sub.add_parser("contract", help="print what the page must agree with; --write updates contract.json")
    c.add_argument("--write", action="store_true")
    tick_parser = sub.add_parser("tick", help="refresh the page for each loaded effort")
    tick_parser.add_argument("--root", action="append", type=Path)
    tick_parser.add_argument("--channel", choices=TICK_CHANNELS, default="none")
    mode = tick_parser.add_mutually_exclusive_group()
    mode.add_argument("--install", action="store_true")
    mode.add_argument("--uninstall", action="store_true")
    u = sub.add_parser("ui")
    u.add_argument("--workspace", choices=tuple(WORKSPACES), default=DEFAULT_WORKSPACE_ID)
    u.add_argument("--port", type=int, default=4747)
    u.add_argument("--project")
    u.add_argument("--no-open", action="store_true")
    u.add_argument("--no-tailnet", action="store_true", help="keep the page on this machine; the default also serves it on the tailnet")
    return parser


# Commands that change keymap.json. One of them runs at a time (plan_lock).
KEYMAP_WRITERS = {"load", "verify", "approve", "dispatch", "claim", "started", "done"}


def run_command(ns, d, plan, given):
    if ns.cmd == "check":
        errs = check(plan)
        for e in errs:
            print(e)
        return int(bool(errs))
    if ns.cmd == "load":
        return load(d, plan, ns.apply, ns.prune, ns.adopt)
    if ns.cmd == "preflight":
        return preflight(d, plan, ns.phase)
    if ns.cmd == "base":
        return base(d, plan, ns.phase)
    if ns.cmd == "ready":
        return ready(d, plan, ns.apply)
    if ns.cmd == "status":
        return status(d, plan, ns.phase)
    if ns.cmd in ("next", "watch"):
        if ns.interval <= 0 or not math.isfinite(ns.interval):
            die("--interval must be a positive number of seconds")
        if ns.cmd == "watch":
            print("wg watch is now wg next: load the work-graph skill again and read coordinator.md \"Loop\"",
                  file=sys.stderr)
        return next_command(d, plan, ns.wait, ns.interval, copy=not ns.no_publish)
    if ns.cmd == "wake":
        return wake_command(d, plan)
    if ns.cmd == "autostart":
        return autostart_command(d, plan, ns.install, ns.uninstall)
    if ns.cmd == "approve":
        return approve(d, plan, ns.keys, ns.quote)
    if ns.cmd == "dispatch":
        return dispatch(d, plan, ns.key, ns.agent, ns.worktree)
    if ns.cmd == "claim":
        return claim(d, plan, ns.key, ns.job, ns.agent)
    if ns.cmd == "started":
        return started(d, plan, ns.key, ns.fields)
    if ns.cmd == "done":
        return done(d, plan, ns.key, ns.failed, ns.worktree, ns.dispatch)
    if ns.cmd == "move":
        return move(d, plan, ns.key, ns.status, ns.note, ns.force, ns.keep_worktree)
    if ns.cmd == "cleanup":
        return cleanup_command(d, plan, ns.dry_run)
    if ns.cmd == "archive":
        if not free_plan():
            print("no archive: the workspace has a paid Linear plan")
            return 0
        if not archive_free(ns.apply):
            print("no completed or canceled issue to archive")
        return 0
    if ns.cmd == "run":
        if ns.mode == "set":
            return run_set(d, plan, ns.key, ns.fields)
        if ns.mode == "reset":
            return run_reset(d, plan, ns.key)
        return run_show(d, plan, ns.key, ns.json)
    if ns.cmd == "evidence":
        return evidence(d, plan, ns.key, given)
    if ns.cmd == "autonomy":
        return autonomy_command(d, plan, ns.level)
    if ns.cmd == "verify":
        return verify(d, plan, ns.key)
    if ns.mode == "overlap":
        return owns(plan, ["overlap", *ns.keys])
    return owns(plan, ["diff", ns.key, ns.base])


def main(argv):
    args = argv[1:]
    given = []  # the old call form names the test command after "--"; it must be the effort's command
    if args and args[0] == "evidence" and "--" in args:
        split = args.index("--")
        args, given = args[:split], args[split + 1:]
    ns = cli_parser().parse_args(args)
    try:
        if ns.cmd == "config":
            return show_config()
        if ns.cmd == "contract":
            if ns.write:
                (Path(__file__).resolve().parent.parent / "contract.json").write_text(contract_text())
            else:
                sys.stdout.write(contract_text())
            return 0
        if ns.cmd == "tick":
            return tick_command(ns)
        if ns.cmd == "ui":
            return ui(ns.port, ns.project, ns.no_open, ns.no_tailnet, ns.workspace)
        plan = load_plan(ns.dir)
        writes = ns.cmd in KEYMAP_WRITERS or (ns.cmd == "run" and ns.mode in ("set", "reset"))
        token = LINEAR_WORKSPACE.set(plan_workspace(plan))
        try:
            with plan_lock(ns.dir) if writes else contextlib.nullcontext():
                return run_command(ns, ns.dir, plan, given)
        finally:
            flush_writes(ns.dir, plan)
            LINEAR_WORKSPACE.reset(token)
    except (ReadError, OSError, ValueError, subprocess.SubprocessError) as e:
        die(str(e))


if __name__ == "__main__":
    sys.exit(main(sys.argv))
