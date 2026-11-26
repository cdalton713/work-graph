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
  wg share     <dir>
  wg pull      <dir> [--force] [--accept-settings]
  wg ready     <dir> [--apply]
  wg status    <dir> [--phase P]
  wg next      <dir> [--wait] [--interval <seconds>] [--no-publish]
  wg approve   <dir> <key>... --quote "<the human's words>"
  wg dispatch  <dir> <key> [--agent codex|claude] [--model <id>] [--effort <level>] [--run | --worktree <path>]
  wg claim     <dir> <key> <dispatch|review|ci|threads|restack> [--agent codex|claude] [--model <id>]
               [--effort <level>] [--send] [--work-file <file>]
  wg started   <dir> <key> dispatch=<id> [<field>=<value>...]
  wg done      <dir> <key> [--dispatch <id>] [--failed "<error>"] [--worktree <path>]
  wg move      <dir> <key> <status> [--note "<text>"] [--force "<reason>"]
  wg archive   <dir> [--apply]      (Linear Free plan: archive completed and canceled issues)
  wg run set   <dir> <key|@effort> <field>=<value>...
  wg run show  <dir> [<key>|@effort] [--json]
  wg run reset <dir> <key>
  wg usage     <dir> [--json] [--since <time>] [--all]
  wg evidence  <dir> <key|@full-PHASE>
  wg verify    <dir> <key>
  wg owns overlap <dir> <key>...
  wg owns diff    <dir> <key> <base>
  wg tick      [--root <dir>]... [--channel none|notify] [--install | --uninstall]
  wg wake      <dir>
  wg autostart <dir> [--install | --uninstall]
  wg health    <dir> [--install | --uninstall | --due | --report <file>]
  wg doctor    [<dir>]
  wg login     [<page-url>] [--workspace <id>] [--token-stdin]
  wg logout    [<page-url>]
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
import getpass
import hashlib
import http.client
import io
import ipaddress
import json
import math
import os
import plistlib
import random
import re
import shlex
import shutil
import ssl
import stat
import subprocess
import sys
import tempfile
import time
import tomllib
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import warnings
from collections import Counter
from datetime import date as datetime_date, datetime, time as datetime_time, timezone
from pathlib import Path

# ---------------------------------------------------------------- config

# The local config of this machine (README "Config"). No file: one Linear workspace with LINEAR_API_KEY, the
# human "Human", no hosted page, and no default test runner.
CONFIG_PATH = Path(os.environ.get("WG_CONFIG") or Path.home() / ".config/work-graph/config.json").expanduser()
# Claude Code does not take an auto-compact window below this many tokens.
CONTEXT_LIMIT_MIN = 100000
DEFAULT_WORKSPACE = {"id": "default", "name": "Linear", "team": None, "teams": None,
                     "key_env": ["LINEAR_API_KEY"], "team_labels": True}
DEFAULT_CONFIG = {"human": "Human", "page_url": None, "github_user": None, "tick_roots": ["~/Projects"],
                  "tick_label": "dev.work-graph.tick", "test_runner": None, "branch_prefix": "wg/",
                  "release_branch": "release", "rules": "~/.config/work-graph/rules.md",
                  "notify": [], "agent_replies": False, "agent_merge": [], "health_interval": 6, "health_agent": "codex",
                  "worker_settings": {}, "coordinator_settings": {}, "context_limit": 250000, "workspaces": [DEFAULT_WORKSPACE]}
# The session settings file of each agent in a worker worktree (config worker_settings). wg dispatch merges the
# values of the worker's agent into this file before the worker starts.
WORKER_SETTINGS_FILES = {"claude": ".claude/settings.local.json", "codex": ".codex/config.toml"}


AGENT_FIELDS = ("agent", "model", "effort")
AGENT_DEFAULTS = {"coordinator": {}, "worker": {"agent": "codex"}}


def safe_agent_value(value):
    return (isinstance(value, str) and bool(value) and value.isprintable()
            and not value.startswith("-") and not any(char.isspace() for char in value))


def merge_agent_settings(lower, higher):
    if lower.get("agent") and higher.get("agent", lower["agent"]) != lower["agent"]:
        return dict(higher)
    return lower | higher


def agent_setting_errors(settings, field, inherited):
    if not isinstance(settings, dict):
        return [f"{field}: must be an object"]
    errors = []
    for role, values in settings.items():
        path = f"{field}.{role}"
        if role not in AGENT_DEFAULTS:
            errors.append(f"{path}: unknown role")
        elif not isinstance(values, dict):
            errors.append(f"{path}: must be an object")
        else:
            for key, value in values.items():
                if key not in AGENT_FIELDS:
                    errors.append(f"{path}.{key}: unknown field")
                elif key == "agent" and value not in ("claude", "codex"):
                    errors.append(f"{path}.agent: must be claude or codex")
                elif key != "agent" and not safe_agent_value(value):
                    errors.append(f"{path}.{key}: must be nonempty text with no leading dash, spaces, or control characters")
            resolved = merge_agent_settings(AGENT_DEFAULTS[role] | inherited.get(role, {}), values)
            if resolved.get("effort") and not resolved.get("model"):
                errors.append(f"{path}.effort: needs a model")
    return errors


def resolve_agent(plan, role, agent=None, model=None, effort=None, row=None):
    if row and any(row.get(field) for field in ("dispatch", *AGENT_FIELDS)):
        settings = AGENT_DEFAULTS[role] | {field: row[field] for field in AGENT_FIELDS if field in row}
    else:
        settings = AGENT_DEFAULTS[role] | CONFIG.get("agents", {}).get(role, {})
        settings = merge_agent_settings(settings, plan.get("effort", {}).get("agents", {}).get(role, {}))
    flags = {field: value for field, value in zip(AGENT_FIELDS, (agent, model, effort)) if value is not None}
    settings = merge_agent_settings(settings, flags)
    for field in ("model", "effort"):
        if field in settings and not safe_agent_value(settings[field]):
            die(f"agents.{role}.{field}: must be nonempty text with no leading dash, spaces, or control characters")
    if settings.get("effort") and not settings.get("model"):
        die(f"agents.{role}.effort: needs a model")
    return settings


def model_args(settings):
    for field in ("model", "effort"):
        if field in settings and not safe_agent_value(settings[field]):
            die(f"{field}: must be nonempty text with no leading dash, spaces, or control characters")
    return [arg for field in ("model", "effort") if settings.get(field)
            for arg in (f"--{field}", settings[field])]


def automation_model_args(agent, settings):
    if agent == "codex" and settings.get("effort"):
        return shlex.join(["--model", settings["model"], "-c", f"model_reasoning_effort={settings['effort']}"])
    return shlex.join(model_args(settings))


def printed_model_args(settings):
    args = model_args(settings)
    return f" {shlex.join(args)}" if args else ""


def read_config(path=CONFIG_PATH):
    try:
        data = json.loads(Path(path).read_text())
    except FileNotFoundError:
        data = {}
    if not isinstance(data, dict):
        raise SystemExit(f"{path}: the config must be a JSON object")
    if errors := agent_setting_errors(data.get("agents", {}), "agents", {}):
        raise SystemExit(f"{path}: " + "; ".join(errors))
    if "agent_replies" in data and type(data["agent_replies"]) is not bool:
        raise SystemExit(f"{path}: agent_replies must be true or false")
    config = DEFAULT_CONFIG | data
    workspaces = [DEFAULT_WORKSPACE | w for w in config["workspaces"]] or [DEFAULT_WORKSPACE]
    ids = [w["id"] for w in workspaces]
    if len(set(ids)) != len(ids) or not all(isinstance(i, str) and re.fullmatch(r"[a-z0-9-]+", i) for i in ids):
        raise SystemExit(f"{path}: each workspace needs a unique id of a-z, 0-9 and -")
    pages = [("page_url", data)] + [(f"workspaces[{i}].page_url", w) for i, w in enumerate(workspaces)]
    for field, source in pages:
        url = source.get("page_url")
        if url is not None and (not isinstance(url, str) or not url.startswith(("http://", "https://"))):
            raise SystemExit(f"{path}: {field} must start with http:// or https://")
    if not isinstance(config["human"], str) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9 ]*", config["human"]):
        raise SystemExit(f"{path}: human must be a name of letters, digits and spaces")
    merge = config["agent_merge"]
    if not isinstance(merge, list) or not all(isinstance(m, str) and re.fullmatch(r"[\w.-]+(/[\w.-]+)?", m)
                                               for m in merge):
        raise SystemExit(f"{path}: agent_merge must be a list of GitHub owners or owner/repo names")
    interval = config["health_interval"]
    if isinstance(interval, bool) or not isinstance(interval, (int, float)) or not 1 <= interval <= 168:
        raise SystemExit(f"{path}: health_interval must be a number of hours from 1 to 168")
    if not isinstance(config["health_agent"], str) or not re.fullmatch(r"[a-z0-9-]+", config["health_agent"]):
        raise SystemExit(f"{path}: health_agent must be an Orca agent id, such as codex or claude")
    for key in ("worker_settings", "coordinator_settings"):
        settings = config[key]
        if not isinstance(settings, dict) or not all(a in WORKER_SETTINGS_FILES and isinstance(v, dict)
                                                     for a, v in settings.items()):
            raise SystemExit(f"{path}: {key} must map {' or '.join(WORKER_SETTINGS_FILES)} to a JSON object")
    limit = config["context_limit"]
    if isinstance(limit, bool) or not isinstance(limit, int) or (limit and limit < CONTEXT_LIMIT_MIN):
        raise SystemExit(f"{path}: context_limit must be 0 (off) or a token count of {CONTEXT_LIMIT_MIN} or more")
    if problem := notify_problem(config["notify"]):
        raise SystemExit(f"{path}: notify: {problem}")
    return config | {"workspaces": workspaces}


def notify_problem(channels):
    """What is wrong with the config field `notify`, or None. A webhook names where its URL is, never the URL."""
    if not isinstance(channels, list):
        return "must be a list of channels"
    for i, channel in enumerate(channels):
        kind = channel.get("type") if isinstance(channel, dict) else None
        if kind == "webhook":
            names = [channel.get(f) for f in ("url_env", "url_file") if f in channel]
            if "url" in channel or not names or not all(isinstance(n, str) and n for n in names):
                return f"channel {i}: a webhook needs url_env or url_file (the URL never goes in the config)"
        elif kind == "page":
            if channel.keys() - {"type", "to"}:
                return f"channel {i}: a page channel takes only type and an optional to"
            if "to" in channel and (not isinstance(channel["to"], str) or not channel["to"].strip()):
                return f"channel {i}: to must name an owner email"
        elif kind == "command":
            argv = channel.get("argv")
            if not isinstance(argv, list) or not argv or not all(isinstance(a, str) and a for a in argv):
                return f"channel {i}: a command needs argv, a list of strings"
        else:
            return f"channel {i}: type must be page, webhook or command"
    return None


CONFIG = read_config()
HUMAN = CONFIG["human"]  # the person who answers, merges and deploys; "wait human" lines wait on this person
WORKSPACES = {w["id"]: w for w in CONFIG["workspaces"]}
DEFAULT_WORKSPACE_ID = CONFIG["workspaces"][0]["id"]  # a plan with no effort.workspace uses the first one
BRANCH_PREFIX = CONFIG["branch_prefix"]  # the prefix of each branch that wg names: <prefix><slug>-core
# The release branch of the HOTFIX and SYNC flow (references/ordering.md): a phase with this target takes
# HOTFIX PRs into it and one SYNC PR from it back to main.
RELEASE_BRANCH = CONFIG["release_branch"]


def show_config(plan=None):
    """`wg config`: the config that wg uses, with where it came from, and whether the rules file exists.
    A key is never in the config, so nothing secret prints."""
    rules = Path(CONFIG["rules"]).expanduser()
    print(json.dumps({"path": str(CONFIG_PATH), "exists": CONFIG_PATH.exists(), "rules": str(rules),
                      "rules_exist": rules.exists(), "wait_status": WAIT_STATUS, "wait_label": WAIT_LABEL,
                      "config": CONFIG,
                      "agents": {role: resolve_agent(plan or {}, role) for role in AGENT_DEFAULTS}}, indent=2))
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


def setup_status_types(wait_status=None):
    return {
        "Triage": "triage", "Backlog": "backlog", "Todo": "unstarted", "Ready": "unstarted",
        "In Progress": "started", (wait_status or WAIT_STATUS): "started", "In Review": "started",
        "Ready to Merge": "started", "Merged": "started", "Verifying": "started",
        "Done": "completed", "Canceled": "canceled", "Duplicate": "duplicate",
    }


CD_STATUSES = setup_status_types().keys() - {"Duplicate"}
AGENT_LABELS = ("agent:codex", "agent:claude", "agent:coordinator")
WAIT_LABEL = f"needs-{human_slug(HUMAN)}"
MERGE_LABEL = "ready-to-merge"
# An ENG workflow has no twin for these statuses. A workspace label marks them on an ENG ticket.
ENG_LABELS = {WAIT_STATUS: WAIT_LABEL, "Ready to Merge": MERGE_LABEL}
REVIEW_OK = {"clean", "accepted"}
MAX_THOROUGH = 2  # thorough reviews of one PR; the second only when a fix needs it
INITIATIVE_GROUP = "initiative"  # the team's single-select project label group; each child label is one initiative
# The autonomy level of each effort (references/autonomy.md): one child label of the single-select project label
# group `autonomy`. No label means AUTONOMY_DEFAULT. The human changes it on the page at any time.
AUTONOMY_GROUP = "autonomy"
AUTONOMY_LEVELS = ("full", "standard", "supervised")
AUTONOMY_DEFAULT = "standard"
# The review effort of each effort (references/review-and-merge.md "Review effort"): one child label of the
# single-select project label group `review`, set and read as the autonomy level is. No label means REVIEW_DEFAULT.
REVIEW_GROUP = "review"
REVIEW_LEVELS = ("thorough", "standard", "light")
REVIEW_DEFAULT = "thorough"
# A workspace has one project label for each name, also in two groups, and the group `autonomy` has `standard`:
# the child labels are `review:<level>`, as the claim labels are `agent:<name>`.
REVIEW_PREFIX = "review:"
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
    try:
        collab = load_keymap(plan_dir).get("collab", {})
    except ValueError:
        collab = {}
    return local_plan(plan, collab)


def normalize_plan(plan):
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


def key_env_name(workspace):
    return f"LINEAR_{workspace.upper().replace('-', '_')}_API_KEY"


def key_source(workspace):
    """The workspace's Linear key and where it came from: the name of its environment variable, or the Path of
    its key file. ("", None) when there is no key."""
    for name in (key_env_name(workspace), *WORKSPACES.get(workspace, DEFAULT_WORKSPACE)["key_env"]):
        if key := os.environ.get(name, "").strip():
            return key, name
    path = Path.home() / f".config/work-graph/{workspace}-linear-api-key"
    if path.exists() and (key := path.read_text().strip()):
        return key, path
    return "", None


def linear_key(workspace=None):
    """The key from LINEAR_<ID>_API_KEY, the workspace's `key_env` names, or ~/.config/work-graph/<id>-linear-api-key."""
    if workspace is None:
        workspace = LINEAR_WORKSPACE.get()
    key, source = key_source(workspace)
    if isinstance(source, Path) and source.stat().st_mode & 0o044:
        print(f"warn: {source} is readable by group or others; set mode 600", file=sys.stderr)
    if not key:
        raise ReadError(f"no Linear key for {workspace}: set {key_env_name(workspace)}")
    return key


def keymap_path(plan_dir):
    return Path(plan_dir) / "keymap.json"


def load_keymap(plan_dir):
    p = keymap_path(plan_dir)
    km = json.loads(p.read_text()) if p.exists() and p.stat().st_size else {}
    km.setdefault("milestones", {})
    km.setdefault("nodes", {})
    return km


def save_keymap(plan_dir, km, *, sync=True):
    p = keymap_path(plan_dir)
    try:
        before = json.loads(p.read_text()) if p.exists() and p.stat().st_size else {}
    except (OSError, ValueError):
        before = None  # a damaged file: its rows are not known, so no change can be journaled
    pending = False
    if sync and before and before.get("collab") and km.get("collab"):
        share_branch_and_pr(before, km)
        old = shared_keymap(before)
        if old != shared_keymap(km):
            km["collab"].setdefault("pending", old)
            pending = True
    save_json(p, km)
    if before is not None:
        journal_keymap(plan_dir, before, km)
    if pending:
        publish_pending_keymap(plan_dir, km)


_HELD_LOCKS = contextvars.ContextVar("wg_held_locks", default=frozenset())


@contextlib.contextmanager
def plan_lock(plan_dir, wait=None):
    """One writer of keymap.json at a time. Without it, two parallel commands lose a run row.

    Reentrant in one context: `wg done` holds it and calls `move`, which cleans up the worktree under it.
    With `wait` (seconds), a lock that another process holds longer raises TimeoutError."""
    key = os.path.realpath(plan_dir)
    held = _HELD_LOCKS.get()
    if key in held:
        yield
        return
    fd = os.open(plan_dir, os.O_RDONLY)
    token = None
    try:
        if wait is None:
            fcntl.flock(fd, fcntl.LOCK_EX)
        else:
            end = time.monotonic() + wait
            while True:
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= end:
                        raise TimeoutError(f"the plan lock is held for more than {wait:g}s")
                    time.sleep(0.05)
        token = _HELD_LOCKS.set(held | {key})
        yield
    finally:
        if token is not None:
            _HELD_LOCKS.reset(token)
        os.close(fd)


@contextlib.contextmanager
def atomic_text_file(path, mode=None):
    if mode is None:
        try:
            mode = stat.S_IMODE(path.stat().st_mode)
        except FileNotFoundError:
            mode = 0o644
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as f:
        tmp = Path(f.name)
        try:
            yield f
            f.close()
            tmp.chmod(mode)
            tmp.replace(path)
        finally:
            tmp.unlink(missing_ok=True)


def save_json(path, value, mode=None):
    with atomic_text_file(path, mode) as file:
        json.dump(value, file, indent=2)
        file.write("\n")


# ---------------------------------------------------------------- journal

JOURNAL = "journal.jsonl"
JOURNAL_OLD = "journal.1.jsonl"
JOURNAL_LIMIT = 5 * 1024 * 1024  # bytes; a full journal becomes journal.1.jsonl
JOURNAL_KINDS = ("run", "status", "claim", "issue", "baseline")
SECRET_FIELD = re.compile(r"key|token|secret|password", re.I)
JOURNAL_WAIT = 5  # seconds that an append waits for the plan lock before it warns
_JOURNAL_COMMAND = contextvars.ContextVar("wg_journal_command", default=None)


def journaled(command):
    """Name the command that the journal records for each change in this call. The outermost command wins:
    a `move` inside `wg dispatch` is journaled as `dispatch`."""
    def wrap(fn):
        def inner(*args, **kwargs):
            if _JOURNAL_COMMAND.get():
                return fn(*args, **kwargs)
            token = _JOURNAL_COMMAND.set(command)
            try:
                return fn(*args, **kwargs)
            finally:
                _JOURNAL_COMMAND.reset(token)
        inner.__name__, inner.__doc__, inner.__wrapped__ = fn.__name__, fn.__doc__, fn
        return inner
    return wrap


def journal_value(field, value):
    """The journal copy of a run-row value. The approval keeps its date: the human's words stay in Linear."""
    if field == "approved" and isinstance(value, str) and value:
        return f"{value[:10]}: approved; the words are in the Linear comment"
    return value


def journal_baseline(plan_dir):
    """The run rows of keymap.json now, as the first line of a new journal file: a rebuild starts from it."""
    try:
        run = load_keymap(plan_dir).get("run") or {}
    except (OSError, ValueError) as e:
        print(f"warn: journal has no baseline ({e}); wg run rebuild needs one", file=sys.stderr)
        return None
    rows = {"effort": dict(run.get("effort") or {}), "nodes": {k: dict(r) for k, r in (run.get("nodes") or {}).items()}}
    for row in [rows["effort"], *rows["nodes"].values()]:
        for field in list(row):
            if SECRET_FIELD.search(field):
                row.pop(field)
            else:
                row[field] = journal_value(field, row[field])
    return {"time": f"{utc_now():%Y-%m-%dT%H:%M:%SZ}", "command": journal_command("wg"), "key": "@baseline",
            "kind": "baseline", "changes": {}, "run": rows}


def journal(plan_dir, command, key, changes, kind="run"):
    """Append one line to <plan-dir>/journal.jsonl: the UTC time, the command, the node key, and each changed
    field as [old, new] (null: no value). A field with a secret name is left out, and no comment body is given.
    A new file (also after the rotation) starts with a baseline line: the run rows at that time.

    A journal failure is a warning: the change that it records is already done. The append waits at most
    JOURNAL_WAIT seconds for the plan lock, so a long command of another process cannot hold this one."""
    changes = {f: [journal_value(f, old), journal_value(f, new)] for f, (old, new) in changes.items()
               if old != new and not SECRET_FIELD.search(f)}
    if not changes:
        return
    entry = {"time": f"{utc_now():%Y-%m-%dT%H:%M:%SZ}", "command": command or "wg", "key": key, "kind": kind,
             "changes": changes}
    try:
        line = json.dumps(entry, sort_keys=True) + "\n"
        with plan_lock(plan_dir, wait=JOURNAL_WAIT):
            path = Path(plan_dir) / JOURNAL
            if path.exists() and path.stat().st_size + len(line) > JOURNAL_LIMIT:
                path.replace(path.with_name(JOURNAL_OLD))
            if not path.exists():
                baseline = journal_baseline(plan_dir)
                if baseline:
                    line = json.dumps(baseline, sort_keys=True) + "\n" + line
            fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
            with os.fdopen(fd, "a", encoding="utf-8") as f:
                os.fchmod(fd, 0o600)
                f.write(line)
    except (OSError, TypeError, ValueError) as e:
        print(f"warn: journal not written ({e})", file=sys.stderr)


def journal_command(fallback):
    return _JOURNAL_COMMAND.get() or fallback


def journal_keymap(plan_dir, before, after):
    """Journal each run row field and each node issue that a save of keymap.json changes."""
    command = journal_command("wg")
    try:
        old_run, new_run = before.get("run") or {}, after.get("run") or {}
        for scope, prefix in (("effort", None), ("nodes", "")):
            old_rows, new_rows = old_run.get(scope) or {}, new_run.get(scope) or {}
            if prefix is None:
                old_rows, new_rows = {"@effort": old_rows}, {"@effort": new_rows}
            for key in sorted(set(old_rows) | set(new_rows)):
                old, new = old_rows.get(key) or {}, new_rows.get(key) or {}
                journal(plan_dir, command, key, {f: (old.get(f), new.get(f)) for f in sorted(set(old) | set(new))})
        old_nodes, new_nodes = before.get("nodes") or {}, after.get("nodes") or {}
        for key in sorted(set(old_nodes) | set(new_nodes)):
            old, new = (old_nodes.get(key) or {}).get("identifier"), (new_nodes.get(key) or {}).get("identifier")
            journal(plan_dir, command, key, {"issue": (old, new)}, kind="issue")
    except (AttributeError, TypeError) as e:
        print(f"warn: journal not written ({e})", file=sys.stderr)


def journal_entries(plan_dir):
    """The journal, oldest first: journal.1.jsonl, then journal.jsonl. A damaged line is skipped with a warning."""
    entries, bad = [], 0
    for name in (JOURNAL_OLD, JOURNAL):
        path = Path(plan_dir) / name
        if not path.exists():
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                entry = json.loads(line)
                parse_utc(entry["time"])
                changes = entry.get("changes")
                if (entry.get("kind", "run") not in JOURNAL_KINDS or not isinstance(changes, dict)
                        or not all(isinstance(v, list) and len(v) == 2 for v in changes.values())
                        or (entry.get("kind") == "baseline" and not isinstance(entry.get("run"), dict))):
                    raise ValueError("not a journal entry")
            except (ValueError, KeyError, TypeError, AttributeError):
                bad += 1
                continue
            entries.append(entry)
    if bad:
        print(f"warn: {bad} damaged journal line(s) skipped", file=sys.stderr)
    return entries


def parse_utc(text):
    value = datetime.fromisoformat(text.replace("Z", "+00:00"))
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


DURATION = re.compile(r"(\d+)([smhdw])")
DURATION_SECONDS = {"s": 1, "m": 60, "h": 3600, "d": 86400, "w": 604800}


def since_time(text):
    """--since: a duration back from now (90m, 2h, 3d, 1w, 1d12h) or an ISO time (UTC when it has no offset)."""
    text = text.strip()
    if re.fullmatch(r"(\d+[smhdw])+", text):
        seconds = sum(int(n) * DURATION_SECONDS[unit] for n, unit in DURATION.findall(text))
        return utc_now().timestamp() - seconds
    try:
        return parse_utc(text).timestamp()
    except ValueError:
        die(f"invalid --since {text!r}: give a duration such as 2h or 3d, or a time such as 2026-01-01T09:00:00Z")


def short_value(value, width=24):
    text = "-" if value is None else str(value)
    return text if len(text) <= width else text[:width - 1] + "…"


def log_line(entry):
    if entry.get("kind") == "baseline":
        return f"{entry['time']} {entry.get('command', 'wg')} baseline: the run rows of {len(entry['run'].get('nodes') or {})} node(s)"
    changes = ", ".join(f"{field} {short_value(old)} -> {short_value(new)}"
                        for field, (old, new) in entry["changes"].items())
    return short_value(flat_line(f"{entry['time']} {entry.get('command', 'wg')} {entry.get('key', '-')} {changes}"), 200)


def duration_text(seconds):
    if seconds is None:
        return "-"
    minutes = int(seconds // 60)
    days, hours, minutes = minutes // 1440, minutes % 1440 // 60, minutes % 60
    if days:
        return f"{days}d{hours:02d}h"
    if hours:
        return f"{hours}h{minutes:02d}m"
    return f"{minutes}m"


def task_times(plan, entries):
    """Per task: dispatch to code done, code done to merged, and the time in the wait status or in Ready to Merge."""
    waits = {WAIT_STATUS, "Ready to Merge"}
    tasks = [n["key"] for n in plan["nodes"] if n["kind"] == "task"]
    out = []
    now = utc_now().timestamp()
    for key in tasks:
        dispatched = code_done = merged = wait_from = job = None
        waited = 0.0
        seen = False
        for entry in entries:
            if entry.get("kind") == "baseline":
                job = ((entry["run"].get("nodes") or {}).get(key) or {}).get("job")
                continue
            if entry.get("key") != key:
                continue
            seen = True
            at = parse_utc(entry["time"]).timestamp()
            changes = entry["changes"]
            if entry.get("kind", "run") == "run":
                job = changes.get("job", [None, job])[1]
                # The worker starts at the receipt of the dispatch job (started_at), not at the claim.
                if dispatched is None and job == "dispatch" and changes.get("started_at", [None, None])[1]:
                    dispatched = at
                if code_done is None and changes.get("code_done_head", [None, None])[1]:
                    code_done = at
            elif entry.get("kind") == "status" and "status" in changes:
                new = changes["status"][1]
                if wait_from is not None and new not in waits:
                    waited += at - wait_from
                    wait_from = None
                if wait_from is None and new in waits:
                    wait_from = at
                if merged is None and new in MERGED:
                    merged = at
        if not seen:
            continue
        if wait_from is not None:
            waited += now - wait_from
        to_code = code_done - dispatched if dispatched is not None and code_done is not None else None
        to_merge = merged - code_done if code_done is not None and merged is not None else None
        out.append((key, to_code, to_merge, waited))
    return out


def log_command(plan_dir, plan, key, since, count, times):
    if key and key != "@effort":
        get_node(plan, key)
    if count < 1:
        die("-n needs a positive number")
    entries = journal_entries(plan_dir)
    if key:
        entries = [e for e in entries if e.get("key") == key]
    if since:
        start = since_time(since)
        entries = [e for e in entries if parse_utc(e["time"]).timestamp() >= start]
    if times:
        rows = task_times(plan, entries)
        if not rows:
            print("no task in the journal")
        for task, to_code, to_merge, waited in rows:
            print(f"{task}\tdispatch->code done {duration_text(to_code)}\tcode done->merged "
                  f"{duration_text(to_merge)}\twait on {HUMAN} {duration_text(waited)}")
        return 0
    if not entries:
        print("no journal entry")
    for entry in entries[-count:]:
        print(log_line(entry))
    return 0


# ---------------------------------------------------------------- usage

USAGE_SHOWN = 15  # the sessions that `wg usage` prints without --all
USAGE_WORKER = "You are working inside Orca, a multi-agent IDE. You are a dispatched worker."
# A short utility session: its first message asks for a chat name, a branch name, or a commit message.
USAGE_UTILITY = re.compile(r"\b(chat|session|conversation|thread|tab)(?:'s)? (name|title)\b|\bbranch name\b|"
                           r"\bcommit message\b|^\s*reply with ok\b", re.I)
# The first user messages of a Codex rollout that its harness writes, not the person or the coordinator.
CODEX_PREAMBLES = ("# AGENTS.md instructions", "<environment_context", "<INSTRUCTIONS", "<user_instructions",
                   "<permissions instructions", "<skills_instructions")
USAGE_FIELDS = ("calls", "fresh", "cache_write", "cache_read", "input", "output")


def usage_paths(plan_dir):
    """{worktree path: node key or None} of an effort: the plan directory (None), and each worktree path that a
    run row or the journal records. A removed worktree keeps its transcripts, so the journal's old paths count."""
    paths = {}

    def add(key, value):
        if not isinstance(value, str) or not value:
            return
        path = value.partition("::")[2] if "::" in value else value  # an Orca worktree id: <repo>::<path>
        for p in {os.path.expanduser(path), str(Path(path).expanduser().resolve())}:
            paths.setdefault(p, key)

    add(None, str(plan_dir))
    km = load_keymap(plan_dir)
    for key, row in run_rows(km)["nodes"].items():
        add(key, row.get("path"))
        add(key, row.get("worktree"))
    for entry in journal_entries(plan_dir):
        if entry.get("kind", "run") != "run" or entry.get("key") in (None, "@effort"):
            continue
        for field in ("path", "worktree"):
            for value in entry["changes"].get(field) or ():
                add(entry["key"], value)
    return paths


# A call of a coordinator: a `wg next` command, or a read of the work-graph skill.
USAGE_COORDINATING = re.compile(r"\bwg(?:\.py)?\s+next\b|work-graph/SKILL\.md")


def usage_role(first, coordinating):
    """coordinator, worker, or other. A worker starts with the worker preamble. A session in the plan directory is
    the coordinator only when it ran `wg next` or loaded the work-graph skill: a session of the human there, with an
    ordinary request, is other."""
    text = (first or "").lstrip()
    if text.startswith(USAGE_WORKER):
        return "worker"
    if USAGE_UTILITY.search(text[:300]):
        return "other"
    return "coordinator" if coordinating else "other"


def usage_numbers(record, fields):
    """The integer values of `fields` in a usage record, with 0 for a missing one. None when one is not an integer:
    that record does not count."""
    values = [record.get(f, 0) if record.get(f) is not None else 0 for f in fields]
    if any(isinstance(v, bool) or not isinstance(v, int) or v < 0 for v in values):
        return None
    return values


def claude_coordinating(message):
    """Does one assistant message of Claude Code run `wg next` or load the work-graph skill?"""
    for block in message.get("content") or []:
        if not isinstance(block, dict) or block.get("type") != "tool_use":
            continue
        tool = block.get("input") if isinstance(block.get("input"), dict) else {}
        if block.get("name") == "Skill" and str(tool.get("skill", "")).rpartition(":")[2] == "work-graph":
            return True
        if USAGE_COORDINATING.search(json.dumps(tool)):
            return True
    return False


def usage_session(agent, file, key, coordinator):
    return {"agent": agent, "session": file.stem, "file": str(file), "key": key, "coordinator": coordinator,
            "coordinating": False, "cwd": None,
            "role": None, "model": None, "models": Counter(), "calls": 0, "fresh": 0, "cache_write": 0,
            "cache_read": 0, "output": 0, "max_context": 0, "start_context": None, "first": None, "last": None,
            "first_message": None, "subagents": 0}


def usage_time(session, stamp):
    if stamp:
        session["first"] = min(session["first"] or stamp, stamp)
        session["last"] = max(session["last"] or stamp, stamp)


def usage_lines(file):
    """The lines of a file as bytes, one at a time, so that a transcript of hundreds of megabytes is not read at
    once. A file that cannot be read gives no line."""
    try:
        with open(file, "rb") as f:
            yield from f
    except OSError:
        return


def claude_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return next((b.get("text") for b in content if isinstance(b, dict) and b.get("type") == "text"), None)
    return None


def claude_usage(session, file, since, seen, main=True):
    """Add the calls of one Claude Code transcript to `session`. A message id counts one time (`seen`), at the time
    of its first record: a later line of the same call does not move it past --since. The main transcript also
    gives the session's first user message, the cwd that its lines record, and whether it coordinated."""
    for line in usage_lines(file):
        want_user = main and session["first_message"] is None and b'"user"' in line
        want_cwd = main and session["cwd"] is None and b'"cwd"' in line
        # Each user record can hold the /work-graph command, not only the first one.
        want_command = main and not session["coordinating"] and b"/work-graph</command-name>" in line
        if b'"usage"' not in line and not want_user and not want_cwd and not want_command:
            continue
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if not isinstance(entry, dict):
            continue
        if want_cwd and isinstance(entry.get("cwd"), str):
            session["cwd"] = entry["cwd"]
        message = entry.get("message")
        if entry.get("type") == "user":
            if want_user and not entry.get("isMeta") and isinstance(message, dict):
                session["first_message"] = claude_text(message.get("content"))
            if main and isinstance(message, dict) and "<command-name>/work-graph</command-name>" in (
                    claude_text(message.get("content")) or ""):
                session["coordinating"] = True
            continue
        if entry.get("type") != "assistant" or not isinstance(message, dict):
            continue
        # Each line of a call holds one content block, so each line can hold the command.
        if main and not session["coordinating"] and claude_coordinating(message):
            session["coordinating"] = True
        usage, ident, model = message.get("usage"), message.get("id"), message.get("model")
        if not isinstance(usage, dict) or model == "<synthetic>" or (ident and ident in seen):
            continue
        values = usage_numbers(usage, ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens",
                                       "output_tokens"))
        if values is None:
            continue  # an invalid record: a later valid record of the same id still counts
        if ident:
            seen.add(ident)  # the first valid record gives the time of the call, also when --since skips it
        stamp = entry.get("timestamp")
        if since and (not usage_epoch(stamp) or usage_epoch(stamp) < since):
            continue
        session["calls"] += 1
        session["fresh"] += values[0]
        session["cache_write"] += values[1]
        session["cache_read"] += values[2]
        session["output"] += values[3]
        if model:
            session["models"][model] += 1
        if main:
            context = sum(values[:3])
            session["max_context"] = max(session["max_context"], context)
            if session["start_context"] is None:
                session["start_context"] = context
        usage_time(session, stamp)


def usage_epoch(stamp):
    """The epoch seconds of a transcript time, or None for a time that is not valid."""
    try:
        return parse_utc(stamp).timestamp() if isinstance(stamp, str) else None
    except ValueError:
        return None


CODEX_TOTALS = ("input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens")
CODEX_CALLS = ("function_call", "custom_tool_call", "local_shell_call")


def codex_usage(session, file, since):
    """Add one Codex rollout to `session`. The token totals are cumulative, and the last total of the rollout is
    the session's (a total that goes down is not added to the one before it). With `since`, the session's part is
    the last total less the last total before `since`. Each token_count event with a new total is one call."""
    last, base, final = None, None, None
    for line in usage_lines(file):
        want_user = session["first_message"] is None and b'"user' in line
        want_call = not session["coordinating"] and b"_call" in line and (b"next" in line or b"SKILL" in line)
        if b'"token_count"' not in line and b'"turn_context"' not in line and not want_user and not want_call:
            continue
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        payload = entry.get("payload") if isinstance(entry, dict) else None
        if not isinstance(payload, dict):
            continue
        kind = payload.get("type")
        if entry.get("type") == "turn_context" and payload.get("model"):
            session["model_now"] = payload["model"]
            continue
        if want_call and kind in CODEX_CALLS:
            if USAGE_COORDINATING.search(json.dumps([payload.get(f) for f in ("arguments", "input", "action")])):
                session["coordinating"] = True
            continue
        if want_user and kind == "user_message" and isinstance(payload.get("message"), str):
            session["first_message"] = payload["message"]
            continue
        if want_user and kind == "message" and payload.get("role") == "user":
            text = next((b.get("text") for b in payload.get("content") or []
                         if isinstance(b, dict) and b.get("type") == "input_text"), None) or ""
            if not text.startswith(CODEX_PREAMBLES):
                session["first_message"] = text
            continue
        info = payload.get("info") if kind == "token_count" else None
        total = info.get("total_token_usage") if isinstance(info, dict) else None
        values = usage_numbers(total, CODEX_TOTALS) if isinstance(total, dict) else None
        if values is None or values == last:
            continue
        last = values
        stamp = entry.get("timestamp")
        if since and (not usage_epoch(stamp) or usage_epoch(stamp) < since):
            base = values
            continue
        final = values
        session["calls"] += 1
        if session.get("model_now"):
            session["models"][session["model_now"]] += 1
        call = info.get("last_token_usage")
        context = (usage_numbers(call, ("input_tokens",)) or [0])[0] if isinstance(call, dict) else 0
        session["max_context"] = max(session["max_context"], context)
        if session["start_context"] is None:
            session["start_context"] = context
        usage_time(session, stamp)
    if final is None:
        return
    # By decision: a total below the one before it (none in 536 real rollouts) is not added to it. The last total
    # is the session's, as Codex writes it.
    inp, cached, written, out = (max(f - b, 0) for f, b in zip(final, base or [0] * len(final)))
    session["fresh"] += max(inp - cached - written, 0)
    session["cache_read"] += cached
    session["cache_write"] += written
    session["output"] += out


def claude_dirs(path):
    """The Claude Code transcript folders of a worktree path: each character that is not a letter or a digit is
    a "-". Claude Code shortens a long name and adds a hash, so a long one also matches by its first 200 characters."""
    root = Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude").expanduser() / "projects"
    name = re.sub(r"[^A-Za-z0-9]", "-", path)
    if len(name) <= 200:
        return [root / name]
    return sorted(root.glob(glob_escape(name[:200]) + "*")) if root.is_dir() else []


def glob_escape(text):
    return re.sub(r"([*?\[])", r"[\1]", text)


def codex_cwd(file):
    """The cwd of a Codex rollout: its first line, the session_meta."""
    try:
        with open(file, "rb") as f:
            first = f.readline()
        payload = json.loads(first).get("payload") or {}
        return payload.get("cwd") if isinstance(payload.get("cwd"), str) else None
    except (OSError, ValueError, AttributeError):
        return None


def effort_usage(plan_dir, since=None):
    """The sessions of an effort with their token use, largest input first. Reads transcripts only."""
    paths = usage_paths(plan_dir)
    core = {p for p, key in paths.items() if key is None}
    sessions, seen, done = [], set(), set()
    for path, key in paths.items():
        for folder in claude_dirs(path):
            if folder in done or not folder.is_dir():
                continue
            done.add(folder)
            for file in sorted(folder.glob("*.jsonl")):
                s = usage_session("claude", file, key, path in core)
                claude_usage(s, file, since, seen)
                # Each character that is not a letter or a digit is a "-", so the folders a-b and a_b share one
                # slug. A session belongs to the cwd that it records: a tracked one gives its node, another one
                # is of another folder. By decision, a session with no cwd on any line (real transcripts record
                # it) counts under the tracked path of the folder.
                if s["cwd"] is not None:
                    owner = next((p for p in (s["cwd"], str(Path(s["cwd"]).resolve())) if p in paths), None)
                    if owner is None:
                        continue
                    s["key"], s["coordinator"] = paths[owner], owner in core
                for sub in sorted((folder / file.stem / "subagents").glob("*.jsonl")):
                    s["subagents"] += 1
                    claude_usage(s, sub, since, seen, main=False)
                sessions.append(s)
    codex = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex").expanduser() / "sessions"
    for file in sorted(codex.rglob("*.jsonl")) if codex.is_dir() else ():
        cwd = codex_cwd(file)
        if cwd is None or (cwd not in paths and str(Path(cwd).resolve()) not in paths):
            continue
        key = paths.get(cwd, paths.get(str(Path(cwd).resolve())))
        s = usage_session("codex", file, key, key is None)
        codex_usage(s, file, since)
        sessions.append(s)
    kept = []
    for s in sessions:
        if not s["calls"]:
            continue
        core_session = s.pop("coordinator")
        s["role"] = usage_role(s.pop("first_message"), core_session and s.pop("coordinating"))
        s.pop("coordinating", None)
        s.pop("cwd", None)
        s["model"] = s.pop("models").most_common(1)[0][0] if s["models"] else None
        s.pop("model_now", None)
        s["input"] = s["fresh"] + s["cache_write"] + s["cache_read"]
        s["start_context"] = s["start_context"] or 0
        kept.append(s)
    kept.sort(key=lambda s: (-s["input"], s["first"] or ""))
    return kept


def usage_sum(sessions):
    out = {"sessions": len(sessions)}
    for f in USAGE_FIELDS:
        out[f] = sum(s[f] for s in sessions)
    return out


def short_count(n):
    """570.4M, 98.6K, 912: a token count on the terminal."""
    units = ((10 ** 3, "K"), (10 ** 6, "M"), (10 ** 9, "B"))
    for i in range(len(units) - 1, -1, -1):
        size, unit = units[i]
        if abs(n) >= size:
            if abs(round(n / size, 1)) >= 1000 and i + 1 < len(units):  # 999999 is 1.0M, not 1000.0K
                size, unit = units[i + 1]
            return f"{n / size:.1f}{unit}"
    return str(n)


def usage_stamp(text):
    return parse_utc(text).strftime("%m-%d %H:%M") if text else "-"


def usage_command(plan_dir, as_json, since, everything):
    """`wg usage <plan-dir>`: the token use of each session of an effort. It reads files only."""
    if not (Path(plan_dir) / "plan.json").is_file():
        die(f"no plan.json in {plan_dir}")
    start = since_time(since) if since else None
    sessions = effort_usage(plan_dir, start)
    roles = {r: usage_sum([s for s in sessions if s["role"] == r]) for r in ("coordinator", "worker", "other")}
    total = usage_sum(sessions)
    if as_json:
        rows = [{k: v for k, v in s.items()} for s in sessions]
        print(json.dumps({"plan_dir": str(plan_dir), "since": since, "sessions": rows, "roles": roles,
                          "total": total}, indent=2))
        return 0
    if not sessions:
        print("no session transcript of this effort")
        return 0
    head = ("role", "node", "agent", "model", "calls", "fresh", "c.write", "c.read", "output", "max ctx", "start",
            "first", "last")
    table = [head]
    shown = sessions if everything else sessions[:USAGE_SHOWN]
    for s in shown:
        table.append((s["role"], s["key"] or "-", s["agent"], s["model"] or "-", str(s["calls"]),
                      *(short_count(s[f]) for f in ("fresh", "cache_write", "cache_read", "output", "max_context",
                                                    "start_context")),
                      usage_stamp(s["first"]), usage_stamp(s["last"])))
    widths = [max(len(row[i]) for row in table) for i in range(len(head))]
    for row in table:
        print("  ".join(cell.ljust(w) for cell, w in zip(row, widths)).rstrip())
    rest = sessions[len(shown):]
    if rest:
        more = usage_sum(rest)
        print(f"and {len(rest)} more sessions: input {short_count(more['input'])}, output {short_count(more['output'])}")
    print()
    for name, part in [*roles.items(), ("total", total)]:
        if part["sessions"] or name == "total":
            print(f"{name:<12} {part['sessions']:>4} sessions  {part['calls']:>6} calls  input {short_count(part['input'])} "
                  f"(fresh {short_count(part['fresh'])}, cache write {short_count(part['cache_write'])}, "
                  f"cache read {short_count(part['cache_read'])})  output {short_count(part['output'])}")
    return 0


def rebuilt_rows(plan, entries):
    """The run rows that the journal gives: the last baseline, then each run row change after it.
    None when the journal has no baseline: without it, the rows are not complete."""
    start = next((i for i in range(len(entries) - 1, -1, -1) if entries[i].get("kind") == "baseline"), None)
    if start is None:
        return None
    base = entries[start]["run"]
    run = {"effort": dict(base.get("effort") or {}), "nodes": {k: dict(r) for k, r in (base.get("nodes") or {}).items()}}
    keys = {n["key"] for n in plan["nodes"]}
    for entry in entries[start + 1:]:
        if entry.get("kind", "run") != "run":
            continue
        key = entry.get("key")
        if key == "@effort":
            row = run["effort"]
        else:
            row = run["nodes"].setdefault(key, {})
        for field, (_, new) in entry["changes"].items():
            if new is None:
                row.pop(field, None)
            else:
                row[field] = new
    run["nodes"] = {k: row for k, row in run["nodes"].items() if row and k in keys}  # the plan's nodes only
    return run


def run_rebuild(plan_dir, plan, apply):
    entries = journal_entries(plan_dir)
    if not entries:
        die(f"no journal in {plan_dir}: the run rows cannot be rebuilt (recovery.md)", 1)
    run = rebuilt_rows(plan, entries)
    if run is None:
        die("the journal has no baseline line, so it cannot give complete run rows; nothing is changed "
            "(recovery.md)", 1)
    kept = [n["key"] for n in plan["nodes"] if n["key"] in run["nodes"]]
    first = next(e for e in reversed(entries) if e.get("kind") == "baseline")
    print(f"from the baseline of {first['time']} and the changes after it")
    if run["effort"]:
        print(f"@effort\t{' '.join(pairs(run['effort']))}")
    for key in kept:
        print(f"{key}\t{' '.join(pairs(run['nodes'][key]))}")
    if not apply:
        print("dry run: add --apply to write these run rows to keymap.json")
        return 0
    km = load_keymap(plan_dir)
    if not km["nodes"]:
        die("keymap.json maps no node: run wg load --adopt first (recovery.md)", 1)
    if km.get("run"):
        backup = Path(plan_dir) / "keymap.run-before-rebuild.json"
        save_json(backup, km["run"], mode=0o600)
        print(f"the replaced run rows are in {backup}")
    km["run"] = run
    save_keymap(plan_dir, km)
    print(f"wrote the run rows of {len(kept)} node(s) to keymap.json")
    return 0


def post_merge(n):
    return n.get("kind") == "task" and n.get("role") in ("sync", "integration")


# ---------------------------------------------------------------- check

def check(plan):
    errs = agent_setting_errors(plan.get("effort", {}).get("agents", {}), "effort.agents",
                                CONFIG.get("agents", {}))
    phases = {str(p["key"]): p for p in plan.get("phases", [])}
    for ph, phase in phases.items():
        if not isinstance(phase.get("target"), str) or not phase["target"].strip():
            errs.append(f"phase {ph}: no target")
    initiative = plan.get("effort", {}).get("initiative")
    if initiative is not None and (not isinstance(initiative, str) or not initiative.strip() or len(initiative) > 80):
        errs.append("effort.initiative: a name of 1 to 80 characters")
    effort = plan.get("effort", {})
    if "lint" in effort and not (isinstance(effort["lint"], list) and all(isinstance(a, str) for a in effort["lint"])):
        errs.append("effort.lint: a list of strings")
    if "rules" in effort and not isinstance(effort["rules"], str):
        errs.append("effort.rules: a text")
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
COMPLEXITY_LIMITS = ("Complexity", "Endpoint-Complexity")
GQL_STATUS_BODY = 500        # bytes of an HTTP 429 or 5xx body to read for the error text
GQL_ERROR_BODY = 64 * 1024   # bytes of another HTTP error body to read for its GraphQL error code


class _GqlFailure(Exception):
    """One failed try. `kind` is "refused" (Linear did not run the request: HTTP 429, or RATELIMITED with
    no data and no error path), "transient" (a network error, a timeout, HTTP 5xx, or a rate limit during
    execution: Linear can have run it), or "final".
    `headers` are the headers of this failed response, or None."""

    def __init__(self, message, kind, cause=None, headers=None):
        super().__init__(message)
        self.kind = kind
        self.cause = cause
        self.headers = headers


def is_query(query):
    """True only when the GraphQL document is known to hold no mutation and no subscription. A document can
    start with a fragment, so each top-level name counts, not only the first token. The check skips white
    space, commas, a byte order mark, comments, and strings. A document that it cannot read is not a query."""
    i, depth, n = 0, 0, len(query)
    while i < n:
        c = query[i]
        if c in " \t\r\n,\ufeff":
            i += 1
        elif c == "#":
            newline = re.compile(r"[\r\n]").search(query, i)
            i = newline.start() if newline else n
        elif query.startswith('"""', i):
            end = re.compile(r'(?<!\\)"""').search(query, i + 3)
            if not end:
                return False
            i = end.end()
        elif c == '"':
            end = re.compile(r'(?:[^"\\\r\n]|\\.)*"').match(query, i + 1)
            if not end:
                return False
            i = end.end()
        elif c in "{(":
            depth += 1
            i += 1
        elif c in "})":
            depth -= 1
            if depth < 0:
                return False
            i += 1
        elif c == "_" or c.isascii() and c.isalpha():
            name = re.compile(r"[_0-9A-Za-z]+").match(query, i).group()
            if depth == 0 and name in ("mutation", "subscription"):
                return False
            i += len(name)
        else:
            i += 1
    return depth == 0


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


def _executed(body):
    """True when a GraphQL response shows that execution began: it has data, or an error has a path."""
    if not isinstance(body, dict):
        return False
    errors = body.get("errors")
    return body.get("data") is not None or (isinstance(errors, list) and any(
        isinstance(e, dict) and e.get("path") is not None for e in errors))


def _rate_kind(body):
    """The kind of a failure whose body has GraphQL errors: "refused" when Linear refused the request at a
    rate limit before execution, "transient" when a rate limit stopped part of an execution, else "final"."""
    if not isinstance(body, dict) or not _rate_limited(body.get("errors")):
        return "final"
    return "transient" if _executed(body) else "refused"


def _epoch_seconds(value):
    try:
        at = float(value)
    except (TypeError, ValueError):
        return None
    return at / 1000 if at > 1e11 else at  # Linear gives reset times in milliseconds since the epoch


def _reset_wait(headers):
    """Seconds until Linear accepts the refused request again, from the headers of that refusal: the
    Retry-After header, and the reset time of each limit that is used up (the latest one counts). A
    complexity limit is used up when its points are fewer than the cost of the request (X-Complexity). When
    no limit is used up, the reset of the complexity limits: a request can cost more than the points that
    are left. Without these, the reset time of the request limit. None when the refusal gives no time."""
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
    try:
        cost = float(headers.get("X-Complexity"))
    except (TypeError, ValueError):
        cost = None

    def used_up(limit):
        try:
            remaining = float(headers.get(f"X-RateLimit-{limit}-Remaining"))
        except (TypeError, ValueError):
            return False
        return remaining <= 0 or (limit in COMPLEXITY_LIMITS and cost is not None and remaining < cost)

    def resets(limits):
        found = (_epoch_seconds(headers.get(f"X-RateLimit-{limit}-Reset")) for limit in limits)
        return [at - now for at in found if at is not None]

    waits += resets([limit for limit in RATE_LIMITS if used_up(limit)])
    if not waits:
        waits = resets([limit for limit in COMPLEXITY_LIMITS
                        if headers.get(f"X-RateLimit-{limit}-Remaining") is not None])
    if not waits:
        waits = resets(["Requests"])
    return max(0.0, max(waits)) if waits else None


def _gql_try(req):
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            headers = getattr(response, "headers", None)
            _note_rate(headers)
            body = json.load(response)
    except urllib.error.HTTPError as e:
        _note_rate(e.headers)
        by_status = e.code == 429 or e.code >= 500  # the status alone gives the kind
        try:
            # An error code can follow a long message, so a body that must be read gets a larger budget.
            detail = e.read(GQL_STATUS_BODY if by_status else GQL_ERROR_BODY).decode(errors="replace")
        except (http.client.HTTPException, OSError) as read_error:  # OSError covers a timeout and a reset
            detail = f"(body not read: {read_error})"
        finally:
            e.close()
        message = f"Linear HTTP {e.code}: {detail[:GQL_STATUS_BODY]}"
        if by_status:
            kind = "transient" if e.code >= 500 else "refused"
        else:
            try:
                kind = _rate_kind(json.loads(detail))
            except ValueError:
                kind = "final"
        raise _GqlFailure(message, kind, e, e.headers) from e
    except (urllib.error.URLError, TimeoutError, http.client.HTTPException, ConnectionError,
            ssl.SSLEOFError, ssl.SSLZeroReturnError) as e:
        raise _GqlFailure(f"Linear request failed: {e}", "transient", e) from e
    if body.get("errors"):
        message = "Linear error: " + json.dumps(body["errors"])[:800]
        raise _GqlFailure(message, _rate_kind(body), headers=headers)
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
    mutation = not is_query(query)  # a document not known to be a query counts as a mutation
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


def setup_labels_contract():
    return {
        "team_issue_labels": [*KIND_LABEL.values(), REVIEWED_LABEL],
        "workspace_issue_labels": [ANSWERED_LABEL],
        "workspace_label_groups": {"agent": list(AGENT_LABELS)},
        "project_label_groups": {INITIATIVE_GROUP: [], AUTONOMY_GROUP: list(AUTONOMY_LEVELS),
                                 REVIEW_GROUP: [review_label(level) for level in REVIEW_LEVELS]},
        "project_labels": [PAUSED_LABEL, "shared"],
    }


def setup_team(key):
    teams = gql("""query($k:String!){ teams(filter:{key:{eq:$k}}){
                   nodes{id visibility triageEnabled parent{key}} } }""", {"k": key})["teams"]["nodes"]
    return teams[0] if teams else None


def setup_pages(read):
    after = None
    while True:
        page = read(after)
        yield from page["nodes"]
        if not page["pageInfo"]["hasNextPage"]:
            return
        after = page["pageInfo"]["endCursor"]


def setup_states(team_id):
    return {state["name"]: state for state in setup_pages(lambda after: gql(
        """query($id:String!,$after:String){ team(id:$id){ states(first:100,after:$after){
           nodes{id name type} pageInfo{hasNextPage endCursor} } } }""",
        {"id": team_id, "after": after})["team"]["states"])}


def setup_labels(kind, team_id):
    field = f"{kind}s"
    scope = {"id": {"eq": team_id}} if team_id else {"null": True}
    query = f"""query($f:{kind[0].upper() + kind[1:]}Filter!,$after:String){{
        {field}(first:100,after:$after,filter:$f){{
            nodes{{id name isGroup groupType parent{{id name}} retiredAt}} pageInfo{{hasNextPage endCursor}} }} }}"""
    return list(setup_pages(lambda after: gql(query, {"f": {"team": scope}, "after": after})[field]))


def setup_mutation(name, query, variables):
    result = gql(query, variables).get(name)
    if not result or not result.get("success"):
        raise ReadError(f"Linear did not confirm {name}")
    return result


def setup_create(kind, item, reread):
    mutation = kind + "Create"
    input_type = kind[0].upper() + kind[1:] + "CreateInput"
    try:
        return setup_mutation(mutation, f"""mutation($i:{input_type}!){{ {mutation}(input:$i){{
                              success {kind}{{id}} }} }}""", {"i": item})[kind]
    except ReadError as e:
        if not re.search(r"duplicate|already exists|already (?:been )?taken", str(e), re.I):
            raise
        for attempt in range(10):
            if attempt:
                time.sleep(1)
            if found := reread():
                return found
        raise


def setup_update_team(team_id, item):
    setup_mutation("teamUpdate", """mutation($id:String!,$i:TeamUpdateInput!){
                   teamUpdate(id:$id,input:$i){success} }""", {"id": team_id, "i": item})


def setup_private_team(key, team, new_team):
    team_id = team["id"]
    if not new_team:
        content = gql("""query($id:String!){ team(id:$id){
                         issues(first:1,includeArchived:true){nodes{id}}
                         projects(first:1,includeArchived:true){nodes{id}} } }""", {"id": team_id})["team"]
        for field, reason in (("issues", "an issue"), ("projects", "a project")):
            if content[field]["nodes"]:
                raise ReadError(f"team {key} has {reason}. Make it private in Linear or rerun with --no-private.")
    hint = "Make it private in Linear and run again, or run again with --no-private."
    try:
        setup_update_team(team_id, {"private": True})
    except ReadError as e:
        try:
            current = setup_team(key)
        except ReadError:
            current = None
        if current and current["id"] == team_id and current["visibility"] != "private":
            raise ReadError(f"{e}\nThe team {key} exists and is not private. {hint}") from e
        if current and current["id"] == team_id and current["visibility"] == "private":
            raise ReadError(f"{e}\nThe team {key} is now private. Run setup again to continue.") from e
        raise ReadError(f"{e}\nThe team {key} exists. Its privacy could not be verified. {hint}") from e
    try:
        verified = setup_team(key)
    except ReadError as e:
        raise ReadError(f"{e}\nThe team {key} exists. Its privacy could not be verified. {hint}") from e
    if not verified or verified["id"] != team_id:
        raise ReadError(f"Linear did not return the team {key} after the update. {hint}")
    if verified["visibility"] != "private":
        raise ReadError(f"Linear did not confirm private visibility. The team {key} exists and is not private. {hint}")
    return verified


def setup_workflow(team, apply, report):
    team_id = team["id"] if team else None
    states = setup_states(team_id) if team else {}

    def find(rows, name):
        return rows.get(name) or next((row for key, row in rows.items()
                                      if key.casefold() == name.casefold()), None)

    def report_state(name, state, expected):
        actual = state.get("type", expected)
        if "name" in state and state["name"] != name:
            report(f"status {name}", "warn", f" (exists as {state['name']!r}. Rename it in Linear.)")
        elif actual != expected:
            report(f"status {name}", "warn", f" ({actual}, expected {expected})")
        else:
            report(f"status {name}", "exists", f" ({actual})")

    for name, expected in setup_status_types().items():
        if state := find(states, name):
            report_state(name, state, expected)
            continue
        report(f"status {name}", "missing", f" ({expected})")
        if not apply:
            continue
        # Linear owns the reserved statuses. Enabling triage adds its state.
        if expected == "triage" and not team["triageEnabled"] and not any(
                state["type"] == "triage" for state in states.values()):
            setup_update_team(team_id, {"triageEnabled": True})
            states = setup_states(team_id)
            if state := find(states, name):
                if state["name"] == name and state["type"] == expected:
                    print(f"created status {name}")
                else:
                    report_state(name, state, expected)
                continue
        if expected in {"triage", "duplicate"}:
            print(f"warn status {name}: Linear manages this status. Check the team's workflow in Linear.")
            continue
        state = setup_create("workflowState", {"name": name, "type": expected, "teamId": team_id,
                                              "color": "#5E6AD2"}, lambda: find(setup_states(team_id), name))
        if "name" in state:
            report_state(name, state, expected)


def setup_label_scope(kind, team_id, groups, plain, apply, report, *, team_scoped):
    def read_labels():
        rows = [dict(row, team_scoped=False) for row in setup_labels(kind, None)]
        if team_id:
            rows.extend(dict(row, team_scoped=True) for row in setup_labels(kind, team_id))
        return rows

    labels = read_labels()
    owner = {"teamId": team_id} if team_scoped else {}
    label_kind = "issue label" if kind == "issueLabel" else "project label"

    def ensure(name, parent=None, group=False):
        def matches_location(row):
            return row["team_scoped"] == team_scoped and (row.get("parent") or {}).get("id") == parent

        def match(rows):
            named = [row for row in rows if row["name"].casefold() == name.casefold()]
            return next((row for row in named if matches_location(row)),
                        named[0] if named else None)

        description = f"{label_kind}{' group' if group else ''} {name}"
        def use(found):
            if not matches_location(found):
                location = "team scope" if found["team_scoped"] else "workspace scope"
                if found_parent := found.get("parent"):
                    location += f" under {found_parent.get('name') or found_parent['id']!r}"
                else:
                    location += " at the top level"
                report(description, "warn", f" (exists in {location})")
                return None
            if (bool(found.get("isGroup")) != group or found.get("retiredAt") or (not group and found["name"] != name)
                    or (group and found.get("groupType") != "singleSelect")):
                report(description, "warn", " (check its type and availability in Linear)")
                return None
            report(description, "exists")
            return found["id"]

        if found := match(labels):
            return use(found), False
        report(description, "missing")
        if apply:
            item = {"name": name, **owner}
            if group:
                item.update(isGroup=True, groupType="singleSelect")
            if parent:
                item["parentId"] = parent
            created = setup_create(kind, item, lambda: match(read_labels()))
            return (use(created) if "team_scoped" in created else created["id"]), True
        return None, True

    for name in plain:
        ensure(name)
    for group, children in groups:
        group_id, missing = ensure(group, group=True)
        for child in children:
            if group_id:
                ensure(child, parent=group_id)
            elif missing and not apply:
                report(f"{label_kind} {child} in {group}", "missing")


def setup_config_hint(workspace, team_key, scoped):
    try:
        raw = json.loads(CONFIG_PATH.read_text())
    except FileNotFoundError:
        raw = {}
    entry = {"id": workspace, "team": team_key, "team_labels": scoped}
    if not any(entry.items() <= row.items() for row in raw.get("workspaces", [])):
        print(f"Set this entry in workspaces in {CONFIG_PATH}:")
        print(json.dumps(entry, indent=2))
    print("Next commands\n  wg preflight <plan-dir>\n  wg doctor")


def setup_command(ns):
    workspace = ns.workspace
    if workspace not in WORKSPACES:
        raise ReadError(f"unknown workspace {workspace}: choose one of {', '.join(WORKSPACES)}")
    config = WORKSPACES[workspace]
    team_key = (ns.team or config["team"] or "").upper()
    if not team_key:
        raise ReadError(f"workspace {workspace} has no default team. Supply --team <KEY>.")
    token = LINEAR_WORKSPACE.set(workspace)
    try:
        missing = False

        def report(item, status, detail=""):
            nonlocal missing
            missing |= status == "missing"
            print(f"{status} {item}{detail}")

        team = setup_team(team_key)
        new_team = team is None
        report(f"team {team_key}", "missing" if new_team else "exists")
        parent = None
        if ns.parent:
            parent_key = ns.parent.upper()
            if new_team:
                parent = setup_team(parent_key)
                if not parent:
                    raise ReadError(f"parent {parent_key} does not exist or is not visible.")
                report(f"parent {parent_key}", "exists")
            else:
                current = (team.get("parent") or {}).get("key")
                if current == parent_key:
                    report(f"parent {parent_key}", "exists")
                else:
                    report(f"parent {parent_key}", "warn", f" (current parent: {current or 'none'})")
        if new_team and ns.apply:
            if not ns.name:
                raise ReadError(f"team {team_key} needs a name. Supply --name <team name>.")
            item = {"key": team_key, "name": ns.name}
            if parent:
                item["parentId"] = parent["id"]
            team = setup_mutation("teamCreate", """mutation($i:TeamCreateInput!){
                teamCreate(input:$i){success team{id visibility triageEnabled parent{key}}} }""",
                {"i": item})["team"]
            if parent:
                actual = (team.get("parent") or {}).get("key")
                if actual != parent_key:
                    raise ReadError(f"Linear created team {team_key} with parent {actual or 'none'}; "
                                    f"expected parent {parent_key}. Check the team in Linear.")
        if ns.private and (not team or team["visibility"] != "private"):
            report(f"private visibility for team {team_key}", "missing")
            if ns.apply:
                team = setup_private_team(team_key, team, new_team)
        visibility = team["visibility"] if team else "public"
        if not ns.private or visibility == "private":
            print(f"Team {team_key} visibility: {visibility}.")

        setup_workflow(team, ns.apply, report)
        team_id = team["id"] if team else None
        scoped = bool(config["team_labels"])
        labels = setup_labels_contract()
        setup_label_scope("issueLabel", team_id, (), labels["team_issue_labels"], ns.apply, report, team_scoped=True)
        setup_label_scope("issueLabel", team_id, labels["workspace_label_groups"].items(), labels["workspace_issue_labels"],
                          ns.apply, report, team_scoped=False)
        setup_label_scope("projectLabel", team_id, labels["project_label_groups"].items(), labels["project_labels"],
                          ns.apply, report, team_scoped=scoped)
        if not missing:
            print("nothing is missing")
        elif not ns.apply:
            print("Run again with --apply to make missing items.")
        setup_config_hint(workspace, team_key, scoped)
        return 0
    finally:
        LINEAR_WORKSPACE.reset(token)


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
    if card and card.get("sha") == sha:
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


def review_label(level):
    """The child label of the group `review` for the review effort `level`."""
    return f"{REVIEW_PREFIX}{level}"


def review_label_level(name):
    """The review effort of a child label of the group `review`, or None. An old label without the prefix
    (`thorough`, `light`) is still that level; the next `wg review-effort` set replaces it."""
    level = name[len(REVIEW_PREFIX):] if name.startswith(REVIEW_PREFIX) else name
    return level if level in REVIEW_LEVELS else None


def project_review_label(project_id):
    """The name of the review effort label of the project, or None when it has none."""
    on = gql("""query($id:String!){ project(id:$id){ labels(first:50){ nodes{name parent{name}} } } }""",
             {"id": project_id})["project"]["labels"]["nodes"]
    return next((label["name"] for label in on if (label.get("parent") or {}).get("name", "").lower() == REVIEW_GROUP
                 and review_label_level(label["name"])), None)


def project_review_effort(project_id):
    """The review effort of the project's label, or None when it has none."""
    name = project_review_label(project_id)
    return review_label_level(name) if name else None


def set_project_review_effort(plan, project_id, level):
    """Give the project the review effort `level`; returns the changes."""
    team_id = team_info(plan_team(plan))[0]
    changes = []
    sync_project_label(REVIEW_GROUP, "work-graph: the review effort of each effort (thorough, standard, light). "
                       "The coordinator follows it.", "review effort",
                       team_id, project_id, review_label(level), True, changes, team_scoped=team_labels(plan))
    return changes


def effort_review(plan_dir, km=None):
    """The review effort of the effort: the project label, or REVIEW_DEFAULT when it has none."""
    km = load_keymap(plan_dir) if km is None else km
    project_id = (km.get("project") or {}).get("id")
    if not project_id:
        raise ReadError("keymap.json has no project; run wg load --apply first")
    return project_review_effort(project_id) or REVIEW_DEFAULT


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
                       f"from now on act as references/autonomy.md says for {level}")]
    return [("note", f"autonomy @effort -: {level}")]


def review_effort_command(plan_dir, plan, level):
    """`wg review-effort <plan-dir> [level]`: print the review effort, or set it as the project label."""
    km = load_keymap(plan_dir)
    project_id = (km.get("project") or {}).get("id")
    if not project_id:
        die("keymap.json has no project; run wg load --apply first, then wg review-effort")
    current = effort_review(plan_dir, km)
    if level:
        if level != current or project_review_label(project_id) != review_label(level):
            set_project_review_effort(plan, project_id, level)
        print(f"review effort {level}" + (f" (was {current})" if level != current else ""))
    else:
        level = current
        print(f"review effort {level}")
    # The coordinator knows this level now: wg next tells it only of a later change.
    with plan_lock(plan_dir):
        km = load_keymap(plan_dir)
        run_rows(km)["effort"]["review_seen"] = level
        save_keymap(plan_dir, km)
    return 0


def review_effort_lines(plan_dir, plan):
    """One line with the effort's review effort; a `do review` line when it changed since the coordinator last saw
    it. The run row keeps the level that wg next and wg move follow (review_level)."""
    try:
        level = effort_review(plan_dir)
    except (ReadError, OSError, KeyError, TypeError) as e:
        return [("note", f"review @effort -: review effort not read ({one_line(e, 120)}); keep the last level")]
    with plan_lock(plan_dir):
        km = load_keymap(plan_dir)
        effort = run_rows(km)["effort"]
        seen = effort.get("review_seen")
        if seen != level:
            effort["review_seen"] = level
            save_keymap(plan_dir, km)
    if seen and seen != level:
        return [("do", f"review @effort -: {HUMAN} set the review effort to {level} (was {seen}); from now on "
                       f"review each PR that has not passed its review gate as review-and-merge.md \"Review effort\" "
                       f"says for {level}")]
    return [("note", f"review @effort -: {level}")]


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


def name_coordinator(plan_dir, name, apply, changes):
    """Give the coordinator's Orca worktree the name of the Linear project. Only the display name in Orca
    changes: the path and the branch stay `<slug>-core`. A failure of Orca is a warning; it never stops `wg load`."""
    try:
        tree = find_tree(orca_worktrees(), path=plan_dir)
        if not tree or tree.get("displayName") == name:
            return
        changes.append(f"name the Orca worktree {tree.get('displayName') or tree['path']!r} as {name!r}")
        if apply:
            orca_result("worktree", "set", "--worktree", f"id:{tree['id']}", "--display-name", name)
    except (ReadError, OSError, ValueError, KeyError, subprocess.TimeoutExpired) as e:
        print(f"warn load: Orca did not name the coordinator worktree ({one_line(e, 120)})", file=sys.stderr)


# ---------------------------------------------------------------- the context limit of the coordinator session

# Config `context_limit`: Claude Code compacts a coordinator session at this many tokens. The core worktree's local
# settings file holds it as `autoCompactWindow`; Claude Code reads the file when a session starts.
CONTEXT_SETTINGS = WORKER_SETTINGS_FILES["claude"]
CONTEXT_KEY = "autoCompactWindow"
# Bytes: `wg next` reads this much of the end of the transcript, a larger part only when it finds no call there.
CONTEXT_TAIL = (1 << 16, 1 << 20, 1 << 22, 1 << 24, 1 << 26)
CONTEXT_USAGE = ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens")


def context_settings(plan_dir):
    """The core worktree's local Claude Code settings: {} when the file does not exist. ValueError when it is not
    a JSON object: then wg does not write it."""
    try:
        data = json.loads((Path(plan_dir) / CONTEXT_SETTINGS).read_text())
    except FileNotFoundError:
        return {}
    if not isinstance(data, dict):
        raise ValueError(f"{CONTEXT_SETTINGS} is not a JSON object")
    return data


def loaded_effort(path):
    """`path` is the plan directory of a loaded effort: plan.json is a JSON object, and keymap.json is a JSON
    object with at least one node. Only then does `wg doctor --fix` write its session settings."""
    try:
        plan = json.loads((Path(path) / "plan.json").read_text())
        km = json.loads((Path(path) / "keymap.json").read_text())
    except (OSError, ValueError):
        return False
    return isinstance(plan, dict) and isinstance(km, dict) and isinstance(km.get("nodes"), dict) and bool(km["nodes"])


def core_settings():
    """{agent: values} that wg merges into the core worktree: config `coordinator_settings`, and for claude the
    context limit as `autoCompactWindow`. A context limit that is not 0 replaces an `autoCompactWindow` of
    `coordinator_settings.claude`."""
    values = {agent: dict(v) for agent, v in CONFIG["coordinator_settings"].items() if v}
    if limit := CONFIG["context_limit"]:
        values["claude"] = values.get("claude", {}) | {CONTEXT_KEY: limit}
    return values


def settings_have(plan_dir, agent, values):
    """The settings file of `agent` in `plan_dir` has `values`: a merge would change nothing. ValueError when the
    file does not parse."""
    path = Path(plan_dir) / WORKER_SETTINGS_FILES[agent]
    if not path.exists():
        return False
    try:
        old = json.loads(path.read_text()) if agent == "claude" else tomllib.loads(path.read_text())
    except (json.JSONDecodeError, tomllib.TOMLDecodeError) as e:
        raise ValueError(f"{path}: does not parse ({e})")
    return isinstance(old, dict) and same_settings(merged_settings(old, values), old)


def set_core_settings(plan_dir, apply, changes):
    """Merge core_settings() into the session settings files of the core worktree through the writer of
    `worker_settings` (merge_claude_settings, merge_codex_config): other keys stay, each file stays out of git
    (also when its values are already there), and wg writes through no symlink. Returns the refusals as text;
    each one also prints one warning."""
    problems = []
    for agent, values in core_settings().items():
        path = Path(plan_dir) / WORKER_SETTINGS_FILES[agent]
        try:
            if not settings_have(plan_dir, agent, values):
                what = [f"coordinator_settings.{agent}"] if CONFIG["coordinator_settings"].get(agent) else []
                if agent == "claude" and CONFIG["context_limit"]:
                    what.append(f"{CONTEXT_KEY} {CONFIG['context_limit']}")
                changes.append(f"set {' and '.join(what)} in {path}")
            if apply:
                (merge_claude_settings if agent == "claude" else merge_codex_config)(plan_dir, values)
        except (ReadError, OSError, ValueError, subprocess.SubprocessError) as e:
            problems.append(one_line(e, 200))
            print(f"warn: the coordinator settings are not set ({problems[-1]})", file=sys.stderr)
    return problems


def session_context_tokens(dirs):
    """The context size of the last call of the Claude Code session that runs this command: the input, cache
    write and cache read tokens of the last `assistant` line of its transcript. Only the end of the file is read.
    None when there is no CLAUDE_CODE_SESSION_ID or no transcript. `dirs`: where the session can have started."""
    sid = os.environ.get("CLAUDE_CODE_SESSION_ID") or ""
    if not re.fullmatch(r"[A-Za-z0-9-]+", sid):
        return None
    root = Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude").expanduser() / "projects"
    names = dict.fromkeys(re.sub(r"[^A-Za-z0-9]", "-", str(p)) for d in dirs for p in (Path(d), Path(d).resolve()))
    path = next((root / n / f"{sid}.jsonl" for n in names if (root / n / f"{sid}.jsonl").is_file()), None)
    path = path or next(root.glob(f"*/{sid}.jsonl"), None)
    if not path:
        return None
    with path.open("rb") as f:
        size = f.seek(0, os.SEEK_END)
        for tail in CONTEXT_TAIL:
            f.seek(max(0, size - tail))
            lines = f.read().split(b"\n")[(1 if size > tail else 0):]  # the first line can be a part of a line
            for line in reversed(lines):
                if b'"assistant"' not in line or b'"usage"' not in line:
                    continue
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue
                usage = (entry.get("message") or {}).get("usage") if entry.get("type") == "assistant" else None
                if isinstance(usage, dict) and not entry.get("isSidechain"):
                    return sum(int(usage.get(k) or 0) for k in CONTEXT_USAGE)
            if size <= tail:
                break
    return None


def context_note(plan_dir):
    """The `note context` line of `wg next` when the session that runs it is over config `context_limit`. With
    the setting in place, Claude Code compacts at the next call, so the line waits for 20% more. A failure gives
    no line."""
    limit = CONFIG["context_limit"]
    if not limit:
        return []
    try:
        tokens = session_context_tokens([plan_dir, Path.cwd()])
        in_place = context_settings(plan_dir).get(CONTEXT_KEY) == limit
    except Exception:
        return []
    if not tokens or tokens <= (limit * 6 // 5 if in_place else limit):
        return []
    fix = "" if in_place else f"run wg doctor {shlex.quote(str(Path(plan_dir).resolve()))} --fix, then "
    return [f"note context @effort -: this session holds {tokens // 1000}K tokens, limit {limit // 1000}K; "
            f"{fix}ask {HUMAN} to run /compact"]


@journaled("load")
def load(plan_dir, plan, apply, prune, adopt=False):
    errs = check(plan)
    if errs:
        print("\n".join(errs))
        die("plan.json fails check; fix it first", 1)
    km = load_keymap(plan_dir)
    collab = km.get("collab") if apply else None
    raw = (Path(plan_dir) / "plan.json").read_bytes() if collab else None
    if raw is not None and local_plan(json.loads(raw), collab) != plan:
        raise ReadError("plan.json changed during wg load; check the change and run wg load --apply again")

    def save_progress():
        save_keymap(plan_dir, km, sync=not collab)

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
            save_progress()
    if not collab:
        name_coordinator(plan_dir, eff["name"], apply, changes)
        set_core_settings(plan_dir, apply, changes)
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
                save_progress()
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
                    save_progress()
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
            save_progress()

    for k, n in nodes.items():
        if k not in conflicts and sync_card(n, km["nodes"].get(k), apply, changes, rows.get(k)):
            save_progress()

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
        save_progress()
    if not collab:
        print("\n".join(changes) or "no changes to nodes")
    _sort(km, plan, nodes)
    if collab:
        if hashlib.sha256(raw).hexdigest() != plan_file_sha(plan_dir):
            raise ReadError("plan.json changed during wg load; check the change and run wg load --apply again")
        collab["load_attempt"] = {"sha": hashlib.sha256(raw).hexdigest(),
                                  "payload": plan_payload_sha(plan, km)}
        save_keymap(plan_dir, km, sync=False)
        push_plan(km, collab, plan_workspace(plan), raw, plan=plan)
        save_keymap(plan_dir, km, sync=False)
        name_coordinator(plan_dir, eff["name"], apply, changes)
        set_core_settings(plan_dir, apply, changes)
        print("\n".join(changes) or "no changes to nodes")
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
        "setup": {
            "statuses": [{"name": name, "type": kind} for name, kind in setup_status_types("Needs {name}").items()],
            **setup_labels_contract(),
        },
        "status_aliases": ALIAS,
        "human": {"default": CONTRACT_HUMAN, "status": "Needs {name}", "label": "needs-{slug}", "wait": "wait human",
                  "slug": "lowercase; each run of other characters than a-z and 0-9 is one -; no - at the ends"},
        "labels": {"needs_human": f"needs-{human_slug(CONTRACT_HUMAN)}", "ready_to_merge": MERGE_LABEL, "reviewed": REVIEWED_LABEL,
                   "claim_prefix": "agent:", "answered": ANSWERED_LABEL},
        "project_labels": {"initiative_group": INITIATIVE_GROUP, "autonomy_group": AUTONOMY_GROUP,
                           "autonomy_levels": list(AUTONOMY_LEVELS), "autonomy_default": AUTONOMY_DEFAULT,
                           "review_group": REVIEW_GROUP, "review_prefix": REVIEW_PREFIX,
                           "review_levels": list(REVIEW_LEVELS), "review_default": REVIEW_DEFAULT,
                           "paused": PAUSED_LABEL},
        "card": {"prefix": "**work-graph node card**", "footers": [CARD_FOOTER, EMPTY_CARD],
                 "fields": [*CARD_PLAN_FIELDS, *CARD_RUN_FIELDS], "samples": cards},
        "status_doc": {"title": STATUS_DOC, "fields": ["status", "wave", "lines", "at", "ran", "wait_interval", "contract"]},
        "statuses": list(CONTRACT_STATUSES),
        "satisfied": edges,
        "link": {"version": LINK_VERSION, "path": "/api/link", "to_coordinator": list(LINK_TO_COORDINATOR),
                 "from_coordinator": list(LINK_FROM_COORDINATOR), "commands": list(LINK_COMMANDS),
                 "agent_reply_statuses": list(AGENT_REPLY_STATUSES),
                 "close_codes": LINK_CLOSE_CODES},
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


def open_blockers(k, nodes, deps, st, rows, shared=None):
    def evidence(key):
        row = rows.get(key, {})
        entry = (shared or {}).get(key, {})
        if not row.get("pr") and entry.get("branch") and entry.get("pr"):
            # In Review is the shared record of code done. The other coordinator's head stays local.
            return {"code_done_head": True}
        return row

    return [d for d in deps[k] if not satisfied(nodes[k], nodes[d], st.get(d, "?"), evidence(d))]


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


def review_level(km):
    """The review effort that the coordinator last saw (`wg next`, `wg review-effort`). None seen means the default."""
    level = run_rows(km)["effort"].get("review_seen")
    return level if level in REVIEW_LEVELS else REVIEW_DEFAULT


def review_gate(row, head, issue=None, level=REVIEW_DEFAULT):
    """The PR passed the review gate of its merge request. At `thorough` it is the merge review; at `standard` and
    `light` it is the wave review result (`review=clean` or `accepted`). A gate that passed at any level stays
    passed for its patch (`gate`, the merge review) after a level change; a new patch clears both."""
    if merge_reviewed(row, head, issue) or row.get("gate") in REVIEW_LEVELS:
        return True
    return level != "thorough" and row.get("review") in REVIEW_OK


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


@journaled("ready")
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
            result = gql("""mutation($id:String!,$s:String!){ issueUpdate(id:$id, input:{stateId:$s}){ success } }""",
                         {"id": km["nodes"][k]["id"], "s": states[want]})
            if (result or {}).get("issueUpdate", {}).get("success"):  # journal only a confirmed move
                journal(plan_dir, journal_command("ready"), k, {"status": (s, want)}, kind="status")
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
                level = review_level(km)
                if not review_gate(row, info.get("headRefOid"), issue, level):
                    problems.append(f"{key}: no merge review of this patch: review-and-merge.md \"Merge point\" step 2, "
                                    "then wg run set … merge_review=clean" if level == "thorough" else
                                    f"{key}: no review of this patch at review effort {level}: review-and-merge.md "
                                    "\"Review effort\", then wg run set … review=clean")
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


@journaled("move")
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
    if status_name == "Ready to Merge" and node["kind"] == "task":
        require_page_claim(plan, km, key)
    entry = km["nodes"].get(key) or die(f"{key}: not loaded")
    if status_name == WAIT_STATUS:
        current = project_claims(plan, km)
        if runner := other_runners(plan, current).get(key):
            raise ReadError(f"{key}: {runner} runs this node and sets its wait status")
    ident = entry["identifier"]
    issue = fetch_nodes({"nodes": {key: entry}}).get(entry["id"]) or die(f"{ident}: issue not found")
    if status_name == "Merged" and node["kind"] == "task" and norm(issue["state"], issue_labels(issue)) not in SETTLED:
        require_page_claim(plan, km, key)
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
    journal(plan_dir, journal_command("move"), key, {"status": (norm(issue["state"], issue_labels(issue)), status_name)},
            kind="status")
    before = next((status for status, name in ENG_LABELS.items() if name in markers), old)
    print(f"{ident}: {before} -> {' + '.join(filter(None, [want, marker])) or status_name}")
    if status_name in SETTLED and (collab := km.get("collab")) is not None:
        release_page_claim(collab, plan_workspace(plan), key)
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


@journaled("run set")
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
        if field == "review" and fields.get(started):
            # The head that the reviewer reads: at review effort `standard`, the fix check starts from it.
            row["review_head"] = row.get("code_done_head", "")
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
            if field == "review" and review_level(km) != "thorough":
                # This result is the gate of the merge request at this level: it stays one after a level change.
                row["gate"] = review_level(km)
    save_keymap(plan_dir, km)
    print(" ".join(pairs(row)))
    if key != "@effort":
        refresh_card(plan_dir, plan, key)
    return 0


@journaled("run reset")
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


# The tool checks of `wg preflight` and `wg doctor`: the name of the check and the command that must exit 0.
TOOL_CHECKS = {"gh auth": ("gh", "auth", "status"), "st": ("st", "--version")}


def tool_problem(args, cwd=None):
    """Why the tool command fails, as `<tool>: <error>`, or None when it exits 0."""
    try:
        result = command(*args, cwd=cwd)
    except OSError as e:
        return f"{args[0]}: {e.strerror}"
    return f"{args[0]}: {command_error(result)}" if result.returncode else None


def linear_workflow_check(team, *, setup_workspace=None):
    try:
        team_id, state_ids, labels = team_info(team)
    except ReadError as e:
        if str(e) == f"team {team} not found":
            return [("FAIL", f"{e}. Run wg setup.")]
        raise
    agents = set(AGENT_LABELS) - labels.keys()
    if agents:
        agents -= workspace_labels(agents).keys()
    expected_types = setup_status_types()
    optional = {"Triage", "Backlog", "Duplicate"}
    missing = sorted((expected_types.keys() - optional - state_ids.keys()) | agents)
    setup = f"wg setup --workspace {shlex.quote(setup_workspace)} --apply" if setup_workspace else "wg setup"
    lines = [("FAIL", f"{team} missing {', '.join(missing)}. Run {setup}.")] if missing else [
        ("ok", f"{team} workflow and agent labels")]
    try:
        states = setup_states(team_id)
    except ReadError as e:
        return [*lines, ("warn", f"{team} could not check status types. Run wg setup. {e}")]
    if absent := sorted(optional - states.keys()):
        lines.append(("warn", f"{team} missing {', '.join(absent)}. Run wg setup."))
    for name, expected in expected_types.items():
        if name in states and (actual := states[name]["type"]) != expected:
            lines.append(("warn", f"{team} {name} has type {actual}, expected {expected}. Run wg setup."))
    return lines


def preflight(plan_dir, plan, phase):
    phases = phase_list(plan, phase)
    failed = False

    def line(level, name, detail):
        nonlocal failed
        print(f"{level} {name}: {detail}")
        failed |= level == "FAIL"

    errors = check(plan)
    line("FAIL" if errors else "ok", "plan", "; ".join(errors) if errors else "valid")
    errors = [problem for args in (("git", "rev-parse", "--git-dir"), *TOOL_CHECKS.values())
              if (problem := tool_problem(args, cwd=plan_dir if args[0] == "git" else None))]
    line("FAIL" if errors else "ok", "tools", "; ".join(errors).replace("\n", " ") or "git, gh, st")
    team = plan_team(plan)
    try:
        gql("{ viewer { id } }")
        options = {"setup_workspace": plan_workspace(plan)} if load_keymap(plan_dir).get("collab") is not None else {}
        for level, message in linear_workflow_check(team, **options):
            line(level, "linear", message)
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


PR_BATCH_SIZE = 50  # PRs in one GraphQL request
PAGE = "pageInfo { hasNextPage }"
PR_BATCH_FIELDS = f"""
  state headRefOid isDraft mergeCommit {{ oid }} mergeable baseRefName
  reviews(first: 100) {{ nodes {{ body }} {PAGE} }}
  comments(first: 100) {{ nodes {{ body }} {PAGE} }}
  commits(last: 1) {{ nodes {{ commit {{ statusCheckRollup {{ contexts(first: 100) {{ nodes {{
    __typename
    ... on CheckRun {{ name status conclusion startedAt checkSuite {{ workflowRun {{ event workflow {{ name }} }} }} }}
    ... on StatusContext {{ context state }}
  }} {PAGE} }} }} }} }} }}"""
# The bucket of each check state, as `gh pr checks` sorts them.
CHECK_BUCKETS = {"SUCCESS": "pass", "SKIPPED": "skipping", "NEUTRAL": "skipping", "CANCELLED": "cancel",
                 "ERROR": "fail", "FAILURE": "fail", "TIMED_OUT": "fail", "ACTION_REQUIRED": "fail"}


def latest_checks(contexts):
    """The contexts that `gh pr checks` keeps: the latest start of each status name, and of each check run name,
    workflow name, and event. A failed run and its rerun that passed give one check, the rerun."""
    seen, out = set(), []
    for c in sorted(contexts, key=lambda c: c.get("startedAt") or "", reverse=True):
        if c.get("context"):
            key = ("status", c["context"])
        else:
            # The key of `gh pr checks` joins the three parts with slashes: a name or workflow with a slash in it
            # can give the key of another check, and then only the later of the two counts, as in `gh pr checks`.
            run = ((c.get("checkSuite") or {}).get("workflowRun") or {})
            parts = (c.get("name"), (run.get("workflow") or {}).get("name"), run.get("event"))
            key = ("check", "/".join(part or "" for part in parts))
        if key not in seen:
            seen.add(key)
            out.append(c)
    return out


def rollup_checks(contexts):
    """The (passed, detail) pair of `pr_checks` from the status check contexts of the PR's head commit."""
    if not contexts:
        return True, "no checks"
    checks = []
    for c in latest_checks(contexts):
        if c.get("__typename") == "StatusContext":
            name, state = c.get("context"), c.get("state")
        else:
            name = c.get("name")
            state = c.get("conclusion") if c.get("status") == "COMPLETED" else c.get("status")
        checks.append((name, CHECK_BUCKETS.get(state, "pending")))
    failures = [name for name, bucket in checks if bucket == "fail"]
    pending = sum(bucket == "pending" for _, bucket in checks)
    return not failures, ", ".join(failures) or "no failed checks" + (f" ({pending} pending)" if pending else "")


def batch_entry(pr):
    """(info, checks) of one PR in the batch answer, or None when the answer is not complete for it."""
    if not isinstance(pr, dict) or pr.get("state") not in {"OPEN", "CLOSED", "MERGED"}:
        return None
    lists = {}
    for field in ("reviews", "comments"):
        connection = pr.get(field)
        if not isinstance(connection, dict) or not isinstance(connection.get("nodes"), list) \
                or (connection.get("pageInfo") or {}).get("hasNextPage") is not False:
            return None  # a failed read or a second page: pr_view reads the whole list
        lists[field] = connection["nodes"]
    commits = (pr.get("commits") or {}).get("nodes")
    if not isinstance(commits, list) or len(commits) != 1 or not isinstance(commits[0], dict) \
            or not isinstance(commits[0].get("commit"), dict):
        return None
    rollup = commits[0]["commit"].get("statusCheckRollup")
    if rollup is None:
        contexts = []  # no check and no status on the head commit
    else:
        connection = rollup.get("contexts") if isinstance(rollup, dict) else None
        if not isinstance(connection, dict) or not isinstance(connection.get("nodes"), list) \
                or (connection.get("pageInfo") or {}).get("hasNextPage") is not False \
                or not all(isinstance(c, dict) for c in connection["nodes"]):
            return None  # a failed read or a second page: pr_checks reads every context
        contexts = connection["nodes"]
    info = {field: pr.get(field) for field in PR_FIELDS.split(",")}
    info.update(lists)
    return info, rollup_checks(contexts)


def pr_batch(numbers, cwd=None):
    """{number: (info, checks)} for each PR that GitHub returns in full, with one `gh api graphql` request for each
    50 PRs on the host of the repository.

    `info` has the shape of `pr_view` with PR_FIELDS, and `checks` the (passed, detail) pair of `pr_checks`.
    A PR that is not in the result (a failed request, an error on the PR, or a list longer than one page) is
    for the caller to read with `pr_view` and `pr_checks`. ReadError: no request returned a PR.
    """
    numbers = sorted({n for n in numbers if isinstance(n, str) and re.fullmatch(r"[1-9][0-9]*", n)}, key=int)
    if not numbers:
        return {}
    result = command("gh", "repo", "view", "--json", "owner,name,url", cwd=cwd)
    if result.returncode:
        raise ReadError(command_error(result))
    repo = json.loads(result.stdout)
    owner, name = (repo.get("owner") or {}).get("login"), repo.get("name")
    host = urllib.parse.urlsplit(repo.get("url") or "").hostname
    if not owner or not name or not host:
        raise ReadError("gh repo view: no owner, name, or host")
    out, failures = {}, []
    for start in range(0, len(numbers), PR_BATCH_SIZE):
        chunk = numbers[start:start + PR_BATCH_SIZE]
        query = ("query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) {"
                 + "".join(f" pr{n}: pullRequest(number: {n}) {{{PR_BATCH_FIELDS} }}" for n in chunk) + " } }")
        try:
            result = command("gh", "api", "graphql", "--hostname", host, "-f", f"query={query}",
                             "-f", f"owner={owner}", "-f", f"name={name}", cwd=cwd)
        except (OSError, subprocess.TimeoutExpired) as e:
            failures.append(str(e))
            continue  # this chunk only: the PRs of the requests before it stay in the result
        try:
            answer = json.loads(result.stdout)
            repository = (answer.get("data") or {}).get("repository") or {}
            errors = answer.get("errors") or []
        except (ValueError, AttributeError):
            failures.append(command_error(result))
            continue  # this chunk only: its PRs are read alone
        # An error names the PR alias in its path; an error without one can touch every PR of the chunk.
        failed = set()
        for error in errors:
            path = error.get("path") if isinstance(error, dict) else None
            alias = path[1] if isinstance(path, list) and len(path) > 1 and path[0] == "repository" else None
            if not isinstance(alias, str) or not alias.startswith("pr"):
                failed = set(chunk)
                break
            failed.add(alias[2:])
        if result.returncode and not errors:
            failed = set(chunk)
        for n in chunk:
            entry = None if n in failed else batch_entry(repository.get(f"pr{n}"))
            if entry:
                out[n] = entry
        if failed == set(chunk):
            failures.append(command_error(result))
    if failures and not out:
        raise ReadError(failures[0])
    return out


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


@journaled("verify")
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


REVIEW_FIELDS = ("review", "merge_review", "merge_review_seen", "merge_review_patch", "verified_head", "gate")


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


AGENT_MERGE_REPOS = {}  # plan dir -> its GitHub owner/repo, read once for each process


def agent_merge_repo(plan_dir):
    """True when config `agent_merge` names the GitHub repository of `plan_dir` or its owner. There, at autonomy
    level full, the coordinator merges each PR itself (references/autonomy.md "Where agents may merge"). A failed
    read is False: the human is asked, as at level standard."""
    allowed = CONFIG.get("agent_merge") or []
    if not allowed:
        return False
    key = str(Path(plan_dir).resolve())
    if key not in AGENT_MERGE_REPOS:
        try:
            result = command("gh", "repo", "view", "--json", "nameWithOwner", cwd=plan_dir)
            name = json.loads(result.stdout).get("nameWithOwner") if not result.returncode else None
        except (OSError, ValueError, AttributeError, subprocess.TimeoutExpired):
            name = None
        AGENT_MERGE_REPOS[key] = name
    name = AGENT_MERGE_REPOS[key]
    return bool(name) and any(m.lower() in (name.lower(), name.split("/")[0].lower()) for m in allowed)


CLAIMS_UNAVAILABLE = "claims unavailable"


def next_lines(plan_dir, plan, tolerant=False, *, inputs=None, triage=None, current_claims=None):
    """One status line; then what the coordinator does now (do), waits for (wait), and must know (note).

    It reads Linear, GitHub, and the run rows. For a shared effort it also maintains the page claims.
    """
    km, live, nodes, st, deps, rows = inputs if inputs is not None else snapshot(plan_dir, plan)
    try:
        current = project_claims(plan, km) if current_claims is None else current_claims
        gates = collaboration_lines(plan, km, st, live, current)
    except (ClaimRefused, PlanPageUnavailable) as error:
        return CLAIMS_UNAVAILABLE, [("wait", f"claims page: {error}")]
    shared = km["nodes"] if km.get("collab") is not None else None
    runners = other_runners(plan, current)
    effort = run_rows(km)["effort"]
    level = review_level(km)
    wave = [k for k in effort.get("wave", "").split(",") if k and k not in gates]
    agent_merges = []  # read at the first PR that can merge

    def coordinator_merges():
        # At level full in a repository of config `agent_merge`, a merge is the coordinator's step, not the human's.
        if not agent_merges:
            agent_merges.append(effort.get("autonomy_seen") == "full" and agent_merge_repo(plan_dir))
        return agent_merges[0]
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
    try:
        # One request reads every PR of the run rows. A PR that it does not return is read alone below.
        batch = pr_batch([row.get("pr") for k, row in rows.items() if k not in gates and isinstance(row, dict)], cwd=plan_dir)
    except (ReadError, OSError, json.JSONDecodeError, subprocess.TimeoutExpired) as e:
        warn(f"the request for all PRs failed, so each PR is read alone: {e}")
        batch = {}

    def pr_info(k, number, optional=False):
        if k not in infos:
            if not isinstance(number, str) or not re.fullmatch(r"[1-9][0-9]*", number):
                raise ReadError(f"{k}: invalid PR number {number!r}")
            try:
                result = batch[number][0] if number in batch else pr_view(number, PR_FIELDS, cwd=plan_dir)
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
        if number in batch:
            return batch[number][1][0]
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

    def reviewer_round(number, rounds, row):
        writer = row.get("agent")
        reviewer = {"claude": "codex", "codex": "claude"}.get(writer)
        return f"#{number} round {rounds + 1}" + (f", agent {reviewer}" if reviewer else "")

    def level_review(k, number, row):
        """The review line at review effort `standard` or `light`, also for a PR that left draft."""
        rounds = int(row.get("review_round") or 0)
        if row.get("review_dispatch"):
            add("wait", "reviewer", k, f"#{number} round {rounds or 1}")
        elif level == "light":
            add("do", "review", k, f"#{number}: read the diff yourself")
        elif row.get("review_head"):
            add("do", "review", k, f"#{number}: check the fix since {row['review_head'][:10]}")
        else:
            # No independent review ran, or it started before wg kept the head it read: a reviewer round.
            add("do", "review", k, reviewer_round(number, rounds, row))

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
        elif level != "thorough" and not review_gate(row, info.get("headRefOid"), issue(k), level):
            # No review of this patch (an adopted PR, a level change, a thread fix): the level's own review.
            level_review(k, number, row)
        elif not review_gate(row, info.get("headRefOid"), issue(k), level):
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
        elif coordinator_merges():
            add("do", "merge", k, f"#{number}")
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
            if waiting and open_blockers(k, nodes, deps, st, rows, shared):
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
            if level != "thorough":
                level_review(k, number, row)
            elif row.get("review_dispatch"):
                add("wait", "reviewer", k, f"#{number} round {rounds or 1}")
            elif rounds >= 2:
                add("wait", "human", k, f"#{number}: 2 review rounds had blocking findings; only this PR is held "
                    f"(label {REVIEWED_LABEL!r} accepts them, or ask for one more fix)")
            else:
                add("do", "review", k, reviewer_round(number, rounds, row))
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

    lines.extend(gate for key, gate in gates.items() if key not in nodes and gate[0] == "do")
    for k in order:
        n, s, row = nodes[k], st.get(k), rows.get(k, {})
        if k in gates:
            runner = runners.get(k)
            if runner and s and s not in SETTLED:
                status_name = s.removeprefix("Needs ")
                wait_label = f"needs-{human_slug(runner)}"
                if s.startswith("Needs ") and gates[k] == ("wait", f"owner {k}"):
                    runner = status_name
                waiting = (status_name != s or s == "Ready to Merge"
                           or any(label["name"] == wait_label for label in issue_labels(issue(k))))
            else:
                waiting = False
            if waiting:
                lines.append(("note", f"human {k}: waits on {runner}"))
                if gates[k][0] == "do" or gates[k][1].startswith("stale "):
                    lines.append(gates[k])
            elif s not in SETTLED or gates[k][0] == "do":
                lines.append(gates[k])
            continue
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
            add("do", "reconcile", k, f"state={state}: no receipt of the job is recorded"
                + (f" (step={row['step']})" if row.get("step") else ""))
        elif state == "running" and row.get("step") == "receipt":
            add("do", "reconcile", k, f"job={row.get('job', '?')} dispatch={row.get('dispatch', '?')} runs; "
                "its claim comment is not written: run the same wg dispatch --run or wg claim --send again")
        elif state == "running":
            add("wait", "worker", k, f"job={row.get('job', '?')} dispatch={row.get('dispatch', '?')}")
        elif claims:
            add("do", "reconcile", k, f"{claims[0]} with no job in the run row")
        elif s == WAIT_STATUS:
            add("wait", "human", k, title(k))
        elif current is not None and s.startswith("Needs "):
            lines.append(("note", f"human {k}: waits on {s.removeprefix('Needs ')}"))
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
    if project.get("id") and (current is None or current["role"] == "owner"):
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
              sum(1 for t in mine if t not in gates and reviewed(t)), sum(1 for t in mine if st.get(t) in MERGED))
    head = "phase {}: {} task{}, {} code done, {} reviewed, {} merged".format(
        current["key"], len(mine), "" if len(mine) == 1 else "s", *counts)
    return head + (f"; wave {','.join(wave)}" if wave else ""), lines


PAGE_URL = CONFIG["page_url"] or "http://127.0.0.1:4747"  # the hosted page (config `page_url`), else `wg ui`


def workspace_page(workspace=None):
    return WORKSPACES.get(workspace, {}).get("page_url")


def page_base(workspace=None):
    return (os.environ.get("WG_UI_URL") or workspace_page(workspace) or PAGE_URL).rstrip("/")


def page_link(plan, identifier=None):
    """The link of the effort in the page, or of one of its issues. `WG_UI_URL` names another page."""
    query = {"project": plan["effort"]["name"]}
    workspace = plan_workspace(plan)
    if workspace != DEFAULT_WORKSPACE_ID:
        query["workspace"] = workspace
    if identifier:
        query["issue"] = identifier
    base = page_base(workspace)
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
LINK_CLOSE_CODES = {"restart": 1012, "recycle": 4001}
LINK_RECONNECT_GRACE = 15
LINK_OPEN_TIMEOUT = 3
LINK_TO_COORDINATOR = ("changed", "answer", "reply", "command", "agent-reply")
LINK_FROM_COORDINATOR = ("hello", "state", "asks", "progress", "ack", "wrote", "agents", "agent-reply-result")
AGENT_REPLY_STATUSES = ("delivered", "refused", "unconfirmed")
LINK_COMMANDS = ("next", "dispatch", "pause", "resume", "autonomy")


# What the server forgets when it restarts, and the coordinator sends again when it connects again.
LINK_REPLAYED = ("state", "asks", "progress")


LINK_TOKEN_FILE = Path.home() / ".config/work-graph/link-token"


class LinkTokenError(ReadError):
    pass


def link_token_env(workspace):
    if workspace_page(workspace):
        suffix = workspace.upper().replace("-", "_")
        return f"WG_{suffix}_LINK_TOKEN"
    return "WG_LINK_TOKEN"


def page_origin(url):
    """Validate the URL before using it in a request or deriving a file name."""
    problem = "use a page URL with HTTPS, or configured HTTP on loopback or a tailnet"
    if not url or "?" in url or "#" in url or any(char.isspace() or ord(char) < 32 for char in url):
        raise LinkTokenError(problem)
    try:
        target = urllib.parse.urlsplit(url)
        host, port = target.hostname, target.port
    except ValueError:
        raise LinkTokenError(problem) from None
    if (target.scheme not in ("http", "https", "ws", "wss") or not host
            or not re.fullmatch(r"[a-z0-9.:-]+", host) or target.username is not None):
        raise LinkTokenError(problem)
    if len(host) > 253:
        raise LinkTokenError("the page host must have at most 253 characters")
    return target.scheme, host, port


def private_page_host(host):
    if host == "localhost" or host.endswith(".ts.net"):
        return True
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return False
    return (address.is_loopback or address in ipaddress.ip_network("100.64.0.0/10")
            or address in ipaddress.ip_network("fd7a:115c:a1e0::/48"))


def configured_pages():
    urls = [CONFIG.get("page_url"), *(workspace_page(w) for w in WORKSPACES)]
    return {url.rstrip("/") for url in urls if url}


def page_token_path(url):
    _, host, port = page_origin(url)
    # Colons in IPv6 literals are valid on the systems that run wg.
    name = f"{host}_{port}" if port is not None else host
    filename = f"{name}-token"
    if len(filename) > 255:
        raise LinkTokenError("the page host and port are too long for a token file")
    return LINK_TOKEN_FILE.parent / "pages" / filename


def clean_link_token(token, source):
    if "\n" in token or "\r" in token:
        raise LinkTokenError(f"{source} must contain one line")
    if any(not (" " <= char <= "~") for char in token):
        raise LinkTokenError(f"{source} cannot be sent in an Authorization header")
    return token.strip()


def link_token(workspace=None, *, url=None):
    """Read the first credential source that exists. An empty source disables the token."""
    source = link_token_env(workspace)
    if source in os.environ:
        return clean_link_token(os.environ[source], source)
    path = LINK_TOKEN_FILE.with_name(f"{workspace}-link-token") if workspace_page(workspace) else LINK_TOKEN_FILE
    token = read_link_token_file(path)
    if token is not None:
        return token
    page_url = (workspace_page(workspace) or PAGE_URL).rstrip("/")
    if url:
        scheme, host, port = page_origin(url)
        scheme = {"ws": "http", "wss": "https"}.get(scheme, scheme)
        if (scheme, host, port) != page_origin(page_url):
            return ""
    return read_link_token_file(page_token_path(page_url)) or ""


def read_link_token_file(source):
    try:
        with source.open(encoding="utf-8") as file:
            if stat.S_IMODE(os.fstat(file.fileno()).st_mode) != 0o600:
                raise LinkTokenError(f"{source} must have mode 600")
            token = file.read().removesuffix("\n")
    except FileNotFoundError:
        return None
    except (OSError, UnicodeError):
        raise LinkTokenError(f"{source} cannot be read") from None
    return clean_link_token(token, source)


def link_token_for(url, workspace=None):
    # Only the origin identifies the token. Request paths can contain queries.
    target = urllib.parse.urlsplit(url)
    base = target._replace(path="", query="", fragment="").geturl()
    token = link_token(workspace, url=base)
    if token:
        scheme, host, port = page_origin(base)
        trusted_tailnet = private_page_host(host) and any(
            page_origin(page) == ("http", host, port) for page in configured_pages() if page.startswith("http:"))
        if scheme not in ("https", "wss") and host not in ("127.0.0.1", "localhost", "::1") and not trusted_tailnet:
            raise LinkTokenError("the link token requires HTTPS for a page outside loopback or the configured tailnet")
    return token


class PlanPageUnavailable(ReadError):
    pass


class PlanVersionConflict(ReadError):
    def __init__(self, data):
        super().__init__(f"the server has plan v{data.get('version')} by {plan_writer(data)}; "
                         "run wg pull, compare both changes, and run wg load --apply again")


class NoPlanRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def plan_writer(data):
    name = str(data.get("writer") or "an unknown writer")
    return " ".join("".join(char for char in name if char.isprintable() or char.isspace()).split())


class ClaimRefused(ReadError):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def claim_request(collab, workspace, method, key=None, body=None):
    try:
        page, headers = collab_page(collab, workspace)
    except PlanPageUnavailable as error:
        raise PlanPageUnavailable(f"the claims page is unavailable: {error}") from None
    project = urllib.parse.quote(collab["project"], safe="")
    path = f"/api/projects/{project}/claims"
    if key is not None:
        path += "/" + urllib.parse.quote(key, safe="")
    if body is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(page + path, method=method, headers=headers,
                                     data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.build_opener(NoPlanRedirect).open(request, timeout=10) as response:
            return None if response.status == 204 else json.load(response)
    except urllib.error.HTTPError as error:
        with error:
            if error.code >= 500 or error.code == 429:
                raise PlanPageUnavailable(f"the claims page answered HTTP {error.code}") from None
            try:
                result = json.load(error)
            except ValueError:
                result = {}
            detail = result.get("error") or f"the claims page answered HTTP {error.code}"
            if (held := result.get("claim")) and error.code == 409:
                detail += f": {held['holder']}, job={held['job']}, lease ends {held['leaseUntil']}"
                if method == "POST" and held.get("stale"):
                    detail += "; the lease ended. Ask before using wg claim --takeover"
            raise ClaimRefused(error.code, detail) from None
    except (OSError, http.client.HTTPException, ValueError) as error:
        raise PlanPageUnavailable(f"the claims page did not give a valid answer ({type(error).__name__})") from None


def start_page_claim(plan_dir, plan, key, job, *, takeover=False):
    collab = load_keymap(plan_dir).get("collab")
    if collab is None:
        if takeover:
            raise ReadError("--takeover needs a collaborative effort")
        return False
    body = {"job": job}
    if takeover:
        body["takeover"] = True
    result = claim_request(collab, plan_workspace(plan), "POST", key, body)
    return result.get("action") == "taken_over"


def release_page_claim(collab, workspace, key):
    try:
        claim_request(collab, workspace, "DELETE", key)
    except ReadError as error:
        if isinstance(error, ClaimRefused) and error.status == 404:
            return True  # The claim is already absent.
        print(f"warn {key}: could not release claim: {error}", file=sys.stderr)
        return False
    return True


@contextlib.contextmanager
def dispatch_lease(plan_dir, plan, km, key):
    """Release a failed dispatch's reservation, including after an ambiguous POST response."""
    collab = km.get("collab")
    retained = False

    def retain():
        nonlocal retained
        retained = True

    if collab is None:
        yield retain
        return
    attempted = False
    try:
        try:
            start_page_claim(plan_dir, plan, key, "dispatch")
        except PlanPageUnavailable:
            attempted = True
            raise
        attempted = True
        yield retain
    finally:
        if attempted and not retained and release_page_claim(collab, plan_workspace(plan), key):
            print(f"released {key}: dispatch did not complete", file=sys.stderr)


def claim_gate_keys(lines):
    held = {text.rsplit(": job=", 1)[0].rsplit(" ", 1)[-1] for level, text in lines
            if level == "wait" and text.startswith("collaborator ")}
    held.update(text.split()[1].rstrip(":") for level, text in lines
                if text.startswith(("stale ", "owner ")) or (level == "note" and text.startswith("human "))
                or (text.startswith("reconcile ") and text.split()[1].endswith(":")))
    return held


def claim_loss(held):
    return f"{held['holder']} holds this node now" if held else "no claim"


def require_page_claim(plan, km, key):
    collab = km.get("collab")
    if collab is None:
        return
    workspace = plan_workspace(plan)
    claims = claim_request(collab, workspace, "GET")["claims"]
    held = next((claim for claim in claims if claim["node"] == key), None)
    if not held or not held["mine"]:
        raise ReadError(f"{key}: {claim_loss(held)}")
    claim_request(collab, workspace, "PUT", key, {"job": held["job"]})


OWNER_NODES = {"merge-point", "ship-point", "ops", "decision"}


def project_claims(plan, km):
    if (collab := km.get("collab")) is not None:
        return claim_request(collab, plan_workspace(plan), "GET")
    return None


def other_runners(plan, current):
    """The nodes this coordinator must leave to another runner, including stale claims."""
    if current is None:
        return {}
    runners = ({n["key"]: "the owner" for n in plan["nodes"] if n["kind"] in OWNER_NODES}
               if current["role"] != "owner" else {})
    runners.update({held["node"]: held["holder"] for held in current["claims"] if not held["mine"]})
    return runners


def collaboration_lines(plan, km, statuses, live, current=None):
    """Return gates by node and maintain local claims."""
    collab = km.get("collab")
    if collab is None:
        return {}
    workspace = plan_workspace(plan)
    current = current if current is not None else project_claims(plan, km)
    claims = {claim["node"]: claim for claim in current["claims"]}
    rows = run_rows(km)["nodes"]
    gates = {}
    if current["role"] != "owner":
        gates.update({n["key"]: ("wait", f"owner {n['key']}") for n in plan["nodes"]
                      if n["kind"] in OWNER_NODES})
    for key, row in rows.items():
        entry = km["nodes"].get(key, {})
        issue = live.get(entry.get("id"), {})
        label = f"agent:{row.get('agent')}"
        local_job = row.get("state") in LIVE or any(item["name"] == label for item in claim_labels(issue))
        if statuses.get(key) not in SETTLED and local_job:
            held = claims.get(key)
            if not held or not held["mine"]:
                gates[key] = ("do", f"reconcile {key}: {claim_loss(held)}")
    for key, held in claims.items():
        if held["mine"]:
            if statuses.get(key) in SETTLED:
                release_page_claim(collab, workspace, key)
                continue
            if not rows.get(key):
                gates[key] = ("do", f"reconcile {key}: this account holds a claim with no local job")
                continue
            try:
                claim_request(collab, workspace, "PUT", key, {"job": held["job"]})
            except ClaimRefused as error:
                if error.status not in (409, 404):
                    raise
                gates[key] = ("do", f"reconcile {key}: {error}")
        elif key in gates:
            continue
        elif held["stale"]:
            end = datetime.fromisoformat(held["leaseUntil"])
            age = max(0, int((utc_now() - end).total_seconds()))
            gates[key] = ("note", f"stale {key}: {held['holder']}, lease ended {age}s ago")
        else:
            gates[key] = ("wait", f"collaborator {held['holder']} {key}: job={held['job']}")
    return gates


def collab_page(collab, workspace):
    if not collab.get("workspace"):
        raise ReadError("the collaboration record needs a workspace")
    page = login_page_url(collab["page"], workspace)
    token = collaboration_page_token(page, workspace, shared=collab["workspace"].startswith("shared:"))
    if not token:
        raise PlanPageUnavailable("no page token; run wg login for the page")
    return page, {"Authorization": f"Bearer {token}", "x-workspace": collab["workspace"]}


def collaboration_page_token(page, workspace, *, shared=False):
    if shared:
        if token := read_link_token_file(page_token_path(page)):
            return token
        for candidate in WORKSPACES:
            if (workspace_page(candidate) or PAGE_URL or "").rstrip("/") == page:
                if token := link_token_for(page, candidate):
                    return token
        return ""
    configured = (workspace_page(workspace) or PAGE_URL or "").rstrip("/")
    return (link_token_for(page, workspace) if page == configured
            else read_link_token_file(page_token_path(page)))


def plan_request(collab, workspace, method, body=None, *, history=False):
    page, headers = collab_page(collab, workspace)
    project = urllib.parse.quote(collab["project"], safe="")
    url = f"{page}/api/projects/{project}/plan"
    if history:
        url += "/versions"
    version = collab.get("version")
    if method == "PUT":
        headers["Content-Type"] = "application/json"
        headers["If-Match" if version else "If-None-Match"] = f'"{version}"' if version else "*"
    elif version and not history:
        headers["If-None-Match"] = f'"{version}"'
    request = urllib.request.Request(url, headers=headers, method=method,
                                     data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.build_opener(NoPlanRedirect).open(request, timeout=10) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        with error:
            if error.code == 304 and method == "GET":
                return None
            if error.code == 412 and method == "PUT":
                raise PlanVersionConflict(json.load(error)) from None
            if error.code in (401, 403):
                raise ReadError(f"the plan page refused the token (HTTP {error.code}); check wg login and project access") from None
            if error.code >= 500 or error.code == 429:
                raise PlanPageUnavailable(f"the plan page answered HTTP {error.code}") from None
            raise ReadError(f"the plan page answered HTTP {error.code}") from None
    except (OSError, http.client.HTTPException) as error:
        raise PlanPageUnavailable(f"the plan page did not answer ({type(error).__name__})") from None


def shared_keymap(km):
    shared = {field: km[field] for field in ("project", "milestones") if field in km}
    if (doc := km.get("status_doc")) and doc.get("id"):
        shared["status_doc"] = {"id": doc["id"]}
    shared["nodes"] = {}
    for key, entry in km.get("nodes", {}).items():
        fields = {field: entry[field] for field in ("id", "identifier", "branch", "pr") if field in entry}
        if (card := entry.get("card")) and card.get("id"):
            fields["card"] = {"id": card["id"]}
        shared["nodes"][key] = fields
    return shared


def plan_file_sha(plan_dir):
    return hashlib.sha256((Path(plan_dir) / "plan.json").read_bytes()).hexdigest()


def shared_effort(effort):
    return {field: effort[field] for field in ("name", "summary") if field in effort}


def collab_settings(effort):
    return {field: value for field, value in effort.items() if field not in shared_effort(effort)}


def new_collab_record(page, workspace, project, local_plan):
    """The join command supplies its own settings and a verified Linear project name."""
    effort = local_plan["effort"]
    return {"page": page, "workspace": workspace, "project": project, "name": effort["name"],
            "settings": collab_settings(effort)}


def local_plan(plan, collab):
    if "settings" in collab:
        plan = plan | {"effort": shared_effort(plan["effort"]) | collab["settings"]}
    return normalize_plan(plan)


def plan_payload_sha(plan, km):
    data = json.dumps({"plan": plan, "keymap": shared_keymap(km)}, sort_keys=True)
    return hashlib.sha256(data.encode()).hexdigest()


def push_plan(km, collab, workspace, raw, *, plan=None):
    if plan is None:
        plan = json.loads(raw)
    plan.setdefault("edges", [])
    answer = plan_request(collab, workspace, "PUT", {"plan": plan, "keymap": shared_keymap(km)})
    km["collab"] = collab | {"version": answer["version"], "plan_sha": hashlib.sha256(raw).hexdigest()}
    km["collab"]["remote_settings"] = collab_settings(plan["effort"])
    km["collab"].pop("pending", None)
    km["collab"].pop("load_attempt", None)


def share_plan(plan_dir):
    km = load_keymap(plan_dir)
    if km.get("collab"):
        print("the effort is already shared")
        return 0
    project = (km.get("project") or {}).get("id")
    if not project:
        raise ReadError("run wg load --apply before wg share")
    plan = load_plan(plan_dir)
    workspace = plan_workspace(plan)
    collab = new_collab_record(login_page_url(None, workspace), workspace, project, plan)
    share_branch_and_pr({}, km)
    raw = (Path(plan_dir) / "plan.json").read_bytes()
    push_plan(km, collab, workspace, raw, plan=plan)
    save_keymap(plan_dir, km)
    print(f"shared plan v{km['collab']['version']}")
    return 0


def remote_plan(collab, workspace, *, force=False):
    data = plan_request(collab | ({"version": None} if force else {}), workspace, "GET")
    if data is None:
        return None
    if (not isinstance(data, dict) or type(data.get("version")) is not int
            or not isinstance(data.get("plan"), dict) or not isinstance(data.get("keymap"), dict)):
        raise ReadError("the page returned an invalid plan")
    plan, keymap = data["plan"], data["keymap"]
    if (not isinstance(plan.get("effort"), dict)
            or any(not isinstance(plan.get(field), list) or any(not isinstance(entry, dict) for entry in plan[field])
                   for field in ("phases", "nodes", "edges"))):
        raise ReadError("the page returned invalid plan fields")
    project = keymap.get("project")
    if not isinstance(project, dict) or project.get("id") != collab["project"]:
        raise ReadError("the shared keymap has the wrong project id")
    if (not isinstance(keymap.get("nodes", {}), dict)
            or not isinstance(keymap.get("milestones", {}), dict)
            or not isinstance(keymap.get("status_doc", {}), dict)):
        raise ReadError("the page returned invalid keymap fields")
    return data


def plan_revision_writer(data, collab, workspace):
    if not data.get("writer"):
        try:
            history = plan_request(collab, workspace, "GET", history=True)
            data = next((row for row in history["versions"] if row["version"] == data["version"]), data)
        except (ReadError, KeyError, TypeError, ValueError):
            pass
    return plan_writer(data)


def replace_shared_keymap(km, incoming):
    result = dict(km)
    shared = shared_keymap(incoming)
    result.update(project=shared["project"],
                  milestones=km["milestones"] | shared.get("milestones", {}),
                  nodes=km["nodes"] | shared["nodes"])
    doc = {field: km["status_doc"][field] for field in ("sha", "at") if field in km.get("status_doc", {})}
    doc.update(shared.get("status_doc", {}))
    if doc:
        result["status_doc"] = doc
    else:
        result.pop("status_doc", None)
    for key, entry in shared["nodes"].items():
        old = km["nodes"].get(key, {})
        if old.get("id") == entry.get("id"):
            result["nodes"][key] = entry = old | entry
        if "published" in old:
            entry["published"] = old["published"]
        card = old.get("card", {})
        if entry.get("card") == {"id": card.get("id")} and "sha" in card:
            entry["card"]["sha"] = card["sha"]
    return result


def share_branch_and_pr(before, km):
    old_run = before.get("run", {}).get("nodes", {})
    for key, row in km.get("run", {}).get("nodes", {}).items():
        if key in km["nodes"]:
            for field in ("branch", "pr"):
                if row.get(field) and row[field] != old_run.get(key, {}).get(field):
                    km["nodes"][key][field] = row[field]


def apply_keymap_changes(before, after, remote, conflict):
    """Carry the local field changes onto a newer keymap for the same plan."""
    result = dict(remote)
    missing = object()
    for key in before.keys() | after.keys():
        old, new, current = (mapping.get(key, missing) for mapping in (before, after, remote))
        if old == new:
            continue
        if all(isinstance(value, dict) for value in (old, new, current)):
            result[key] = apply_keymap_changes(old, new, current, conflict)
        elif current != old and current != new:
            raise conflict
        elif new is missing:
            result.pop(key, None)
        else:
            result[key] = new
    return result


_PLAN_WARNED = contextvars.ContextVar("plan_warned", default=False)


def warn_plan(message):
    if not _PLAN_WARNED.get():
        print(f"warn plan: {message}", file=sys.stderr)
        _PLAN_WARNED.set(True)


def valid_shared_branch(value):
    return (isinstance(value, str) and bool(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]*", value))
            and ".." not in value and not value.endswith(".")
            and all(part and not part.startswith(".") and not part.endswith(".lock") for part in value.split("/")))


def validate_shared_plan(plan, name):
    if plan["effort"].get("name") != name:
        raise ReadError("the shared plan has the wrong project name")
    component = r"[A-Za-z0-9][A-Za-z0-9_-]{0,79}"
    slug = plan["effort"].get("slug")
    if not isinstance(slug, str) or not re.fullmatch(component, slug):
        raise ReadError("unsafe effort.slug")
    for phase in plan["phases"]:
        if not re.fullmatch(component, str(phase["key"])) or not valid_shared_branch(phase["target"]):
            raise ReadError("unsafe phase key or target branch")
    for node in plan["nodes"]:
        if not isinstance(node["key"], str) or not re.fullmatch(r"[a-z0-9-]{1,40}", node["key"]):
            raise ReadError("unsafe node key")
        if node.get("lane") is not None and not re.fullmatch(component, str(node["lane"])):
            raise ReadError("unsafe node lane")
    if problems := check(plan):
        raise ReadError("shared plan fails wg check: " + "; ".join(problems))


def validate_shared_mapping(km, incoming, workspace, project, plan, local):
    nodes, old = incoming.get("nodes", {}), km["nodes"]
    old_plan_nodes = {node["key"]: node for node in local.get("nodes", [])}
    changes = {}
    references = set()
    for node in plan["nodes"]:
        for field in ("issue", "eng"):
            if node.get(field) and node[field] != old_plan_nodes.get(node["key"], {}).get(field):
                references.add(node[field])
    for key, entry in nodes.items():
        if (not isinstance(entry, dict) or not isinstance(entry.get("id"), str) or not entry["id"]
                or not isinstance(entry.get("identifier"), str)
                or not re.fullmatch(r"[A-Z][A-Z0-9]{0,9}-[0-9]{1,9}", entry["identifier"])
                or not isinstance(entry.get("card", {}), dict)):
            raise ReadError("invalid shared issue mapping")
        if "branch" in entry and not valid_shared_branch(entry["branch"]):
            raise ReadError("unsafe shared branch")
        if "pr" in entry and not re.fullmatch(r"[1-9][0-9]*", str(entry["pr"])):
            raise ReadError("invalid shared PR number")
        if any(entry.get(field) != old.get(key, {}).get(field) for field in ("id", "identifier")):
            changes[key] = entry
    if any(not isinstance(value, str) or not value for value in incoming.get("milestones", {}).values()):
        raise ReadError("invalid shared milestone mapping")
    milestones = {value for key, value in incoming.get("milestones", {}).items()
                  if value != km["milestones"].get(key)}
    token = LINEAR_WORKSPACE.set(workspace)
    try:
        if changes:
            issues = fetch_nodes({"nodes": changes})
            for entry in changes.values():
                issue = issues.get(entry["id"]) or {}
                if (issue.get("project") or {}).get("id") != project or issue.get("identifier") != entry.get("identifier"):
                    raise ReadError("the shared keymap has an issue outside the project or an incorrect identifier")
        for identifier in sorted(references):
            issue = find_issue(identifier) or {}
            if (issue.get("project") or {}).get("id") != project:
                raise ReadError(f"the shared plan references {identifier} outside the project")
        if milestones:
            found = {item["id"] for item in project_entries(project, "projectMilestones", "id")}
            if not milestones <= found:
                raise ReadError("the shared keymap has a milestone outside the project")
        for key, entry in nodes.items():
            card = entry.get("card") or {}
            prior = old.get(key, {})
            if card.get("id") and (card["id"] != (prior.get("card") or {}).get("id") or entry["id"] != prior.get("id")):
                result = gql("query($id:String!){ comment(id:$id){ issue { id } } }", {"id": card["id"]})
                if (((result.get("comment") or {}).get("issue")) or {}).get("id") != entry["id"]:
                    raise ReadError("the shared keymap has a card outside its issue")
        document = (incoming.get("status_doc") or {}).get("id")
        if document and document != (km.get("status_doc") or {}).get("id"):
            result = gql("query($id:String!){ document(id:$id){ project { id } } }", {"id": document})
            if (((result.get("document") or {}).get("project")) or {}).get("id") != project:
                raise ReadError("the shared keymap has a status document outside the project")
    finally:
        LINEAR_WORKSPACE.reset(token)


def sync_shared_keymap(plan_dir, km):
    collab = km["collab"]
    old, new = collab["pending"], shared_keymap(km)
    raw = (Path(plan_dir) / "plan.json").read_bytes()
    if hashlib.sha256(raw).hexdigest() != collab.get("plan_sha"):
        raise ReadError("plan.json has local changes; run wg load --apply")
    local = local_plan(json.loads(raw), collab)
    workspace = plan_workspace(local)
    plan = json.loads(raw)
    if "remote_settings" in collab:
        plan["effort"] = shared_effort(plan["effort"]) | collab["remote_settings"]
    plan.setdefault("edges", [])
    try:
        push_plan(km, collab, workspace, raw, plan=plan)
    except PlanVersionConflict as conflict:
        data = remote_plan(collab, workspace)
        if not data or data["plan"] != plan:
            raise
        validate_shared_mapping(km, data["keymap"], workspace, collab["project"], local, local)
        incoming = shared_keymap(data["keymap"])
        merged = replace_shared_keymap(km, apply_keymap_changes(old, new, incoming, conflict))
        push_plan(merged, collab | {"version": data["version"]}, workspace, raw, plan=plan)
        print(f"note plan v{data['version']} by {plan_revision_writer(data, collab, workspace)}")
        km.clear()
        km.update(merged)
    save_keymap(plan_dir, km, sync=False)


def publish_pending_keymap(plan_dir, km):
    if "pending" in km["collab"] and not _PLAN_WARNED.get():
        try:
            sync_shared_keymap(plan_dir, km)
        except (ReadError, OSError, ValueError) as error:
            warn_plan(f"shared keymap changes are pending ({error})")


def finish_plan_pair(plan_dir, km):
    collab = km["collab"]
    staged = collab.get("pull_pending")
    if not staged:
        return
    path = Path(plan_dir) / "plan.json"
    current = plan_file_sha(plan_dir) if path.exists() else None
    if current != collab["plan_sha"]:
        if current != staged["prior"]:
            raise ReadError("plan.json changed during an interrupted pull; save your edits before recovering the pull")
        save_json(path, staged["plan"])
    del collab["pull_pending"]
    save_keymap(plan_dir, km, sync=False)


def stage_plan_pair(plan_dir, km, plan, prior):
    collab = km["collab"]
    collab["plan_sha"] = hashlib.sha256((json.dumps(plan, indent=2) + "\n").encode()).hexdigest()
    collab["pull_pending"] = {"prior": prior, "plan": plan}
    save_keymap(plan_dir, km, sync=False)
    finish_plan_pair(plan_dir, km)


def pull_plan(plan_dir, *, force=False, explicit=False, applying=False, strict=False, accept_settings=False, quiet=False):
    with plan_lock(plan_dir):
        km = load_keymap(plan_dir)
        if not (collab := km.get("collab")):
            if explicit:
                raise ReadError("this effort is not shared; run wg share first")
            return
        finish_plan_pair(plan_dir, km)
        path = Path(plan_dir) / "plan.json"
        try:
            local = load_plan(plan_dir, strict=strict or force)
        except (OSError, ValueError):
            if not force or "settings" not in collab:
                raise
            local = {"effort": collab["settings"]}
        workspace = plan_workspace(local)
        if "settings" not in collab:  # A local record from before settings were saved.
            collab.update(name=local["effort"]["name"], settings=collab_settings(local["effort"]))
        try:
            data = remote_plan(collab, workspace, force=force or accept_settings)
        except PlanPageUnavailable as error:
            if explicit or applying:
                raise
            if not quiet:
                warn_plan(f"{error}; using the local copy")
            return
        if data is None:
            if not applying:
                publish_pending_keymap(plan_dir, km)
            if explicit:
                print(f"plan v{collab['version']} is current")
            return
        writer = plan_revision_writer(data, collab, workspace)
        prior = plan_file_sha(plan_dir) if path.exists() else None
        dirty = prior is None or prior != collab.get("plan_sha")
        version = data["version"]
        wire = data["plan"]
        remote_settings = collab_settings(wire["effort"])
        settings = collab["settings"]
        changes = sorted(field for field, value in remote_settings.items() if field not in settings or value != settings[field])
        old_settings = settings
        if accept_settings:
            settings = settings | remote_settings
        attempt = collab.get("load_attempt", {})
        recovered = bool(attempt and prior == attempt["sha"] and attempt["payload"] == plan_payload_sha(wire, data["keymap"]))
        saved_attempt = explicit and prior is not None and prior == attempt.get("sha")
        if dirty and not (force or recovered or saved_attempt or (accept_settings and version == collab["version"])):
            raise ReadError(f"the server has plan v{version} by {writer}; save your change, "
                            f"run wg pull {shlex.quote(str(plan_dir))} --force, and make your change again")
        if applying and not recovered:
            raise ReadError(f"the server has plan v{version} by {writer}; run wg pull, then run wg load --apply again")
        source = local if dirty and accept_settings and version == collab["version"] and not force else wire
        plan = normalize_plan(source | {"effort": shared_effort(source["effort"]) | settings})
        try:
            validate_shared_plan(plan, collab["name"])
            validate_shared_mapping(km, data["keymap"], workspace, collab["project"], plan, local)
        except (KeyError, AttributeError, TypeError) as error:
            raise ReadError("the page returned invalid plan or keymap fields") from error
        after = replace_shared_keymap(km, data["keymap"])
        base = after["collab"] = collab | {"version": version, "settings": settings,
                                          "remote_settings": remote_settings}
        base.pop("load_attempt", None)
        if "pending" in collab:
            incoming = shared_keymap(after)
            conflict = ReadError("the page also changed a pending keymap field")
            try:
                after = replace_shared_keymap(after, apply_keymap_changes(
                    collab["pending"], shared_keymap(km), incoming, conflict))
                base["pending"] = incoming
            except ReadError:
                warn_plan(f"{conflict}; local changes still pending")
                if explicit or applying:
                    raise
                return
        if dirty and saved_attempt and not (force or recovered):
            backup = path.with_name(f"plan.conflict-{prior[:12]}.json")
            if not backup.exists():
                save_json(backup, json.loads(path.read_bytes()))
            print(f"saved local plan edits in {backup.name}")
        stage_plan_pair(plan_dir, after, plan, prior)
        for field in changes:
            label = f"note effort.{json.dumps(field)[1:-1]} from {writer}"
            if accept_settings:
                print(f"{label}: accepted {json.dumps(remote_settings[field])} "
                      f"(local value was {json.dumps(old_settings.get(field))})")
            else:
                print(f"{label}: kept the local setting")
        if dirty and force and not recovered:
            print("discarded local plan changes")
        print(f"note plan v{version} by {writer}")
        if not applying:
            publish_pending_keymap(plan_dir, after)


def read_current_plan(plan_dir, *, strict=False, applying=False, quiet=False):
    if load_keymap(plan_dir).get("collab"):
        pull_plan(plan_dir, strict=strict, applying=applying, **({"quiet": True} if quiet else {}))
    return load_plan(plan_dir, strict=strict)


def join_workspace(effort, project, page):
    team, name = effort.get("team"), effort["name"]
    workspace = effort.get("workspace", DEFAULT_WORKSPACE_ID)
    if not isinstance(workspace, str) or not re.fullmatch(r"[a-z0-9-]+", workspace):
        raise ReadError("the shared plan has an invalid Linear workspace id")
    if not isinstance(team, str) or not team:
        raise ReadError("the shared plan needs effort.team; ask the owner to set it and publish the plan")
    has_key = False
    for candidate in WORKSPACES:
        if not key_source(candidate)[0]:
            continue
        has_key = True
        try:
            plan_workspace({"effort": {"workspace": candidate, "team": team}})
        except ValueError:
            continue
        scope = LINEAR_WORKSPACE.set(candidate)
        try:
            linear = gql("""query($id:String!,$team:String!){
                teams(filter:{key:{eq:$team}}){nodes{id}}
                project(id:$id){id name teams{nodes{id}}} }""", {"id": project, "team": team})
        except ReadError:
            continue
        finally:
            LINEAR_WORKSPACE.reset(scope)
        result = linear.get("project") or {}
        member_teams = {row["id"] for row in result.get("teams", {}).get("nodes", [])}
        if result.get("id") == project and result.get("name") == name and any(
                row["id"] in member_teams for row in linear.get("teams", {}).get("nodes", [])):
            return candidate, has_key
    print(f"Add or update this entry in workspaces in {CONFIG_PATH}:")
    print(json.dumps({"id": workspace, "team": team, "key_env": [], "page_url": page}, indent=2))
    print(f"Set {key_env_name(workspace)} or save your Linear key in "
          f"~/.config/work-graph/{workspace}-linear-api-key with mode 600.")
    return None, has_key


def join_worktree(repo, plan, page, project):
    repo = Path(git_output("rev-parse", "--show-toplevel", cwd=repo)).resolve()
    name = f"{plan['effort']['slug']}-core"
    branch = BRANCH_PREFIX + name
    entries = git_output("worktree", "list", "--porcelain", "-z", cwd=repo)
    for entry in entries.split("\0\0"):
        fields = entry.split("\0")
        if f"branch refs/heads/{branch}" in fields:
            return Path(fields[0].removeprefix("worktree "))
    target = plan["phases"][0]["target"] if plan["phases"] else "main"
    args = ("--name", name, "--branch", branch, "--repo", f"path:{repo}", "--no-parent",
            "--base-branch", f"origin/{target}", "--setup", "skip")
    if not orca_caller():
        print("Create the coordinator worktree in Orca, then run wg join again:")
        print(f"  {shlex.join([orca_cli(), 'worktree', 'create', *args, '--json'])}")
        print(f"  {shlex.join(['wg', 'join', page, '--project', project, '--repo', str(repo)])}")
        return None
    tree = created_tree(*args)
    path = Path(tree["path"])
    if problem := repo_problem(name, path, repo) or branch_problem(name, path, branch):
        raise ReadError(problem)
    return path


def join_display_name(name):
    return "".join(char for char in name
                   if unicodedata.category(char) not in {"Cc", "Cf", "Cs", "Zl", "Zp"}).strip()[:120]


def is_join_link(argument):
    value = argument.partition("=")[2] if argument.startswith("--") and "=" in argument else argument
    try:
        path = urllib.parse.urlsplit(value).path
    except ValueError:
        path = re.split(r"[?#]", value, maxsplit=1)[0]
    return "/join/" in urllib.parse.unquote(path).casefold()


def join_project(ns):
    if ns.page_url is None and not (workspace_page(DEFAULT_WORKSPACE_ID) or CONFIG.get("page_url")):
        raise ReadError("Give wg join the page URL. Open the collab link in a browser first.")
    page = login_page_url(ns.page_url, DEFAULT_WORKSPACE_ID)
    token = collaboration_page_token(page, DEFAULT_WORKSPACE_ID, shared=True)
    if not token:
        origin = urllib.parse.urlsplit(page)._replace(path="").geturl()
        raise ReadError("Open the collab link in a browser, sign in, and press Join. "
                        f"Make a coordinator token in Settings and run wg login {shlex.quote(origin)}.")
    status = token_page_request(page, "/api/status", token)
    workspaces = status.get("workspaces") if isinstance(status, dict) else None
    if not isinstance(workspaces, list) or any(
            not isinstance(entry, dict) or not isinstance(entry.get("id"), str) for entry in workspaces):
        raise ReadError("The page returned an invalid workspace list.")
    members = [entry for entry in workspaces if entry["id"].startswith("shared:")]
    if any(not isinstance(entry.get(field), str) or not entry[field]
           for entry in members for field in ("name", "owner", "role", "projectId")):
        raise ReadError("The page returned invalid shared project fields.")
    if any(not re.fullmatch(r"shared:[A-Za-z0-9-]+", entry["id"]) for entry in members):
        raise ReadError("The page returned an invalid shared membership id.")
    if not members:
        raise ReadError("Open the collab link in a browser and press Join first.")
    projects = [entry for entry in members if ns.project is None or entry["id"] == ns.project]
    if not projects:
        projects = [entry for entry in members if entry["name"].casefold() == ns.project.casefold()]
    if not projects:
        raise ReadError("No shared project with that name. Run wg join without --project to see your projects.")
    if len(projects) > 1:
        print("Shared projects. Select one with --project:")
        for entry in projects:
            name, owner, role = (join_display_name(entry[field]) for field in ("name", "owner", "role"))
            print(f"  {entry['id']}  {name} by {owner} ({role})")
        raise ReadError("Select one shared project by its id.")
    member = projects[0]
    if member["role"] != "collaborator":
        raise ReadError("A read-only member cannot run wg on this project.")
    page_name = status.get("human")
    if page_name != HUMAN:
        check_collaboration_human(join_display_name(page_name) if isinstance(page_name, str) else None)
        raise ReadError("The page returned an invalid account name.")
    project, name = member["projectId"], member["name"]
    collab = {"page": page, "workspace": member["id"], "project": project}
    data = remote_plan(collab, DEFAULT_WORKSPACE_ID)
    wire = data["plan"]
    workspace, has_key = join_workspace(wire["effort"] | {"name": name}, project, page)
    if workspace is None:
        if has_key:
            query = urllib.parse.urlencode({"workspace": member["id"], "project": project})
            print(f"Open {page}/?{query} and use Request access if your key cannot read the team.")
        raise ReadError("Set up your own Linear key with access to the team and project, then run wg join again.")
    # The owner's local automation, paths, and test commands need local setup.
    effort = shared_effort(wire["effort"]) | {"slug": wire["effort"].get("slug"),
                                             "team": wire["effort"]["team"], "workspace": workspace}
    plan = wire | {"effort": effort}
    km = {"nodes": {}, "milestones": {}}
    try:
        validate_shared_plan(plan, name)
        validate_shared_mapping(km, data["keymap"], workspace, project, plan, {})
    except (KeyError, AttributeError, TypeError):
        raise ReadError("The page returned invalid plan or keymap fields.") from None
    if not (path := join_worktree(ns.repo, plan, page, member["id"])):
        return 2
    with plan_lock(path):
        if git_output("status", "--porcelain", "--untracked-files=normal", cwd=path):
            raise ReadError(f"{path} has local changes. Make the coordinator worktree clean before running wg join.")
        paths = [path / file for file in ("plan.json", "keymap.json", "PLAN.md")]
        if any(file.exists() or file.is_symlink() for file in paths):
            raise ReadError(f"{path} already has plan files. Use wg next there if the project is set up.")
        after = replace_shared_keymap(km, data["keymap"])
        after["collab"] = new_collab_record(page, member["id"], project, plan) | {
            "version": data["version"], "remote_settings": collab_settings(wire["effort"])}
        with atomic_text_file(path / "PLAN.md") as file:
            file.write(f"# {join_display_name(name)} by {join_display_name(member['owner'])}\n")
            stage_plan_pair(path, after, plan, None)
    print(f"Joined {path}")
    print("The owner keeps merge points, ship points, and deploys.")
    scope = LINEAR_WORKSPACE.set(workspace)
    try:
        return preflight(path, plan, None) or next_command(path, plan, False, 0)
    finally:
        LINEAR_WORKSPACE.reset(scope)


def leave_project(plan_dir):
    with plan_lock(plan_dir):
        km = load_keymap(plan_dir)
        if not (collab := km.get("collab", {})).get("workspace", "").startswith("shared:"):
            raise ReadError("This worktree has no collaborator record.")
        workspace = DEFAULT_WORKSPACE_ID
        try:
            current = claim_request(collab, workspace, "GET")
            claims = [claim["node"] for claim in current["claims"] if claim["mine"]]
        except (ReadError, OSError, ValueError, KeyError, TypeError) as error:
            print(f"warn: could not list claims: {error}", file=sys.stderr)
        else:
            for key in claims:
                release_page_claim(collab, workspace, key)
        del km["collab"]
        save_keymap(plan_dir, km, sync=False)
    print("Removed the local collaboration record. End your membership on the page.")
    return 0


def retry_page_request(request, response_error, *, deadline=None):
    """Retry only 503. response_error extracts the HTTP status and headers for this transport."""
    for attempt in range(4):
        try:
            return request()
        except Exception as error:
            status, headers = response_error(error)
            if status != 503 or attempt == 3:
                raise
            if isinstance(error, urllib.error.HTTPError):
                error.close()
            delay = headers.get("Retry-After", "1") if headers is not None else "1"
            try:
                seconds = int(delay)
            except (TypeError, ValueError):
                try:
                    seconds = (email.utils.parsedate_to_datetime(delay) - datetime.now(timezone.utc)).total_seconds()
                except (TypeError, ValueError, OverflowError):
                    seconds = 1
            pause = max(0, min(5, seconds))
            if deadline is not None and time.monotonic() + pause >= deadline:
                raise
            time.sleep(pause)


def ws_response_error(error):
    response = getattr(error, "response", None)
    return getattr(response, "status_code", None), getattr(response, "headers", None)


def open_page_request(request, timeout):
    def response_error(error):
        if isinstance(error, urllib.error.HTTPError):
            return error.code, error.headers
        return None, None

    return retry_page_request(lambda: urllib.request.urlopen(request, timeout=timeout), response_error)


def login_page_url(url, workspace):
    default = workspace_page(workspace) or CONFIG.get("page_url")
    url = (url if url is not None else default or "").rstrip("/")
    scheme, host, _ = page_origin(url)
    if scheme != "https" and (scheme != "http" or url not in configured_pages() or not private_page_host(host)):
        raise LinkTokenError("use HTTPS unless the page has a configured HTTP loopback or tailnet URL")
    return url


def token_page_request(url, path, token="", *, expected_error=()):
    request = urllib.request.Request(f"{url}{path}")
    if token:
        request.add_unredirected_header("Authorization", f"Bearer {token}")
    try:
        with open_page_request(request, 10) as response:
            if response.geturl() != request.full_url:
                raise LinkTokenError("the page redirected the token check")
            if response.status != 200:
                raise LinkTokenError(f"the page answered HTTP {response.status}")
            return json.load(response)
    except urllib.error.HTTPError as error:
        with error:
            if error.geturl() != request.full_url:
                raise LinkTokenError("the page redirected the token check") from None
            if error.code in expected_error:
                return error.code
            if error.code in (401, 403):
                raise LinkTokenError(f"the page refused the token (HTTP {error.code})") from None
            raise LinkTokenError(f"the page answered HTTP {error.code}") from None
    except (OSError, http.client.HTTPException) as error:
        reason = getattr(error, "reason", error)
        raise LinkTokenError(f"connection failed ({type(reason).__name__})") from None
    except ValueError:
        raise LinkTokenError("the page returned an invalid token check response") from None


def check_page_token(url, token):
    config = token_page_request(url, "/api/config", token)
    if not isinstance(config, dict) or not isinstance(config.get("auth"), bool):
        raise LinkTokenError("the page did not report whether sign-in is enabled")
    if not config["auth"]:
        # The coordinator must name a project after it passes the link's token check.
        path = "/api/link?role=coordinator"
        with_token = token_page_request(url, path, token, expected_error=(400,))
        without_token = token_page_request(url, path, expected_error=(400, 401, 403))
        if with_token != 400 or without_token not in (401, 403):
            raise LinkTokenError("the page did not confirm the token")
    return token_page_request(url, "/api/status", token)


def save_page_token(path, token):
    try:
        directory = path.parent
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        if directory.is_symlink() or stat.S_IMODE(directory.stat().st_mode) != 0o700:
            raise LinkTokenError(f"{directory} must be a directory with mode 700")
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=directory, delete=False) as file:
            temporary = Path(file.name)
            try:
                os.fchmod(file.fileno(), 0o600)
                file.write(token + "\n")
                file.close()
                temporary.replace(path)
            finally:
                temporary.unlink(missing_ok=True)
    except OSError as error:
        reason = error.strerror or type(error).__name__
        raise LinkTokenError(f"cannot save the page token at {path}: {reason}") from None


def page_login(ns):
    url = login_page_url(ns.page_url, ns.workspace)
    path = page_token_path(url)
    if ns.token_stdin:
        raw = sys.stdin.readline().removesuffix("\n")
    else:
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("error", getpass.GetPassWarning)
                raw = getpass.getpass("Page coordinator token: ")
        except (getpass.GetPassWarning, EOFError):
            raise LinkTokenError("cannot read the token without echo; use --token-stdin") from None
    token = clean_link_token(raw, "the token")
    if not token:
        raise LinkTokenError("the token is empty")
    status = check_page_token(url, token)
    rows = status.get("workspaces", []) if isinstance(status, dict) else []
    save_page_token(path, token)

    def report(message):
        # The page controls workspace names. Do not print the token even if a page echoes it.
        print(message.replace(token, "[redacted]"))

    report(f"Saved the coordinator token for {url}.")
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict) or not isinstance(row.get("id"), str):
            continue
        workspace = row["id"]
        if not re.fullmatch(r"[a-z0-9-]+", workspace):
            continue
        name = one_line(row.get("name") or workspace, 120)
        current = (workspace_page(workspace) or CONFIG.get("page_url") or "").rstrip("/")
        if workspace in WORKSPACES and current == url:
            report(f"{workspace} ({name}): configured")
        else:
            report(f"{workspace} ({name}): set this entry in workspaces")
            report(json.dumps({"id": workspace, "name": name, "page_url": url}))
    return 0


def page_logout(url):
    url = login_page_url(url, DEFAULT_WORKSPACE_ID)
    path = page_token_path(url)
    try:
        path.unlink()
        print(f"Removed the saved token for {url}.")
    except FileNotFoundError:
        print(f"There was no saved token for {url}.")
    print("Use the page settings to revoke the token on the page.")
    return 0


class LinkResponseError(ReadError):
    pass


class LinkUnauthorized(LinkResponseError):
    pass


_LINK_AUTH_WARNED = set()


def warn_link_token(problem, workspace=None, *, polling=False):
    base = (page_base(workspace), link_token_env(workspace))
    if base not in _LINK_AUTH_WARNED:
        _LINK_AUTH_WARNED.add(base)
        fallback = " Polling Linear instead." if polling else ""
        print(f"warn link: {problem}.{fallback}", file=sys.stderr, flush=True)


def link_unauthorized_message(workspace):
    return f"HTTP 401. Check {link_token_env(workspace)}"


@contextlib.contextmanager
def link_socket(url, *, workspace, deadline=None, **options):
    from websockets.sync.client import connect
    target = urllib.parse.urlsplit(url)
    scope = urllib.parse.parse_qs(target.query).get("workspace", [""])[0]
    if scope.startswith("shared:"):
        origin = target._replace(scheme="https" if target.scheme == "wss" else "http",
                                 path="", query="", fragment="").geturl()
        token = collaboration_page_token(login_page_url(origin, workspace), workspace, shared=True)
    else:
        token = link_token_for(url, workspace)
    if token:
        options["additional_headers"] = {"Authorization": f"Bearer {token}"}
    open_timeout = options.pop("open_timeout", LINK_OPEN_TIMEOUT)

    def open_socket():
        budget = open_timeout if deadline is None else min(open_timeout, deadline - time.monotonic())
        if budget <= 0:
            raise TimeoutError("the link deadline passed")
        return connect(url, open_timeout=budget, close_timeout=1, **options)

    try:
        ws = retry_page_request(open_socket, ws_response_error, deadline=deadline)
    except Exception as error:
        if token:
            status = getattr(getattr(error, "response", None), "status_code", None)
            if status == 401:
                raise LinkUnauthorized("HTTP 401") from None
            if isinstance(status, int):
                raise LinkResponseError(f"HTTP {status}") from None
            raise ReadError(f"connection failed ({type(error).__name__})") from None
        raise
    with ws:
        yield ws


class Link:
    """The connection of this coordinator to the page server (`/api/link`). The server tells it at once
    about a change on the page or in Linear, and keeps the messages for it while it is busy. Linear stays the
    truth: without a link (`WG_LINK=off`, no `websockets` package, no server), `wg next` polls as before."""

    def __init__(self, url, project, session, hello, workspace):
        self.url, self.project, self.session, self.hello = url, project, session, hello
        self.workspace = workspace
        self.inbox, self.ws, self.reader = [], None, None
        self.cond = __import__("threading").Condition()
        self.connection_lock = __import__("threading").RLock()
        self.retry_at = 0.0
        self.planned_until = 0.0
        self.retry_delay = 1
        self.quick_closes = 0
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
        link = cls(url, project, session, hello, plan_workspace(plan))
        link.connect()
        return link

    def envelope(self, kind, payload):
        return link_envelope(self.session, self.project, kind, payload)

    def connect(self):
        with self.connection_lock:
            return self._connect()

    def _connect(self):
        from websockets.exceptions import ConnectionClosed

        if self.ws or time.monotonic() < self.retry_at:
            return self.ws is not None
        stack = contextlib.ExitStack()
        opened_at = None
        try:
            ws = stack.enter_context(link_socket(self.url, workspace=self.workspace, max_size=2**22))
            opened_at = time.monotonic()
            ws.stack = stack
            ws.send(self.envelope("hello", self.hello))
            for kind, payload in self.last.items():
                ws.send(self.envelope(kind, payload))
        except Exception as e:
            with contextlib.suppress(Exception):
                stack.close()
            now = time.monotonic()
            if opened_at is not None and isinstance(e, ConnectionClosed) and self._planned(e):
                self._schedule_planned_close(opened_at, now)
                return False
            if now < self.planned_until:
                self.retry_at = min(now + self.retry_delay, self.planned_until)
                self.retry_delay = min(self.retry_delay * 2, 5)
                return False
            self.quick_closes = 0
            self.retry_at = now + 30
            if isinstance(e, (LinkUnauthorized, LinkTokenError)):
                problem = link_unauthorized_message(self.workspace) if isinstance(e, LinkUnauthorized) else e
                warn_link_token(problem, self.workspace, polling=True)
                self.warned = True
            elif not self.warned:
                print(f"warn link: {self.url.split('?')[0]}: {e}. Polling Linear instead.", file=sys.stderr, flush=True)
                self.warned = True
            return False
        self.warned = False
        self.planned_until = 0
        self.ws = ws
        self.reader = __import__("threading").Thread(target=self.read, args=(ws, opened_at), daemon=True)
        self.reader.start()
        return True

    @staticmethod
    def _planned(error):
        return error.rcvd is not None and error.rcvd.code in LINK_CLOSE_CODES.values()

    def _schedule_planned_close(self, opened_at, now):
        self.quick_closes = min(self.quick_closes + 1, 7) if now - opened_at < 10 else 0
        delay = min(2 ** (self.quick_closes - 2), 30) if self.quick_closes >= 2 else 0
        self.retry_at = now + delay
        # A deliberate backoff can outlast presence grace. Allow short retries after that first attempt too.
        self.planned_until = self.retry_at + LINK_RECONNECT_GRACE
        self.retry_delay = 1

    def read(self, ws, opened_at):
        from websockets.exceptions import ConnectionClosed

        planned = False
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
        except ConnectionClosed as error:
            planned = self._planned(error)
        except Exception:
            pass
        with self.connection_lock:
            if self.ws is ws:
                with self.cond:
                    self.ws = None
                    now = time.monotonic()
                    if planned:
                        self._schedule_planned_close(opened_at, now)
                    else:
                        self.quick_closes = 0
                        self.retry_at = now + 5
                    self.cond.notify_all()
                if planned:
                    self._connect()
        with contextlib.suppress(Exception):
            ws.stack.close()

    def send(self, kind, payload):
        with self.connection_lock:
            fresh = self.ws is None
            if kind in LINK_REPLAYED:
                self.last[kind] = payload
            if not self._connect():
                return False
            if fresh and kind in LINK_REPLAYED:
                return True  # connect sent it after hello
            try:
                self.ws.send(self.envelope(kind, payload))
                return True
            except Exception:
                return False  # the reader handles the close and the retry

    def take(self, timeout=0.0):
        """The messages that came, after waiting up to `timeout` seconds for the first one."""
        deadline = time.monotonic() + timeout
        with self.cond:
            while not self.inbox and (left := deadline - time.monotonic()) > 0:
                if self.ws is None:
                    until_retry = self.retry_at - time.monotonic()
                    if until_retry <= 0:
                        break
                    self.cond.wait(min(left, until_retry))
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
        with self.connection_lock:
            ws, self.ws = self.ws, None
        if ws:
            with contextlib.suppress(Exception):
                ws.stack.close()


def link_target(plan_dir, plan):
    """The link URL of the plan's project, the project, this coordinator's session, and its `hello`."""
    km = load_keymap(plan_dir)
    project = (km.get("project") or {}).get("id") or plan["effort"]["name"]
    workspace = plan_workspace(plan)
    base = page_base(workspace)
    collab = km.get("collab") or {}
    if collab.get("workspace", "").startswith("shared:"):
        base = login_page_url(collab["page"], workspace)
        workspace = collab["workspace"]
    scheme, rest = base.split("://", 1)
    query = urllib.parse.urlencode({"role": "coordinator", "workspace": workspace, "project": project})
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
    the server does not count as a coordinator. The server's own check sees the change later if the link fails."""
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
        url, project, session, _ = link_target(plan_dir, plan)
        with link_socket(url, workspace=plan_workspace(plan)) as ws:
            ws.send(link_envelope(session, project, "wrote", payload))
        return True
    except LinkUnauthorized:
        workspace = plan_workspace(plan)
        warn_link_token(link_unauthorized_message(workspace), workspace)
        return False
    except LinkTokenError as error:
        warn_link_token(error, plan_workspace(plan))
        return False
    except Exception:  # no package, no server, or an old server: the server's check sees the change later
        return False


def contract_hash():
    return hashlib.sha256(contract_text().encode()).hexdigest()[:12]


def answer_runner(key, current):
    """Return who should handle a message that this coordinator must skip."""
    if current is None:
        return None
    held = next((claim for claim in current["claims"] if claim["node"] == key), None)
    if held:
        return None if held["mine"] else held["holder"]
    return None if current["role"] == "owner" else "the owner"


def link_lines(messages, keys=None, plan_dir=None, current=None):
    """The lines of `wg next` that messages of the page server give, and the ids that these lines settle.
    `changed` gives no line: it makes `wg next` read Linear again at once. `keys` maps identifiers to node keys,
    for an issue whose message names no key."""
    keys = keys or {}
    lines, settled = [], []
    for m in messages:
        kind, payload = m.get("type"), m.get("payload") or {}
        issue = payload.get("issue") or "-"
        key = (keys.get(issue) if issue != "-" else payload.get("key")) or "-"
        if kind in ("answer", "reply") and (runner := answer_runner(key, current)):
            lines.append(("note", f"{kind} {key} {issue}: waits on {runner}"))
            settled.append(m["id"])
        elif kind == "changed":
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


ASK_TYPES = ("question", "escalation")  # the Orca message types that wait on an answer


def open_asks(plan_dir):
    """The open questions and escalations of the effort's workers, from Orca: each `question` or `escalation`
    message that is not handled and came from the dispatch in a node's run row. `kind` is the message type. An
    escalation that no coordinator read (`handled` false) waits like a question: the worker stopped. A failure of
    `orca` gives no asks; it never stops `wg next`."""
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
            if m.get("type") not in ASK_TYPES or m.get("handled") or dispatch not in by_dispatch:
                continue
            key = by_dispatch[dispatch]
            asks.append({"id": m["id"], "key": key, "issue": (km["nodes"].get(key) or {}).get("identifier"),
                         "from": m.get("from", ""), "at": m.get("createdAt") or m.get("at") or "", "run": run_id,
                         "kind": m["type"],
                         "body": m.get("body") or (f"The worker stopped: {payload['stopReason']}" if payload.get("stopReason") else "")})
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


# The `do` verbs that one `wg` command does. The terminal adds ` -> <command>` to their lines.
DO_COMMANDS = {
    "verify": "done {dir} {key}",
    "dispatch": "dispatch {dir} {key} --run",
    "merged": "move {dir} {key} Merged",
    "close": "move {dir} {key} Done",
    "verifying": "move {dir} {key} Verifying",
    "ship": "move {dir} {key} Done",
    "load": "load {dir} --apply",  # coordinator.md "Loop": the dry run `wg load <plan-dir>` comes first
}
# The `note` lines that the terminal prints in full. It counts the other notes in one line.
NOTES_SHOWN = ("autonomy", "triage", "page", "review", "doctor", "health")


def line_verb(text):
    return text.split(" ", 1)[0].rstrip(":")


def line_key(text, keys):
    """The node key of a line `<verb> <key> <identifier>[: <detail>]`, and the rest after the key. A key can hold
    a space, so the longest of `keys` that the line names wins. A line that names no known key gives None."""
    verb = text.split(" ", 1)[0]
    found = [k for k in keys if text.startswith(f"{verb} {k} ") or text == f"{verb} {k}"]
    if not found:
        return None, None
    key = max(found, key=len)
    return key, text[len(verb) + len(key) + 2:]


def terminal_lines(plan_dir, lines, everything=False, keys=(), *, collaborative=False):
    """The lines of `wg next` as the terminal prints them. Each `do` line that one `wg` command does ends with
    ` -> <command>`. Without `everything`, the `wait` lines with the same verb are one line, and the notes that
    are not in NOTES_SHOWN are counted in one line. The status document, the node cards, and the link get the
    full lines: this is a print step only. `keys` are the node keys of the plan (and `@effort`): a command names
    only a key from them, quoted."""
    keys = {*keys, "@effort"}
    here = shlex.quote(str(Path(plan_dir).resolve()))
    out, waits, hidden = [], {}, 0
    for level, text in lines:
        verb, (key, _) = line_verb(text), line_key(text, keys)
        if level == "do" and verb in DO_COMMANDS and key and key != "@effort":
            out.append(f"do {text} -> wg " + DO_COMMANDS[verb].format(dir=here, key=shlex.quote(key)))
        elif (everything or level == "do" or verb in {"collaborator", "owner", "stale"}
              or (level == "note" and (verb in NOTES_SHOWN or (collaborative and verb in {"human", "answer", "reply"})))):
            out.append(f"{level} {text}")
        elif level == "wait":
            if verb not in waits:
                out.append(("wait", verb))  # the place of the group: its first line
            waits.setdefault(verb, []).append(text)
        else:
            hidden += 1
    printed = []
    for line in out:
        if isinstance(line, str):
            printed.append(line)
        elif len(group := waits[line[1]]) == 1:
            printed.append(f"wait {group[0]}")
        else:
            items = []
            for text in group:
                key, rest = line_key(text, keys)
                m = re.match(r"\S+(?:: (.*))?$", rest or "", re.S)
                key, detail = (key, m.group(1)) if key and m else (text, None)
                if detail and (job := re.search(r"\bjob=(\S+)", detail)):
                    detail = job.group(1)
                items.append(f"{key} ({detail})" if detail else key)
            printed.append(f"wait {line[1]}: " + ", ".join(items))
    if hidden:
        printed.append(f"note other: {hidden} more note line{'' if hidden == 1 else 's'}; "
                       f"wg next {here} --all prints them")
    return printed


# `wg explain <verb>` prints the parts of the skill text that say what to do for a verb of `wg next`.
# The reference files mark each part: `<!-- explain: verb,verb -->` … `<!-- /explain -->`.
EXPLAIN = {
    "claims": "the claims page is unavailable; wait before starting a job",
    "collaborator": "another coordinator holds the node",
    "owner": "the project owner handles this node",
    "stale": "the claim lease ended; ask before taking over",
    "load": "a node of plan.json is not in keymap.json: load the graph",
    "wave": "each node of the last wave is code done: pick the next wave",
    "dispatch": "start the first worker job of a ready node",
    "adopt": "a node whose branch or PR exists: adopt it, no dispatch",
    "integration": "the coordinator's own integration branch",
    "verify": "check code done: wg done",
    "review": "the wave review of a draft PR at the review effort, or a change of the review effort",
    "ask-ready": "ask the human to mark PRs ready (merge_prep=human)",
    "undraft": "mark the PR ready for review yourself",
    "merge-review": "request, read, or check the thorough merge review",
    "ask-merge": "the PR can merge: move it to Ready to Merge and ask for the merge",
    "merge": "the PR can merge (autonomy full, config agent_merge): move it to Ready to Merge and merge it yourself",
    "merged": "the PR merged: move the task to Merged",
    "close": "every pre-merge task merged: close the merge point",
    "restack": "send a restack job",
    "full-suite": "the repo-wide test run of the phase",
    "ops": "an ops node that the coordinator does",
    "ask": "an ops or decision node: ask the human",
    "verifying": "move the ship point to Verifying",
    "ship": "the soak passed: close the ship point",
    "triage": "an issue in the project that is not a node",
    "closed": "the PR closed without a merge",
    "reconcile": "the run rows and Linear do not agree: resume",
    "answer": "the human answered on the page",
    "relay": "send the human's reply to the worker yourself",
    "replied": "wg next sent the human's reply to the worker",
    "autonomy": "the autonomy level, or a change of it",
    "paused": "the human paused the effort",
    "resumed": "the human resumed the effort",
    "below": "wait: the node below in the lane comes first",
    "blockers": "wait: a blocker of the ship point opened again",
    "soak": "wait: the soak runs",
    "worker": "wait: a worker job runs",
    "reviewer": "wait: a reviewer job runs",
    "coordinator": "wait: an ops node that you run",
    "human": "wait: the human must act",
    "health": "the last status check found faults (note health)",
    "health-check": "the checks of the status check agent (wg health)",
    "context": "note: this session is over the context limit; after a compaction",
}
EXPLAIN_MAX_LINES = 60


def explain_sections():
    """Each verb's marked parts of SKILL.md and the references, in file order, with the file of each."""
    root = Path(__file__).resolve().parent.parent
    sections = {}
    for path in [root / "SKILL.md", *sorted((root / "references").glob("*.md"))]:
        verbs, part = None, []
        for line in path.read_text().splitlines():
            if m := re.fullmatch(r"<!-- explain: ([a-z,-]+) -->", line.strip()):
                verbs, part = m.group(1).split(","), []
            elif line.strip() == "<!-- /explain -->" and verbs:
                for verb in verbs:
                    sections.setdefault(verb, []).append((str(path.relative_to(root)), part))
                verbs = None
            elif verbs:
                part.append(line)
    return sections


def explain_text(verb):
    lines, last = [], None
    for name, part in explain_sections().get(verb, []):
        lines += ([""] if lines else []) + ([f"({name})"] if name != last else []) + part
        last = name
    return "\n".join(lines)


def explain_command(verb):
    """`wg explain [verb]`: what to do for a verb of `wg next`, or the list of the verbs. Exit 2: unknown verb."""
    if not verb:
        width = max(map(len, EXPLAIN))
        for name, summary in EXPLAIN.items():
            print(f"{name.ljust(width)}  {summary}")
        return 0
    if verb not in EXPLAIN:
        print(f"unknown verb {verb!r}; wg explain lists the verbs", file=sys.stderr)
        return 2
    print(explain_text(verb))
    return 0


def next_command(plan_dir, plan, wait, interval, copy=False, everything=False):
    """Print the next actions. With wait: return only when the coordinator has something to do.

    With copy: also copy each result to Linear for the page, also while it waits (`publish`). With everything:
    print each `wait` and `note` line in full (terminal_lines)."""
    link = Link.open(plan_dir, plan)
    messages = link.take() if link else []
    handled = set()
    try:
        while True:
            try:
                km = load_keymap(plan_dir)
                try:
                    current = project_claims(plan, km)
                except (ClaimRefused, PlanPageUnavailable) as error:
                    print(f"wait claims page: {error}", flush=True)
                    return 0
                keys = {e.get("identifier"): k for k, e in km.get("nodes", {}).items()}
                unique = {m["id"]: m for m in messages}
                extra, settled = link_lines([m for mid, m in unique.items() if mid not in handled],
                                            keys, plan_dir, current)
                settled.extend(mid for mid in unique if mid in handled)
                answers = [line for line in answer_lines(plan_dir)
                           if line[0] != "do" or not answer_runner(line_key(line[1], keys.values())[0], current)]
                # An answer in Linear and its message give one line; the label also holds after a server restart.
                marked = {text.split(":", 1)[0] for level, text in answers if level == "do"}
                extra = answers + [line for line in extra if not (line[0] == "do" and line[1].split(":", 1)[0] in marked)]
                # Before next_lines: a new review effort applies to the lines of this same wg next.
                reviews = review_effort_lines(plan_dir, plan)
                options = {"current_claims": current} if current is not None else {}
                head, lines = next_lines(plan_dir, plan, tolerant=wait, **options)
                if head == CLAIMS_UNAVAILABLE:
                    print(f"wait {lines[0][1]}", flush=True)
                    return 0
                held_keys = claim_gate_keys(lines)
                extra = [line for line in extra if not (line[1].startswith("dispatch ")
                         and line_key(line[1], held_keys)[0])]
                lines = paused_lines(plan_dir, plan, extra + lines) + page_contract_note(plan_dir, plan) + health_lines(plan_dir)
                if head != COMPLETE:
                    lines = autonomy_lines(plan_dir, plan) + reviews + lines
                done = not wait or head == COMPLETE or any(level == "do" for level, _ in lines)
                if link:
                    flush_writes(plan_dir, plan, link)
                    link.send("state", {"mode": "working" if done else "waiting", "head": head,
                                        "lines": [{"level": level, "text": text} for level, text in lines]})
                    link.send("asks", {"asks": open_asks(plan_dir)})
                    link.send("progress", {"nodes": progress_nodes(plan_dir)})
                if copy:
                    publish(plan_dir, plan, head, lines, wait_interval=interval if wait else None)
                paused = any(t.startswith("paused @effort") for _, t in lines)
                if done:
                    print(head)
                    for line in terminal_lines(plan_dir, lines, everything, [n["key"] for n in plan["nodes"]],
                                               collaborative=current is not None):
                        print(line, flush=True)
                    for line in context_note(plan_dir):
                        print(line, flush=True)
                    if head != COMPLETE:
                        print(f"note page {page_link(plan)}", flush=True)
                    # A message is settled once its line is on the terminal. Before that, the server keeps it.
                    if link and settled:
                        link.send("ack", {"ids": settled})
                    # After the result: a slow channel does not delay it (NOTIFY_DEADLINE).
                    notify_effort(plan_dir, plan, lines, paused)
                    return 0
                if link and settled:  # a `changed` that did not wake the coordinator is still read
                    for level, message in extra:
                        if level == "note" and message.startswith(("answer ", "reply ")):
                            print(f"note {message}", flush=True)
                    handled.update(settled)
                    link.send("ack", {"ids": settled})
                notify_effort(plan_dir, plan, lines, paused)
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


def orca_agents(*, local=False):
    """Each agent that Orca knows, with the path of its workspace."""
    args = ("--environment", "local") if local else ()
    result = command(orca_cli(), "agent", "list", *args, "--json")
    if result.returncode != 0:
        raise ReadError(f"orca agent list: {command_error(result)}")
    agents = json.loads(result.stdout)["result"]["agents"]
    return [{**a, "path": (a.get("worktreeId") or "").split("::", 1)[-1]} for a in agents]


def live_agents():
    """The agents that Orca reports as not done, with the path of their workspace."""
    return [a for a in orca_agents() if a.get("state") != "done"]


def page_waiting(plan, project_id):
    """How many page messages wait for a coordinator (answer, reply, command). 0 when the server cannot be read."""
    workspace = plan_workspace(plan)
    try:
        presence = page_get(f"/api/projects/{urllib.parse.quote(project_id)}/presence",
                            headers={"x-workspace": workspace}, workspace=workspace)
        return int(presence.get("waiting") or 0)
    except (ReadError, OSError, ValueError, TypeError, http.client.HTTPException):
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
            f"work and no coordinator was running. Load the work-graph skill. Run `wg next {plan_dir}` first. For the "
            "verb of each `do` and `wait` line, read `wg explain <verb>` before you act on it; do not read "
            "references/coordinator.md as a whole. Act on each line, until the effort is complete or a line needs "
            f"{HUMAN}. Then wait as references/coordinator.md \"Wait\" says (`wg explain human` prints it): one "
            f"`wg next {plan_dir} --wait` in the background, then end the turn. Do not ask for the autonomy level or the review effort: this run uses the "
            f"project's current levels (`wg autonomy {plan_dir}`, `wg review-effort {plan_dir}`), as setup.md "
            "\"Autostart\" says.")


def automation_precheck(*args):
    """The precheck command of an Orca automation: `wg <args>` with this shell's PATH (git, gh) and the Orca CLI,
    because Orca runs it without the login shell. A stable uv (a shim or a package-manager link), not a versioned
    path that the next uv upgrade removes."""
    home = Path.home()
    uv = next((str(c) for c in (home / ".proto/shims/uv", home / ".local/bin/uv", home / ".cargo/bin/uv",
                                Path("/opt/homebrew/bin/uv"), Path("/usr/local/bin/uv")) if c.is_file()), None) or shutil.which("uv")
    script = str(Path(__file__).resolve())
    path = os.pathsep.join(d for d in os.environ.get("PATH", "").split(os.pathsep) if d and "/.cache/uv/" not in d)
    env = f"env PATH={shlex.quote(path)} ORCA_CLI_COMMAND={shlex.quote(orca_cli())} "
    return env + (f"{shlex.quote(uv)} run --quiet --script {shlex.quote(script)}" if uv
                  else f"python3 -I {shlex.quote(script)}") + "".join(f" {shlex.quote(a)}" for a in args)


def autostart_command(plan_dir, plan, install, uninstall, agent=None, model=None, effort=None):
    """`wg autostart <plan-dir> [--install | --uninstall]`: an Orca automation that runs `wg wake` every 5 minutes
    and starts a coordinator agent in this worktree when it says start. Without a flag, print its state."""
    here = str(Path(plan_dir).resolve())
    km = load_keymap(plan_dir)
    run = run_rows(km)["effort"]
    current = run.get("autostart")

    def save(value, configured=False):
        with plan_lock(plan_dir):
            k = load_keymap(plan_dir)
            row = run_rows(k)["effort"]
            if value:
                row["autostart"] = value
            else:
                row.pop("autostart", None)
            if configured:
                row["autostart_configured"] = True
            else:
                row.pop("autostart_configured", None)
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
    settings = resolve_agent(plan, "coordinator", agent, model, effort)
    if not install:
        if settings:
            print("coordinator settings: " + " ".join(f"{field}={shlex.quote(value)}"
                                                       for field, value in settings.items()))
        if not current:
            print("autostart off")
            return 0
        shown = orca("automations", "show", current).get("automation") or {}
        print(f"autostart {'on' if shown.get('enabled', True) else 'disabled'}: automation {current}, every 5 minutes")
        return 0
    precheck = automation_precheck("wake", here)

    def provider():
        if settings.get("agent"):
            return settings["agent"]
        agents = orca("agent", "installed")["agents"]
        return next((a["id"] for a in agents if a.get("default")), "claude")

    if current:
        # Install again: refresh the precheck and the prompt, and turn the automation on.
        changes = []
        if settings or run.get("autostart_configured"):
            agent = provider()
            changes = ["--provider", agent, f"--extra-agent-args={automation_model_args(agent, settings)}"]
        orca("automations", "edit", current, "--precheck", precheck, "--prompt", autostart_prompt(here),
             "--enabled", *changes)
        if changes:
            save(current, bool(settings))
        print(f"autostart on: automation {current}, every 5 minutes (updated)")
        return 0
    worktree = orca("worktree", "show", "--worktree", f"path:{here}")["worktree"]["id"]
    agent = provider()
    extra = automation_model_args(agent, settings)
    created = orca("automations", "create", "--name", f"wg coordinator: {plan['effort']['name']}",
                   "--trigger", WAKE_SCHEDULE, "--prompt", autostart_prompt(here), "--provider", agent,
                   "--workspace", f"id:{worktree}", "--precheck", precheck, "--precheck-timeout", "120",
                   "--fresh-session", *([f"--extra-agent-args={extra}"] if extra else []))
    automation = (created.get("automation") or created).get("id")
    if not automation:
        die("orca automations create returned no id")
    save(automation, bool(settings))
    print(f"autostart on: automation {automation}, every 5 minutes, agent {agent}")
    return 0


# ---------------------------------------------------------------- status check (wg health)

# An Orca automation runs `wg health --due` each hour. When it says start, a fresh agent (config `health_agent`)
# checks the effort, read only, and gives its findings to `wg health --report`. The code, not the agent, sets the
# health value from the findings (references/health.md).
HEALTH_SCHEDULE = "0 * * * *"
HEALTH_FORMS = ({"FREQ": "HOURLY", "BYMINUTE": "0"}, {"FREQ": "HOURLY"})  # the rrule forms of HEALTH_SCHEDULE
HEALTH_FORCE = 24 * 3600  # seconds: with no change, a check still runs this long after the last one
HEALTH_STALE_HUMAN = 24  # hours in `Needs <human>` that make a `stale-human` finding
HEALTH_STALE_REVIEW = 48  # hours in `In Review` or `Ready to Merge` with no activity that make a `stale-review` finding
HEALTH_IDLE = 3 * 24 * 3600  # seconds with no journal entry while work is open: an `idle` finding
HEALTH_LEVELS = ("onTrack", "atRisk", "offTrack")  # Linear's project update health, from good to bad
HEALTH_LABEL = "health"  # the issue label of each fault issue
HEALTH_MARK = "wg-health-fault:"  # the line of a fault issue's description that names its fault id
# The finding kinds that the agent reports, with the health value of each (None: an issue, no value).
HEALTH_KINDS = {"status": "offTrack", "connection": "offTrack", "stale-human": "atRisk", "stale-review": "atRisk",
                "comment": "atRisk", "plan-drift": "atRisk", "relation": "atRisk", "worker": "atRisk",
                "other": "atRisk", "doctor-gap": None}
HEALTH_STALE_HOURS = {"stale-human": HEALTH_STALE_HUMAN, "stale-review": HEALTH_STALE_REVIEW}
# Run row fields of @effort that a check, the page contract cache, a notice, or a level read change: an entry
# with only these fields is not a change of the effort.
HEALTH_QUIET = re.compile(r"(health\w*|page_contract\w*|notified_\d+|notify_failed_\d+|paused_seen|autonomy_seen)")


def health_rank(value):
    return HEALTH_LEVELS.index(value) if value in HEALTH_LEVELS else 0


def health_last(effort):
    """The time of the last check or of the last start of a check (a check that gave no report), or None."""
    times = []
    for field in ("health_at", "health_started"):
        with contextlib.suppress(KeyError, TypeError, ValueError, AttributeError):
            times.append(parse_utc(effort[field]).timestamp())
    return max(times) if times else None


def health_worktree_path(plan_dir, plan):
    return run_rows(load_keymap(plan_dir))["effort"].get("health_worktree")


def journal_changed(plan_dir, since):
    """Is there a journal entry after `since` (epoch seconds) that is a change of the effort?"""
    for entry in journal_entries(plan_dir):
        if parse_utc(entry["time"]).timestamp() <= since:
            continue
        if entry.get("key") == "@effort" and all(HEALTH_QUIET.fullmatch(f) for f in entry.get("changes") or {}):
            continue
        return True
    return False


def linear_changed(project_id, since):
    """Did an issue of the project change after `since`, other than a fault issue of the status check?"""
    at = datetime.fromtimestamp(since, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    found = gql("""query($p:ID!,$t:DateTimeOrDuration!){ issues(first:50, filter:{project:{id:{eq:$p}}, updatedAt:{gt:$t}}){
                   nodes{ id labels(first:20){nodes{name}} } } }""", {"p": project_id, "t": at})["issues"]["nodes"]
    return any(HEALTH_LABEL not in {label["name"] for label in issue["labels"]["nodes"]} for issue in found)


def health_due(plan_dir, plan, now=None):
    """Should the status check start an agent now? Returns (start, reason). On start, it records the start time,
    so a check that gives no report waits one interval before the next start."""
    now = now or time.time()
    km = load_keymap(plan_dir)
    project_id = (km.get("project") or {}).get("id")
    if not project_id or not km.get("nodes"):
        return False, "the plan is not loaded"
    effort = run_rows(km)["effort"]
    if worktree := effort.get("health_worktree"):
        try:
            alive = live_agents()
        except (ReadError, OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as e:
            return False, f"Orca cannot be read ({one_line(e, 120)})"
        if any(a["path"] == str(Path(worktree).resolve()) for a in alive):
            return False, "a status check agent runs"
    last = health_last(effort)
    interval = CONFIG["health_interval"] * 3600
    if last is not None and now - last < interval:
        return False, f"the last check was {duration_text(now - last)} ago (interval {duration_text(interval)})"
    if effort_paused(plan_dir, plan):
        return False, "the effort is paused"
    statuses = snapshot(plan_dir, plan, km)[3]
    ships = [n["key"] for n in plan["nodes"] if n["kind"] == "ship-point"]
    if ships and all(statuses.get(k) in {"Done", "Canceled"} for k in ships):
        return False, "the effort is complete"
    if last is None:
        reason = "no check yet"
    elif not effort.get("health_at") or (effort.get("health_started") or "") > effort["health_at"]:
        reason = "the last start gave no report"
    elif now - last >= HEALTH_FORCE:
        reason = f"no check for {duration_text(now - last)}"
    elif journal_changed(plan_dir, last) or linear_changed(project_id, last):
        reason = "the effort changed since the last check"
    else:
        return False, "no change since the last check"
    with plan_lock(plan_dir):
        km = load_keymap(plan_dir)
        run_rows(km)["effort"]["health_started"] = datetime.fromtimestamp(now, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        save_keymap(plan_dir, km)
    return True, reason


def health_finding_problem(i, f):
    """What is wrong with finding i of a report, or None."""
    if not isinstance(f, dict):
        return f"finding {i}: not an object"
    if f.get("kind") not in HEALTH_KINDS:
        return f"finding {i}: kind must be one of {', '.join(HEALTH_KINDS)}"
    if not isinstance(f.get("subject"), str) or not re.fullmatch(r"[A-Za-z0-9_.@-]{1,60}", f["subject"]):
        return f"finding {i}: subject must be 1-60 characters of A-Z, a-z, 0-9, _ . @ -"
    if not isinstance(f.get("text"), str) or not f["text"].strip() or len(f["text"]) > 2000:
        return f"finding {i}: text must be 1-2000 characters"
    if "fix" in f and not isinstance(f["fix"], str):
        return f"finding {i}: fix must be text"
    if f["kind"] in HEALTH_STALE_HOURS and (isinstance(f.get("hours"), bool) or not isinstance(f.get("hours"), (int, float))):
        return f"finding {i}: a {f['kind']} finding needs hours, a number"
    return None


def health_findings(report, doctor, entries, now, complete=False):
    """The faults of one check: the agent's findings that pass the rules, each FAIL line of `wg doctor`, and an
    `idle` fault. Returns (faults, notes): each fault is {id, kind, subject, text, fix, level}; the notes are the
    doctor warnings and the findings that the rules drop."""
    faults, notes = {}, []
    for f in report["findings"]:
        kind = f["kind"]
        if kind in HEALTH_STALE_HOURS and f["hours"] < HEALTH_STALE_HOURS[kind]:
            notes.append(f"dropped {kind} {f['subject']}: {f['hours']:g} hours is less than {HEALTH_STALE_HOURS[kind]}")
            continue
        fault = {"kind": kind, "subject": f["subject"], "text": " ".join(f["text"].split()),
                 "fix": " ".join((f.get("fix") or "").split()), "level": HEALTH_KINDS[kind]}
        faults.setdefault(f"{kind}:{f['subject']}", fault)
    for level, text in doctor:
        if level == "warn":
            notes.append(f"doctor warn: {text}")
        elif level == "FAIL":
            subject = re.sub(r"[^A-Za-z0-9_.@-]+", "-", text.split(":", 1)[0]).strip("-")[:60] or "doctor"
            faults.setdefault(f"doctor:{subject}", {"kind": "doctor", "subject": subject, "text": text,
                                                     "fix": "wg doctor prints the fix", "level": "offTrack"})
    times = [parse_utc(e["time"]).timestamp() for e in entries
             if not (e.get("key") == "@effort" and all(HEALTH_QUIET.fullmatch(c) for c in e.get("changes") or {}))]
    if not complete and times and now - max(times) > HEALTH_IDLE:
        faults["idle:@effort"] = {"kind": "idle", "subject": "@effort", "level": "atRisk", "fix": "",
                                  "text": f"no journal entry for {duration_text(now - max(times))} while work is open"}
    for fault_id, fault in faults.items():
        fault["id"] = fault_id
    return faults, notes


def health_value(faults):
    return max((f["level"] for f in faults.values() if f["level"]), key=health_rank, default="onTrack")


def health_body(value, faults, notes, issues, at):
    lines = [f"**work-graph status check: {value}**", ""]
    counted = [f for f in faults.values() if f["level"]]
    if counted:
        for f in sorted(counted, key=lambda f: (-health_rank(f["level"]), f["id"])):
            issue = f" ({issues[f['id']]})" if f["id"] in issues else ""
            lines.append(f"- {f['level']} {f['id']}{issue}: {f['text']}" + (f" Fix: {f['fix']}" if f["fix"] else ""))
    else:
        lines.append("No faults.")
    if gaps := [f for f in faults.values() if not f["level"]]:
        lines += ["", "Checks to add to wg doctor:"]
        lines += [f"- {f['subject']}" + (f" ({issues[f['id']]})" if f["id"] in issues else "") + f": {f['text']}"
                  for f in gaps]
    if notes:
        lines += ["", "Notes:"] + [f"- {n}" for n in notes]
    lines += ["", f"Checked at {at} by wg health. The status check changes nothing in the effort."]
    return "\n".join(lines)


def health_open_issue(team_id, fault_id):
    found = gql("""query($t:ID!,$m:String!){ issues(first:5, filter:{team:{id:{eq:$t}}, labels:{name:{eq:"health"}},
                   state:{type:{nin:["completed","canceled"]}}, description:{contains:$m}}){ nodes{ id identifier } } }""",
                {"t": team_id, "m": f"{HEALTH_MARK} {fault_id}"})["issues"]["nodes"]
    return found[0] if found else None


def health_file(plan, project_id, faults, previous):
    """One Triage issue for each new fault: a comment on its open issue, else a new issue. A fault that the last
    check also had gets nothing. Returns {fault id: identifier}."""
    new = [f for fid, f in sorted(faults.items()) if fid not in previous]
    if not new:
        return {}
    team_id, states, labels = team_info(plan_team(plan))
    label = labels.get(HEALTH_LABEL) or gql(
        """mutation($i:IssueLabelCreateInput!){ issueLabelCreate(input:$i){ issueLabel{id} } }""",
        {"i": {"name": HEALTH_LABEL, "teamId": team_id}})["issueLabelCreate"]["issueLabel"]["id"]
    state = states.get("Triage") or states.get("Backlog")
    filed = {}
    for f in new:
        body = f"{f['text']}" + (f"\n\nFix: {f['fix']}" if f["fix"] else "")
        if found := health_open_issue(team_id, f["id"]):
            gql("""mutation($i:CommentCreateInput!){ commentCreate(input:$i){ success } }""",
                {"i": {"issueId": found["id"], "body": f"The status check found this fault again.\n\n{body}"}})
            filed[f["id"]] = found["identifier"]
            continue
        title = (f"health: add a wg doctor check: {f['subject']}" if f["kind"] == "doctor-gap"
                 else f"health: {f['kind']} {f['subject']}: {f['text']}")
        inp = {"teamId": team_id, "title": title[:120], "labelIds": [label],
               "description": f"{body}\n\nThe work-graph status check of {plan['effort']['name']} found this fault.\n\n"
                              f"{HEALTH_MARK} {f['id']}"}
        if state:
            inp["stateId"] = state
        if f["kind"] != "doctor-gap":  # a check to add to wg is not work of the effort
            inp["projectId"] = project_id
        issue = gql("""mutation($i:IssueCreateInput!){ issueCreate(input:$i){ issue{id identifier} } }""",
                    {"i": inp})["issueCreate"]["issue"]
        filed[f["id"]] = issue["identifier"]
    return filed


def health_notice(plan, title, body):
    """Send one notice through each `notify` channel. Failures give one `warn notify:` line; it never raises."""
    deadline, errors = time.monotonic() + NOTIFY_DEADLINE, []
    for channel in CONFIG.get("notify") or []:
        if channel["type"] == "page":  # Health reports have no issue to open.
            continue
        try:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ReadError("no time left")
            NOTIFY_SENDERS[channel["type"]](channel, title, body, page_link(plan), remaining)
        except ReadError as e:
            errors.append(f"{channel['type']}: {one_line(e, 200)}")
    if errors:
        print(f"warn notify: {'; '.join(errors)}", file=sys.stderr, flush=True)


def health_report(plan_dir, plan, path, now=None):
    """`wg health <dir> --report <file>`: publish one check. Exit 0: published; 2: the file is not a report."""
    try:
        report = json.loads(Path(path).read_text())
    except (OSError, ValueError) as e:
        die(f"{path}: {e}")
    if not isinstance(report, dict) or not isinstance(report.get("findings"), list):
        die(f"{path}: a report is a JSON object with a list `findings`")
    for i, f in enumerate(report["findings"]):
        if problem := health_finding_problem(i, f):
            die(f"{path}: {problem}")
    if not isinstance(report.get("summary", ""), str):
        die(f"{path}: summary must be text")
    now = now or time.time()
    km = load_keymap(plan_dir)
    project_id = (km.get("project") or {}).get("id") or die("keymap.json has no project; run wg load --apply")
    statuses = snapshot(plan_dir, plan, km)[3]
    ships = [n["key"] for n in plan["nodes"] if n["kind"] == "ship-point"]
    complete = bool(ships) and all(statuses.get(k) in {"Done", "Canceled"} for k in ships)
    doctor = list(doctor_lines(plan_dir))
    faults, notes = health_findings(report, doctor, journal_entries(plan_dir), now, complete)
    value = health_value(faults)
    effort = run_rows(km)["effort"]
    previous = {i for i in (effort.get("health_faults") or "").split(",") if i}
    issues = health_file(plan, project_id, faults, previous)
    at = datetime.fromtimestamp(now, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    body = health_body(value, faults, notes, issues, at)
    if summary := " ".join(report.get("summary", "").split()):
        body = body.replace("\n\n", f"\n\n{summary}\n\n", 1)
    update = gql("""mutation($i:ProjectUpdateCreateInput!){ projectUpdateCreate(input:$i){ projectUpdate{ id url } } }""",
                 {"i": {"projectId": project_id, "body": body, "health": value}})["projectUpdateCreate"]["projectUpdate"]
    before = effort.get("health")
    with plan_lock(plan_dir):
        km = load_keymap(plan_dir)
        row = run_rows(km)["effort"]
        row.update(health=value, health_at=at, health_update=update.get("url") or update["id"])
        notify_set(row, "health_faults", set(faults))
        row.pop("health_started", None)
        save_keymap(plan_dir, km)
    if health_rank(value) > health_rank(before) and not effort_paused(plan_dir, plan):
        counted = [f for f in faults.values() if f["level"]]
        health_notice(plan, f"work-graph: {plan['effort']['name']} is {value}",
                      "\n".join(f"{f['level']} {f['id']}: {f['text'][:200]}" for f in counted[:10])
                      + f"\n{update.get('url') or ''}".rstrip())
    print(f"health {value}: {sum(1 for f in faults.values() if f['level'])} fault(s), {len(issues)} issue(s) filed or "
          f"commented; {update.get('url') or update['id']}")
    return 0


def health_lines(plan_dir):
    """The `note health` line of `wg next` when the last check was atRisk or offTrack."""
    effort = run_rows(load_keymap(plan_dir))["effort"]
    value = effort.get("health")
    if health_rank(value) == 0:
        return []
    count = len([i for i in (effort.get("health_faults") or "").split(",") if i])
    return [("note", f"health @effort -: {value} at {effort.get('health_at', '?')}, {count} fault(s); "
                     f"{effort.get('health_update', 'no update')}")]


def health_prompt(plan_dir, worktree):
    return (f"You are the work-graph status check of the effort in {plan_dir}. `wg health` started you. You are read "
            f"only: edit no file in {plan_dir} or in a repository, move no issue, add no comment or label, send no "
            "message to an agent, and run only the wg commands that references/health.md names, each with "
            "WG_LINK=off. Load the work-graph skill and read references/health.md (`wg explain health-check` prints "
            f"it). Do its checks. Write the findings as JSON to a new file in {worktree}/.wg-health/, run "
            f"`wg health {plan_dir} --report <file>` once, print its last line, and end.")


def health_command(plan_dir, plan, install=False, uninstall=False, due=False, report=None):
    """`wg health <dir> [--install | --uninstall | --due | --report <file>]`. With no flag: print the state."""
    here = str(Path(plan_dir).resolve())
    if due:
        start, reason = health_due(plan_dir, plan)
        print(f"{'start' if start else 'skip'}: {reason}")
        return 0 if start else 1
    if report:
        return health_report(plan_dir, plan, report)
    effort = run_rows(load_keymap(plan_dir))["effort"]
    current = effort.get("health_automation")

    def save(**fields):
        with plan_lock(plan_dir):
            km = load_keymap(plan_dir)
            row = run_rows(km)["effort"]
            for field, value in fields.items():
                if value:
                    row[field] = value
                else:
                    row.pop(field, None)
            save_keymap(plan_dir, km)

    if uninstall:
        if current:
            orca_result("automations", "remove", current)
        save(health_automation=None)
        tail = f"; the worktree {effort['health_worktree']} stays (orca worktree rm to remove it)" if effort.get("health_worktree") else ""
        print("health off" + tail)
        return 0
    if not install:
        last = f"last check {effort['health']} at {effort.get('health_at')}" if effort.get("health") else "no check yet"
        if not current:
            print(f"health off; {last}")
            return 0
        shown = orca_result("automations", "show", current).get("automation") or {}
        print(f"health {'on' if shown.get('enabled', True) else 'disabled'}: automation {current}, each hour, "
              f"interval {CONFIG['health_interval']:g} hours; {last}")
        return 0
    slug = plan["effort"].get("slug") or die("effort.slug is missing in plan.json")
    trees = orca_worktrees()
    core = find_tree(trees, path=here) or die(f"{here} is not an Orca worktree")
    branch = f"{BRANCH_PREFIX}{slug}-health"
    tree = find_tree({i: t for i, t in trees.items() if tree_repo(t) == tree_repo(core)}, branch=branch)
    if not tree:
        tree = created_tree("--name", f"{slug}-health", "--branch", branch, "--parent-worktree", f"id:{core['id']}",
                            "--base-branch", checked_out(here) or "HEAD", "--setup", "skip")
    worktree = str(Path(tree["path"]).resolve())
    agents = {a["id"] for a in orca_result("agent", "installed")["agents"]}
    agent = CONFIG["health_agent"]
    if agent not in agents:
        die(f"config health_agent {agent!r} is not an installed Orca agent ({', '.join(sorted(agents)) or 'none'})")
    precheck, prompt = automation_precheck("health", here, "--due"), health_prompt(here, worktree)
    if current:
        orca_result("automations", "edit", current, "--precheck", precheck, "--prompt", prompt, "--enabled")
        save(health_worktree=worktree)
        print(f"health on: automation {current}, each hour (updated), worktree {worktree}")
        return 0
    created = orca_result("automations", "create", "--name", f"wg health: {plan['effort']['name']}",
                          "--trigger", HEALTH_SCHEDULE, "--prompt", prompt, "--provider", agent,
                          "--workspace", f"id:{tree['id']}", "--precheck", precheck, "--precheck-timeout", "120",
                          "--fresh-session")
    automation = (created.get("automation") or created).get("id") or die("orca automations create returned no id")
    save(health_automation=automation, health_worktree=worktree)
    print(f"health on: automation {automation}, each hour, agent {agent}, worktree {worktree}")
    return 0


# ---------------------------------------------------------------- scheduled refresh

TICK_LABEL = CONFIG["tick_label"]  # the launchd label of `wg tick --install`
TICK_TRIGGER = [{"Minute": minute} for minute in (0, 15, 30, 45)]  # its launchd calendar: each 15 minutes


def discard_notice(page, entries):
    """Acknowledge the digest without delivery."""
    return True


# `notify`: the notice of notify_effort, through the channels of the config field `notify`. It replaces the digest.
TICK_CHANNELS = {"none": discard_notice, "notify": discard_notice}
TICK_DEFAULT_CHANNEL = "notify" if CONFIG["notify"] else "none"

# ---------------------------------------------------------------- notices (config field `notify`)

NOTIFY_RETRY = 300  # seconds: after a failed send, the next try waits this long
NOTIFY_DEADLINE = 5  # seconds for all channels of one notice together


def notify_entries(lines, asks):
    """The moves that are the human's: each `wait human` line, each `do ask` line, and each open worker question.
    Returns {id: text}. A line's id is a hash of its text; a question's id is a hash of its Orca message id."""
    texts = [f"{level} {text}" for level, text in lines
             if (level, text.split(" ", 1)[0]) == ("wait", "human")
             or (level == "do" and text.split(" ", 1)[0] in {"ask", "ask-ready", "ask-merge"})]
    entries = {hashlib.sha256(t.encode()).hexdigest()[:12]: t for t in texts}
    for ask in asks:
        body = " ".join(str(ask.get("body") or "").split())
        source = f"ask:{ask.get('id')}" if ask.get("id") else f"ask-text:{ask.get('key')}:{body}"
        entries[hashlib.sha256(source.encode()).hexdigest()[:12]] = \
            f"{ask.get('kind') or 'question'} {ask.get('issue') or ask.get('key')}: {body[:200]}"
    return entries


def notify_url(channel):
    """The URL of a webhook: from the environment variable `url_env`, else the mode-600 file `url_file`."""
    url = os.environ.get(channel["url_env"], "").strip() if channel.get("url_env") else ""
    if not url and channel.get("url_file"):
        path = Path(channel["url_file"]).expanduser()
        if not path.is_file():
            raise ReadError(f"no URL: {channel.get('url_env') or '-'} is not set and {path} does not exist")
        if path.stat().st_mode & 0o077:
            raise ReadError(f"{path} is readable by group or others; set mode 600")
        url = path.read_text().strip()
    if not url:
        raise ReadError(f"no URL: set {channel.get('url_env')}")
    return url


def notify_post(url, data, headers, timeout):
    """One HTTP POST. Tests replace it (the fake transport)."""
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as response:
        response.read()


def send_webhook(channel, title, body, link, timeout):
    """POST {title, body, url, text} as JSON. `text` is for a Slack-compatible incoming webhook. A plain ntfy
    topic URL takes the body as a template: the headers name the fields for the title and the message."""
    url = notify_url(channel)
    text = f"{title}\n{body}\n{link}"
    data = json.dumps({"title": title, "body": f"{body}\n{link}", "url": link, "text": text}).encode()
    headers = {"Content-Type": "application/json", "X-Template": "yes", "X-Title": "{{.title}}",
               "X-Message": "{{.body}}", "X-Click": link}
    try:
        notify_post(url, data, headers, timeout)
    except (OSError, ValueError, http.client.HTTPException) as e:
        # The URL is a secret (a topic or a webhook token): the error is a fixed text, never the transport's own.
        code = getattr(e, "code", None)
        reason = getattr(e, "reason", None)
        raise ReadError(f"HTTP {code}" if isinstance(code, int) else type(e).__name__ + (
            f" ({type(reason).__name__})" if isinstance(reason, BaseException) else "")) from None


def send_command(channel, title, body, link, timeout):
    """Run argv with the notice text on stdin. Its output is not shown: it can hold a credential."""
    try:
        result = subprocess.run(channel["argv"], input=f"{title}\n{body}\n{link}\n", capture_output=True,
                                text=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError) as e:
        raise ReadError(f"{Path(channel['argv'][0]).name}: {type(e).__name__}") from None
    if result.returncode != 0:
        raise ReadError(f"{Path(channel['argv'][0]).name}: exit {result.returncode}")


NOTIFY_SENDERS = {"webhook": send_webhook, "command": send_command}


class MissingPushToken(ReadError):
    pass


class PageNoticeRejected(ReadError):
    """A permanent error. Retrying this notice will not help."""


def push_page_connection(workspace, collab):
    if collab:
        return collab_page(collab, workspace)
    page = (workspace_page(workspace) or PAGE_URL).rstrip("/")
    token = link_token_for(page, workspace)
    if not token:
        raise MissingPushToken("run wg login for the workspace page")
    return page, {"Authorization": f"Bearer {token}"}


def push_page_request(page, headers, path, data, timeout):
    body = json.dumps(data).encode() if data is not None else None
    request = urllib.request.Request(page + path, data=body, headers=headers | {"Content-Type": "application/json"})
    try:
        with urllib.request.build_opener(NoPlanRedirect).open(request, timeout=timeout) as response:
            if response.status != (202 if body else 200):
                raise PageNoticeRejected(f"page returned HTTP {response.status}")
            return None if body else json.load(response)
    except urllib.error.HTTPError as error:
        with error:
            try:
                payload = json.loads(error.read(4096))
            except (ValueError, OSError, http.client.HTTPException):
                payload = None
            detail = payload.get("error") if isinstance(payload, dict) else None
            message = f"page returned HTTP {error.code}"
            if isinstance(detail, str) and detail:
                token = headers.get("Authorization", "").removeprefix("Bearer ")
                message += ": " + one_line(detail.replace(token, "[redacted]") if token else detail, 200)
            if data is None and error.code == 400:
                message += "; set to in the page channel to select an owner"
            elif data is None and error.code == 403 and detail == "The token identifies the recipient":
                message += "; remove to from the page channel"
            if error.code == 429 or 500 <= error.code < 600:
                raise ReadError(message) from None
            raise PageNoticeRejected(message) from None
    except (OSError, ValueError, http.client.HTTPException) as error:
        raise ReadError(f"page request failed ({type(error).__name__})") from None


def page_notice_entry(text, nodes, km):
    move, _, detail = text.partition(": ")
    parts = move.split()
    if parts and parts[0] in ("question", "escalation") and len(parts) == 2:
        issue = km["nodes"].get(parts[1], {}).get("identifier") or parts[1]
        kind = "question"
    elif len(parts) == 4:
        _, action, key, issue = parts
        if action in ("ask-merge", "ask-ready") or detail.startswith(("merge PR #", "mark PR #")):
            kind = "merge"
        elif action == "ask" or nodes.get(key) in ("decision", "ops"):
            kind = "decision"
        else:
            kind = "wait"
    else:
        raise PageNoticeRejected("the move has no issue")
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*-[0-9]+", issue):
        raise PageNoticeRejected("the move has no issue identifier")
    return {"issue": issue, "kind": kind}


def doctor_push(workspace, channel, collab, *, planless=False):
    try:
        page, headers = push_page_connection(workspace, collab)
    except MissingPushToken:
        if planless:
            return "warn", f"page notices for {workspace}: no token"
        raise
    path = "/api/push/status"
    if "to" in channel:
        path += "?" + urllib.parse.urlencode({"recipient": channel["to"]})
    result = push_page_request(page, headers, path, None, 5)
    label = f"page notices for {workspace}"
    if not isinstance(result, dict) or type(result.get("enabled")) is not bool or type(result.get("devices")) is not int:
        return "FAIL", f"{label}: invalid status response"
    if not result["enabled"]:
        return "FAIL", f"{label}: push is not set up"
    if result["devices"] < 1:
        return "FAIL", f"{label}: register a device on the page"
    return "ok", f"{label}: {result['devices']} registered device(s)"


def notify_ids(row, field):
    return {i for i in (row.get(field) or "").split(",") if i}


def notify_set(row, field, ids):
    if ids:
        row[field] = ",".join(sorted(ids))
    else:
        row.pop(field, None)


def notify_effort(plan_dir, plan, lines, paused, asks=None):
    """Send one notice when the human's moves (notify_entries) have an entry that the last notice did not have.

    Each channel N has its own run row fields: `notified_N`, the ids of the entries that it got and that still
    stand (an entry that goes away is removed, so it is sent again if it comes back), and `notify_failed_N`, the
    time of its last failed send; its next try waits NOTIFY_RETRY seconds. New entries are claimed under the plan
    lock before the send, so two commands do not send them twice. All channels together have NOTIFY_DEADLINE
    seconds. Failures give one `warn notify:` line. No channels or a paused effort: nothing. It never raises."""
    channels = CONFIG.get("notify") or []
    if not channels or paused:
        return None
    deadline = time.monotonic() + NOTIFY_DEADLINE
    try:
        entries = notify_entries(lines, open_asks(plan_dir) if asks is None else asks)
        now = utc_now()
        claims = {}
        with plan_lock(plan_dir):
            km = load_keymap(plan_dir)
            row = run_rows(km)["effort"]
            before = dict(row)
            for n in range(len(channels)):
                sent = notify_ids(row, f"notified_{n}") & entries.keys()
                new = [i for i in entries if i not in sent]
                failed = row.get(f"notify_failed_{n}")
                if new and not (failed and (now - parse_utc(failed)).total_seconds() < NOTIFY_RETRY):
                    claims[n] = new
                    sent |= set(new)
                notify_set(row, f"notified_{n}", sent)
            if row != before:
                save_keymap(plan_dir, km)
        errors = {}
        warnings = []
        for n, new in claims.items():
            accepted = 0
            kind = channels[n]["type"]
            title = f"work-graph: {len(new)} new move(s) for {HUMAN} in {plan['effort']['name']}"
            try:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ReadError("no time left")
                if kind == "page":
                    workspace = plan_workspace(plan)
                    collab = km.get("collab") or {}
                    page, headers = push_page_connection(workspace, collab)
                    target = {"workspace": collab.get("workspace") or workspace,
                              "project": collab.get("project") or (km.get("project") or {}).get("id") or plan["effort"]["name"]}
                    if "to" in channels[n]:
                        target["recipient"] = channels[n]["to"]
                    nodes = {node["key"]: node["kind"] for node in plan["nodes"]}
                    for entry in new:
                        remaining = deadline - time.monotonic()
                        if remaining <= 0:
                            raise ReadError("no time left")
                        try:
                            data = target | page_notice_entry(entries[entry], nodes, km)
                            push_page_request(page, headers, "/api/push/notices", data, remaining)
                        except PageNoticeRejected as e:
                            warnings.append(f"page: skipped entry {entry}: {one_line(e, 200)}")
                        accepted += 1
                    continue
                NOTIFY_SENDERS[kind](channels[n], title, "\n".join(entries[i] for i in new), page_link(plan),
                                     remaining)
            except ReadError as e:
                claims[n] = new[accepted:]
                errors[n] = f"{kind}: {one_line(e, 200)}"
        if claims:
            with plan_lock(plan_dir):
                km = load_keymap(plan_dir)
                row = run_rows(km)["effort"]
                for n, new in claims.items():
                    if n in errors:
                        notify_set(row, f"notified_{n}", notify_ids(row, f"notified_{n}") - set(new))
                        row[f"notify_failed_{n}"] = f"{now:%Y-%m-%dT%H:%M:%SZ}"
                    else:
                        row.pop(f"notify_failed_{n}", None)
                save_keymap(plan_dir, km)
        warnings.extend(errors.values())
        if warnings:
            print(f"warn notify: {'; '.join(warnings)}", file=sys.stderr, flush=True)
        return "failed" if errors else ("sent" if claims else None)
    except (ReadError, OSError, ValueError, KeyError, TypeError) as e:
        print(f"warn notify: {one_line(e, 200)}", file=sys.stderr, flush=True)
        return "failed"


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


def tick_members(inputs, lines, triage, runners=None):
    km, live, nodes, statuses, _, _ = inputs
    said = node_next(lines, nodes)
    members = dict(triage)
    held = claim_gate_keys(lines)
    for key, status in statuses.items():
        if key not in nodes or key in held or key in (runners or {}) or status in {"Done", "Canceled"}:
            continue
        entry = km["nodes"][key]
        reasons = [part for part in said.get(key, "").splitlines()
                   if part.split(": ", 1)[0] in {"wait human", "do ask", "do ask-ready", "do ask-merge"}]
        # A Ready to Merge PR that the coordinator merges itself (`do merge`, autonomy full) is not the human's move.
        coordinator_merges = any(part.startswith("do merge:") for part in said.get(key, "").splitlines())
        if reasons or status in {WAIT_STATUS, "Triage"} or (status == "Ready to Merge" and not coordinator_merges):
            members[entry["id"]] = {
                "issue": live[entry["id"]].get("identifier") or entry["identifier"],
                "reason": " ".join(reasons) or status,
            }
    return members


def tick_refresh(plan_dir, plan, km, record, notify=False):
    inputs = snapshot(plan_dir, plan, copy.deepcopy(km))
    statuses = inputs[3]
    ships = [node["key"] for node in plan["nodes"] if node["kind"] == "ship-point"]
    for key in ships:
        if key not in statuses:
            raise ReadError(f"{key}: ship point is missing from the keymap or Linear")
    complete = all(statuses[key] in {"Done", "Canceled"} for key in ships)
    current = project_claims(plan, km)
    if complete and current is not None:
        collaboration_lines(plan, km, statuses, inputs[1], current)
    if complete and record.get("complete"):
        return "complete", None
    triage = {}
    if complete:
        head, lines, members = COMPLETE, [], {}
    else:
        options = {"current_claims": current} if current is not None else {}
        head, lines = next_lines(plan_dir, plan, inputs=inputs, triage=triage, **options)
        if head == CLAIMS_UNAVAILABLE:
            raise ReadError(lines[0][1])
        members = tick_members(inputs, lines, triage, other_runners(plan, current))
    skipped = publish(plan_dir, plan, head, lines, expected=km)
    if skipped:
        return skipped, None
    if notify and not complete:
        notify_effort(plan_dir, plan, lines, effort_paused(plan_dir, plan))
    record["complete"] = complete
    return None, members


def tick_effort(plan_dir, state, save, sender, notify=False):
    plan = read_current_plan(plan_dir, strict=True)
    km = load_keymap(plan_dir)
    project = (km.get("project") or {}).get("id")
    if not project or not km["nodes"]:
        return "skipped: plan is not loaded"
    workspace = plan_workspace(plan)
    record = state.setdefault(f"{workspace}/{project}", {})
    token = LINEAR_WORKSPACE.set(workspace)
    try:
        linear_key()
        skipped, members = tick_refresh(plan_dir, plan, km, record, notify)
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


def tick_plans(roots=None):
    """The loaded efforts under the tick roots (config `tick_roots`): each `*-core` folder with plan.json and keymap.json."""
    roots = roots or [Path(root) for root in CONFIG["tick_roots"]]
    return sorted({path.parent.resolve() for root in roots for path in root.expanduser().glob("*-core/plan.json")
                   if path.is_file() and (path.parent / "keymap.json").is_file()})


def tick_command(ns):
    if ns.install or ns.uninstall:
        return tick_agent(ns)
    channel = ns.channel or TICK_DEFAULT_CHANNEL
    home = Path.home()
    plans = tick_plans(ns.root)
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
                outcome = tick_effort(path, state, save, TICK_CHANNELS[channel], channel == "notify")
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
    if ns.channel:  # an explicit choice; without one, each tick uses the default of the config
        args.extend(["--channel", ns.channel])
    path_dirs = dict.fromkeys([str(gh.parent), str(python.parent), "/usr/bin", "/bin", "/usr/sbin", "/sbin"])
    for root in ns.root or []:
        args.extend(["--root", str(root.expanduser().resolve())])
    path.write_bytes(plistlib.dumps({
        "Label": TICK_LABEL,
        "ProgramArguments": args,
        "RunAtLoad": True,
        "StartCalendarInterval": TICK_TRIGGER,
        "EnvironmentVariables": {"PATH": ":".join(path_dirs),
                                 "GH_PROMPT_DISABLED": "1"},
        "StandardOutPath": str(log / "out.log"),
        "StandardErrorPath": str(log / "error.log"),
    }))
    print("Put each Linear key in a private file (mode 600) in ~/.config/work-graph.")
    print("Name each file <workspace id>-linear-api-key: " + ", ".join(f"{w}-linear-api-key" for w in WORKSPACES) + ".")
    print(f"/bin/launchctl bootstrap {domain} {shlex.quote(str(path))}")
    return 0


# ---------------------------------------------------------------- agents (the agents of each effort, from Orca)

WATCH_LABEL = TICK_LABEL + ".agents"  # the launchd label of `wg agents --install`
WATCH_OPEN_TIMEOUT = 5    # seconds for the hosted page to start, resolve the project, and upgrade
WATCH_WARN_AFTER = 60     # seconds of failed sends before the first warning
WATCH_INTERVAL = 10       # seconds between two reads of Orca
WATCH_HEARTBEAT = 60      # seconds: the rows go again at least this often, so the page knows that `wg agents` runs
WATCH_SAID = 500          # characters of an agent's last message that go to the page
WATCH_ROWS = 50           # the most rows of one effort
WATCH_DONE_AGE = 24 * 3600  # seconds: an agent that ended longer ago is not sent
WATCH_POLLS = 2           # an agent must wait on the human in this many reads in sequence before the notice
# The Orca states in which an agent waits on the human, and what the notice says.
WATCH_NEEDS = {"blocked": "waits at a prompt", "waiting": "waits for your input"}


def agent_needs(row):
    """Why this agent waits on the human, or None. src/lib/link.ts `agentNeeds` has the same rule."""
    return WATCH_NEEDS.get(row.get("state"))


def agent_rows(plan_dir, km, agents, now=None):
    """The rows of the link message `agents` for one effort: the agents in the plan directory (role coordinator)
    and in the worktree of a run row (role worker, with its node key and issue). Coordinators first, then the
    newest first."""
    now = now or utc_now()
    here = str(Path(plan_dir).resolve())
    workers = {str(Path(row["path"]).expanduser().resolve()): key
               for key, row in run_rows(km)["nodes"].items() if row.get("path")}
    rows = []
    for a in agents:
        path = str(Path(a["path"]).resolve()) if a.get("path") else ""
        key = workers.get(path)
        if path != here and key is None:
            continue
        ident = str(a.get("orcaSessionId") or a.get("paneKey") or "")
        stamp = a.get("updatedAt")
        at = datetime.fromtimestamp(stamp / 1000, timezone.utc) if isinstance(stamp, (int, float)) else None
        if not ident or (a.get("state") == "done" and (not at or (now - at).total_seconds() > WATCH_DONE_AGE)):
            continue
        rows.append({"id": ident, "role": "coordinator" if path == here else "worker",
                     "key": None if path == here else key,
                     "issue": None if path == here else (km.get("nodes", {}).get(key) or {}).get("identifier"),
                     "agent": str(a.get("agent") or ""), "state": str(a.get("state") or ""),
                     "title": one_line(a.get("title"), 120), "said": one_line(a.get("lastAssistantMessage"), WATCH_SAID),
                     "at": f"{at:%Y-%m-%dT%H:%M:%SZ}" if at else None})
    rows.sort(key=lambda r: r["at"] or "", reverse=True)
    rows.sort(key=lambda r: r["role"] != "coordinator")
    return rows[:WATCH_ROWS]


def agent_replies_enabled():
    return CONFIG.get("agent_replies") is True and orca_caller()


def terminal_reply_ready(agent):
    """Require a rendered screen for the exact live terminal and reject visible choices."""
    terminals = orca_result("terminal", "list", "--include-visual-layouts", "--environment", "local")
    if terminals.get("truncated"):
        return False
    matches = [t for t in terminals["terminals"]
               if t.get("worktreeId") == agent.get("worktreeId") and t.get("connected") and t.get("writable")
               and t.get("tabId") and t.get("leafId")
               and f"{t['tabId']}:{t['leafId']}" == agent.get("paneKey")]
    if len(matches) != 1 or not matches[0].get("handle"):
        return False
    screen = orca_result("terminal", "read", "--terminal", matches[0]["handle"], "--screen",
                         "--environment", "local")["terminal"]
    if screen.get("source") != "screen" or not screen.get("tail"):
        return False
    choices = re.compile(r"^\s*[❯›>]\s*(?:\d+[.)]|[○●◯□■])\s|^\s*[○●◯□■]\s")
    return not any(choices.match(line) for line in screen["tail"])


def idle_reply_agent(plan_dir, km, ident):
    agents = orca_agents(local=True)
    matches = [a for a in agents if a.get("orcaSessionId") == ident]
    rows = [r for r in agent_rows(plan_dir, km, matches) if r["id"] == ident]
    if len(matches) == len(rows) == 1 and rows[0]["state"] == "done":
        return matches[0], rows[0]
    return None, None


def deliver_agent_reply(plan_dir, plan, reply):
    """Verify the target with local Orca, then submit mail once, with a replay only on Orca's request id."""
    ident, body, reply_id = reply.get("agent"), reply.get("body"), reply["id"]

    def refused(reason):
        return {"id": reply_id, "status": "refused", "reason": reason}

    unconfirmed = {"id": reply_id, "status": "unconfirmed",
                   "reason": "Orca did not confirm the mail. Check Orca before you reply again"}

    if not agent_replies_enabled():
        return refused("Agent replies require the watcher to run in your Orca terminal")
    if not isinstance(ident, str) or not re.fullmatch(r"(?:orca_session_id:)?[A-Za-z0-9_-]{1,180}", ident):
        return refused("Invalid Orca session id")
    if not isinstance(body, str) or len(body) > 4000:
        return refused("Invalid reply text")
    body = re.sub(r"[\x00-\x09\x0b-\x1f\x7f-\x9f]", "", body.replace("\r\n", "\n"))
    if not body.strip():
        return refused("Invalid reply text")

    token = COMMAND_TIMEOUT.set(3)
    try:
        km = load_keymap(plan_dir)
        agent, row = idle_reply_agent(plan_dir, km, ident)
        if not agent:
            return refused("The agent is no longer idle in this effort")
        if agent.get("kind") == "terminal":
            if not terminal_reply_ready(agent):
                return refused("Answer this agent in Orca")
            km = load_keymap(plan_dir)
            current, row = idle_reply_agent(plan_dir, km, ident)
            if not current or any(current.get(k) != agent.get(k) for k in ("paneKey", "worktreeId", "kind")):
                return refused("The agent is no longer idle in this effort")
        elif agent.get("kind") != "chat":
            return refused("Answer this agent in Orca")
    except (ReadError, OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        return refused("Could not check the agent in Orca. Answer this agent in Orca")
    finally:
        COMMAND_TIMEOUT.reset(token)

    target = "orca_session_id:" + ident.removeprefix("orca_session_id:")
    token = COMMAND_TIMEOUT.set(3)
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8") as text_file:
            text_file.write(body)
            text_file.flush()
            args = ("orchestration", "send", "--to", target, "--subject", "Reply from the project page",
                    "--body-file", text_file.name, "--environment", "local")
            try:
                receipt = orca_mutation(*args)
            except OrcaLost as error:
                receipt = orca_mutation(*args, retry=error.request)
        message = receipt.get("message")
        mail_id = message.get("id") if isinstance(message, dict) else None
        if not isinstance(mail_id, str) or not mail_id:
            return unconfirmed
    except OrcaRefused:
        return refused("Orca refused the mail. Answer this agent in Orca")
    except (OrcaLost, ReadError, OSError, ValueError, subprocess.SubprocessError):
        return unconfirmed
    finally:
        COMMAND_TIMEOUT.reset(token)

    issue = (km.get("nodes", {}).get(row["key"]) or {}).get("id") if row["role"] == "worker" else None
    if issue:
        workspace = LINEAR_WORKSPACE.set(plan_workspace(plan))
        try:
            comment(issue, "Reply to the agent: " + body)
        except (ReadError, OSError, ValueError, http.client.HTTPException):
            print("warn agents: Linear did not record the agent reply", file=sys.stderr, flush=True)
        finally:
            LINEAR_WORKSPACE.reset(workspace)
    return {"id": reply_id, "status": "delivered", "messageId": mail_id}


# Old servers accept rows but give no poll response. Remember this per endpoint until restart.
_NO_AGENT_REPLY_POLL = set()


def send_agents(plan_dir, plan, rows):
    """Publish the agent rows without becoming a coordinator. When enabled, take one queued reply."""
    url, project, session, _ = link_target(plan_dir, plan)
    endpoint = url.partition("?")[0]
    enabled = endpoint not in _NO_AGENT_REPLY_POLL and agent_replies_enabled()
    deadline = time.monotonic() + WATCH_INTERVAL - 1  # leave one second for the close
    with link_socket(url, workspace=plan_workspace(plan), open_timeout=WATCH_OPEN_TIMEOUT, deadline=deadline) as ws:
        payload = {"agents": rows}
        if CONFIG.get("agent_replies") is True:
            payload["replies"] = enabled
        if enabled:
            payload["sender"] = session
        ws.send(link_envelope(session, project, "agents", payload))
        if not enabled:
            return
        try:
            raw = ws.recv(timeout=2)
        except TimeoutError:
            _NO_AGENT_REPLY_POLL.add(endpoint)
            return
        message = json.loads(raw)
        if (not isinstance(message, dict) or message.get("v") != LINK_VERSION
                or message.get("type") != "agent-reply" or (message.get("project") or {}).get("id") != project):
            return
        reply = message.get("payload")
        if isinstance(reply, dict) and isinstance(reply.get("id"), str) and 0 < len(reply["id"]) <= 200:
            result = deliver_agent_reply(plan_dir, plan, reply)
            ws.send(link_envelope(session, project, "agent-reply-result", result))


def agent_entries(rows, seen):
    """The notice entries {id: text} of the rows: each agent that waits on the human for WATCH_POLLS reads in
    sequence. `seen` counts the reads, by entry id; an agent that moves again leaves it."""
    entries, counts = {}, {}
    for row in rows:
        why = agent_needs(row)
        if not why:
            continue
        ident = hashlib.sha256(f"agent:{row['id']}:{row['state']}".encode()).hexdigest()[:12]
        counts[ident] = seen.get(ident, 0) + 1
        if counts[ident] >= WATCH_POLLS:
            who = "coordinator" if row["role"] == "coordinator" else f"worker {row['issue'] or row['key']}"
            entries[ident] = f"{who} ({row['agent']}) {why}: {row['said'][:200]}"
    seen.clear()
    seen.update(counts)
    return entries


def notify_agents(plan, entries, record, now=None):
    """Send one notice for the entries that channel N did not get yet. `record` is this effort's part of the
    state file: `sent` {N: ids} and `failed` {N: time}. An entry that goes away leaves `sent`, so it is sent again
    if it comes back. A failed channel waits NOTIFY_RETRY seconds. Returns True when `record` changed."""
    channels = CONFIG.get("notify") or []
    now = now or utc_now()
    before = json.dumps(record, sort_keys=True)
    deadline = time.monotonic() + NOTIFY_DEADLINE
    sent_by, failed_by = record.setdefault("sent", {}), record.setdefault("failed", {})
    errors = []
    for n, channel in enumerate(channels):
        if channel["type"] == "page":  # Agent activity is separate from human move notices.
            continue
        sent = set(sent_by.get(str(n), [])) & entries.keys()
        new = [i for i in entries if i not in sent]
        failed = failed_by.get(str(n))
        if new and not (failed and (now - parse_utc(failed)).total_seconds() < NOTIFY_RETRY):
            title = f"work-graph: {len(new)} agent(s) wait on {HUMAN} in {plan['effort']['name']}"
            try:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ReadError("no time left")
                NOTIFY_SENDERS[channel["type"]](channel, title, "\n".join(entries[i] for i in new), page_link(plan),
                                                remaining)
                sent |= set(new)
                failed_by.pop(str(n), None)
            except ReadError as e:
                failed_by[str(n)] = f"{now:%Y-%m-%dT%H:%M:%SZ}"
                errors.append(f"{channel['type']}: {one_line(e, 200)}")
        sent_by[str(n)] = sorted(sent)
    if errors:
        print(f"warn notify: {'; '.join(errors)}", file=sys.stderr, flush=True)
    return json.dumps(record, sort_keys=True) != before


def agents_state_path():
    return Path.home() / ".local/state/work-graph/agents.json"


def agents_stamp(plan_dir):
    key = hashlib.sha256(os.fsencode(Path(plan_dir).resolve())).hexdigest()
    return agents_state_path().parent / "agent-sends" / f"{key}.json"


def record_agents_send(plan_dir):
    path = agents_stamp(plan_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    save_json(path, {"at": f"{utc_now():%Y-%m-%dT%H:%M:%SZ}"}, mode=0o600)


def agents_file_stamp(path):
    try:
        st = path.stat()
    except FileNotFoundError:
        return None
    return [st.st_mtime_ns, st.st_ino]


def agents_token_files():
    paths = {LINK_TOKEN_FILE}
    for workspace in WORKSPACES:
        url = workspace_page(workspace)
        if url:
            paths.add(LINK_TOKEN_FILE.with_name(f"{workspace}-link-token"))
    for url in {PAGE_URL, *configured_pages()}:
        with contextlib.suppress(LinkTokenError):
            paths.add(page_token_path(url))
    return paths


def agents_token_stamps():
    return {str(path): agents_file_stamp(path) for path in agents_token_files()}


def reload_agents_config():
    global CONFIG, HUMAN, WORKSPACES, DEFAULT_WORKSPACE_ID, PAGE_URL
    config = read_config(CONFIG_PATH)
    CONFIG, HUMAN = config, config["human"]
    WORKSPACES = {w["id"]: w for w in config["workspaces"]}
    DEFAULT_WORKSPACE_ID = config["workspaces"][0]["id"]
    PAGE_URL = config["page_url"] or "http://127.0.0.1:4747"


def start_agents_send(path, plan, rows):
    from concurrent.futures import Future
    from threading import Thread

    result = Future()

    def send():
        try:
            send_agents(path, plan, rows)
        except Exception as error:
            result.set_exception(error)
        else:
            result.set_result(None)

    # One send per effort. A system DNS lookup can outlive a socket deadline.
    Thread(target=contextvars.copy_context().run, args=(send,), daemon=True).start()
    return result


def finish_agents_send(path, mine, clock, record_send, once):
    result, digest, started, name, workspace = mine.pop("pending")
    try:
        result.result()
    except Exception as error:
        since = mine.setdefault("failed_since", started)
        if once or (not mine.get("warned") and clock() - since > WATCH_WARN_AFTER):
            if isinstance(error, LinkUnauthorized):
                reason = link_unauthorized_message(workspace)
            elif isinstance(error, (LinkTokenError, LinkResponseError, ReadError)):
                reason = one_line(error, 200)
            else:
                reason = type(error).__name__
            print(f"warn link: {name}: {reason}", file=sys.stderr, flush=True)
            mine["warned"] = True
    else:
        mine.update(digest=digest, at=clock())
        mine.pop("failed_since", None)
        if mine.pop("warned", False):
            print(f"ok link: {name}: agents send recovered", file=sys.stderr, flush=True)
        if record_send:
            record_send(path)


def watch_poll(memory, state, roots=None, clock=time.monotonic, *, record_send=None, once=False):
    """One read of Orca. For each loaded effort: send its rows when they changed or the heartbeat is due, and
    send the notice of the agents that wait on the human. `memory` lives as long as the process: for each plan
    directory, what was last sent and the wait counts. `state` is the file of the sent notices (agents.json). Returns the
    efforts with their rows, and True when `state` changed."""
    from concurrent.futures import wait

    deadline = time.monotonic() + WATCH_INTERVAL
    agents = orca_agents(local=True) if agent_replies_enabled() else orca_agents()
    found, changed = [], False
    for path in tick_plans(roots):
        try:
            plan, km = read_current_plan(path), load_keymap(path)
        except ReadError as error:
            print(f"warn agents: {path}: {error}", file=sys.stderr)
            continue
        except (SystemExit, OSError, ValueError):
            continue
        project = (km.get("project") or {}).get("id")
        if not project:
            continue
        rows = agent_rows(path, km, agents)
        mine = memory.setdefault(str(path), {"digest": None, "at": 0.0, "seen": {}})
        digest = json.dumps(rows, sort_keys=True)
        due = mine.get("resend") or digest != mine["digest"] or (rows and clock() - mine["at"] >= WATCH_HEARTBEAT)
        workspace = plan_workspace(plan)
        # Send an empty message after the last agent leaves.
        if not mine.get("pending") and (due or agent_replies_enabled()) and (rows or mine["digest"] not in (None, "[]")):
            mine.pop("resend", None)
            mine["pending"] = (start_agents_send(path, plan, rows), digest, clock(),
                               plan["effort"]["name"], workspace)
        elif not rows and not mine.get("pending"):
            mine.pop("failed_since", None)
            mine.pop("warned", None)
        key = f"{workspace}/{project}"
        entries = agent_entries(rows, mine["seen"])
        if CONFIG.get("notify") and (entries or key in state):
            record = state.setdefault(key, {})
            changed |= notify_agents(plan, entries, record)
            if not entries and not any(record.get("sent", {}).values()) and not record.get("failed"):
                del state[key]
                changed = True
        found.append((plan["effort"]["name"], rows))
    pending = [(path, mine) for path, mine in memory.items() if mine.get("pending")]
    if pending:
        wait([mine["pending"][0] for _, mine in pending], timeout=max(0, deadline - time.monotonic()))
        for path, mine in pending:
            if mine["pending"][0].done():
                finish_agents_send(path, mine, clock, record_send, once)
    return found, changed


def watch_command(ns):
    """`wg agents`: read Orca each WATCH_INTERVAL seconds and send each effort's agents to the page. `--once`: one
    read, and print the rows. `--wait`: when another sender runs, wait for it to stop instead of exiting."""
    if ns.install or ns.uninstall:
        return watch_agent(ns)
    home = Path.home()
    state_path = agents_state_path()
    state_path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(state_path.with_suffix(".lock"), os.O_CREAT | os.O_RDWR, 0o600)
    token = COMMAND_TIMEOUT.set(30)
    try:
        if not ns.once:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                if not getattr(ns, "wait", False):
                    print("skipped: wg agents is already running")
                    return 0
                print("waiting: wg agents is already running; this one starts when it stops", flush=True)
                fcntl.flock(fd, fcntl.LOCK_EX)
        state = json.loads(state_path.read_text()) if state_path.exists() else {}
        memory, warned, trimmed = {}, None, 0.0
        script = Path(__file__).resolve()
        script_stamp = agents_file_stamp(script)
        config_stamp = agents_file_stamp(CONFIG_PATH)
        reload_config = not ns.once
        token_stamps = agents_token_stamps()
        while True:
            cycle = time.monotonic()
            if agents_file_stamp(script) != script_stamp:
                print("note agents: wg.py changed, restart the sender", file=sys.stderr, flush=True)
                return 1
            try:
                new_config = agents_file_stamp(CONFIG_PATH)
                if reload_config or new_config != config_stamp:
                    try:
                        reload_agents_config()
                        reload_config = False
                    except SystemExit as error:
                        raise ReadError(str(error)) from None
                new_tokens = agents_token_stamps()
                if new_config != config_stamp or new_tokens != token_stamps:
                    for mine in memory.values():
                        mine["resend"] = True
                    config_stamp, token_stamps = new_config, new_tokens
                if not ns.once:
                    save_json(state_path.with_suffix(".sender"), {
                        "script": str(script), "source": script_stamp, "config": config_stamp, "tokens": token_stamps,
                    }, mode=0o600)
                found, changed = watch_poll(memory, state, ns.root, record_send=record_agents_send, once=ns.once)
                if changed:
                    save_json(state_path, state, mode=0o600)
                warned = None
            except (ReadError, OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as e:
                if ns.once:
                    raise ReadError(one_line(e, 300)) from None
                found, text = [], f"{type(e).__name__}: {one_line(e, 200)}"
                if text != warned:  # one line for each new fault, not one for each read
                    print(f"warn agents: {text}", file=sys.stderr, flush=True)
                    warned = text
            if ns.once:
                for name, rows in found:
                    for r in rows:
                        who = "coordinator" if r["role"] == "coordinator" else f"worker {r['issue'] or r['key']}"
                        print(f"{name}: {who} {r['agent']} {r['state']} {r['at'] or '-'}: {r['said'][:120]}")
                if not any(rows for _, rows in found):
                    print("no agent of a loaded effort is open in Orca")
                return 0
            if time.monotonic() - trimmed > 3600:
                trim_tick_logs(home / "Library/Logs/wg-agents")
                trimmed = time.monotonic()
            time.sleep(max(0, cycle + WATCH_INTERVAL - time.monotonic()))
    finally:
        COMMAND_TIMEOUT.reset(token)
        os.close(fd)


AGENTS_PLUGIN_ID = "wg-agents"  # the Orca plugin in orca-plugin/ that keeps `wg agents` running in an Orca terminal


def agents_plugin_dir():
    """The plugin folder of the checkout that holds this wg.py."""
    return Path(__file__).resolve().parents[3] / "orca-plugin"


def orca_json(*args):
    """Run one Orca CLI command with --json. Returns the parsed reply; Orca puts an error in it."""
    result = command(orca_cli(), *args, "--json")
    try:
        return json.loads(result.stdout)
    except ValueError:
        raise ReadError(f"orca {args[0]} {args[1]}: {one_line(command_error(result), 200)}") from None


def agents_plugin():
    """The installed `wg-agents` Orca plugin, or None."""
    reply = orca_json("plugin", "list")
    if not reply.get("ok"):
        raise ReadError(f"orca plugin list: {(reply.get('error') or {}).get('message', 'failed')}")
    return next((p for p in reply["result"].get("plugins", [])
                 if p.get("pluginKey", "").rsplit(".", 1)[-1] == AGENTS_PLUGIN_ID), None)


def legacy_watch_agent():
    """Remove the launchd sender of older versions: it cannot send replies, and it holds the sender lock."""
    path = Path.home() / "Library/LaunchAgents" / (WATCH_LABEL + ".plist")
    if not path.exists():
        return
    domain = f"gui/{os.getuid()}"
    if sys.platform == "darwin":
        command("/bin/launchctl", "bootout", f"{domain}/{WATCH_LABEL}")
    path.unlink(missing_ok=True)
    print(f"removed the launchd sender {WATCH_LABEL}")


def watch_agent(ns):
    """`wg agents --install`: install or update the Orca plugin that keeps `wg agents` running in an Orca terminal.
    `--uninstall` removes it. Both remove the launchd sender of older versions."""
    try:
        legacy_watch_agent()
        installed = agents_plugin()
        if ns.uninstall:
            if installed:
                reply = orca_json("plugin", "uninstall", installed["pluginKey"])
                if not reply.get("ok"):
                    raise ReadError(f"orca plugin uninstall: {(reply.get('error') or {}).get('message', 'failed')}")
                print(f"removed the Orca plugin {installed['pluginKey']}")
            else:
                print("the Orca plugin is not installed")
            return 0
        folder = agents_plugin_dir()
        if not (folder / "orca-plugin.json").exists():
            raise ReadError(f"no Orca plugin at {folder}: install wg from a checkout of the repository")
        local = orca_json("plugin", "inspect", str(folder))
        if not local.get("ok"):
            raise ReadError(f"orca plugin inspect: {(local.get('error') or {}).get('message', 'failed')}")
        source = (installed or {}).get("source") or {}
        if installed and source.get("contentHash") == local["result"].get("contentHash") \
                and not installed.get("needsReconsent"):
            print(f"the Orca plugin {installed['pluginKey']} is installed and current ({installed.get('status')})")
            return 0
        args = ("plugin", "update", installed["pluginKey"]) if installed and source.get("reference") == str(folder) \
            else ("plugin", "install", str(folder))
        reply = orca_json(*args, *(("--approve", ns.approve) if ns.approve else ()))
    except (OSError, subprocess.SubprocessError) as error:
        raise ReadError(f"orca: {one_line(error, 200)}") from None
    if reply.get("ok"):
        result = reply["result"]
        print(f"installed the Orca plugin {result.get('pluginKey')} {result.get('version')}: "
              "it starts wg agents in an Orca terminal now and after each Orca start")
        return 0
    error = reply.get("error") or {}
    data = error.get("data") or {}
    if error.get("code") in ("approval_required", "approval_stale"):
        grants = (data.get("plugin") or {}).get("grants") or data.get("grants") or {}
        print("The Orca plugin asks for this access:")
        if grants.get("executionDescription"):
            print(f"  - {grants['executionDescription']}")
        for grant in grants.get("capabilities", []):
            print(f"  - {grant.get('kind')}: {grant.get('description', '')}")
        fingerprint = re.search(r"--approve (\S+)", data.get("command", ""))
        if fingerprint:
            print(f"To approve it, run: wg agents --install --approve {fingerprint.group(1)}")
        return 3
    raise ReadError(f"orca {' '.join(args[:2])}: {error.get('message', 'failed')}")


# ---------------------------------------------------------------- doctor

DOCTOR_STALE_START = 30 * 60  # seconds: a run row in creating or starting for longer is stuck (recovery.md "Resume")
PAGE_CONTRACT_TTL = 10 * 60   # seconds: `wg next` reads the server's contract at most this often
PAGE_CONTRACT_WAIT = 2        # seconds: the time limit of that GET, and of the plan lock for its cache
# The skill links of the agents (README "Install"). Each that exists must point at the checkout of `wg` on PATH.
SKILL_LINKS = ("~/.claude/skills/work-graph", "~/.agents/skills/work-graph", "~/.codex/skills/work-graph")
STUCK = {"creating", "starting"}
NOT_STARTED = {"Todo", "Ready", "Backlog", "Triage"}


def doctor_run(name, check):
    """The lines of one check: a list of (level, text). A check that raises is one FAIL line with the error."""
    try:
        result = check()
    except SystemExit as e:  # die() printed its message to stderr
        return [("FAIL", f"{name}: stopped with exit code {e.code}")]
    except Exception as e:
        return [("FAIL", f"{name}: {one_line(e, 300) or type(e).__name__}")]
    return result if isinstance(result, list) else [result]


def doctor_python():
    v = sys.version_info
    if v < (3, 11):
        return "FAIL", f"python: {v.major}.{v.minor}.{v.micro}; wg needs 3.11 or later"
    return "ok", f"python: {v.major}.{v.minor}.{v.micro}"


def doctor_websockets():
    try:
        import websockets
    except ImportError:
        return "warn", "websockets: not in this Python, so wg next polls Linear; run wg through uv for the link"
    return "ok", f"websockets: {getattr(websockets, '__version__', 'installed')}"


def git_top(path):
    result = command("git", "-C", str(path), "rev-parse", "--show-toplevel")
    return result.stdout.strip() if result.returncode == 0 else None


def doctor_checkout():
    """`wg` on PATH and each skill link point at one checkout, and that checkout is not behind origin/main."""
    found = {}
    if on_path := shutil.which("wg"):
        found["wg"] = Path(on_path).resolve().parent
    for link in SKILL_LINKS:
        if (path := Path(link).expanduser()).exists():
            found[link] = path.resolve()
    if "wg" not in found:
        return "FAIL", "checkout: wg is not on PATH (setup.md: ln -s <skill-dir>/scripts/wg.py ~/.local/bin/wg)"
    if len(found) == 1:
        return "FAIL", "checkout: no skill link (README \"Install\": " + ", ".join(SKILL_LINKS) + ")"
    tops = {name: git_top(path) or str(path) for name, path in found.items()}
    if len(set(tops.values())) > 1:
        return "FAIL", "checkout: " + "; ".join(f"{n} -> {t}" for n, t in tops.items()) + ": link each to one checkout"
    top = tops["wg"]
    remote = command("git", "-C", top, "ls-remote", "origin", "refs/heads/main")
    if remote.returncode or not remote.stdout.split():
        return "warn", f"checkout: {top}; origin/main not read ({command_error(remote) if remote.returncode else 'no main'})"
    sha = remote.stdout.split()[0]
    head = git_output("rev-parse", "HEAD", cwd=top)
    if head == sha:
        return "ok", f"checkout: {top} at origin/main"
    if command("git", "-C", top, "merge-base", "--is-ancestor", sha, "HEAD").returncode == 0:
        return "ok", f"checkout: {top}, ahead of origin/main"
    return "FAIL", f"checkout: {top} is behind origin/main ({sha[:10]}); pull it (git -C {shlex.quote(top)} pull --ff-only)"


def rate_budget():
    """The remaining request budget from the last Linear response."""
    parts = [f"{name} {LINEAR_RATE[f'{name}-remaining']}/{LINEAR_RATE.get(f'{name}-limit', '?')}"
             for name in ("requests", "complexity") if f"{name}-remaining" in LINEAR_RATE]
    return ", ".join(parts) + " left" if parts else "no budget headers"


def doctor_key(workspace, *, team=None):
    def check():
        key, source = key_source(workspace)
        if not key:
            return "FAIL", (f"key {workspace}: none; set {key_env_name(workspace)} or write "
                            f"~/.config/work-graph/{workspace}-linear-api-key (mode 600)")
        if isinstance(source, Path) and (mode := stat.S_IMODE(source.stat().st_mode)) != 0o600:
            return "FAIL", f"key {workspace}: {source} has mode {mode:o}, not 600; chmod 600 it"
        LINEAR_RATE.clear()
        token = LINEAR_WORKSPACE.set(workspace)
        try:
            gql("{ viewer { id } }")
            accepted = ("ok", f"key {workspace}: accepted ({source}); {rate_budget()}")
            if team:
                try:
                    workflow = linear_workflow_check(team)
                except ReadError as e:
                    workflow = [("warn", f"{team} could not check the workflow. Run wg setup. {e}")]
                return [accepted, *(("warn" if level == "FAIL" else level, message)
                                    for level, message in workflow)]
            return accepted
        finally:
            LINEAR_WORKSPACE.reset(token)
    return check


def doctor_tool(name, args):
    def check():
        problem = tool_problem(args)
        return ("FAIL", f"{name}: {flat_line(problem)}") if problem else ("ok", f"{name}: {' '.join(args)}")
    return check


def page_get(path, timeout=10, headers=None, *, use_token=True, workspace=None):
    request = urllib.request.Request(f"{page_base(workspace)}{path}", headers=headers or {})
    try:
        token = link_token_for(request.full_url, workspace) if use_token else ""
    except LinkTokenError as error:
        warn_link_token(error, workspace)
        token = ""
    if token:
        # Do not forward the credential on a redirect.
        request.add_unredirected_header("Authorization", f"Bearer {token}")
    try:
        response = open_page_request(request, timeout)
    except urllib.error.HTTPError as error:
        if token and error.code == 401:
            warn_link_token(link_unauthorized_message(workspace), workspace)
        raise
    except ValueError:
        if token:
            warn_link_token("the token could not be sent in the page request", workspace)
            raise ValueError("could not send page request") from None
        raise
    with response:
        return json.load(response)


def doctor_link_token(workspace=None):
    url = (workspace_page(workspace) or PAGE_URL).rstrip("/")
    label = f"link token for {url}"
    token = link_token_for(url, workspace)
    if not token:
        return "ok", f"{label}: no token"
    check_page_token(url, token)
    return "ok", f"{label}: accepted"


def doctor_page(workspace=None):
    """The page server answers `/healthz`, and `/api/config` names the contract of this wg."""
    health = page_get("/healthz", workspace=workspace)
    if not isinstance(health, dict) or health.get("ok") is not True:
        return "FAIL", f"page: {page_base(workspace)}/healthz did not answer ok"
    theirs, ours = page_get("/api/config", workspace=workspace).get("contract"), contract_hash()
    if theirs != ours:
        return "FAIL", f"page contract: deploy the page (the server has {theirs}, wg has {ours})"
    return "ok", f"page: {page_base(workspace)}, contract {ours}"


def doctor_tick():
    if sys.platform != "darwin":
        return "warn", "tick: wg tick --install uses launchd (macOS); schedule wg tick another way"
    path = Path.home() / "Library/LaunchAgents" / (TICK_LABEL + ".plist")
    if not path.exists():
        return "warn", "tick: not installed (wg tick --install)"
    domain = f"gui/{os.getuid()}"
    if command("/bin/launchctl", "print", f"{domain}/{TICK_LABEL}").returncode:
        return "warn", f"tick: {path} is not loaded (/bin/launchctl bootstrap {domain} {shlex.quote(str(path))})"
    try:
        trigger = plistlib.loads(path.read_bytes()).get("StartCalendarInterval")
    except (OSError, ValueError, AttributeError, plistlib.InvalidFileException):
        return "warn", f"tick: {TICK_LABEL} loaded, but its trigger in {path} is not readable"
    if trigger != TICK_TRIGGER:
        return "FAIL", f"tick: the trigger of {path} is {trigger!r}, not each 15 minutes; wg tick --install again"
    return "ok", f"tick: {TICK_LABEL} loaded, each 15 minutes"


def doctor_watch():
    try:
        plugin = agents_plugin()
    except (ReadError, OSError, subprocess.SubprocessError) as error:
        return "warn", f"agents: cannot read the Orca plugins ({one_line(error, 120)})"
    if not plugin:
        return "warn", "agents: the Orca plugin is not installed (wg agents --install); the page does not show the agents"
    if plugin.get("needsReconsent"):
        return "warn", f"agents: the Orca plugin {plugin['pluginKey']} needs a new approval (wg agents --install)"
    try:
        local = orca_json("plugin", "inspect", str(agents_plugin_dir()))
        current = (plugin.get("source") or {}).get("contentHash") == (local.get("result") or {}).get("contentHash")
    except (ReadError, OSError, subprocess.SubprocessError):
        current = True
    if not current:
        return "warn", f"agents: the Orca plugin {plugin['pluginKey']} is older than this checkout (wg agents --install)"
    if plugin.get("status") in ("disabled", "error", "failed"):
        return "warn", f"agents: the Orca plugin {plugin['pluginKey']} is {plugin['status']}"
    return "ok", f"agents: the Orca plugin {plugin['pluginKey']} keeps wg agents running ({plugin.get('status')})"


def doctor_agents(plan_dir):
    # Only the continuous sender holds this lock. A stale lock file is harmless.
    running = False
    try:
        with agents_state_path().with_suffix(".lock").open("rb") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                running = True
    except FileNotFoundError:
        pass
    last = "none"
    try:
        last = json.loads(agents_stamp(plan_dir).read_text())["at"]
    except FileNotFoundError:
        pass
    level, detail = ("ok", "running") if running else ("warn", "stopped")
    status = f"agents: service {detail}; last send: {last}"
    if running:
        try:
            sender = json.loads(agents_state_path().with_suffix(".sender").read_text())
        except FileNotFoundError:
            restart = "close its Orca terminal; the Orca plugin starts a new one"
            return "warn", f"{status}; cannot verify sender settings, {restart}"
        if (sender["source"] != agents_file_stamp(Path(sender["script"]))
                or sender["config"] != agents_file_stamp(CONFIG_PATH)
                or sender["tokens"] != agents_token_stamps()):
            return "warn", f"{status}; the agents sender runs old settings, it reloads or restarts at its next cycle"
    return level, status


def doctor_agent_replies():
    if CONFIG.get("agent_replies") is not True:
        return "ok", "agent replies: off"
    if orca_caller():
        return "ok", "agent replies: on; this Orca terminal can run the watcher"
    try:
        plugin = agents_plugin()
    except (ReadError, OSError, subprocess.SubprocessError):
        plugin = None
    if plugin and not plugin.get("needsReconsent"):
        return "ok", f"agent replies: on; the Orca plugin {plugin['pluginKey']} runs the watcher in an Orca terminal"
    return "warn", "agent replies: on in config; install the Orca plugin (wg agents --install) to take replies"


def wake_trigger(automation, cron=WAKE_SCHEDULE, forms=None):
    """True when the Orca automation runs at the times of `cron` (default: each 5 minutes, WAKE_SCHEDULE), False
    when it runs at other times, None when its trigger is not readable. Orca keeps the trigger as `rrule`; a
    `trigger` field is the cron text. `forms` are the rrule parts that are the same times as `cron`."""
    if (text := automation.get("trigger")) is not None:
        return text == cron
    rrule = automation.get("rrule")
    if not isinstance(rrule, str) or "FREQ=" not in rrule:
        return None
    parts = dict(part.split("=", 1) for part in rrule.upper().split(";") if "=" in part)
    if parts.get("BYSECOND") == "0":
        del parts["BYSECOND"]
    if parts.get("INTERVAL") == "1":
        del parts["INTERVAL"]
    if forms is None:
        forms = ({"FREQ": "MINUTELY", "INTERVAL": "5"},
                 {"FREQ": "HOURLY", "BYMINUTE": ",".join(str(m) for m in range(0, 60, 5))})
    return parts in forms


def doctor_autostart(plans):
    """Each effort with autostart on has its Orca automation, and the automation is on."""
    def check():
        lines = []
        for path in plans:
            automation = run_rows(load_keymap(path))["effort"].get("autostart")
            if not automation:
                continue
            result = command(orca_cli(), "automations", "show", automation, "--json")
            if result.returncode:
                lines.append(("FAIL", f"autostart {path}: automation {automation}: {flat_line(command_error(result))}; "
                              f"wg autostart {shlex.quote(str(path))} --install"))
                continue
            shown = json.loads(result.stdout)["result"].get("automation") or {}
            name = f"autostart {path}: automation {automation}"
            if "agentId" in shown or "extraAgentArgs" in shown:
                settings = resolve_agent(load_plan(path), "coordinator")
                extra = automation_model_args(settings.get("agent") or shown.get("agentId"), settings)
                agent_differs = ("agentId" in shown and settings.get("agent")
                                 and shown["agentId"] != settings["agent"])
                if agent_differs or (shown.get("extraAgentArgs") or "") != extra:
                    lines.append(("warn", f"{name} differs from the coordinator settings. "
                                  f"Run wg autostart {shlex.quote(str(path))} --install"))
            if not shown.get("enabled", True):
                lines.append(("warn", f"{name} disabled"))
            elif (every5 := wake_trigger(shown)) is None:
                lines.append(("warn", f"{name} on, but its trigger is not readable"))
            elif not every5:
                lines.append(("FAIL", f"{name} does not run each 5 minutes ({shown.get('rrule') or shown.get('trigger')}); "
                              f"wg autostart {shlex.quote(str(path))} --install"))
            else:
                lines.append(("ok", f"{name} on, each 5 minutes"))
        return lines or [("ok", "autostart: off for each loaded effort")]
    return check


def doctor_health(plans):
    """Each effort with the status check on has its Orca automation, the automation is on and runs each hour, and
    its worktree exists."""
    def check():
        lines = []
        for path in plans:
            effort = run_rows(load_keymap(path))["effort"]
            automation = effort.get("health_automation")
            if not automation:
                continue
            name = f"health {path}: automation {automation}"
            fix = f"wg health {shlex.quote(str(path))} --install"
            result = command(orca_cli(), "automations", "show", automation, "--json")
            if result.returncode:
                lines.append(("FAIL", f"{name}: {flat_line(command_error(result))}; {fix}"))
                continue
            shown = json.loads(result.stdout)["result"].get("automation") or {}
            if (worktree := effort.get("health_worktree")) and not Path(worktree).exists():
                lines.append(("FAIL", f"{name}: its worktree {worktree} does not exist; {fix}"))
            elif not shown.get("enabled", True):
                lines.append(("warn", f"{name} disabled"))
            elif (hourly := wake_trigger(shown, HEALTH_SCHEDULE, HEALTH_FORMS)) is None:
                lines.append(("warn", f"{name} on, but its trigger is not readable"))
            elif not hourly:
                lines.append(("FAIL", f"{name} does not run each hour ({shown.get('rrule') or shown.get('trigger')}); {fix}"))
            else:
                lines.append(("ok", f"{name} on, each hour; last check {effort.get('health') or 'none'}"))
        return lines or [("ok", "health: off for each loaded effort")]
    return check


def doctor_context(plans, fix):
    """Each effort's core worktree has core_settings(): config `coordinator_settings` and the context limit. With
    fix, write them; a refusal of the writer is the result."""
    def check():
        values = core_settings()
        if not values:
            return "ok", "settings: off (no coordinator_settings, context_limit 0)"
        lines = []
        for path in plans:
            if not loaded_effort(path):
                if fix:
                    lines.append(("warn", f"settings {path}: not the plan directory of a loaded effort (plan.json "
                                  "and keymap.json); nothing written"))
                continue
            # Each agent on its own: a file that does not parse stops only that agent.
            missing, broken = [], []
            for agent, v in values.items():
                try:
                    if not settings_have(path, agent, v):
                        missing.append(WORKER_SETTINGS_FILES[agent])
                except (OSError, ValueError) as e:
                    broken.append(one_line(e, 200))
            if not fix:
                lines += [("FAIL", f"settings {path}: {e}") for e in broken]
                if missing:
                    lines.append(("warn", f"settings {path}: {', '.join(missing)} lacks the configured values; "
                                  f"wg doctor {shlex.quote(str(path))} --fix"))
                continue
            # Also when nothing is missing: the exclude step. One line for each refusal.
            lines += [("warn", f"settings {path}: not written: {problem}") for problem in set_core_settings(path, True, [])]
            done = [WORKER_SETTINGS_FILES[a] for a, v in values.items()
                    if WORKER_SETTINGS_FILES[a] in missing and settings_have(path, a, v)]
            if done:
                lines.append(("ok", f"settings {path}: {', '.join(done)} set; a new session uses them"))
        return lines or [("ok", "settings: each loaded effort's core worktree has the coordinator settings")]
    return check


def row_age(plan_dir, key, field, value, entries, now):
    """Seconds since the run row field got its value: the last journal entry that set it, else the time of
    keymap.json (the row did not change after it)."""
    times = [parse_utc(e["time"]).timestamp() for e in entries
             if e.get("key") == key and (e.get("changes") or {}).get(field, [None, None])[1] == value]
    return now - (times[-1] if times else keymap_path(plan_dir).stat().st_mtime)


def doctor_keymap(plan_dir, statuses):
    """keymap.json against Linear: each issue exists, each claim label has a live job, no job start is stuck,
    and no live job runs on an issue that is not started or is settled. Fills `statuses` (key -> status)."""
    def check():
        km = load_keymap(plan_dir)
        if not km["nodes"]:
            return "warn", "keymap: no nodes; run wg load --apply"
        live, rows, now = fetch_nodes(km), run_rows(km)["nodes"], time.time()
        entries = journal_entries(plan_dir)
        lines = []
        for key, entry in sorted(km["nodes"].items()):
            name, row = f"keymap {key} {entry.get('identifier', '-')}", rows.get(key, {})
            issue = live.get(entry["id"])
            if issue is None:
                lines.append(("FAIL", f"{name}: the issue is gone from Linear; recovery.md \"Run state\""))
                continue
            status = statuses[key] = norm(issue["state"], issue_labels(issue))
            job = row.get("state")
            claims = [label["name"] for label in claim_labels(issue)]
            if claims and job not in LIVE:
                lines.append(("FAIL", f"{name}: {claims[0]} with no live job in the run row"))
            if job in STUCK and (age := row_age(plan_dir, key, "state", job, entries, now)) > DOCTOR_STALE_START:
                lines.append(("FAIL", f"{name}: state={job} for {duration_text(age)}; recovery.md \"Resume\""))
            if job in LIVE and status in SETTLED | NOT_STARTED:
                lines.append(("FAIL", f"{name}: state={job} in the run row, but the issue is {status}"))
        return lines or [("ok", f"keymap: {len(km['nodes'])} node(s) agree with Linear")]
    return check


def doctor_worktrees(plan_dir, statuses):
    """Each worktree path in a run row exists. A settled node's worktree is gone by design (wg move cleans it up)."""
    def check():
        rows = run_rows(load_keymap(plan_dir))["nodes"]
        missing = [(k, row["path"]) for k, row in sorted(rows.items())
                   if row.get("path") and statuses.get(k) not in SETTLED and not Path(row["path"]).exists()]
        if missing:
            return [("FAIL", f"worktree {k}: {path} does not exist") for k, path in missing]
        return "ok", "worktrees: each path in the run rows exists"
    return check


def doctor_link(plan_dir, plan):
    """Open the link socket and close it with no `hello`: the server registers no coordinator, so the page does
    not change. It tests the connection only, not the messages."""
    def check():
        if os.environ.get("WG_LINK", "").lower() in ("off", "0", "no"):
            return "warn", "link: WG_LINK is off"
        try:
            import websockets.sync.client  # noqa: F401
        except ImportError:
            return "warn", "link: no websockets in this Python; run wg through uv"
        url = link_target(plan_dir, plan)[0]
        with link_socket(url, workspace=plan_workspace(plan)):
            pass  # the WebSocket handshake passed
        return "ok", f"link: {url.split('?')[0]} accepts a connection (the connection only; no hello sent)"
    return check


def check_collaboration_human(page_name):
    """Check that this token's account and the local wait status use the same human name."""
    if page_name != HUMAN:
        raise ReadError(f"page name {page_name!r} differs from config human {HUMAN!r}")


def doctor_collaboration_human(plan_dir, plan):
    km = load_keymap(plan_dir)
    try:
        current = project_claims(plan, km)
    except (PlanPageUnavailable, ClaimRefused, LinkTokenError) as error:
        return "warn", f"collaboration human: {error}"
    if current is None:
        return []
    names = {held["holder"] for held in current["claims"] if held["mine"]}
    for name in sorted(names):
        check_collaboration_human(name)
    if not names:
        try:
            page, headers = collab_page(km["collab"], plan_workspace(plan))
            status = token_page_request(page, "/api/status", headers["Authorization"].removeprefix("Bearer "))
        except (PlanPageUnavailable, LinkTokenError) as error:
            return "warn", f"collaboration human: {error}"
        name = status.get("human") if isinstance(status, dict) else None
        if not name:
            return "warn", "collaboration human: page status has no account name and this account has no claims"
        check_collaboration_human(name)
    return "ok", f"collaboration human: {HUMAN} matches the page"


def doctor_lines(plan_dir=None, fix=False):
    """Yield the machine and effort check results for `wg doctor [<dir>]`.
    Load the plan first to select the page, then report machine checks before plan checks.
    With fix, write the coordinator settings of each loaded effort."""
    loaded = {}

    def plan_check():
        plan = read_current_plan(plan_dir, strict=True)
        plan_workspace(plan)
        errors = check(plan)
        loaded["plan"] = plan
        return ("FAIL", "plan: " + "; ".join(errors)) if errors else ("ok", "plan: wg check is clean")

    plan_result = list(doctor_run("plan", plan_check)) if plan_dir else []
    workspace = plan_workspace(loaded["plan"]) if "plan" in loaded else None

    plans = set(tick_plans())
    checks = [("python", doctor_python), ("websockets", doctor_websockets), ("checkout", doctor_checkout)]
    effort_team = loaded.get("plan", {}).get("effort", {}).get("team")
    checks += [(f"key {w}", doctor_key(w, team=(effort_team if w == workspace else None) or config["team"]))
               for w, config in WORKSPACES.items()]
    checks += [(name, doctor_tool(name, args)) for name, args in TOOL_CHECKS.items()]
    checks += [("orca", doctor_tool("orca", (orca_cli(), "--version"))), ("page", lambda: doctor_page(workspace))]
    pages = {}
    for w in dict.fromkeys(([workspace] if workspace else []) + list(WORKSPACES)):
        pages.setdefault((workspace_page(w) or PAGE_URL).rstrip("/"), w)
    if CONFIG.get("page_url"):
        pages.setdefault(PAGE_URL.rstrip("/"), None)
    checks += [(f"link token for {url}", lambda w=w: doctor_link_token(w)) for url, w in pages.items()]
    for channel in CONFIG.get("notify") or []:
        if channel["type"] == "page":
            collab = load_keymap(plan_dir).get("collab") if workspace and plan_dir else None
            for w in ([workspace] if workspace else WORKSPACES):
                checks.append((f"page notices for {w}", lambda w=w, c=channel: doctor_push(w, c, collab, planless=plan_dir is None)))
    checks += [("tick", doctor_tick), ("agents_plugin", doctor_watch)]
    if plan_dir:
        checks.append(("agents", lambda: doctor_agents(plan_dir)))
    checks.append(("agent_replies", doctor_agent_replies))
    if plan_dir:
        plans.add(Path(plan_dir).resolve())
    checks += [("autostart", doctor_autostart(sorted(plans))), ("health", doctor_health(sorted(plans)))]
    checks.append(("settings", doctor_context(sorted(plans), fix)))
    for name, step in checks:
        for level, message in doctor_run(name, step):
            if name == "page" and plan_dir and workspace is None:
                destination = "the WG_UI_URL override" if os.environ.get("WG_UI_URL") else "the top-level page"
                message = f"{message} (plan unavailable, checking {destination})"
            yield level, message
    if not plan_dir:
        return
    yield from plan_result
    if plan := loaded.get("plan"):
        statuses = {}
        token = LINEAR_WORKSPACE.set(plan_workspace(plan))
        try:
            for name, step in (("keymap", doctor_keymap(plan_dir, statuses)),
                               ("worktrees", doctor_worktrees(plan_dir, statuses)), ("link", doctor_link(plan_dir, plan))):
                yield from doctor_run(name, step)
            yield from doctor_run("collaboration human", lambda: doctor_collaboration_human(plan_dir, plan))
        finally:
            LINEAR_WORKSPACE.reset(token)


def doctor(plan_dir=None, fix=False):
    """`wg doctor [<dir>] [--fix]`: one ok, warn, or FAIL line for each check of this machine and, with a plan
    directory, of that effort. It changes nothing; with fix, it writes the coordinator settings of each loaded effort.
    Exit 1 on a FAIL."""
    failed = False
    for level, text in doctor_lines(plan_dir, fix):
        print(f"{level} {text}", flush=True)
        failed |= level == "FAIL"
    return int(failed)


def page_contract_note(plan_dir, plan):
    """The `note doctor` line of `wg next` when the page server runs another contract than this wg. One GET of
    `/api/config` at most each PAGE_CONTRACT_TTL: the run row of @effort keeps the answer and its time. No
    answer gives no line: the link and `wg doctor` report a server that is down."""
    effort = run_rows(load_keymap(plan_dir))["effort"]
    workspace = plan_workspace(plan)
    base = page_base(workspace)
    theirs, at = effort.get("page_contract"), effort.get("page_contract_at")
    try:
        fresh = (effort.get("page_contract_url") == base and bool(at)
                 and time.time() - parse_utc(at).timestamp() < PAGE_CONTRACT_TTL)
    except (TypeError, ValueError):
        fresh = False
    if not fresh:
        try:
            theirs = str(page_get("/api/config", timeout=PAGE_CONTRACT_WAIT, workspace=workspace).get("contract") or "none")
        except (ReadError, OSError, ValueError, AttributeError, http.client.HTTPException):
            theirs = ""  # no answer: cached too, so a page that is down costs one GET each PAGE_CONTRACT_TTL
        with contextlib.suppress(TimeoutError, OSError, ValueError):
            with plan_lock(plan_dir, wait=PAGE_CONTRACT_WAIT):
                km = load_keymap(plan_dir)
                run_rows(km)["effort"].update(page_contract=theirs, page_contract_url=base,
                                              page_contract_at=f"{utc_now():%Y-%m-%dT%H:%M:%SZ}")
                save_keymap(plan_dir, km)
    if theirs and theirs != contract_hash():
        return [("note", "doctor @effort -: page contract differs; run wg doctor")]
    return []


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


class Literal(str):
    """A spec value that `render` puts in after its check: a `{name}` in it is text, not a missing value."""


def render(text, values):
    for name, value in values.items():
        if not isinstance(value, Literal):
            text = text.replace("{" + name + "}", str(value))
    missing = sorted(set(re.findall(r"\{[a-z_]+\}", text)) - {"{" + n + "}" for n, v in values.items()
                                                                if isinstance(v, Literal)})
    if missing:
        die("worker-spec.md: no value for " + ", ".join(missing))
    for name, value in values.items():
        if isinstance(value, Literal):
            text = text.replace("{" + name + "}", value)
    return text


def write_spec(plan_dir, name, text):
    path = Path(plan_dir).resolve() / "specs" / f"{name}.md"
    path.parent.mkdir(exist_ok=True)
    path.write_text(text + "\n")
    return path


def lint_step(plan, lower):
    """The lint part of push check step 4, or "" for no lint step.

    `effort.lint` replaces the config `test_runner.lint`; a plan with its own `effort.test` is for another
    repository, so the config lint does not apply to it. Each `{lower}` in an argument is the diff base."""
    effort = plan["effort"]
    if "lint" in effort:
        args = effort["lint"]
    elif "test" in effort or not TEST_RUNNER:
        args = []
    else:
        args = TEST_RUNNER.get("lint") or []
    if not isinstance(args, list) or not all(isinstance(a, str) for a in args):
        die(f"the lint command must be a list of strings (effort.lint, or test_runner.lint in {CONFIG_PATH})")
    if not args:
        return ""
    lint = shlex.join(a.replace("{lower}", lower) for a in args)
    return f"one lint of what your diff affects, `{lint}`; commit, also what the lint fixed; then, "


def spec_values(plan_dir, plan, node, entry, issue, row):
    plan_path = Path(plan_dir).resolve()
    return {"identifier": entry["identifier"], "url": issue.get("url") or "no URL", "key": node["key"],
            "path": row.get("path", "-"), "branch": row["branch"], "parent": row["parent"], "lower": row["lower"],
            "pr": row.get("pr", "-"), "wg": wg_command(), "plan_dir": shlex.quote(str(plan_path)),
            "project": plan["effort"]["name"], "skill": str(Path(__file__).resolve().parent.parent),
            "lint": Literal(lint_step(plan, row["lower"])),
            "dispatch_spec": shlex.quote(str(plan_path / "specs" / f"{node['key']}.md"))}


# The Agent notes block that `wg load` adds to each issue description (node_body). A worker spec drops it,
# and keeps the text before and after it.
NOTES_BLOCK = re.compile(r"\+\+\+ Agent notes\n\nwork-graph node .*?\n\+\+\+[ \t]*(?=\n|$)", re.S)


def issue_design(entry, issue):
    """The issue description, read from Linear for this one issue, without the notes block of `wg load`."""
    text = issue.get("description")
    if text is None:
        text = (gql("query($id:String!){ issue(id:$id){ description } }", {"id": entry["id"]}).get("issue") or {}
                ).get("description")
    text = re.sub(r"\n{3,}", "\n\n", NOTES_BLOCK.sub("", text or "")).strip()
    return text or "The issue has no description."


def spec_context(plan, node, entry, issue):
    """The parts of a dispatch spec after the task contract: the design, the node card, the repository rules."""
    files = [f"- owns `{g}`" for g in node.get("owns", [])]
    files += [f"- shares `{g}` (additive only)" for g in node.get("shares", [])]
    card = [f"**Acceptance**\n\n{node['acceptance']}"] if node.get("acceptance") else []
    card += ["**Files**\n\n" + "\n".join(files)] if files else []
    parts = ["## Design\n\n" + issue_design(entry, issue),
             "## Node card\n\n" + ("\n\n".join(card) or EMPTY_CARD)]
    rules = (plan["effort"].get("rules") or "").strip()
    if rules:
        parts.append("## Repository rules\n\n" + rules)
    return "\n\n".join(parts)


def claim_labels(issue):
    return [label for label in issue_labels(issue) if label["name"].startswith("agent:")]


def take_claim(plan_dir, plan, key, entry, issue, agent):
    """The only writer of a claim label. An issue holds one claim: one worker job that is not over."""
    held = claim_labels(issue)
    if held:
        die(f"{entry['identifier']}: {held[0]['name']} holds the claim; find its job with wg run show", 1)
    name = f"agent:{agent}"
    label_id = workspace_labels({name}).get(name) or team_info(plan_team(plan))[2].get(name)
    issue_update(entry["id"], {"addedLabelIds": [label_id or die(f"label {name} not found (wg preflight)")]})
    journal(plan_dir, journal_command("claim"), key, {"claim": (None, name)}, kind="claim")


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
    if not dry_run and (collab := load_keymap(plan_dir).get("collab")) is not None:
        workspace = plan_workspace(plan)
        try:
            claims = claim_request(collab, workspace, "GET")["claims"]
        except ReadError as error:
            print(f"warn cleanup: could not list claims: {error}", file=sys.stderr)
        else:
            for held in claims:
                if held["mine"]:
                    release_page_claim(collab, workspace, held["node"])
    kept = cleanup_worktrees(plan_dir, plan, dry_run=dry_run)
    if kept:
        print(f"{kept} worktree(s) stay: see the warnings")
    return int(bool(kept))


def branch_plan(plan, key, nodes, deps, st, rows, recorded=None, shared=None):
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
        parent = (shared or {}).get(below, {}).get("branch") or rows.get(below, {}).get("branch")
        if not parent:
            die(f"{key}: {below} below it has no branch in its run row"
                + (" or the shared keymap" if shared is not None else ""), 1)
        lower = parent
    return names | {"branch": f"{BRANCH_PREFIX}{names['child']}", "lower": lower, "parent": parent, "stax": True}


def check_first_claim(plan_dir, plan, key, snap, quiet=False):
    """The checks and the claim of a node's first job.

    The run row records the claim (`step=claim`) before the label and the move, so a call that stops in between
    can finish them (claim_steps): no job starts on an issue that is not claimed and In Progress."""
    km, live, nodes, st, deps, rows = snap
    node, entry, row = nodes[key], km["nodes"][key], rows[key]
    ident = entry["identifier"]
    problems = []
    if node.get("branch") or node.get("pr"):
        problems.append(f"{key}: its branch or PR exists: adopt it (jobs.md \"Adopt an existing branch or PR\")")
    if row.get("state") or row.get("branch"):
        problems.append(f"{key}: the run row has state={row.get('state', '-')} branch={row.get('branch', '-')}")
    if st.get(key) not in ("Todo", "Ready"):
        problems.append(f"{key}: the status is {st.get(key)}, not Todo or Ready")
    blockers = open_blockers(key, nodes, deps, st, rows, km["nodes"] if km.get("collab") is not None else None)
    if blockers:
        problems.append(f"{key}: open blockers: {', '.join(blockers)}")
    if key not in run_rows(km)["effort"].get("wave", "").split(","):
        problems.append(f"{key}: not in the wave (wg run set {plan_dir} @effort wave=...)")
    below = lane_below(key, nodes, deps) if node["kind"] == "task" else None
    if below and stale_push(nodes, rows, st, below, lambda number: pr_view(number, "headRefOid", cwd=plan_dir).get("headRefOid")):
        problems.append(f"{key}: {below} below it has a push that is not code done (wg done)")
    if problems:
        if quiet:  # one line: the one-command form prints at most 3
            print(flat_line("FAIL " + "; ".join(problems)))
            die(f"{ident}: not dispatched", 1)
        refuse(ident, problems, "not dispatched")
    held = claim_labels(live[entry["id"]])
    if held:
        die(f"{ident}: {held[0]['name']} holds the claim; find its job with wg run show", 1)


def first_claim(plan_dir, plan, key, settings, snap, names, quiet=False, warnings=None):
    km, _, _, _, _, rows = snap
    row = rows[key]
    row.update(state="creating", job="dispatch", step="claim",
               branch=names["branch"], parent=names["parent"], lower=names["lower"])
    row.update(settings)
    save_keymap(plan_dir, km)
    claim_steps(plan_dir, plan, key, snap, quiet, warnings)


def claim_steps(plan_dir, plan, key, snap, quiet=False, warnings=None):
    """The label and the move of a recorded first claim, each only when Linear does not show it yet."""
    km, live, nodes, st, deps, rows = snap
    entry = km["nodes"][key]
    issue = live[entry["id"]]
    row = run_row(load_keymap(plan_dir), key)
    agent = row["agent"]
    if row.get("step") == "claim":
        if f"agent:{agent}" not in {label["name"] for label in claim_labels(issue)}:
            take_claim(plan_dir, plan, key, entry, issue, agent)
        update_row(plan_dir, key, step="status")
    print(f"claimed {entry['identifier']} agent:{agent}")
    out, err = io.StringIO(), io.StringIO()
    try:
        with contextlib.ExitStack() as stack:
            if quiet:
                stack.enter_context(contextlib.redirect_stdout(out))
                stack.enter_context(contextlib.redirect_stderr(err))
            if st.get(key) != "In Progress":
                move(plan_dir, plan, key, "In Progress")
            update_row(plan_dir, key, step=None)
            refresh_card(plan_dir, plan, key)
            start_project(plan_dir)
    finally:
        if warnings is not None:
            warnings += [line.strip() for line in err.getvalue().splitlines() if line.strip()]


def dispatch_spec(plan_dir, plan, node, entry, issue, row):
    """Write the worker spec of a node's first job. Returns the spec path and the task title."""
    text = dispatch_text(plan_dir, plan, node, entry, issue, row)
    return write_spec(plan_dir, node["key"], text), f"{entry['identifier']}: {node.get('title') or issue.get('title', node['key'])}"


def dispatch_text(plan_dir, plan, node, entry, issue, row):
    """The dispatch spec: the time line, the task or spike section, the design, the node card, the rules."""
    sections, values = spec_sections(), spec_values(plan_dir, plan, node, entry, issue, row)
    if node["kind"] == "spike":
        text = render(sections["spike"], values)
    else:
        kind = node.get("role") if node.get("role") in ("hotfix", "sync") else "lane"
        text = render(sections["task"], {"submit": sections[f"submit {kind}"]} | values)
    if load_keymap(plan_dir).get("collab") is not None:
        text = text.replace('"Needs <human>"', shlex.quote(WAIT_STATUS))
    # The text of the issue and plan.json is not rendered: a `{name}` in it is not a spec value.
    when = utc_now().strftime("%Y-%m-%dT%H:%M:%SZ")
    first = (f"Written by `wg dispatch` at {when}: a copy of Linear issue `{entry['identifier']}` and of the node "
             f"`{node['key']}` of plan.json. The issue stays the record.")
    return "\n\n".join([first, text, spec_context(plan, node, entry, issue)])


def dispatch_target(plan_dir, plan, key):
    """The snapshot, the node, its keymap entry, and its issue, for a node that can get a first worker."""
    snap = snapshot(plan_dir, plan)
    km, live, nodes = snap[0], snap[1], snap[2]
    node = nodes.get(key) or die(f"unknown key {key}")
    entry = km["nodes"].get(key) or die(f"{key}: not loaded")
    issue = live.get(entry["id"]) or die(f"{key}: issue not found")
    if node["kind"] not in ("task", "spike") or node.get("role") == "integration":
        die(f"{key}: only a task or a spike gets a worker (an integration node: ordering.md)")
    snap[5].setdefault(key, {})
    return snap, node, entry, issue


@journaled("dispatch")
def dispatch(plan_dir, plan, key, agent, worktree, model=None, effort=None):
    """Start a node's first worker. First call: the claim and the Orca commands. With --worktree: the checks and the spec."""
    snap, node, entry, issue = dispatch_target(plan_dir, plan, key)
    km, live, nodes, st, deps, rows = snap
    ident, row = entry["identifier"], rows[key]
    mine = row.get("job") == "dispatch" and row.get("state") in ("creating", "starting")
    here = shlex.quote(str(Path(plan_dir).resolve()))
    # A retry prints the names of the claim, also when the node below merged or was canceled in between.
    names = branch_plan(plan, key, nodes, deps, st, rows, recorded=row if mine else None,
                        shared=km["nodes"] if km.get("collab") is not None else None)
    if mine:
        pending_start(key, row, here)
    if worktree:
        if not mine:
            die(f"{key}: run 'wg dispatch {plan_dir} {key}' first (state={row.get('state', '-')})", 1)
        if row.get("step") in ("claim", "status"):
            die(f"{key}: the claim is not complete: run 'wg dispatch {plan_dir} {key}' again", 1)
        require_page_claim(plan, km, key)
        path = Path(worktree).resolve()
        problems = worktree_problems(node, row, path, names["stax"], plan_dir)
        if problems:
            save_keymap(plan_dir, km)
            refuse(ident, problems, "no worker spec")
        row.update(state="starting", path=str(path))
        save_keymap(plan_dir, km)
        if warning := write_worker_settings(path, row.get("agent", agent)):
            print(f"warning: {warning}")
        path, title = dispatch_spec(plan_dir, plan, node, entry, issue, row)
        spec, task_title = shlex.quote(str(path)), shlex.quote(title)
        print(f"spec {spec}\nRun these in order. Each <...> is an id from Orca's output:\n"
              f"  orca orchestration worker-start --spec-file {spec} --task-title {task_title} "
              f"--worktree id:<child-id> --agent {row.get('agent', agent)}"
              + printed_model_args(row) + " --json\n"
              f"  {wg_command()} started {here} {key} dispatch=<dispatch_id> task=<task_id> "
              f"worktree=<worktree id> run_id=<run_id>")
        return 0
    if not mine:
        check_first_claim(plan_dir, plan, key, snap)
    settings = resolve_agent(plan, "worker", agent, model, effort) if not mine else None
    with dispatch_lease(plan_dir, plan, km, key) as retain:
        if not mine:
            first_claim(plan_dir, plan, key, settings, snap, names)
        elif row.get("step") in ("claim", "status"):
            claim_steps(plan_dir, plan, key, snap)
        lane_base = names["lower"] if names["lower"].startswith("origin/") else f"origin/{phase_of(plan, node)['target']}"
        out = [f"branch {names['branch']} on {names['lower']}"
               + (f", stax parent {names['parent']}" if names["stax"] else ", not tracked by stax"),
               "Run these in order. Each <...> is an id or a path from Orca's output:",
               "  orca worktree list --json    # find "]
        core = f"{plan['effort']['slug']}-core"
        # Orca shows the coordinator with the name of the Linear project (wg load), so find it by its path.
        if names["stack"] == core:
            out[-1] += f"the parent worktree: the coordinator (path {here})"
        else:
            # A lane parent nests under the coordinator, so each effort is one tree in Orca (ordering.md).
            out[-1] += f"the parent worktree {names['stack']} and the coordinator (path {here})"
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
        retain()
        return 0


# ---------------------------------------------------------------- one-command jobs (--run, --send)

# The `step` of a run row while `wg dispatch --run` works, in order. `receipt`: the worker runs, the claim comment
# is not written yet.
RUN_STEPS = ("claim", "status", "parent", "child", "track", "spec", "start", "receipt")


class OrcaLost(Exception):
    """Orca lost the reply of a durable call (worker-start, send). Retry it only with its request id."""

    def __init__(self, request, query):
        super().__init__(f"Orca lost the reply of request {request}")
        self.request, self.query = request, query


class OrcaRefused(ReadError):
    """Orca answered that it did not do a durable call: it is safe to call it again with a new request."""


def orca_caller():
    """True in an Orca terminal. Outside one, Orca refuses the orchestration calls or can guess a wrong caller."""
    return bool(os.environ.get("ORCA_AGENT_SESSION_ID") or os.environ.get("ORCA_TERMINAL_HANDLE"))


def need_orca_caller(flag, cmd):
    if not orca_caller():
        die(f"{flag} needs an Orca terminal (ORCA_AGENT_SESSION_ID or ORCA_TERMINAL_HANDLE is not set): "
            f"run wg {cmd} without {flag} to print the commands", 1)


def orca_mutation(*args, retry=None, warnings=None):
    """A durable Orca call. Its result; OrcaLost when Orca names a request id; OrcaRefused when Orca answered
    that it did not do the call. Any other failure (no JSON, a timeout) leaves the outcome unknown: ReadError
    or subprocess.SubprocessError."""
    argv = [orca_cli(), *args, "--json"] + (["--retry-request", retry] if retry else [])
    try:
        result = command(*argv)
    except OSError as e:
        if retry:  # the replay did not run, but the first request may have: keep its id
            raise ReadError(f"orca did not run: {e}") from e
        raise OrcaRefused(f"orca did not run: {e}") from e
    try:
        answer = json.loads(result.stdout)
    except ValueError:
        answer = None
    if not isinstance(answer, dict):
        raise ReadError(f"orca gave no JSON answer (exit {result.returncode}): {command_error(result)}")
    if result.returncode == 0 and answer.get("ok", True) and isinstance(answer.get("result"), dict):
        if warnings is not None:
            warnings += [line.strip() for line in result.stderr.splitlines() if line.strip()]
        return answer["result"]
    error = answer.get("error") if isinstance(answer.get("error"), dict) else {}
    recovery = (error.get("data") or {}).get("recovery") if isinstance(error.get("data"), dict) else None
    if isinstance(recovery, dict) and recovery.get("orchestrationRequestId"):
        query = recovery.get("queryCommand") or ""
        raise OrcaLost(recovery["orchestrationRequestId"], " ".join(query) if isinstance(query, list) else query)
    if result.returncode and answer.get("ok") is False and error.get("code") and not retry:
        # With --retry-request, an error can be a failed lookup or replay: it does not prove that the first
        # request did nothing, so the request id stays (an unknown outcome below).
        raise OrcaRefused(f"{error['code']}: {error.get('message', '')}".strip())
    raise ReadError(f"orca gave no result (exit {result.returncode}): {command_error(result)}")


def update_row(plan_dir, key, **fields):
    """Write fields of a run row now (None removes a field), so that a later call continues from here."""
    km = load_keymap(plan_dir)
    row = run_rows(km)["nodes"].setdefault(key, {})
    for field, value in fields.items():
        if value is None:
            row.pop(field, None)
        else:
            row[field] = value
    save_keymap(plan_dir, km)
    return row


def tree_repo(tree):
    """The Orca repository of a worktree: the `<repoId>` of its `<repoId>::<path>` id."""
    return tree.get("repoId") or str(tree.get("id", "")).partition("::")[0]


def find_tree(trees, branch=None, path=None):
    for tree in trees.values():
        if path and tree.get("path") and Path(tree["path"]).resolve() == Path(path).resolve():
            return tree
        if branch and short_branch(tree.get("branch")) == branch:
            return tree
    return None


def created_tree(*args):
    tree = orca_result("worktree", "create", *args)["worktree"]
    if not tree.get("id") or not tree.get("path"):
        raise ReadError("orca worktree create gave no worktree id or path")
    return tree


def git_common_dir(path):
    """The shared .git directory of a checkout: one value for each worktree of one repository."""
    return str((Path(path) / git_output("rev-parse", "--git-common-dir", cwd=path)).resolve())


def checked_out(path):
    return git_output("branch", "--show-current", cwd=path)


def branch_problem(key, path, branch):
    """Why the checkout at `path` is not on `branch` (None: it is)."""
    try:
        actual = checked_out(path)
    except (ReadError, OSError) as e:
        return f"{key}: {path}: {e}"
    if actual != branch:
        return f"{key}: {path} is on {actual or 'a detached HEAD'}, not {branch}"
    return None


def repo_problem(key, path, plan_dir):
    """Why `path` is not a checkout of the coordinator's repository (None: it is one)."""
    try:
        if git_common_dir(path) != git_common_dir(plan_dir):
            return f"{key}: {path} is not a checkout of the repository of {plan_dir}"
    except (ReadError, OSError) as e:
        return f"{key}: {path}: {e}"
    return None


def run_durable(plan_dir, key, step, args, retry, warnings):
    """Run worker-start or send for `step`. Its result, or None after it printed why it stopped.

    The request id stays in the run row until Orca gives a result or a refusal. With an unknown outcome and no
    request id, `step` stays, and the next call refuses until the coordinator reconciles it (unknown_start)."""
    update_row(plan_dir, key, step=step)
    try:
        return orca_mutation(*args, retry=retry, warnings=warnings)
    except OrcaLost as e:
        update_row(plan_dir, key, retry_request=e.request)
        warnings.append(f"{key}: {e}; the next call retries it with --retry-request {e.request}"
                        + (f"; check it with: orca {e.query}" if e.query else ""))
    except OrcaRefused as e:
        # Orca did not do the call: the next call writes the spec and tries again.
        update_row(plan_dir, key, step="spec" if step == "start" else None, retry_request=None)
        print_fail(step, e)
    except (ReadError, subprocess.SubprocessError) as e:
        print_fail(step, e)
        warnings.append(f"{key}: the outcome is not known; " + (
            f"the next call retries request {retry}" if retry else "the next call refuses until you look in Orca"))
    return None


def pending_start(key, row, plan_dir):
    """Stop a printed dispatch while a worker-start of an earlier `--run` has no known result: a new start
    could be a second worker."""
    request = row.get("retry_request")
    if request:
        die(f"{key}: worker-start request {request} has no known result. Run wg dispatch {plan_dir} {key} --run "
            f"(it retries with --retry-request {request}), or look with orca orchestration request-show --request "
            f"{request} --json and record a started worker with wg started {plan_dir} {key} dispatch=<id> ...", 1)
    if row.get("step") == "start":
        unknown_start(key, "start", plan_dir)


def unknown_start(key, step, plan_dir):
    """A call of an earlier run stopped during `step` with no known outcome and no request id."""
    die(f"{key}: an earlier {step} stopped with no known outcome from Orca, so a worker may run. Look for it "
        f"(orca orchestration worker-list --json); record it with wg started {plan_dir} {key} dispatch=<id> ..., "
        f"or start again with wg run set {plan_dir} {key} step=" + ("spec" if step == "start" else ""), 1)


def record_started(plan_dir, plan, key, fields):
    """The worker job started: record its Orca ids, then comment the claim. Returns the run row.

    The ids are saved with `step=receipt` before the comment, so a failed comment is written by the next
    `wg dispatch --run` or `wg claim --send`, with no second start (finish_receipt)."""
    get_node(plan, key)
    km = load_keymap(plan_dir)
    km["nodes"].get(key) or die(f"{key}: not loaded")
    run = run_rows(km)
    row = run["nodes"].setdefault(key, {})
    if row.get("state") == "running" and row.get("step") == "receipt" and fields.get("dispatch") == row.get("dispatch"):
        return finish_receipt(plan_dir, plan, key)  # the ids are saved; only the claim comment is missing
    if row.get("state") != "starting":
        die(f"{key}: no job is starting (state={row.get('state', '-')}): use wg dispatch or wg claim first", 1)
    if not fields.get("dispatch"):
        die("wg started needs dispatch=<id>")
    run_id = fields.pop("run_id", None)
    if run_id:
        run["effort"]["run_id"] = run_id
    row.update({field: value for field, value in fields.items() if value})
    row.pop("retry_request", None)
    row.pop("fresh_worker", None)
    row.update(state="running", step="receipt", started_at=utc_now().strftime("%Y-%m-%dT%H:%M:%SZ"))
    save_keymap(plan_dir, km)
    return finish_receipt(plan_dir, plan, key)


def finish_receipt(plan_dir, plan, key):
    km = load_keymap(plan_dir)
    entry, row = km["nodes"][key], run_row(km, key)
    where = row.get("path") or row.get("worktree", "-")
    comment(entry["id"], f"Claimed: dispatch {row['dispatch']}, worktree {where}, job {row.get('job', 'dispatch')}")
    row = update_row(plan_dir, key, step=None)
    refresh_card(plan_dir, plan, key)
    return row


def receipt(result, row):
    """The `wg started` fields of an Orca answer. A send to a finished worker gives a new dispatch and task."""
    fields = {"dispatch": result.get("dispatchId") or row.get("dispatch"), "task": result.get("taskId") or row.get("task")}
    if result.get("workspace"):
        fields["worktree"] = result["workspace"]
    if result.get("runId"):
        fields["run_id"] = result["runId"]
    if not fields["dispatch"]:
        raise ReadError("Orca gave no dispatchId")
    return fields


def start_and_record(plan_dir, plan, key, step, args, row, warnings, old):
    """The durable call of a job, then its receipt. The run row, or None after a FAIL line."""
    result = run_durable(plan_dir, key, step, args, row.get("retry_request"), warnings)
    if result is None:
        return None
    try:
        fields = receipt(result, old)
    except ReadError as e:
        print_fail(step, e)
        warnings.append(f"{key}: the outcome is not known; the next call refuses until you look in Orca")
        return None
    given = dict(fields)
    try:
        return record_started(plan_dir, plan, key, fields)
    except (ReadError, OSError) as e:
        print_fail("receipt", e)
        saved = run_row(load_keymap(plan_dir), key)
        if saved.get("step") == "receipt" and saved.get("dispatch") == given["dispatch"]:
            warnings.append(f"{key}: the worker runs; the next call writes the claim comment")
        else:  # the ids are not saved: give them to the coordinator
            ids = " ".join(f"{field}={shlex.quote(value)}" for field, value in given.items() if value)
            warnings.append(f"{key}: the worker runs, but its ids are not saved; record them with: "
                            f"{wg_command()} started {shlex.quote(str(Path(plan_dir).resolve()))} {key} {ids}")
        return None


def flat_line(text):
    """Diagnostic text on one line: command stderr can hold many."""
    return " ".join(str(text).split())


def print_fail(step, error):
    """The one FAIL line of a one-command job."""
    print(flat_line(f"FAIL {step}: {error}"))


def print_warnings(warnings):
    """The one warning line of a one-command job: the output of `--run` is at most 3 lines."""
    if warnings:
        print(flat_line("warning: " + "; ".join(warnings)), file=sys.stderr)


@journaled("dispatch")
def dispatch_run(plan_dir, plan, key, agent, model, effort=None):
    """`wg dispatch --run`: each step of a first job in one call. The run row records each step before it runs."""
    need_orca_caller("--run", "dispatch")
    warnings = []
    try:
        return first_job(plan_dir, plan, key, agent, model, effort, warnings)
    finally:
        print_warnings(warnings)


def first_job(plan_dir, plan, key, agent, model, effort, warnings):
    snap, node, entry, issue = dispatch_target(plan_dir, plan, key)
    km, live, nodes, st, deps, rows = snap
    row = rows[key]
    here = shlex.quote(str(Path(plan_dir).resolve()))
    receipt_due = row.get("state") == "running" and row.get("step") == "receipt"
    mine = row.get("job") == "dispatch" and (row.get("state") in ("creating", "starting") or receipt_due)
    names = branch_plan(plan, key, nodes, deps, st, rows, recorded=row if mine else None,
                        shared=km["nodes"] if km.get("collab") is not None else None)
    continues = f"wg dispatch {here} {key} --run continues there"
    claim_pending = mine and row.get("step") in ("claim", "status")
    if mine and receipt_due:
        require_page_claim(plan, km, key)
        try:
            row = finish_receipt(plan_dir, plan, key)
        except (ReadError, OSError) as e:
            print_fail("receipt", e)
            warnings.append(continues)
            return 1
        print(f"started {key} dispatch={row['dispatch']} worktree={row.get('path', '-')}")
        return 0
    if not mine:
        check_first_claim(plan_dir, plan, key, snap, quiet=True)
    settings = resolve_agent(plan, "worker", agent, model, effort) if not mine else None
    with dispatch_lease(plan_dir, plan, km, key) as retain:
        try:
            if not mine:
                first_claim(plan_dir, plan, key, settings,
                            snap, names, quiet=True, warnings=warnings)
            elif row.get("step") in ("claim", "status"):
                claim_steps(plan_dir, plan, key, snap, quiet=True, warnings=warnings)
        except (ReadError, OSError, subprocess.SubprocessError) as e:
            print_fail(run_row(load_keymap(plan_dir), key).get('step', 'claim'), e)
            warnings.append(continues)
            return 1
        row = run_row(load_keymap(plan_dir), key)
        step = row.get("step") or "parent"
        if step == "start" and not row.get("retry_request"):
            unknown_start(key, step, here)
        if mine and not claim_pending:
            # A resume: before an Orca call that can start a worker, Linear must show this claim and In Progress.
            held = {label["name"] for label in claim_labels(issue)}
            if f"agent:{row['agent']}" not in held or st.get(key) != "In Progress":
                try:
                    update_row(plan_dir, key, step="claim")
                    claim_steps(plan_dir, plan, key, snap, quiet=True, warnings=warnings)
                except (ReadError, OSError, subprocess.SubprocessError) as e:
                    print_fail(run_row(load_keymap(plan_dir), key).get("step", "claim"), e)
                    warnings.append(continues)
                    return 1
                update_row(plan_dir, key, step=step)
        row = update_row(plan_dir, key, step=step)
        try:
            if RUN_STEPS.index(step) <= RUN_STEPS.index("child") or not (row.get("worktree") and row.get("path")):
                below = lane_below(key, nodes, deps)
                shared_branch = km["nodes"].get(below, {}).get("branch") if km.get("collab") is not None else None
                if shared_branch == names["lower"] and not rows.get(below, {}).get("branch"):
                    fetch_shared_parent(plan_dir, shared_branch)
                row = first_worktree(plan_dir, plan, key, names, row)
            path = Path(row["path"])
            if not row.get("retry_request"):  # a lost start reply: the worktree steps are done
                # Read-only checks of the checkout; only a call that has not passed `track` may change stax.
                problem = repo_problem(key, path, plan_dir) or branch_problem(key, path, row["branch"])
                if problem:
                    raise ReadError(problem)
                if RUN_STEPS.index(row.get("step") or "track") <= RUN_STEPS.index("track"):
                    row = update_row(plan_dir, key, step="track")
                    if names["stax"] and (branch_metadata(path, row["branch"]) or {}).get("parentBranchName") != row["parent"]:
                        tracked = command("st", "branch", "track", "--parent", row["parent"], cwd=path)
                        if tracked.returncode:
                            raise ReadError(f"st branch track: {command_error(tracked)}")
                    row = update_row(plan_dir, key, step="spec")
        except (ReadError, OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError) as e:
            print_fail(run_row(load_keymap(plan_dir), key).get('step', step), e)
            warnings.append(continues)
            return 1
        try:
            if not row.get("retry_request"):
                problems = worktree_problems(node, row, path, names["stax"], plan_dir)
                if problems:
                    print_fail("spec", "; ".join(problems))
                    warnings.append(f"{entry['identifier']}: no worker spec; {continues}")
                    return 1
                row = update_row(plan_dir, key, state="starting")
            if warning := write_worker_settings(path, row.get("agent", agent)):
                warnings.append(warning)
            sent = Path(plan_dir).resolve() / "specs" / f"{key}.md"
            if row.get("retry_request") and sent.is_file():  # the spec of an unresolved request stays as it was sent
                spec = sent
                title = f"{entry['identifier']}: {node.get('title') or issue.get('title', key)}"
            else:
                spec, title = dispatch_spec(plan_dir, plan, node, entry, issue, row)
        except (ReadError, OSError) as e:
            print_fail("spec", e)
            warnings.append(continues)
            return 1
        args = ["orchestration", "worker-start", "--spec-file", str(spec), "--task-title", title,
                "--worktree", f"id:{row['worktree']}", "--agent", row.get("agent", agent), "--environment", "local"]
        args += model_args(row)
        row = start_and_record(plan_dir, plan, key, "start", args, row, warnings, {})
        if row is None:
            return 1
        print(f"started {key} dispatch={row['dispatch']} worktree={row['path']}")
        retain()
        return 0


def fetch_shared_parent(plan_dir, branch):
    ref = f"refs/heads/{branch}"
    git_output("check-ref-format", ref, cwd=plan_dir)
    if not command("git", "show-ref", "--verify", "--quiet", ref, cwd=plan_dir).returncode:
        return
    remote = f"refs/remotes/origin/{branch}"
    git_output("fetch", "--no-tags", "--no-recurse-submodules", "origin", f"{ref}:{remote}", cwd=plan_dir)
    git_output("branch", "--track", "--", branch, remote, cwd=plan_dir)


def first_worktree(plan_dir, plan, key, names, row):
    """The lane parent and the child worktree of a first job: found in Orca, else created.

    Only worktrees of the coordinator's repository count, and each must sit under its parent in the effort's
    tree (ordering.md "Branches and worktrees"); a wrong one stops the call before wg changes it."""
    trees = orca_worktrees()
    core = find_tree(trees, path=plan_dir)
    if not core:
        raise ReadError(f"{plan_dir} is not an Orca worktree")
    repo = tree_repo(core)
    trees = {i: t for i, t in trees.items() if tree_repo(t) == repo}
    child = find_tree(trees, branch=row["branch"])
    parent = core
    if names["stack"] != f"{plan['effort']['slug']}-core":
        row = update_row(plan_dir, key, step="parent")
        parent = find_tree(trees, branch=f"{BRANCH_PREFIX}{names['stack']}")
        if parent and parent.get("parentWorktreeId") != core["id"]:
            raise ReadError(f"the lane parent {parent['path']} is not under the coordinator: orca worktree set "
                            f"--worktree id:{parent['id']} --parent-worktree id:{core['id']} --json")
        if not parent and child:
            raise ReadError(f"the worktree {child['path']} on {row['branch']} has no lane parent {names['stack']}")
        if not parent:
            lane_base = names["lower"] if names["lower"].startswith("origin/") else f"origin/{phase_of(plan, get_node(plan, key))['target']}"
            parent = created_tree("--name", names["stack"], "--branch", f"{BRANCH_PREFIX}{names['stack']}",
                                  "--parent-worktree", f"id:{core['id']}", "--base-branch", lane_base, "--setup", "skip")
    row = update_row(plan_dir, key, step="child")
    if child and child.get("parentWorktreeId") != parent["id"]:
        raise ReadError(f"the worktree {child['path']} on {row['branch']} is not under {parent['path']}")
    if not child:
        child = created_tree("--name", names["child"], "--branch", row["branch"], "--base-branch", row["lower"],
                             "--parent-worktree", f"id:{parent['id']}", "--setup", "run")
    if short_branch(child.get("branch")) != row["branch"]:
        raise ReadError(f"Orca made {child['path']} on {short_branch(child.get('branch')) or 'no branch'}, not "
                        f"{row['branch']} (Orca adds a number to a taken name): free the name, then run again")
    path = str(Path(child["path"]).resolve())
    problem = repo_problem(key, path, plan_dir) or branch_problem(key, path, row["branch"])
    if problem:
        raise ReadError(problem)
    row = update_row(plan_dir, key, worktree=child["id"], path=path)
    orca_result("worktree", "set", "--worktree", f"id:{child['id']}", "--display-name", names["display"])
    return update_row(plan_dir, key, step="track")


def worktree_problems(node, row, path, stax, plan_dir=None):
    """Why a worker must not start in this new worktree yet (an empty list: start it).

    `stax`: the branch plan's decision (branch_plan) that stax tracks this branch."""
    key, problems = node["key"], []
    if plan_dir is not None:
        problem = repo_problem(key, path, plan_dir)
        if problem:
            return [problem]
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


# ---------------------------------------------------------------- worker session settings (config worker_settings)

def same_settings(a, b):
    """`a` and `b` are the same settings value: the same types (true is not 1) and values; NaN is NaN."""
    if type(a) is not type(b):
        return False
    if isinstance(a, dict):
        return a.keys() == b.keys() and all(same_settings(a[k], b[k]) for k in a)
    if isinstance(a, list):
        return len(a) == len(b) and all(same_settings(x, y) for x, y in zip(a, b))
    if isinstance(a, float) and math.isnan(a):
        return math.isnan(b)
    return a == b


def merged_settings(old, new):
    """`new` merged into `old`: objects merge key by key, a list gets the items of `new` that it does not have
    (once each), and any other value of `new` replaces the old one, also a value of another type. No key of
    `old` goes away."""
    if isinstance(old, dict) and isinstance(new, dict):
        return old | {k: merged_settings(old[k], v) if k in old else v for k, v in new.items()}
    if isinstance(new, list):
        out = list(old) if isinstance(old, list) else []
        for v in new:
            if not any(same_settings(v, x) for x in out):
                out.append(v)
        return out
    return new


def settings_target(worktree, name):
    """The settings file `name` of `worktree`, after the checks that make it safe to write: not tracked, not a
    symlink (nor its folder), and ignored by git (wg adds it to info/exclude first). ReadError says why not."""
    path = Path(worktree) / name
    for part in (path.parent, path):
        if part.is_symlink():
            raise ReadError(f"{part} is a symlink; wg does not write through it")
    if not command("git", "ls-files", "--error-unmatch", name, cwd=worktree).returncode:
        raise ReadError(f"{name} is tracked in {worktree}; wg does not change it")
    if command("git", "check-ignore", "-q", name, cwd=worktree).returncode:
        exclude = Path(worktree) / git_output("rev-parse", "--git-path", "info/exclude", cwd=worktree)
        exclude.parent.mkdir(parents=True, exist_ok=True)
        text = exclude.read_text() if exclude.exists() else ""
        if f"/{name}" not in text.splitlines():  # a retry after a refusal adds no second line
            exclude.write_text(text + ("" if not text or text.endswith("\n") else "\n") + f"/{name}\n")
        if command("git", "check-ignore", "-q", name, cwd=worktree).returncode:
            raise ReadError(f"git does not ignore {name} in {worktree} (a .gitignore rule overrides "
                            "info/exclude); wg does not write it")
    return path


def write_settings_file(path, text):
    """Write `text` to `path` through a temporary file in the same folder, so a failure leaves the old file.
    A file that exists keeps its mode; a new file gets the mode of the umask."""
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        mode = stat.S_IMODE(path.stat().st_mode)
    else:
        umask = os.umask(0)
        os.umask(umask)
        mode = 0o666 & ~umask
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, prefix=f".{path.name}.",
                                     delete=False) as f:
        f.write(text)
    os.chmod(f.name, mode)
    os.replace(f.name, path)


def merge_claude_settings(worktree, values):
    """Merge `values` into the Claude Code file .claude/settings.local.json of `worktree`, and keep it out of git.
    Other keys of a file that exists stay. A file that is not a JSON object, or a file wg may not write
    (settings_target), stops with ReadError, unchanged."""
    path = settings_target(worktree, WORKER_SETTINGS_FILES["claude"])
    try:
        old = json.loads(path.read_text()) if path.exists() else {}
    except json.JSONDecodeError as e:
        raise ReadError(f"{path}: not JSON ({e})")
    if not isinstance(old, dict):
        raise ReadError(f"{path}: not a JSON object")
    new = merged_settings(old, values)
    if not same_settings(new, old) or not path.exists():
        write_settings_file(path, json.dumps(new, indent=2, ensure_ascii=False) + "\n")
    return path


def toml_text(data):
    """`data` as TOML: tables, arrays of tables, and inline values. It takes JSON values (no null) and each value
    that tomllib returns (dates and times too); a string can hold any Unicode text."""
    def string(s):
        out = []
        for c in s:
            if c in '"\\':
                out.append("\\" + c)
            elif ord(c) < 0x20 or ord(c) == 0x7F:
                out.append(f"\\u{ord(c):04X}")
            elif 0xD800 <= ord(c) <= 0xDFFF:
                raise ValueError(f"no TOML string for a lone surrogate in {s!r}")
            else:
                out.append(c)
        return '"' + "".join(out) + '"'

    def key(k):
        return k if re.fullmatch(r"[A-Za-z0-9_-]+", k) else string(k)

    def value(v):
        if isinstance(v, bool):
            return "true" if v else "false"
        if isinstance(v, int):
            return str(v)
        if isinstance(v, float):
            return "nan" if math.isnan(v) else ("inf" if v > 0 else "-inf") if math.isinf(v) else repr(v)
        if isinstance(v, str):
            return string(v)
        if isinstance(v, (datetime_date, datetime_time)):  # a datetime is a date too
            return v.isoformat()
        if isinstance(v, list):
            return "[" + ", ".join(value(x) for x in v) + "]"
        if isinstance(v, dict):
            return "{" + ", ".join(f"{key(k)} = {value(x)}" for k, x in v.items()) + "}"
        raise ValueError(f"no TOML value for {v!r}")

    def tables(v):
        return isinstance(v, list) and v and all(isinstance(x, dict) for x in v)

    lines = []

    def table(prefix, body, header):
        inline = [(k, v) for k, v in body.items() if not isinstance(v, dict) and not tables(v)]
        if prefix and (inline or not body or header.startswith("[[")):
            lines.append(header)
        lines.extend(f"{key(k)} = {value(v)}" for k, v in inline)
        for k, v in body.items():
            name = f"{prefix}.{key(k)}" if prefix else key(k)
            if isinstance(v, dict):
                table(name, v, f"[{name}]")
            elif tables(v):
                for item in v:
                    table(name, item, f"[[{name}]]")

    table("", data, "")
    return "\n".join(lines) + "\n"


def merge_codex_config(worktree, values):
    """Merge `values` into the Codex project file .codex/config.toml of `worktree`, and keep it out of git.
    wg writes the file again from its parsed values, so a comment in it does not stay. wg writes only text that
    tomllib reads back as the merged values; else ReadError, and the file stays as it was."""
    path = settings_target(worktree, WORKER_SETTINGS_FILES["codex"])
    try:
        old = tomllib.loads(path.read_text()) if path.exists() else {}
    except tomllib.TOMLDecodeError as e:
        raise ReadError(f"{path}: not TOML ({e})")
    new = merged_settings(old, values)
    if not same_settings(new, old) or not path.exists():
        text = toml_text(new)
        try:
            back = tomllib.loads(text)
        except tomllib.TOMLDecodeError as e:
            raise ReadError(f"{path}: the merged TOML does not parse ({e}); wg does not write it")
        if not same_settings(back, new):
            raise ReadError(f"{path}: the merged TOML does not read back as the values; wg does not write it")
        write_settings_file(path, text)
    return path


def write_worker_settings(worktree, agent):
    """Before a worker starts in `worktree`: merge the config worker_settings of `agent` into its settings file.
    The warning to print, or None. Without settings for the agent, wg changes nothing. A failure does not stop
    the start: the worker then starts with the settings of the machine."""
    values = CONFIG["worker_settings"].get(agent)
    if not values:
        return None
    try:
        (merge_claude_settings if agent == "claude" else merge_codex_config)(worktree, values)
    except (ReadError, OSError, ValueError, subprocess.SubprocessError) as e:
        return f"worker_settings: {e}; the worker starts without them"
    return None


def start_settings(row, agent):
    """write_worker_settings for a worker that starts in the worktree of a run row: its path, else the path that
    Orca gives for its worktree id. The warning to print, or None."""
    if not CONFIG["worker_settings"].get(agent):
        return None
    path = row.get("path")
    if not path and row.get("worktree"):
        try:
            path = (orca_worktrees().get(row["worktree"]) or {}).get("path")
        except (ReadError, OSError, subprocess.SubprocessError, KeyError, TypeError):
            path = None
    if not path or not Path(path).is_dir():
        return (f"worker_settings: no local path for worktree {row.get('worktree') or path or '-'}; "
                "the settings are not written")
    return write_worker_settings(path, agent)


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
    line = f"target {pin} at {sha}; base: {kind}; parent merged: {'yes' if merged else 'no'}"
    if not merged:
        return line
    # After a squash merge, `st restack` replays the parent's commits. The branch's own commits are the ones
    # after the old tip of the parent: where the branch left it.
    try:
        old = (git_output("merge-base", row["branch"], row["parent"], cwd=plan_dir) if row.get("branch")
               else git_output("rev-parse", row["parent"], cwd=plan_dir))
    except ReadError:
        old = run_row(load_keymap(plan_dir), below).get("code_done_head") or ""
        if not old:
            raise ReadError(f"no old tip of the merged parent {row['parent']}: ask {HUMAN}")
        if row.get("branch"):  # a rewritten parent: its last head can be off the branch's history
            old = git_output("merge-base", row["branch"], old, cwd=plan_dir)
    return f"{line}; refresh: git rebase --onto origin/{pin} {old}, then st branch reparent --parent {pin}"


@journaled("claim")
def claim(plan_dir, plan, key, job, agent, send=False, work_file=None, model=None, effort=None, *, takeover=False):
    """Start a follow-up job on a node: the checks, the claim, the job header.

    The job `dispatch` continues a node that has a branch and no PR: an adopted node, or a first job that failed.
    `work_file`: its text goes at the end of the job spec. `send`: also start the job in Orca and record the receipt.
    """
    if send:
        need_orca_caller("--send", "claim")
    work = ""
    if work_file:
        try:
            work = Path(work_file).read_text().strip()
        except OSError as e:
            die(f"--work-file: {e}")
        if not work:
            die(f"--work-file {work_file} is empty")
    if not takeover:
        require_page_claim(plan, load_keymap(plan_dir), key)
    taken_over = start_page_claim(plan_dir, plan, key, job, takeover=takeover)
    km, live, nodes, st, deps, rows = snapshot(plan_dir, plan)
    node = nodes.get(key) or die(f"unknown key {key}")
    entry = km["nodes"].get(key) or die(f"{key}: not loaded")
    ident, issue = entry["identifier"], live.get(entry["id"]) or die(f"{key}: issue not found")
    if node["kind"] != "task":
        die(f"{key}: wg claim is for a task")
    row = rows.setdefault(key, {})
    here = shlex.quote(str(Path(plan_dir).resolve()))
    settings = resolve_agent(plan, "worker", agent, model, effort, row)
    agent = settings["agent"]
    same = send and row.get("job") == job and all(row.get(field) == value for field, value in settings.items())
    if same and row.get("state") == "running" and row.get("step") == "receipt":
        # The job runs; only its claim comment is missing.
        try:
            row = finish_receipt(plan_dir, plan, key)
        except (ReadError, OSError) as e:
            print_fail("receipt", e)
            return 1
        print(f"started {key} dispatch={row['dispatch']} job={job}")
        return 0
    # A second --send after a failed send continues the same claim: no second claim, no second job.
    resume = same and row.get("state") == "starting"
    if resume and row.get("step") == "send" and not row.get("retry_request"):
        unknown_start(key, "send", here)
    problems = [f"{key}: missing run field {field}" for field in ("branch", "parent", "lower") if not row.get(field)]
    if job != "dispatch" and not row.get("pr"):
        problems.append(f"{key}: no pr in the run row")
    if job == "dispatch" and row.get("pr"):
        problems.append(f"{key}: it has a PR; send a follow-up job (review, ci, threads, restack)")
    if row.get("state") in LIVE and not resume:
        problems.append(f"{key}: a job is live: state={row['state']} job={row.get('job', '-')}")
    running = live_jobs(rows, key)
    restacking = [k for k in running if rows[k].get("job") == "restack"]
    if job == "restack" and restacking:
        problems.append(f"one restack job at a time: {restacking[0]} is live")
    # A legacy row can lack an agent. Keep its existing dispatch unless a known launch setting changes.
    changed = (row.get("agent", agent) != agent
               or any(row.get(field) != settings.get(field) for field in ("model", "effort")))
    fresh = not row.get("dispatch") or bool(row.get("fresh_worker") if resume else changed)
    if send and fresh and not row.get("worktree") and not row.get("path"):
        problems.append(f"{key}: no worktree in the run row for a new worker")
    if problems:
        refuse(ident, problems, "not claimed")
    restack = restack_line(plan_dir, plan, node, row, nodes, deps, st) if job == "restack" else ""
    if "parent merged: yes" in restack:
        # The worker's push checks and `wg evidence` count from the new target, not the merged parent.
        # `wg done` sets the parent when the PR's base is the target.
        row["lower"] = f"origin/{bottom_base(node, phase_of(plan, node)['target'])}"
    if not resume:
        if taken_over and (old_claim := claim_labels(issue)):
            issue_update(entry["id"], {"removedLabelIds": [label["id"] for label in old_claim]})
            issue = fetch_nodes({"nodes": {key: entry}})[entry["id"]]
        held = claim_labels(issue)
        if send and held:  # the same refusal as take_claim, before the run row changes
            die(f"{ident}: {held[0]['name']} holds the claim; find its job with wg run show", 1)
        if not send:
            take_claim(plan_dir, plan, key, entry, issue, agent)
        row.update(state="starting", job=job)
        for field in AGENT_FIELDS:
            row.pop(field, None)
        row.update(settings)
        if fresh and row.get("dispatch"):
            row["fresh_worker"] = True
        row.pop("started_at", None)
        if job == "review":  # the fix job replaces the reviewer of this round
            row.pop("review_dispatch", None)
            row.pop("review_patch", None)
        save_keymap(plan_dir, km)
    if send and f"agent:{agent}" not in {label["name"] for label in claim_labels(issue)}:
        # The row holds the job before the label, so a second --send adds a label that failed.
        try:
            take_claim(plan_dir, plan, key, entry, issue, agent)
        except ReadError as e:
            print_fail("claim", e)
            return 1
    sections, values = spec_sections(), spec_values(plan_dir, plan, node, entry, issue, row)
    header = render(sections["job"], {"job": job, "restack": f"Restack: `{restack}`." if restack else ""} | values)
    if fresh:  # a new worker has no contract in its context
        kind = node.get("role") if node.get("role") in ("hotfix", "sync") else "lane"
        header = render(sections["task"], {"submit": sections[f"submit {kind}"]} | values) + "\n\n" + header
    spec_path = Path(plan_dir).resolve() / "specs" / f"{key}-{job}.md"
    if not (resume and row.get("retry_request") and spec_path.is_file()):  # a pending request keeps its spec
        if fresh:  # step 2 names the dispatch spec: an adopted node has none, so write it (design, card, rules)
            write_spec(plan_dir, key, dispatch_text(plan_dir, plan, node, entry, issue, row))
        spec_path = write_spec(plan_dir, f"{key}-{job}", header + (f"\n\n{work}" if work else ""))
    spec = shlex.quote(str(spec_path))
    task_title = f"{ident}: {node.get('title') or issue.get('title', key)}"
    subject = f"{job}: #{row['pr']}" if row.get("pr") else f"{job}: {row['branch']}"
    print(f"claimed {ident} agent:{agent} for job {job}")
    if restack:
        print(restack)
    if fresh and (warning := start_settings(row, agent)):  # a new worker session starts in this worktree
        print(f"warning: {warning}")
    if send:
        refresh_card(plan_dir, plan, key)
        if fresh:
            where = f"id:{row['worktree']}" if row.get("worktree") else f"path:{row['path']}"
            args = ["orchestration", "worker-start", "--spec-file", str(spec_path), "--task-title", task_title,
                    "--worktree", where, "--agent", agent, "--environment", "local"]
            args += model_args(row)
        else:
            args = ["orchestration", "send", "--to", f"dispatch:{row['dispatch']}", "--subject", subject,
                    "--body-file", str(spec_path)]
        warnings = []
        try:
            row = start_and_record(plan_dir, plan, key, "send", args, row, warnings, {} if fresh else row)
        finally:
            print_warnings(warnings)
        if row is None:
            return 1
        print(f"started {key} dispatch={row['dispatch']} job={job}")
        return 0
    print(f"spec {spec}    # " + ("the work of this job is at its end; then:" if work else
                                    "add the work of this job at its end, then:"))
    if fresh:
        print(f"  orca orchestration worker-start --spec-file {spec} --task-title {shlex.quote(task_title)} "
              f"--worktree id:<child-id> --agent {agent}{printed_model_args(row)} --json")
    else:
        print(f"  orca orchestration send --to dispatch:{row['dispatch']} --subject {shlex.quote(subject)} --body \"$(cat {spec})\"")
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


@journaled("started")
def started(plan_dir, plan, key, assignments):
    """The worker job started: record its Orca ids and comment the claim."""
    require_page_claim(plan, load_keymap(plan_dir), key)
    row = record_started(plan_dir, plan, key, parse_fields(assignments))
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


@journaled("done")
def done(plan_dir, plan, key, failed=None, worktree=None, dispatch_id=None):
    """A worker job on this node is over, or its PR head moved: clear the job label, then check code done."""
    require_page_claim(plan, load_keymap(plan_dir), key)
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
        journal(plan_dir, journal_command("done"), key, {"claim": (held[0]["name"], None)}, kind="claim")
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
    elif status == "Ready to Merge" and (result or not review_gate(row, row.get("code_done_head"), issue,
                                                                   review_level(load_keymap(plan_dir)))):
        move(plan_dir, plan, key, "In Review")  # this head has no merge review: it leaves the merge queue
    refresh_card(plan_dir, plan, key)
    return result


@journaled("approve")
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
        with open_page_request(f"http://127.0.0.1:{port}/healthz", timeout=2) as response:
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


def agent_flag_value(value):
    if not safe_agent_value(value):
        raise argparse.ArgumentTypeError("use nonempty text with no leading dash, spaces, or control characters")
    return value


def add_agent_flags(parser):
    parser.add_argument("--agent", choices=("codex", "claude"))
    parser.add_argument("--model", type=agent_flag_value, help="the provider model id")
    parser.add_argument("--effort", type=agent_flag_value, help="the effort level for the model")


def cli_parser():
    parser = argparse.ArgumentParser(description="Validate and manage a work-graph effort.")
    sub = parser.add_subparsers(dest="cmd", required=True)

    def add(group, name):
        p = group.add_parser(name)
        p.add_argument("dir")
        return p

    add(sub, "check")
    add(sub, "share")
    pull = add(sub, "pull")
    pull.add_argument("--force", action="store_true")
    pull.add_argument("--accept-settings", action="store_true")
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
        n.add_argument("--all", action="store_true", help="print each wait and note line in full")
    add(sub, "wake")
    h = add(sub, "health")
    h_mode = h.add_mutually_exclusive_group()
    h_mode.add_argument("--install", action="store_true")
    h_mode.add_argument("--uninstall", action="store_true")
    h_mode.add_argument("--due", action="store_true", help="the precheck of the automation: exit 0 starts a check")
    h_mode.add_argument("--report", metavar="FILE", help="publish the findings of a check")
    auto = add(sub, "autostart")
    auto_mode = auto.add_mutually_exclusive_group()
    auto_mode.add_argument("--install", action="store_true")
    auto_mode.add_argument("--uninstall", action="store_true")
    add_agent_flags(auto)
    a = add(sub, "approve")
    a.add_argument("keys", nargs="+")
    a.add_argument("--quote", required=True)
    d = add(sub, "dispatch")
    d.add_argument("key")
    add_agent_flags(d)
    d_mode = d.add_mutually_exclusive_group()
    d_mode.add_argument("--worktree")
    d_mode.add_argument("--run", action="store_true", help="do each Orca step in this call (an Orca terminal only)")
    c = add(sub, "claim")
    c.add_argument("key")
    c.add_argument("job", choices=JOBS)
    add_agent_flags(c)
    c.add_argument("--send", action="store_true", help="send the job in Orca and record the receipt (an Orca terminal only)")
    c.add_argument("--takeover", action="store_true", help="take a claim whose lease ended")
    c.add_argument("--work-file", help="a file with the work of this job; its text goes at the end of the job spec")
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
    add(r, "rebuild").add_argument("--apply", action="store_true", help="write the rebuilt run rows to keymap.json")
    lg = add(sub, "log")
    lg.add_argument("key", nargs="?")
    lg.add_argument("--since", help="a duration back from now (2h, 3d) or an ISO time")
    lg.add_argument("-n", type=int, default=30, help="the number of entries, newest last (default 30)")
    lg.add_argument("--times", action="store_true", help="per task: dispatch to code done, code done to merged, wait")
    us = add(sub, "usage")
    us.add_argument("--json", action="store_true", help="exact integers and each session")
    us.add_argument("--since", help="only calls after this: a duration back from now (2h, 3d) or an ISO time")
    us.add_argument("--all", action="store_true", help="print each session, not the largest 15")
    add(sub, "evidence").add_argument("key")
    add(sub, "autonomy").add_argument("level", nargs="?", choices=AUTONOMY_LEVELS)
    add(sub, "review-effort").add_argument("level", nargs="?", choices=REVIEW_LEVELS)
    add(sub, "verify").add_argument("key")
    o = sub.add_parser("owns").add_subparsers(dest="mode", required=True)
    add(o, "overlap").add_argument("keys", nargs="+")
    o_diff = add(o, "diff")
    o_diff.add_argument("key")
    o_diff.add_argument("base")
    e = sub.add_parser("explain", help="print what to do for a verb of wg next; with no verb, list the verbs")
    e.add_argument("verb", nargs="?")
    d = sub.add_parser("doctor", help="check this machine and, with a plan directory, that effort; changes nothing")
    d.add_argument("dir", nargs="?")
    d.add_argument("--fix", action="store_true", help="also write the coordinator settings and context limit of each loaded effort")
    setup = sub.add_parser("setup", help="check a Linear team and create missing workflow items with --apply")
    setup.add_argument("--workspace", default=DEFAULT_WORKSPACE_ID)
    setup.add_argument("--team")
    setup.add_argument("--name")
    setup.add_argument("--parent", metavar="KEY",
                       help="parent team key: a new team is created under it; an existing team's parent is checked")
    setup.add_argument("--private", action=argparse.BooleanOptionalAction, default=False)
    setup.add_argument("--apply", action="store_true")
    sub.add_parser("config", help="print the config of this machine (no keys) and the local rules file").add_argument("dir", nargs="?")
    c = sub.add_parser("contract", help="print what the page must agree with; --write updates contract.json")
    c.add_argument("--write", action="store_true")
    tick_parser = sub.add_parser("tick", help="refresh the page for each loaded effort")
    tick_parser.add_argument("--root", action="append", type=Path)
    tick_parser.add_argument("--channel", choices=TICK_CHANNELS)
    mode = tick_parser.add_mutually_exclusive_group()
    mode.add_argument("--install", action="store_true")
    mode.add_argument("--uninstall", action="store_true")
    watch_parser = sub.add_parser("agents", help="send each loaded effort's Orca agents to the page, each 10 seconds")
    watch_parser.add_argument("--root", action="append", type=Path)
    mode = watch_parser.add_mutually_exclusive_group()
    mode.add_argument("--once", action="store_true")
    mode.add_argument("--install", action="store_true")
    mode.add_argument("--uninstall", action="store_true")
    mode.add_argument("--wait", action="store_true", help="when a sender runs, wait for it to stop, then run")
    watch_parser.add_argument("--approve", metavar="FINGERPRINT",
                              help="with --install: the approval that Orca printed for the plugin")
    login = sub.add_parser("login")
    login.add_argument("page_url", nargs="?")
    login.add_argument("--workspace", choices=tuple(WORKSPACES), default=DEFAULT_WORKSPACE_ID)
    login.add_argument("--token-stdin", action="store_true")
    sub.add_parser("logout").add_argument("page_url", nargs="?")
    join = sub.add_parser("join")
    join.add_argument("page_url", nargs="?")
    join.add_argument("--project")
    join.add_argument("--repo", default=".")
    sub.add_parser("leave").add_argument("dir")
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
        return next_command(d, plan, ns.wait, ns.interval, copy=not ns.no_publish, everything=ns.all)
    if ns.cmd == "wake":
        return wake_command(d, plan)
    if ns.cmd == "autostart":
        return autostart_command(d, plan, ns.install, ns.uninstall, ns.agent, ns.model, ns.effort)
    if ns.cmd == "health":
        return health_command(d, plan, ns.install, ns.uninstall, ns.due, ns.report)
    if ns.cmd == "approve":
        return approve(d, plan, ns.keys, ns.quote)
    if ns.cmd == "dispatch":
        if ns.run:
            return dispatch_run(d, plan, ns.key, ns.agent, ns.model, ns.effort)
        return dispatch(d, plan, ns.key, ns.agent, ns.worktree, ns.model, ns.effort)
    if ns.cmd == "claim":
        if ns.send and not ns.work_file:
            die("wg claim --send needs --work-file <file> with the work of the job")
        options = {"takeover": True} if ns.takeover else {}
        return claim(d, plan, ns.key, ns.job, ns.agent, ns.send, ns.work_file, ns.model, ns.effort, **options)
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
        if ns.mode == "rebuild":
            return run_rebuild(d, plan, ns.apply)
        return run_show(d, plan, ns.key, ns.json)
    if ns.cmd == "log":
        return log_command(d, plan, ns.key, ns.since, ns.n, ns.times)
    if ns.cmd == "evidence":
        return evidence(d, plan, ns.key, given)
    if ns.cmd == "autonomy":
        return autonomy_command(d, plan, ns.level)
    if ns.cmd == "review-effort":
        return review_effort_command(d, plan, ns.level)
    if ns.cmd == "verify":
        return verify(d, plan, ns.key)
    if ns.mode == "overlap":
        return owns(plan, ["overlap", *ns.keys])
    return owns(plan, ["diff", ns.key, ns.base])


def command_name(ns):
    """The command as the journal records it, such as `run set` or `load --apply`."""
    words = [ns.cmd] + ([ns.mode] if ns.cmd in ("run", "owns") else [])
    return " ".join(words + ["--apply"] * bool(getattr(ns, "apply", False)))


def main(argv):
    warned = _PLAN_WARNED.set(False)
    try:
        return main_command(argv)
    finally:
        _PLAN_WARNED.reset(warned)


def main_command(argv):
    args = argv[1:]
    if args and args[0] in {"join", "leave"} and any(is_join_link(arg) for arg in args[1:]):
        die("Open the collab link in a browser. Give wg join the page URL.")
    given = []  # the old call form names the test command after "--"; it must be the effort's command
    if args and args[0] == "evidence" and "--" in args:
        split = args.index("--")
        args, given = args[:split], args[split + 1:]
    ns = cli_parser().parse_args(args)
    try:
        if ns.cmd == "login":
            return page_login(ns)
        if ns.cmd == "logout":
            return page_logout(ns.page_url)
        if ns.cmd == "join":
            return join_project(ns)
        if ns.cmd == "leave":
            return leave_project(ns.dir)
        if ns.cmd == "config":
            return show_config(read_current_plan(ns.dir, strict=True) if ns.dir else None)
        if ns.cmd == "explain":
            return explain_command(ns.verb)
        if ns.cmd == "doctor":
            return doctor(ns.dir, ns.fix)
        if ns.cmd == "setup":
            return setup_command(ns)
        if ns.cmd == "contract":
            if ns.write:
                (Path(__file__).resolve().parent.parent / "contract.json").write_text(contract_text())
            else:
                sys.stdout.write(contract_text())
            return 0
        if ns.cmd == "usage":  # reads transcripts only: no plan lock, no Linear, no write to flush
            return usage_command(ns.dir, ns.json, ns.since, ns.all)
        if ns.cmd == "share":
            with plan_lock(ns.dir):
                return share_plan(ns.dir)
        if ns.cmd == "pull":
            pull_plan(ns.dir, force=ns.force, explicit=True, accept_settings=ns.accept_settings)
            return 0
        if ns.cmd == "tick":
            return tick_command(ns)
        if ns.cmd == "agents":
            return watch_command(ns)
        if ns.cmd == "ui":
            return ui(ns.port, ns.project, ns.no_open, ns.no_tailnet, ns.workspace)
        writes = ns.cmd in KEYMAP_WRITERS or (ns.cmd == "run" and ns.mode in ("set", "reset", "rebuild"))
        with plan_lock(ns.dir) if writes else contextlib.nullcontext():
            options = {"quiet": True} if ns.cmd in ("next", "watch") else {}
            plan = (load_plan(ns.dir) if ns.cmd == "check"
                    else read_current_plan(ns.dir, applying=ns.cmd == "load" and ns.apply, **options))
            return run_plan_command(ns, plan, given)
    except (ReadError, OSError, ValueError, subprocess.SubprocessError) as e:
        die(str(e))


def run_plan_command(ns, plan, given):
    token = LINEAR_WORKSPACE.set(plan_workspace(plan))
    named = _JOURNAL_COMMAND.set(command_name(ns))
    try:
        return run_command(ns, ns.dir, plan, given)
    finally:
        flush_writes(ns.dir, plan)
        _JOURNAL_COMMAND.reset(named)
        LINEAR_WORKSPACE.reset(token)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
