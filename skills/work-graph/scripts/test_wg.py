import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import re
import subprocess
import threading
import sys
import tempfile
import time
import unittest
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import Mock, patch

sys.dont_write_bytecode = True
# No test may reach the page server; LinkTests turn the link on against a local server.
import os  # noqa: E402
os.environ["WG_LINK"] = "off"
# The tests use their own config, never the config of this machine: two workspaces, the default human, a page,
# and a test runner that prints the commit it tests.
TEST_CONFIG = Path(tempfile.mkdtemp()) / "config.json"
TEST_CONFIG.write_text(json.dumps({
    "page_url": "https://wg.example.com", "github_user": "octo", "tick_label": "dev.work-graph.tick",
    "tick_roots": ["~/Projects"],
    "test_runner": {"run": ["./node_modules/.bin/tr", "run", "--"], "suite": [":test"],
                    "options": ["--concurrency", "7"], "commit_marker": r"pushing ([0-9a-f]{10}) \("},
    "workspaces": [
        {"id": "work", "name": "Work", "team": "CD", "key_env": ["LINEAR_API_KEY"], "team_labels": True},
        {"id": "home", "name": "Home", "team": "HOM", "teams": ["HOM"], "key_env": [], "team_labels": False},
    ],
}))
os.environ["WG_CONFIG"] = str(TEST_CONFIG)
spec = importlib.util.spec_from_file_location("wg", Path(__file__).with_name("wg.py"))
wg = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wg)
# The other tests mock Linear call by call; AutonomyTests use the real autonomy_lines.
AUTONOMY_LINES = wg.autonomy_lines
wg.autonomy_lines = lambda plan_dir, plan: []
# Likewise the pause label and the answers from the page: CommandTests and AnswerTests use the real ones.
ANSWER_LINES = wg.answer_lines
wg.answer_lines = lambda plan_dir: []
PROJECT_PAUSED = wg.project_paused
wg.project_paused = lambda project_id: False
# The other tests mock pr_view and pr_checks PR by PR: with no batch answer, next_lines reads each PR alone.
# PrBatchTests use the real pr_batch.
PR_BATCH = wg.pr_batch
wg.pr_batch = lambda numbers, cwd=None: {}

SHA = "a" * 40
OTHER = "b" * 40


def node(key, kind="task", phase="1", **fields):
    return {"key": key, "kind": kind, "phase": phase, "title": key,
            **({"lane": "one"} if kind == "task" else {}), **fields}


def edge(a, b):
    return {"from": a, "to": b}


def plan(target="main"):
    return {"effort": {"name": "Example"},
            "phases": [{"key": "1", "name": "Phase 1", "target": target}],
            "nodes": [node("a", owns=["a/*"], shares=["shared"]), node("mp", "merge-point"),
                      node("sp", "ship-point")],
            "edges": [edge("mp", "a"), edge("sp", "mp")]}


def live_issue(name="Todo", labels=(), **fields):
    return {"state": {"name": name, "type": "unstarted"},
            "labels": {"nodes": [{"name": label, "id": label} for label in labels]},
            "team": {"id": "cd"}, "projectMilestone": {"id": "p1"},
            "project": {"id": "project"}, "relations": {"nodes": []},
            **fields}


class CheckTests(unittest.TestCase):
    def rejects(self, p, message):
        self.assertTrue(any(message in e for e in wg.check(p)), wg.check(p))

    def test_target_eng_issue_and_edges(self):
        p = plan()
        p["nodes"][0]["eng"] = "ENG-42"
        self.assertEqual(wg.check(p), [])
        p["phases"][0]["target"] = ""
        p["nodes"][0].update(eng="eng-42", issue="CD-X")
        p["edges"].append(p["edges"][0])
        for message in ("no target", "duplicate", "invalid eng", "invalid issue", "both eng and issue"):
            self.rejects(p, message)
        p = plan()
        p["nodes"][0]["issue"] = "CD-10"
        self.assertEqual(wg.check(p), [])

    def test_a_lane_may_fork(self):
        p = plan()
        p["nodes"] += [node("b"), node("c")]
        p["edges"] += [edge("b", "a"), edge("c", "a"), edge("mp", "b"), edge("mp", "c")]
        self.assertEqual(wg.check(p), [])

    def test_rejects_duplicate_existing_issue_identifiers(self):
        for first, second in (("issue", "issue"), ("eng", "eng"), ("eng", "issue")):
            with self.subTest(first=first, second=second):
                p = plan()
                p["nodes"][0][first] = "CD-50"
                p["nodes"][1][second] = "CD-50"
                self.assertEqual(wg.check(p), ["mp: issue CD-50 is also used by a"])

    def test_second_phase_task_has_no_dependency_on_previous_ship(self):
        p = plan()
        p["phases"].append({"key": "2", "target": "main"})
        p["nodes"] += [node("b", phase="2"), node("mp2", "merge-point", "2"),
                       node("sp2", "ship-point", "2"), node("research", "spike", "2")]
        p["edges"] += [edge("sp2", "mp2"), edge("mp2", "b"), edge("mp2", "sp"),
                       edge("sp2", "research")]
        self.assertEqual(wg.check(p), ["b: does not depend on ship point sp of phase 1"])
        p["edges"].append(edge("b", "sp"))
        self.assertEqual(wg.check(p), [])
        p["edges"].remove(edge("b", "sp"))
        p["edges"].remove(edge("mp2", "sp"))
        for key in ("b", "mp2", "sp2"):
            self.rejects(p, f"{key}: does not depend on ship point sp")

    def test_ops_needs_merge_point_and_ship_point_needs_merge_point(self):
        p = plan()
        p["nodes"].append(node("ops", "ops"))
        p["edges"].append(edge("sp", "ops"))
        self.assertEqual(wg.check(p), ["ops: not after merge point mp"])
        p["edges"].append(edge("ops", "mp"))
        self.assertEqual(wg.check(p), [])
        p["edges"].remove(edge("ops", "mp"))
        p["edges"].remove(edge("sp", "mp"))
        self.rejects(p, "sp: not after merge point mp")

    def test_release_rejects_stacked_hotfixes_and_requires_one_sync(self):
        p = plan("release")
        p["nodes"][0]["role"] = "hotfix"
        p["nodes"] += [node("hotfix", role="hotfix"), node("sync", role="sync")]
        p["edges"] += [edge("hotfix", "a"), edge("mp", "hotfix"),
                       edge("sp", "sync"), edge("sync", "mp")]
        self.assertEqual(wg.check(p), ["hotfix: release pre-merge task depends on another task"])
        p["edges"].remove(edge("hotfix", "a"))
        self.assertEqual(wg.check(p), [])
        p["nodes"][0].pop("role")
        p["nodes"][-1]["role"] = "hotfix"
        self.rejects(p, "needs exactly one sync")
        self.rejects(p, "a: release pre-merge task needs role hotfix")

    def test_role_and_merge_rules_outside_release(self):
        p = plan("effort/topic")
        self.rejects(p, "needs exactly one integration")
        p["nodes"].append(node("merge", role="integration", lane=None))
        p["edges"] += [edge("sp", "merge"), edge("merge", "mp")]
        self.assertEqual(wg.check(p), [])
        p["edges"].remove(edge("merge", "mp"))
        self.rejects(p, "merge: not after merge point mp")
        p["phases"][0]["target"] = "main"
        self.rejects(p, "integration requires an effort/")
        for role in ("hotfix", "sync"):
            p["nodes"][0]["role"] = role
            self.rejects(p, f"role {role} requires target release")


class DirTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.d = Path(temp.name)
        self.p = plan()
        self.write_plan()
        # The PR scope and native-stack checks call GitHub; their own tests are PrGuardTests.
        for name, check in (("pr_scope", "scope"), ("pr_stack", "stack")):
            patcher = patch.object(wg, name, return_value=(True, check, "faked"))
            patcher.start()
            self.addCleanup(patcher.stop)
        # A move to Merged or Done cleans up worktrees through Orca; CleanupTests fakes Orca itself.
        patcher = patch.object(wg, "orca_worktrees", return_value={})
        patcher.start()
        self.addCleanup(patcher.stop)

    def write_plan(self):
        wg.save_json(self.d / "plan.json", self.p)

    def keymap(self, keys=None, rows=None):
        keys = keys if keys is not None else [n["key"] for n in self.p["nodes"]]
        km = {"project": {"id": "project"}, "milestones": {"1": "p1"},
              "nodes": {k: {"id": k, "identifier": f"CD-{i+1}"} for i, k in enumerate(keys)}}
        if rows is not None:
            km["run"] = {"effort": {}, "nodes": rows}
        wg.save_keymap(self.d, km)
        return km

    def call(self, fn, *args, code=0):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            try:
                self.assertEqual(fn(*args), code)
            except SystemExit as e:
                self.assertEqual(e.code, code)
        return stdout.getvalue(), stderr.getvalue()


class LinearTests(DirTests):
    def test_home_key_never_falls_back_to_the_work_key(self):
        self.keymap(["a"])
        self.p["effort"]["workspace"] = "home"
        self.write_plan()
        with tempfile.TemporaryDirectory() as private, patch.object(wg.Path, "home", return_value=Path(private)), \
                patch.dict(wg.os.environ, {"LINEAR_API_KEY": "work-key"}, clear=True), \
                patch.object(wg.urllib.request, "urlopen") as request:
            _, err = self.call(wg.main, ["wg", "status", str(self.d)], code=2)
            self.assertIn("no Linear key for home", err)
            request.assert_not_called()
            folder = Path(private) / ".config/work-graph"
            folder.mkdir(parents=True)
            (folder / "home-linear-api-key").write_text("file-home-key\n")
            request.return_value = contextlib.closing(io.StringIO(json.dumps({"data": {"issues": {"nodes": []}}})))
            self.call(wg.main, ["wg", "status", str(self.d)])
            self.assertEqual(request.call_args.args[0].get_header("Authorization"), "file-home-key")

    def test_bad_workspace_or_team_stops_before_a_request(self):
        self.keymap(["a"])
        with patch.object(wg.urllib.request, "urlopen") as request:
            for workspace, team in (("typo", "CD"), ("home", "CD"), ("work", "HOM")):
                self.p["effort"].update(workspace=workspace, team=team)
                self.write_plan()
                self.call(wg.main, ["wg", "status", str(self.d)], code=2)
            request.assert_not_called()

    def test_cli_uses_each_plans_workspace_key_without_changing_the_shell_key(self):
        self.keymap(["a"])
        seen = []

        def answer(request, **kwargs):
            seen.append(request.get_header("Authorization"))
            return contextlib.closing(io.StringIO(json.dumps({"data": {"issues": {"nodes": []}}})))

        with patch.dict(wg.os.environ, {"LINEAR_API_KEY": "work-key", "LINEAR_HOME_API_KEY": "home-key"}, clear=True), \
                patch.object(wg.urllib.request, "urlopen", side_effect=answer), contextlib.redirect_stdout(io.StringIO()):
            for workspace in ("work", "home", "work"):
                self.p["effort"]["workspace"] = workspace
                self.write_plan()
                self.assertEqual(wg.main(["wg", "status", str(self.d)]), 0)
            self.assertEqual(wg.os.environ["LINEAR_API_KEY"], "work-key")
        self.assertEqual(seen, ["work-key", "home-key", "work-key"])

    def test_norm(self):
        for raw, expected in wg.ALIAS.items():
            self.assertEqual(wg.norm({"name": raw, "type": "unstarted"}), expected)
        for typ, expected in [("completed", "Done"), ("canceled", "Canceled"),
                              ("duplicate", "Canceled"), ("started", "Scoping")]:
            state = {"name": "Scoping", "type": typ}
            self.assertEqual(wg.norm(state), expected)
            self.assertEqual(wg.norm(state, [{"name": "needs-human"}]), "Needs Human")
        review = {"name": "In Review", "type": "started"}
        self.assertEqual(wg.norm(review, [{"name": "ready-to-merge"}]), "Ready to Merge")
        self.assertEqual(wg.norm(review, [{"name": "ready-to-merge"}, {"name": "needs-human"}]), "Needs Human")
        self.assertEqual(wg.norm({"name": "In Dev", "type": "started"}, [{"name": "ready-to-merge"}]), "In Progress")

    def test_eng_status_write_table_and_cd_cleanup(self):
        self.keymap()
        self.p["nodes"][0]["eng"] = "ENG-42"
        expected = {"Todo": "Ready for Eng", "Ready": "Ready for Eng", "In Progress": "In Dev",
                    "In Review": "In Review", "Ready to Merge": "In Review", "Merged": "Ready for Deploy",
                    "Done": "Done", "Canceled": "Canceled"}
        for status, twin in [*expected.items(), ("Ready", "Ready")]:
            if twin == "Ready":
                self.p["nodes"][0].pop("eng")
            with self.subTest(status=status, twin=twin), \
                 patch.object(wg, "fetch_nodes", return_value={"a": live_issue("Scoping", ["needs-human"])}), \
                 patch.object(wg, "gql", return_value={"team": {"states": {"nodes": [{"name": twin, "id": "state"}]}}}), \
                 patch.object(wg, "move_guard", return_value=([], [])), patch.object(wg, "sync_ready"), \
                 patch.object(wg, "marker_label_id", return_value="merge-label"), \
                 patch.object(wg, "issue_update") as update:
                out, _ = self.call(wg.move, self.d, self.p, "a", status)
                marked = status == "Ready to Merge" and twin != "Ready"
                self.assertEqual(out, f"CD-1: Needs Human -> {twin}{' + ready-to-merge' if marked else ''}\n")
                fields = {"stateId": "state", "removedLabelIds": ["needs-human"]}
                update.assert_called_once_with("a", fields | ({"addedLabelIds": ["merge-label"]} if marked else {}))
        self.p["nodes"][0]["eng"] = "ENG-42"
        for status in ("Triage", "Backlog", "Verifying"):
            with patch.object(wg, "gql") as gql:
                _, err = self.call(wg.move, self.d, self.p, "a", status, code=2)
                self.assertIn(f"no ENG status for {status}: ask Human", err)
                gql.assert_not_called()

    def test_a_move_removes_the_answered_label(self):
        self.keymap()
        for status in ("In Progress", "Needs Human"):
            with self.subTest(status=status), \
                 patch.object(wg, "fetch_nodes", return_value={"a": live_issue("Needs Human", ["answered"])}), \
                 patch.object(wg, "gql", return_value={"team": {"states": {"nodes": [{"name": status, "id": "state"}]}}}), \
                 patch.object(wg, "move_guard", return_value=([], [])), patch.object(wg, "sync_ready"), \
                 patch.object(wg, "issue_update") as update:
                self.call(wg.move, self.d, self.p, "a", status)
                fields = update.call_args.args[1]
                self.assertEqual(fields["removedLabelIds"], ["answered"])

    def test_eng_wait_label_is_global(self):
        self.keymap()
        self.p["nodes"][0]["eng"] = "ENG-42"
        for existing in (False, True):
            with self.subTest(existing=existing), \
                 patch.object(wg, "fetch_nodes", return_value={"a": live_issue("In Dev")}), \
                 patch.object(wg, "workspace_labels", return_value={"needs-human": "label"} if existing else {}), \
                 patch.object(wg, "gql", return_value={"issueLabelCreate": {"issueLabel": {"id": "label"}}}) as gql, \
                 patch.object(wg, "issue_update") as update:
                self.call(wg.move, self.d, self.p, "a", "Needs Human")
                update.assert_called_once_with("a", {"addedLabelIds": ["label"]})
                if existing:
                    gql.assert_not_called()
                else:
                    self.assertEqual(gql.call_args.args[1], {"i": {"name": "needs-human"}})

    def test_node_card_text_sha_and_lifecycle(self):
        n = node("a", role="hotfix", acceptance="Pass.", owns=["a/*"], shares=["shared"])
        expected = """**work-graph node card** `a` · kind `task` · phase `1` · lane `one` · role `hotfix`

**Acceptance**

Pass.

**Files**

- owns `a/*`
- shares `shared` (additive only)

```json
{"wg": 1, "key": "a", "kind": "task", "phase": "1", "lane": "one", "role": "hotfix"}
```

Generated from plan.json by `wg load`. Change plan.json, not this comment."""
        self.assertEqual(wg.node_card(n), expected)
        self.assertNotIn("Pass.", wg.node_body(n))
        self.assertIn("Acceptance and files are in the node card comment.", wg.node_body(n))
        self.assertEqual(wg.card_data(n, {"pr": "7", "review": "clean", "dispatch": "d1"}),
                         {"wg": 1, "key": "a", "kind": "task", "phase": "1", "lane": "one", "role": "hotfix",
                          "pr": "7", "review": "clean"})
        self.assertIn('{"wg": 1, "key": "mp", "kind": "merge-point", "phase": "1"}', wg.node_card(node("mp", "merge-point")))
        entry, changes = {"id": "issue"}, []
        with patch.object(wg, "gql") as gql:
            self.assertFalse(wg.sync_card(n, entry, False, changes))
            self.assertEqual(changes, ["card a: create"])
            gql.assert_not_called()
            gql.return_value = {"commentCreate": {"comment": {"id": "card"}}}
            self.assertTrue(wg.sync_card(n, entry, True, []))
            self.assertEqual(entry["card"], {"id": "card", "sha": hashlib.sha256(expected.encode()).hexdigest()})
            self.assertFalse(wg.sync_card(n, entry, True, []))
            self.assertEqual(gql.call_count, 1)
            n["acceptance"] = "Changed."
            gql.return_value = {"commentUpdate": {"comment": {"id": "card"}}}
            self.assertTrue(wg.sync_card(n, entry, True, changes))
            self.assertEqual(changes[-1], "card a: update")
            self.assertEqual(gql.call_args.args[1]["id"], "card")

    def test_project_refusal_and_adopt_mapping(self):
        self.p["nodes"][0]["eng"] = "ENG-42"
        self.p["nodes"][1]["issue"] = "CD-50"
        self.p["nodes"].append(node("ops", "ops"))
        self.p["edges"].extend([edge("sp", "ops"), edge("ops", "mp")])
        (self.d / "keymap.json").touch()
        project = {"id": "project", "url": "https://example.test/project"}
        with patch.object(wg, "team_info", return_value=("cd", {}, {})), \
             patch.object(wg, "find_project", return_value=project), \
             patch.object(wg, "project_entries", side_effect=[
                 [{"id": "p1", "name": "Phase 1"}],
                 [{"id": "s", "identifier": "CD-3", "description": "work-graph node `sp`"}],
             ]), patch.object(wg, "find_issue", side_effect=[
                 {"id": "e", "identifier": "ENG-42"}, {"id": "m", "identifier": "CD-50", "team": {"id": "cd"}},
             ]) as lookup, patch.object(wg, "find_card", side_effect=[
                 {"id": "card", "sha": SHA}, None, None
             ]), patch.object(wg, "gql") as gql:
            _, err = self.call(wg.load, self.d, self.p, False, False, code=2)
            self.assertIn(f"project 'Example' exists: {project['url']}. Run 'wg load {self.d} --adopt'", err)
            out, _ = self.call(wg.load, self.d, self.p, False, False, True)
            self.assertEqual(out.splitlines(), ["adopted a -> ENG-42", "adopted mp -> CD-50",
                                                "adopted sp -> CD-3", "unmapped ops"])
            self.assertEqual([c.args[0] for c in lookup.call_args_list], ["ENG-42", "CD-50"])
            gql.assert_not_called()
        km = wg.load_keymap(self.d)
        self.assertEqual(km["project"], project)
        self.assertEqual(km["milestones"], {"1": "p1"})
        self.assertEqual(set(km["nodes"]), {"a", "mp", "sp"})
        self.assertEqual(km["nodes"]["a"]["card"], {"id": "card", "sha": SHA})

    def test_adopt_uses_only_unique_unmapped_titles_after_reserving_markers(self):
        project = {"id": "project", "url": "https://example.test/project"}
        self.p["nodes"][0]["title"] = "mp"
        issues = [
            {"id": "marked", "identifier": "CD-3", "title": "mp", "description": "work-graph node `mp`"},
            {"id": "matching", "identifier": "CD-4", "title": "mp"},
            {"id": "different-case", "identifier": "CD-5", "title": "MP"},
            {"id": "dup1", "identifier": "CD-6", "title": "sp"},
            {"id": "dup2", "identifier": "CD-7", "title": "sp"},
        ]
        with patch.object(wg, "project_entries", side_effect=[[], issues]), \
             patch.object(wg, "find_card", return_value=None):
            out, _ = self.call(wg.adopt_project, self.d, self.p, wg.load_keymap(self.d), project, "cd")
        self.assertEqual(out.splitlines(), ["adopted a -> CD-4 (by title)", "adopted mp -> CD-3", "unmapped sp"])
        self.assertEqual(set(wg.load_keymap(self.d)["nodes"]), {"a", "mp"})

    def test_adopt_leaves_all_nodes_with_ambiguous_title_unmapped(self):
        project = {"id": "project", "url": "https://example.test/project"}
        self.p["nodes"][0]["title"] = self.p["nodes"][1]["title"] = "Deploy to beta"
        issues = [{"id": "only", "identifier": "CD-5", "title": "Deploy to beta"}]
        with patch.object(wg, "project_entries", side_effect=[[], issues]), \
             patch.object(wg, "find_card") as card:
            out, _ = self.call(wg.adopt_project, self.d, self.p, wg.load_keymap(self.d), project, "cd")
            card.assert_not_called()
        self.assertEqual(out.splitlines(), ["unmapped a", "unmapped mp", "unmapped sp"])
        self.assertEqual(wg.load_keymap(self.d)["nodes"], {})

    def test_project_entries_reads_second_page(self):
        def page(identifier, more, cursor):
            return {"project": {"issues": {"nodes": [{"id": identifier}],
                                           "pageInfo": {"hasNextPage": more, "endCursor": cursor}}}}

        with patch.object(wg, "gql", side_effect=[page("first", True, "next"), page("second", False, None)]) as gql:
            self.assertEqual(list(wg.project_entries("project", "issues", "id")),
                             [{"id": "first"}, {"id": "second"}])
            self.assertEqual([call.args[1] for call in gql.call_args_list],
                             [{"id": "project", "after": None}, {"id": "project", "after": "next"}])

    def test_conflict_guard_stops_all_creates_before_apply(self):
        self.keymap(keys=["mp"])
        conflict = {"id": "unmapped", "identifier": "CD-50", "title": "sp"}
        with patch.object(wg, "team_info", return_value=("cd", {}, {})), \
             patch.object(wg, "project_entries", return_value=[conflict]), \
             patch.object(wg, "fetch_nodes", return_value={}), patch.object(wg, "gql") as gql:
            out, _ = self.call(wg.load, self.d, self.p, False, False)
            expected = 'conflict sp: CD-50 has this title; set "issue": "CD-50" in plan.json'
            self.assertIn(expected, out)
            self.assertIn("create task a", out)
            self.assertNotIn("create ship-point sp", out)
            out, _ = self.call(wg.load, self.d, self.p, True, False, code=2)
            self.assertEqual(out.strip(), expected)
            gql.assert_not_called()
        self.assertEqual(set(wg.load_keymap(self.d)["nodes"]), {"mp"})

    def test_empty_card_updates_once_and_is_recoverable(self):
        n = node("a")
        entry = {"id": "issue", "card": {"id": "card", "sha": OTHER}}
        changes = []
        body = ("**work-graph node card** `a` · kind `task` · phase `1` · lane `one`\n\n"
                '```json\n{"wg": 1, "key": "a", "kind": "task", "phase": "1", "lane": "one"}\n```\n\n'
                "Generated from plan.json by `wg load`. Change plan.json, not this comment.")
        with patch.object(wg, "gql", return_value={"commentUpdate": {"comment": {"id": "card"}}}) as request:
            self.assertTrue(wg.sync_card(n, entry, True, changes))
            self.assertFalse(wg.sync_card(n, entry, True, changes))
            self.assertEqual(changes, ["card a: update"])
            self.assertEqual(request.call_args.args[1], {"id": "card", "i": {"body": body}})
            self.assertEqual(request.call_count, 1)
        page = {"nodes": [{"id": "card", "body": body}], "pageInfo": {"hasNextPage": False}}
        with patch.object(wg, "gql", return_value={"issue": {"comments": page}}):
            self.assertEqual(wg.find_card("issue", "a"), entry["card"])

    def test_team_info_reads_later_label_pages(self):
        first = {"nodes": [{"id": "1", "name": "merge-point"}],
                 "pageInfo": {"hasNextPage": True, "endCursor": "next"}}
        last = {"nodes": [{"id": "2", "name": "ops"}], "pageInfo": {"hasNextPage": False}}
        team = {"id": "cd", "states": {"nodes": [{"id": "todo", "name": "Todo"}]}}
        with patch.object(wg, "gql", side_effect=[{"teams": {"nodes": [team]}}, {"team": {"labels": first}}, {"team": {"labels": last}}]) as request:
            self.assertEqual(wg.team_info("CD"), ("cd", {"Todo": "todo"}, {"merge-point": "1", "ops": "2"}))
            self.assertEqual(request.call_args.args[1], {"id": "cd", "after": "next"})

    def test_legacy_keymap_load_status_and_ready_keep_eng_issue_unmodified(self):
        legacy = self.keymap()
        self.p["nodes"][0]["eng"] = "ENG-42"
        live = {"a": live_issue("Ready for Eng", title="Different", projectMilestone=None),
                "mp": live_issue(title="mp", sortOrder=2000),
                "sp": live_issue(title="sp", sortOrder=3000)}
        labels = {"merge-point": "l", "ship-point": "s", "reviewed": "r"}
        with patch.object(wg, "team_info", return_value=("cd", {}, labels)), \
             patch.object(wg, "fetch_nodes", return_value=live), patch.object(wg, "_relations"), \
             patch.object(wg, "project_entries") as list_issues, patch.object(wg, "sync_card", return_value=False), \
             patch.object(wg, "gql", return_value={"viewer": {"id": "me"}}) as request:
            dry, _ = self.call(wg.load, self.d, self.p, False, False)
            self.assertEqual(dry, "no changes to nodes\n")
            out, _ = self.call(wg.load, self.d, self.p, True, False)
            self.assertIn("sort order: 0 issue(s) updated", out)
            self.assertNotIn("update a:", out)
            self.assertEqual(request.call_count, 1)
            self.assertIn("viewer", request.call_args.args[0])
            list_issues.assert_not_called()
            status, _ = self.call(wg.status, self.d, self.p, None)
            ready, _ = self.call(wg.ready, self.d, self.p, False)
        self.assertEqual(wg.load_keymap(self.d), legacy)
        self.assertIn("a\tCD-1\tTodo", status)
        self.assertIn("a\tCD-1\ttask", ready)

    def test_ready_apply_moves_cd_both_directions_without_writing_eng(self):
        self.p["nodes"].append(node("eng", eng="ENG-42", lane="eng"))
        self.p["edges"].append(edge("mp", "eng"))
        self.keymap()
        live = {"a": live_issue("Todo"), "eng": live_issue("Ready for Eng"),
                "mp": live_issue("Ready"), "sp": live_issue("Todo")}
        with patch.object(wg, "team_info", return_value=("cd", {"Todo": "todo", "Ready": "ready"}, {})), \
             patch.object(wg, "fetch_nodes", return_value=live), patch.object(wg, "gql") as request:
            out, err = self.call(wg.ready, self.d, self.p, True)
        self.assertIn("eng\t", out)
        self.assertIn("Todo -> Ready", err)
        self.assertIn("Ready -> Todo", err)
        self.assertEqual({(c.args[1]["id"], c.args[1]["s"]) for c in request.call_args_list},
                         {("a", "ready"), ("mp", "todo")})

    def test_load_refuses_adopt_with_project_and_refuses_foreign_cd_issue(self):
        self.keymap(keys=["mp", "sp"])
        with patch.object(wg, "team_info", return_value=("cd", {}, {"merge-point": "l", "ship-point": "s", "reviewed": "r"})), \
             patch.object(wg, "fetch_nodes", return_value={}), patch.object(wg, "gql") as request:
            _, err = self.call(wg.load, self.d, self.p, False, False, True, code=2)
            self.assertIn("--adopt requires a keymap.json with no project", err)
            self.p["nodes"][0]["issue"] = "CD-50"
            with patch.object(wg, "find_issue", return_value=live_issue(team={"id": "eng"})):
                _, err = self.call(wg.load, self.d, self.p, False, False, code=2)
            self.assertIn("CD-50: issue is not in team CD", err)
            request.assert_not_called()

    def test_initiative_creates_group_and_label_then_replaces_the_old_one(self):
        calls = []
        labels = []
        on_project = [{"id": "old", "name": "Old", "parent": {"id": "g0"}}, {"id": "other", "name": "AI", "parent": None}]

        def gql(query, variables=None):
            calls.append(query)
            if "projectLabels(" in query:
                return {"projectLabels": {"nodes": labels}}
            if "project(id" in query:
                return {"project": {"labels": {"nodes": on_project}}}
            if "projectLabelCreate" in query:
                made = {"id": f"l{len(labels)}", "name": variables["i"]["name"], "isGroup": variables["i"].get("isGroup", False),
                        "retiredAt": None, "parent": {"id": variables["i"]["parentId"]} if "parentId" in variables["i"] else None}
                labels.append(made)
                return {"projectLabelCreate": {"projectLabel": {"id": made["id"]}}}
            return {"x": {"success": True}}

        with patch.object(wg, "gql", side_effect=gql):
            changes = []
            wg.sync_initiative("cd", None, "Tooling", False, changes)
            self.assertEqual(changes, ["create project label group 'initiative'", "create initiative 'Tooling'", "set initiative 'Tooling'"])
            labels.append({"id": "g0", "name": "Initiative", "isGroup": True, "retiredAt": None, "parent": None})
            labels.append({"id": "old", "name": "Old", "isGroup": False, "retiredAt": None, "parent": {"id": "g0"}})
            changes = []
            wg.sync_initiative("cd", "p", "Tooling", True, changes)
            self.assertEqual(changes, ["create initiative 'Tooling' (existing: Old)", "set initiative 'Tooling' (was 'Old')"])
            self.assertEqual(labels[-1]["parent"], {"id": "g0"})
            self.assertTrue(any("projectRemoveLabel" in q for q in calls))
            self.assertTrue(any("projectAddLabel" in q for q in calls))
            on_project[:] = [{"id": labels[-1]["id"], "name": "Tooling", "parent": {"id": "g0"}}, on_project[1]]
            changes = []
            wg.sync_initiative("cd", "p", "Tooling", True, changes)
            self.assertEqual(changes, [])

    def test_initiative_uses_a_new_label_that_linear_lists_late(self):
        reads = []
        late = {"id": "late", "name": "Tooling", "isGroup": False, "retiredAt": None, "parent": {"id": "g"}}
        group = {"id": "g", "name": "initiative", "isGroup": True, "retiredAt": None, "parent": None}

        def gql(query, variables=None):
            if "projectLabels(" in query:
                reads.append(1)
                return {"projectLabels": {"nodes": [group] + ([late] if len(reads) > 2 else [])}}
            if "projectLabelCreate" in query:
                raise wg.ReadError('Linear error: [{"message": "duplicate label name"}]')
            if "project(id" in query:
                return {"project": {"labels": {"nodes": []}}}
            self.assertEqual(variables["l"], "late")
            return {"projectAddLabel": {"success": True}}

        with patch.object(wg, "gql", side_effect=gql), patch.object(wg.time, "sleep"):
            changes = []
            wg.sync_initiative("cd", "p", "Tooling", True, changes)
        self.assertEqual(changes, ["create initiative 'Tooling'", "set initiative 'Tooling'"])

    def test_home_initiative_uses_workspace_labels(self):
        seen = []

        def gql(query, variables=None):
            seen.append(variables)
            if "projectLabels(" in query:
                return {"projectLabels": {"nodes": []}}
            if "projectLabelCreate" in query:
                return {"projectLabelCreate": {"projectLabel": {"id": variables["i"]["name"]}}}
            if "project(id" in query:
                return {"project": {"labels": {"nodes": []}}}
            return {"projectAddLabel": {"success": True}}

        with patch.object(wg, "gql", side_effect=gql):
            wg.sync_initiative("hom", "p", "Tools", True, [], team_scoped=False)
        self.assertEqual(seen[0], {"f": {"team": {"null": True}}})
        self.assertTrue(all("teamId" not in (v or {}).get("i", {}) for v in seen))

    def test_check_rejects_an_empty_initiative(self):
        self.p["effort"]["initiative"] = " "
        self.assertIn("effort.initiative: a name of 1 to 80 characters", wg.check(self.p))
        self.p["effort"]["initiative"] = "Tooling"
        self.assertEqual(wg.check(self.p), [])

    def test_dry_load_does_not_lookup_unmapped_eng(self):
        self.p["nodes"][0]["eng"] = "ENG-42"
        self.keymap(keys=["mp", "sp"])
        with patch.object(wg, "team_info", return_value=("cd", {}, {"merge-point": "l", "ship-point": "s", "reviewed": "r"})), \
             patch.object(wg, "fetch_nodes", return_value={}), patch.object(wg, "find_issue") as lookup, \
             patch.object(wg, "project_entries") as list_issues:
            out, _ = self.call(wg.load, self.d, self.p, False, False)
            self.assertIn("map a -> existing ENG-42", out)
            lookup.assert_not_called()
            list_issues.assert_not_called()

    def test_move_rejects_unknown_status_and_unloaded_node(self):
        with patch.object(wg, "gql") as request:
            _, err = self.call(wg.move, self.d, self.p, "a", "Unknown", code=2)
            self.assertIn("unknown status Unknown", err)
            _, err = self.call(wg.move, self.d, self.p, "a", "Todo", code=2)
            self.assertIn("a: not loaded", err)
            request.assert_not_called()

    def test_existing_cd_issue_updates_only_project_title_and_milestone(self):
        self.keymap(keys=["mp", "sp"])
        self.p["nodes"][0]["issue"] = "CD-50"
        looked_up = live_issue(id="existing", identifier="CD-50", title="Old", project=None, projectMilestone=None)
        with patch.object(wg, "team_info", return_value=("cd", {}, {"merge-point": "l", "ship-point": "s", "reviewed": "r"})), \
             patch.object(wg, "find_issue", return_value=looked_up), \
             patch.object(wg, "fetch_nodes", return_value={}), patch.object(wg, "gql", return_value={"viewer": {"id": "me"}}) as gql, \
             patch.object(wg, "issue_update") as update, patch.object(wg, "sync_card", return_value=False), \
             patch.object(wg, "_relations"), patch.object(wg, "_sort"):
            dry, _ = self.call(wg.load, self.d, self.p, False, False)
            update.assert_not_called()
            gql.assert_not_called()
            out, _ = self.call(wg.load, self.d, self.p, True, False)
            for printed in (dry, out):
                for message in ("map a -> existing CD-50", "update a: project", "update a: title", "update a: milestone"):
                    self.assertIn(message, printed)
            update.assert_called_once_with("existing", {"projectId": "project", "title": "a", "projectMilestoneId": "p1"})
            self.assertEqual(wg.load_keymap(self.d)["nodes"]["a"]["identifier"], "CD-50")
            self.assertEqual(gql.call_count, 1)

    def test_orphans_reported_and_pruned_after_relations(self):
        self.keymap(keys=["a", "mp", "sp", "old"], rows={"old": {"pr": "7"}, "run_only": {"pr": "8"}})
        live = {k: live_issue(title=k) for k in ("a", "mp", "sp", "old")}
        live["a"]["relations"]["nodes"] = [
            {"id": "r1", "type": "blocks", "relatedIssue": {"id": "mp"}},
            {"id": "r2", "type": "blocks", "relatedIssue": {"id": "old"}},
        ]
        live["mp"]["relations"]["nodes"] = [{"id": "r3", "type": "blocks", "relatedIssue": {"id": "sp"}}]

        def gql(query, variables=None):
            if "viewer" in query:
                return {"viewer": {"id": "me"}}
            self.assertIn("issueRelationDelete", query)
            self.assertEqual(variables, {"id": "r2"})
            self.assertIn("old", wg.load_keymap(self.d)["nodes"])
            return {"issueRelationDelete": {"success": True}}

        with patch.object(wg, "team_info", return_value=("cd", {}, {"merge-point": "l", "ship-point": "s", "reviewed": "r"})), \
             patch.object(wg, "fetch_nodes", return_value=live), patch.object(wg, "gql", side_effect=gql) as request, \
             patch.object(wg, "_sort"), patch.object(wg, "sync_card", return_value=False):
            out, _ = self.call(wg.load, self.d, self.p, False, True)
            self.assertIn("orphan old -> CD-4", out)
            self.assertIn("orphan run_only -> -", out)
            self.assertNotIn("no changes to nodes", out)
            request.assert_not_called()
            out, _ = self.call(wg.load, self.d, self.p, True, False)
            self.assertIn("orphan old -> CD-4", out)
            self.assertIn("old", wg.load_keymap(self.d)["run"]["nodes"])
            self.assertIn("old", wg.load_keymap(self.d)["nodes"])
            self.call(wg.load, self.d, self.p, True, True)
        km = wg.load_keymap(self.d)
        self.assertNotIn("old", km["nodes"])
        self.assertEqual(km["run"]["nodes"], {})

    def test_ready_gates_lane_and_reports_unmapped_status(self):
        self.p["nodes"] += [node("b"), node("c", eng="ENG-43", lane="other")]
        self.p["edges"] += [edge("b", "a"), edge("mp", "b"), edge("mp", "c")]
        # b stacks on a as soon as a is code done (In Review); a's review does not hold it.
        live = {"a": live_issue("In Review"), "b": live_issue(), "c": live_issue("Scoping")}
        with patch.object(wg, "fetch_nodes", return_value=live):
            self.keymap(rows={"a": {}})  # In Review with no wg done: not code done
            out, _ = self.call(wg.ready, self.d, self.p, False)
            self.assertFalse(out.startswith("b\t"))
        for below, review, ready in [("In Progress", None, False), ("In Review", None, True),
                                     ("In Review", "pending", True), ("Ready to Merge", "clean", True)]:
            live = {"a": live_issue(below), "b": live_issue(), "c": live_issue("Scoping")}
            with self.subTest(below=below, review=review), patch.object(wg, "fetch_nodes", return_value=live):
                self.keymap(rows={"a": {"review": review, "code_done_head": SHA}})
                out, err = self.call(wg.ready, self.d, self.p, False)
                self.assertEqual(out.startswith("b\t"), ready)
                self.assertEqual(err, "skipped c: status Scoping\n")

    def test_status_appends_five_run_columns(self):
        self.keymap(rows={"a": {"state": "review", "pr": "27", "code_done_head": SHA,
                                "review": "clean", "dispatch": "x"}})
        with patch.object(wg, "fetch_nodes", return_value={"a": live_issue("In Review")}):
            out, _ = self.call(wg.status, self.d, self.p, None)
        columns = out.splitlines()[0].split("\t")
        self.assertEqual(len(columns), 12)
        self.assertEqual(columns[-5:], ["review", "27", SHA[:10], "clean", "x"])


class GuardTests(DirTests):
    def setUp(self):
        super().setUp()
        self.p["phases"][0]["soak"] = "24h"
        self.p["nodes"] += [node("b"), node("ops", "ops"), node("dec", "decision")]
        self.p["edges"] += [edge("b", "a"), edge("mp", "b"), edge("ops", "mp"), edge("dec", "ops"), edge("sp", "dec")]
        self.assertEqual(wg.check(self.p), [])
        self.write_plan()

    def move(self, key, status, *, live=None, rows=None, prs=None, eng_labels=(), code=0, note=None, force=None,
             checks=(True, "no checks")):
        self.keymap(rows=rows or {})
        issues = {n["key"]: live_issue((live or {}).get(n["key"], "Todo")) for n in self.p["nodes"]}
        issues[key]["labels"]["nodes"] += [{"name": name, "id": name} for name in eng_labels]
        names = {status, "In Review", wg.ENG_WRITES.get(status, status)}
        states = {"team": {"states": {"nodes": [{"name": name, "id": name} for name in names]}}}
        with patch.object(wg, "fetch_nodes", return_value=issues), \
             patch.object(wg, "pr_view", side_effect=lambda pr, fields, cwd=None: (prs or {})[pr]), \
             patch.object(wg, "pr_checks", return_value=checks), \
             patch.object(wg, "gql", return_value=states), patch.object(wg, "sync_ready") as sync, \
             patch.object(wg, "issue_update") as update, patch.object(wg, "comment") as comment:
            out, _ = self.call(wg.move, self.d, self.p, key, status, note, force, code=code)
        self.assertEqual(update.called, code == 0)
        self.assertEqual(sync.called, code == 0 and (status in wg.SETTLED or status == "In Review"))
        self.fields = update.call_args.args[1] if update.called else None
        return out, comment

    def test_task_is_merged_only_when_its_pr_is_merged(self):
        out, _ = self.move("a", "Merged", code=1)
        self.assertIn("FAIL a: no pr in the run row", out)
        out, _ = self.move("a", "Merged", rows={"a": {"pr": "7"}}, prs={"7": {"state": "OPEN"}}, code=1)
        self.assertIn("FAIL a: PR #7 is OPEN, not MERGED", out)
        merged = {"state": "MERGED", "baseRefName": "main", "mergeCommit": {"oid": SHA}}
        for status in ("Merged", "Done"):
            out, comment = self.move("a", status, rows={"a": {"pr": "7"}}, prs={"7": merged})
            self.assertEqual(out, f"CD-1: Todo -> {status}\n")
            self.assertEqual(comment.call_args.args, ("a", f"PR #7 merged to `main` as `{SHA}`."))

    def test_the_reviewed_label_is_humans_merge_review(self):
        row = {"pr": "8", "code_done_head": SHA, "merge_review": "requested"}
        pr = {"state": "OPEN", "isDraft": False, "headRefOid": SHA, "baseRefName": "main", "mergeable": "MERGEABLE"}
        out, _ = self.move("b", "Ready to Merge", live={"a": "Merged", "b": "In Review"}, eng_labels=["reviewed"],
                           rows={"b": row}, prs={"8": pr})
        self.assertEqual(out, "CD-4: In Review -> Ready to Merge\n")

    def test_ready_to_merge_needs_ready_pr_code_done_head_merge_review_and_merged_lane_below(self):
        row = {"pr": "8", "code_done_head": SHA, "merge_review": "clean"}
        pr = {"state": "OPEN", "isDraft": False, "headRefOid": SHA, "baseRefName": "main", "mergeable": "MERGEABLE"}
        out, comment = self.move("b", "Ready to Merge", live={"a": "Merged"}, rows={"b": row}, prs={"8": pr})
        self.assertEqual(out, "CD-4: Todo -> Ready to Merge\n")
        comment.assert_not_called()
        cases = [
            ({}, {"isDraft": True}, "Merged", "b: PR #8 is a draft"),
            ({}, {"state": "CLOSED"}, "Merged", "b: PR #8 is CLOSED"),
            ({}, {"headRefOid": OTHER}, "Merged", "b: the PR head is not code done (wg done)"),
            ({"merge_review": "requested"}, {}, "Merged", 'b: no merge review of this patch: review-and-merge.md '
             '"Merge point" step 2, then wg run set … merge_review=clean'),
            ({}, {}, "In Review", "b: a is below it in the lane and is not merged"),
            ({}, {"baseRefName": "wg/ex-one-00-a"}, "Merged", "b: the base of PR #8 is wg/ex-one-00-a, not main"),
            ({}, {"mergeable": "CONFLICTING"}, "Merged", "b: PR #8 conflicts with main"),
        ]
        out, _ = self.move("b", "Ready to Merge", live={"a": "Merged"}, rows={"b": row, "a": {"pr": "7"}},
                           prs={"8": pr, "7": {"state": "OPEN"}}, code=1)
        self.assertEqual(out, "FAIL b: a is below it and its PR #7 is not merged\n")
        for row_delta, pr_delta, below, message in cases:
            with self.subTest(message=message):
                out, _ = self.move("b", "Ready to Merge", live={"a": below}, rows={"b": row | row_delta},
                                   prs={"8": pr | pr_delta}, code=1)
                self.assertEqual(out, f"FAIL {message}\n")
        out, _ = self.move("b", "Ready to Merge", live={"a": "Merged"}, rows={"b": row}, prs={"8": pr},
                           checks=(False, "lint"), code=1)
        self.assertEqual(out, "FAIL b: a check of PR #8 failed: lint\n")

    def test_a_row_of_the_old_flow_passes_with_its_verified_head(self):
        row = {"pr": "8", "code_done_head": SHA, "verified_head": SHA}
        pr = {"state": "OPEN", "isDraft": False, "headRefOid": SHA, "baseRefName": "main"}
        self.move("b", "Ready to Merge", live={"a": "Merged"}, rows={"b": row}, prs={"8": pr})
        out, _ = self.move("b", "Ready to Merge", live={"a": "Merged"}, rows={"b": row | {"verified_head": OTHER}},
                           prs={"8": pr}, code=1)
        self.assertIn("FAIL b: no merge review of this patch", out)

    def test_done_ops_and_decision_need_a_note(self):
        for key, label in (("ops", "Evidence"), ("dec", "Answer")):
            with self.subTest(key=key):
                out, _ = self.move(key, "Done", code=1)
                self.assertIn(f"FAIL {key}: a Done {self.p['nodes'][-2 if key == 'ops' else -1]['kind']} needs --note", out)
                self.move(key, "Done", note=" ", code=1)
                _, comment = self.move(key, "Done", note="be to beta at 10:00; check: smoke; result: pass")
                self.assertEqual(comment.call_args.args[1], f"{label}: be to beta at 10:00; check: smoke; result: pass")
        out, comment = self.move("ops", "Needs Human")
        comment.assert_not_called()

    def test_merge_point_done_needs_each_merge_commit_in_the_target(self):
        rows = {"a": {"pr": "7"}, "b": {"pr": "8"}}
        prs = {n: {"state": "MERGED", "mergeCommit": {"oid": SHA}} for n in ("7", "8")}
        out, _ = self.move("mp", "Done", live={"a": "Merged", "b": "In Review"}, rows=rows, prs=prs, code=1)
        self.assertEqual(out, "FAIL mp: blocker b is In Review\n")
        for ancestor in (True, False):
            def git(*args, cwd=None):
                self.assertEqual((args[0], cwd), ("git", self.d))
                code = 0 if ancestor or args[1] != "merge-base" else 1
                return subprocess.CompletedProcess(args, code, "tip\n", "")

            with self.subTest(ancestor=ancestor), patch.object(wg, "command", side_effect=git) as command:
                out, comment = self.move("mp", "Done", live={"a": "Merged", "b": "Done"}, rows=rows, prs=prs,
                                         code=0 if ancestor else 1)
                self.assertIn(("git", "merge-base", "--is-ancestor", SHA, "tip"), [c.args for c in command.call_args_list])
            if ancestor:
                self.assertEqual(comment.call_args.args[1], "All pre-merge PRs are merged to `main`.")
            else:
                self.assertIn(f"FAIL a: merge commit {SHA[:10]} of PR #7 is not in origin/main", out)
        with patch.object(wg, "command", return_value=subprocess.CompletedProcess([], 0, "tip", "")):
            out, _ = self.move("mp", "Done", live={"a": "Merged", "b": "Merged"}, rows={"a": {"pr": "7"}}, prs=prs, code=1)
        self.assertEqual(out, "FAIL b: no pr in the run row\n")

    def test_merge_point_needs_each_pre_merge_task_also_without_a_direct_edge(self):
        self.p["edges"].remove(edge("mp", "a"))
        self.assertEqual(wg.check(self.p), [])
        out, _ = self.move("mp", "Done", live={"a": "In Review", "b": "Merged"}, rows={"b": {"pr": "8"}},
                           prs={"8": {"state": "MERGED", "mergeCommit": {"oid": SHA}}}, code=1)
        self.assertEqual(out, "FAIL mp: blocker a is In Review\n")

    def test_ship_point_waits_for_its_blockers_and_the_soak(self):
        done = {"mp": "Done", "dec": "Done", "a": "Done", "b": "Done"}
        out, _ = self.move("sp", "Verifying", live=done | {"dec": "Needs Human", "b": "In Review"}, code=1)
        self.assertEqual(out, "FAIL sp: blocker dec is Needs Human\nFAIL sp: blocker b is In Review\n")
        self.move("sp", "Verifying", live=done)
        out, _ = self.move("sp", "Done", live=done, code=1)
        self.assertEqual(out, "FAIL sp: the phase has a 24h soak and the run row has no soak_until\n")
        out, _ = self.move("sp", "Done", live=done, rows={"sp": {"soak_until": "2999-01-01T00:00:00Z"}}, code=1)
        self.assertEqual(out, "FAIL sp: the soak ends at 2999-01-01T00:00:00Z\n")
        self.move("sp", "Done", live=done, rows={"sp": {"soak_until": "2020-01-01T00:00:00Z"}})

    def test_done_ship_point_takes_its_merged_tasks_to_done(self):
        live = {"mp": "Done", "dec": "Done", "a": "Merged", "b": "Merged"}
        merged = {"state": "MERGED", "baseRefName": "main", "mergeCommit": {"oid": SHA}}
        states = {"team": {"states": {"nodes": [{"name": "Done", "id": "Done"}]}}}

        def ship(rows, prs, code=0, full=None, holds=True, sp=None):
            self.keymap(rows={"sp": {"soak_until": "2020-01-01T00:00:00Z"} | (sp or {})} | rows)
            issues = {n["key"]: live_issue(live.get(n["key"], "Todo")) for n in self.p["nodes"]}
            path = wg.evidence_path(self.d, "@full-1")
            path.unlink(missing_ok=True)
            if full is not None:
                path.parent.mkdir(exist_ok=True)
                wg.save_json(path, {"sha": OTHER, "valid": True, "exit": 0, "command": wg.DEFAULT_TEST,
                                    "log": "full.log"} | full)
            ancestor = subprocess.CompletedProcess([], 0 if holds else 1, "", "")
            with patch.object(wg, "fetch_nodes", return_value=issues), patch.object(wg, "command", return_value=ancestor), \
                 patch.object(wg, "pr_view", side_effect=lambda pr, fields, cwd=None: prs[pr]), \
                 patch.object(wg, "gql", return_value=states), patch.object(wg, "sync_ready"), \
                 patch.object(wg, "issue_update") as update, patch.object(wg, "comment"):
                out, _ = self.call(wg.move, self.d, self.p, "sp", "Done", code=code)
            return out, [call.args[0] for call in update.call_args_list]

        out, moved = ship({"a": {"pr": "7"}}, {"7": merged}, code=1)
        self.assertEqual((out, moved), ("FAIL b: no pr in the run row\n", []))
        out, moved = ship({"a": {"pr": "7"}, "b": {"pr": "8"}}, {"7": merged, "8": {"state": "OPEN"}}, code=1)
        self.assertEqual((out, moved), ("FAIL b: PR #8 is OPEN, not MERGED\n", []))
        both = ({"a": {"pr": "7"}, "b": {"pr": "8"}}, {"7": merged, "8": merged})
        for arguments, message in (
                (dict(), "no repo-wide test run of phase 1; in a clean worktree at origin/main: "),
                (dict(full={"valid": False}), "the repo-wide test run of phase 1 is invalid; "),
                (dict(full={"command": [*wg.TEST_RUN, "a:test"]}), "the repo-wide test run of phase 1 is invalid; "),
                (dict(full={}, holds=False),
                 f"the repo-wide test run on {OTHER[:10]} does not hold merge commit {SHA[:10]}; "),
                (dict(full={"exit": 1}), f"the repo-wide test run on {OTHER[:10]} failed (exit 1): read full.log; "),
                (dict(full={"exit": 1}, sp={"tests_accepted": SHA + ":other head"}), "failed (exit 1)"),
        ):
            with self.subTest(message=message):
                out, moved = ship(*both, code=1, **arguments)
                self.assertIn(f"FAIL sp: {message}", out) if message[0] != "f" else self.assertIn(message, out)
                self.assertEqual(moved, [])
        ship(*both, full={"exit": 1}, sp={"tests_accepted": OTHER + ":known failure of frontend:test"})
        out, moved = ship(*both, full={})
        self.assertEqual(moved, ["sp", "a", "b"])
        self.assertIn("CD-1: Merged -> Done\n", out)
        live["b"] = "Done"  # a Done status that GitHub does not confirm
        out, moved = ship({"a": {"pr": "7"}, "b": {"pr": "8"}}, {"7": merged, "8": {"state": "OPEN"}}, code=1, full={})
        self.assertEqual((out, moved), ("FAIL b: PR #8 is OPEN, not MERGED\n", []))

    def test_force_skips_the_check_and_comments_the_reason(self):
        self.move("a", "Merged", force="", code=2)
        out, comment = self.move("a", "Merged", force="merged as a part of PR #9")
        self.assertEqual(out, "CD-1: Todo -> Merged\n")
        self.assertEqual(comment.call_args.args[1],
                         "Moved to Merged with `--force`, without the `wg` check: merged as a part of PR #9")

    def test_eng_ready_to_merge_is_in_review_with_the_marker_label(self):
        self.p["nodes"][0]["eng"] = "ENG-42"
        row = {"pr": "7", "code_done_head": SHA, "merge_review": "accepted"}
        pr = {"state": "OPEN", "isDraft": False, "headRefOid": SHA, "baseRefName": "main"}
        with patch.object(wg, "marker_label_id", return_value="label") as label:
            out, _ = self.move("a", "Ready to Merge", live={"a": "In Review"}, rows={"a": row}, prs={"7": pr})
            label.assert_called_once_with("ready-to-merge")
        self.assertEqual(out, "CD-1: In Review -> In Review + ready-to-merge\n")
        self.assertEqual(self.fields, {"addedLabelIds": ["label"]})
        merged = {"state": "MERGED", "baseRefName": "main", "mergeCommit": {"oid": SHA}}
        out, _ = self.move("a", "Merged", live={"a": "In Review"}, rows={"a": row}, prs={"7": merged},
                           eng_labels=["ready-to-merge"])
        self.assertEqual(out, "CD-1: Ready to Merge -> Ready for Deploy\n")
        self.assertEqual(self.fields, {"stateId": "Ready for Deploy", "removedLabelIds": ["ready-to-merge"]})


class BaseTests(DirTests):
    def setUp(self):
        super().setUp()
        self.origin = self.d / "origin.git"
        self.repo = self.d / "checkout"
        self.git("init", "--bare", self.origin, cwd=self.d)
        self.git("init", "-b", "main", self.repo, cwd=self.d)
        self.git("config", "user.name", "Work Graph Test")
        self.git("config", "user.email", "test@example.test")
        self.git("remote", "add", "origin", self.origin)
        self.git("commit", "--allow-empty", "-m", "first")
        self.git("push", "origin", "main")
        self.old = self.git("rev-parse", "main")
        self.plan_dir = self.repo / "plans"
        self.plan_dir.mkdir()

    def git(self, *args, cwd=None, input=None):
        return subprocess.run(["git", *args], cwd=cwd or self.repo, input=input,
                              capture_output=True, text=True, check=True).stdout.strip()

    def blob_ref(self, ref, value):
        digest = self.git("hash-object", "-w", "--stdin", input=value)
        self.git("update-ref", ref, digest)

    def metadata(self, name, *, imported=True, frozen=True):
        data = {"parentBranchName": "release", "parentBranchRevision": self.old,
                "sourceRemote": "origin" if imported else "", "frozen": frozen}
        self.blob_ref(f"refs/branch-metadata/{name}", json.dumps(data))

    def advance_origin(self, *, change_file=False):
        self.git("switch", "-c", "update-origin")
        if change_file:
            (self.repo / "tracked.txt").write_text("from origin\n")
            self.git("add", "tracked.txt")
        self.git("commit", "--allow-empty", "-m", "remote next")
        # Push from a separate checkout so the tested checkout keeps a stale tracking ref.
        publisher = self.d / "publisher"
        self.git("clone", "--branch", "update-origin", self.repo, publisher, cwd=self.d)
        self.git("push", self.origin, "HEAD:main", cwd=publisher)
        sha = self.git("rev-parse", "HEAD")
        self.git("switch", "main")
        return sha

    def cli(self, mode, phases, *flags, code=0):
        self.p["phases"] = phases
        wg.save_json(self.plan_dir / "plan.json", self.p)
        return self.call(wg.main, ["wg", mode, str(self.plan_dir), *flags], code=code)

    def test_base_fast_forwards_the_worktree_that_holds_the_branch(self):
        self.blob_ref("refs/stax/trunk", "release")
        self.metadata("main")
        new = self.advance_origin()
        out, _ = self.cli("base", self.p["phases"])
        self.assertEqual(out, f"ok base main: {self.old[:10]} -> {new[:10]}\n")
        self.assertEqual(self.git("rev-parse", "HEAD"), new)

    def test_base_refreshes_unchecked_branch_and_reports_up_to_date(self):
        self.blob_ref("refs/stax/trunk", "release")
        self.metadata("main")
        new = self.advance_origin()
        self.git("switch", "-c", "main-2")
        out, _ = self.cli("base", self.p["phases"])
        self.assertEqual(out, f"ok base main: {self.old[:10]} -> {new[:10]}\n")
        self.assertEqual(self.git("symbolic-ref", "--short", "HEAD"), "main-2")
        self.assertEqual(self.git("rev-parse", "HEAD"), self.old)
        self.assertEqual(self.git("rev-parse", "main"), new)
        out, _ = self.cli("base", self.p["phases"])
        self.assertEqual(out, f"ok base main: up to date {new[:10]}\n")

    def test_base_refuses_local_commits_without_changing_refs(self):
        self.blob_ref("refs/stax/trunk", "release")
        self.metadata("main")
        self.advance_origin()
        self.git("commit", "--allow-empty", "-m", "local only")
        before = self.git("show-ref")
        for checked_out in (True, False):
            with self.subTest(checked_out=checked_out):
                if not checked_out:
                    self.git("switch", "--detach")
                out, _ = self.cli("base", self.p["phases"], code=1)
                self.assertEqual(out, "FAIL base main: Not possible to fast-forward, aborting.\n")
                self.assertEqual(self.git("show-ref"), before)

    def test_base_updates_linked_worktree_and_leaves_plan_checkout_alone(self):
        self.blob_ref("refs/stax/trunk", "release")
        self.metadata("main")
        new = self.advance_origin()
        self.git("switch", "--detach")
        path = self.d / "other checkout"
        self.git("worktree", "add", path, "main")
        out, _ = self.cli("base", self.p["phases"])
        self.assertEqual(out, f"ok base main: {self.old[:10]} -> {new[:10]}\n")
        self.assertEqual(self.git("rev-parse", "HEAD", cwd=path), new)
        self.assertEqual(self.git("rev-parse", "HEAD"), self.old)

    def test_base_lists_distinct_targets_in_order_and_filters_phase(self):
        self.blob_ref("refs/stax/trunk", "main")
        phases = [{"key": str(i), "target": target} for i, target in
                  enumerate(("main", "release", "effort/one", "feature", "main"), 1)]
        self.git("remote", "remove", "origin")
        out, _ = self.cli("base", phases, code=1)
        self.assertEqual(out.splitlines(), [
            "ok base main: stax trunk (st sync refreshes it)",
            "ok base release: no stax",
            "ok base effort/one: coordinator-owned",
            "FAIL base feature: not an imported, frozen stax branch (run wg preflight)",
        ])
        out, _ = self.cli("base", phases, "--phase", "3")
        self.assertEqual(out, "ok base effort/one: coordinator-owned\n")

    def test_base_updates_checked_out_branch_with_narrow_fetch_refspec(self):
        self.blob_ref("refs/stax/trunk", "release")
        self.metadata("main")
        new = self.advance_origin()
        self.git("config", "remote.origin.fetch", "+refs/heads/release:refs/remotes/origin/release")
        self.assertEqual(self.git("rev-parse", "origin/main"), self.old)
        out, _ = self.cli("base", self.p["phases"])
        self.assertEqual(out, f"ok base main: {self.old[:10]} -> {new[:10]}\n")
        self.assertEqual(self.git("rev-parse", "HEAD"), new)
        self.assertEqual(self.git("rev-parse", "origin/main"), new)

    def test_base_refuses_conflicting_local_change_without_changing_refs(self):
        self.blob_ref("refs/stax/trunk", "release")
        self.metadata("main")
        path = self.repo / "tracked.txt"
        path.write_text("first version\n")
        self.git("add", "tracked.txt")
        self.git("commit", "-m", "add tracked file")
        self.git("push", "origin", "main")
        self.advance_origin(change_file=True)
        path.write_text("local change\n")
        before = self.git("show-ref")
        out, _ = self.cli("base", self.p["phases"], code=1)
        self.assertEqual(out, "FAIL base main: error: Your local changes to the following files "
                              "would be overwritten by merge:; Aborting\n")
        self.assertEqual(self.git("show-ref"), before)
        self.assertEqual(path.read_text(), "local change\n")
        self.assertEqual(self.git("diff", "--name-only"), "tracked.txt")

    def test_base_reports_missing_local_branch_before_fetch(self):
        self.blob_ref("refs/stax/trunk", "release")
        self.metadata("main")
        self.git("switch", "--detach")
        self.git("branch", "-d", "main")
        before = self.git("show-ref")
        out, _ = self.cli("base", self.p["phases"], code=1)
        self.assertEqual(out, "FAIL base main: fatal: Needed a single revision\n")
        self.assertEqual(self.git("show-ref"), before)
        self.assertFalse((self.repo / ".git" / "FETCH_HEAD").exists())

    def test_base_waits_for_a_refresh_that_holds_the_repository_lock(self):
        self.metadata("main")
        new = self.advance_origin()
        done = []
        with wg.base_lock(self.plan_dir):
            worker = threading.Thread(target=lambda: done.append(wg.refresh_base(self.plan_dir, "main")))
            worker.start()
            worker.join(0.5)
            self.assertTrue(worker.is_alive())
            self.assertEqual(self.git("rev-parse", "main"), self.old)
        worker.join(10)
        self.assertEqual(done, [f"{self.old[:10]} -> {new[:10]}"])
        self.assertEqual(self.git("rev-parse", "main"), new)

    def test_base_reports_git_error_on_one_line(self):
        self.blob_ref("refs/stax/trunk", "release")
        self.metadata("main")
        self.git("remote", "remove", "origin")
        before = self.git("show-ref")
        out, _ = self.cli("base", self.p["phases"], code=1)
        self.assertEqual(len(out.splitlines()), 1)
        self.assertTrue(out.startswith("FAIL base main: "))
        self.assertEqual(self.git("show-ref"), before)

    def preflight(self, target, *, code=0):
        self.p = plan(target)
        if target in {"release", "effort/one"}:
            role = "sync" if target == "release" else "integration"
            self.p["nodes"] += [node("post", role=role)]
            self.p["edges"] += [edge("sp", "post"), edge("post", "mp")]
            if role == "sync":
                self.p["nodes"][0]["role"] = "hotfix"
        command = wg.command

        def local_command(*args, cwd=None):
            if args[0] == "git":
                self.assertEqual(cwd, str(self.plan_dir))
                return command(*args, cwd=cwd)
            if args[:3] == ("gh", "pr", "list"):
                return subprocess.CompletedProcess(args, 0, "[]", "")  # the frozen base has no open PR
            self.assertIn(args, (("gh", "auth", "status"), ("st", "--version")))
            return subprocess.CompletedProcess(args, 0, "", "")

        labels = dict.fromkeys(["agent:codex", "agent:claude", "agent:coordinator"])
        with patch.object(wg, "command", side_effect=local_command), patch.object(wg, "gql"), \
             patch.object(wg, "team_info", return_value=("cd", dict.fromkeys(wg.CD_WRITES), labels)):
            out, _ = self.cli("preflight", self.p["phases"], code=code)
        self.assertTrue(out.startswith("ok plan: valid\nok tools: git, gh, st\n"))
        self.assertIn("ok linear:", out)
        return out.splitlines()[3:]

    def expected_trunk_failure(self, target, trunk, branch):
        return [
            f"FAIL trunk: phase 1 targets {target}, but the stax trunk is {trunk} "
            f"and {branch} is not an imported, frozen stax branch",
            f"  ask Human to run, in the checkout that holds {branch}: "
            f"st get {branch} --parent {trunk} --no-checkout --downstack --no-restack && st freeze {branch}",
        ]

    def test_preflight_fails_when_trunk_is_missing_and_skips_release(self):
        self.assertEqual(self.preflight("main", code=1),
                         ["FAIL trunk: phase 1 targets main, but the stax trunk is not set"])
        self.assertEqual(self.preflight("release"),
                         ["ok trunk: phase 1 targets release: no stax"])

    def test_preflight_accepts_trunk_and_imported_frozen_base(self):
        self.blob_ref("refs/stax/trunk", "main")
        self.assertEqual(self.preflight("main"), ["ok trunk: phase 1 targets main: stax trunk"])
        self.blob_ref("refs/stax/trunk", "release")
        self.metadata("main")
        self.assertEqual(self.preflight("main"), ["ok trunk: phase 1 targets main: frozen base under release",
                                                 "ok base: main sits on its PR base"])

    def frozen_problem(self, pr, own="4", stack=""):
        def fake(*args, cwd=None):
            if args[:3] == ("gh", "pr", "list"):
                return subprocess.CompletedProcess(args, 0, json.dumps(pr), "")
            if args[:2] == ("gh", "api"):
                return subprocess.CompletedProcess(args, 0, stack, "")
            raise AssertionError(args)
        with patch.object(wg, "command", side_effect=fake), patch.object(wg, "git_output", return_value=own):
            return wg.frozen_base_pr_problem(self.d, "wg/x-guard-00-knip", "release")

    def test_frozen_base_pr_must_match_parent_scope_and_have_no_stack(self):
        ok = [{"number": 7701, "baseRefName": "release", "commits": [{}] * 4}]
        self.assertIsNone(self.frozen_problem(ok))
        self.assertIsNone(self.frozen_problem([]))
        wrong_base = [{"number": 7701, "baseRefName": "main", "commits": [{}] * 4}]
        self.assertIn("targets main, but its stax parent is release", self.frozen_problem(wrong_base))
        # 2026-11-20: branch cut from main, PR into release.
        foreign = [{"number": 7701, "baseRefName": "release", "commits": [{}] * 518}]
        self.assertIn("carries 518 commits on GitHub, but the branch has 4", self.frozen_problem(foreign))
        self.assertIn("native GitHub stack #7738", self.frozen_problem(ok, stack="7738\n"))

    def test_preflight_rejects_untracked_import_only_and_frozen_only(self):
        self.blob_ref("refs/stax/trunk", "release")
        expected = self.expected_trunk_failure("main", "release", "main")
        self.assertEqual(self.preflight("main", code=1), expected)
        for imported, frozen in ((True, False), (False, True)):
            with self.subTest(imported=imported, frozen=frozen):
                self.metadata("main", imported=imported, frozen=frozen)
                self.assertEqual(self.preflight("main", code=1), expected)

    def test_preflight_rejects_invalid_metadata_and_accepts_base_without_parent(self):
        self.blob_ref("refs/stax/trunk", "release")
        for value in ("not JSON", "[]"):
            with self.subTest(value=value):
                self.blob_ref("refs/branch-metadata/main", value)
                self.assertEqual(self.preflight("main", code=1),
                                 self.expected_trunk_failure("main", "release", "main"))
        self.blob_ref("refs/branch-metadata/main", '{"sourceRemote":"origin","frozen":true}')
        self.assertEqual(self.preflight("main"), ["ok trunk: phase 1 targets main: frozen base",
                                                 "ok base: main sits on its PR base"])

    def test_preflight_effort_checks_main_and_its_own_metadata(self):
        self.blob_ref("refs/stax/trunk", "main")
        expected = ["ok trunk: phase 1 targets effort/one: integration branch on main"]
        self.assertEqual(self.preflight("effort/one"), expected)
        self.blob_ref("refs/stax/trunk", "release")
        failure = self.expected_trunk_failure("effort/one", "release", "main")
        self.assertEqual(self.preflight("effort/one", code=1), failure)
        self.metadata("main")
        self.assertEqual(self.preflight("effort/one"), expected)
        self.metadata("effort/one", imported=False)
        self.assertEqual(self.preflight("effort/one"), expected)
        self.metadata("effort/one", frozen=False)
        self.assertEqual(self.preflight("effort/one", code=1), [
            "FAIL trunk: phase 1 targets effort/one: the integration branch is tracked "
            "but not frozen (st freeze effort/one)",
        ])


class LocalTests(DirTests):
    def test_save_json_replaces_atomically_and_preserves_mode(self):
        path = self.d / "test.json"
        wg.save_json(path, {"old": True})
        self.assertEqual(path.stat().st_mode & 0o777, 0o644)
        path.chmod(0o640)
        with path.open() as before:
            wg.save_json(path, {"new": True})
            self.assertEqual(json.load(before), {"old": True})
        self.assertEqual(json.loads(path.read_text()), {"new": True})
        self.assertEqual(path.stat().st_mode & 0o777, 0o640)
        self.assertEqual(set(self.d.iterdir()), {path, self.d / "plan.json"})

    def test_run_show_json_with_key_returns_only_that_row(self):
        self.keymap(rows={"a": {"pr": "7"}, "mp": {"state": "done"}})
        self.call(wg.run_set, self.d, self.p, "@effort", ["wave=one"])
        for key, expected in [("a", {"pr": "7"}), ("sp", {}), ("@effort", {"wave": "one"})]:
            out, _ = self.call(wg.run_show, self.d, self.p, key, True)
            self.assertEqual(json.loads(out), expected)

    def test_main_leaves_programming_errors_visible(self):
        for error in (KeyError("title"), TypeError("bad internal data")):
            with self.subTest(error=error), patch.object(wg, "check", side_effect=error):
                with self.assertRaises(type(error)):
                    wg.main(["wg", "check", str(self.d)])

    def custom_test(self):
        self.p["effort"]["test"] = ["test", "--", "arg"]
        self.write_plan()

    def test_evidence_exit_signal_and_missing_command(self):
        self.custom_test()
        with patch.object(wg, "git_output", side_effect=["", SHA]), patch.object(wg.subprocess, "Popen") as popen:
            proc = popen.return_value.__enter__.return_value
            proc.stdout = iter([])
            proc.wait.return_value = -15
            self.call(wg.evidence, self.d, self.p, "a", code=143)
            self.assertEqual(json.loads(wg.evidence_path(self.d, "a").read_text())["exit"], 143)
        with patch.object(wg, "git_output", side_effect=["", SHA]), \
             patch.object(wg.subprocess, "Popen", side_effect=FileNotFoundError("command missing")):
            _, err = self.call(wg.main, ["wg", "evidence", str(self.d), "mp"], code=2)
        self.assertIn("command missing", err)
        self.assertFalse(wg.evidence_path(self.d, "mp").exists())

    def test_evidence_runs_only_the_effort_test_command(self):
        with patch.object(wg.subprocess, "Popen") as popen:
            _, err = self.call(wg.main, ["wg", "evidence", str(self.d), "a", "--", "true"], code=2)
            self.assertIn("runs only the effort's test command", err)
            popen.assert_not_called()

    def node_evidence(self, targets, code=0):
        self.keymap(rows={"a": {"lower": "origin/main"}})
        with patch.object(wg, "git_output", side_effect=["", SHA, OTHER]) as git, \
             patch.object(wg, "affected_tests", return_value=targets) as affected, \
             patch.object(wg.subprocess, "Popen") as popen:
            proc = popen.return_value.__enter__.return_value
            proc.stdout = iter([f"pushing {SHA[:10]} (topic) to the box\n"])
            proc.wait.return_value = code
            out, _ = self.call(wg.evidence, self.d, self.p, "a", code=code)
        self.assertEqual(git.call_args.args, ("merge-base", "origin/main", "HEAD"))
        affected.assert_called_once_with(OTHER)
        return out, popen, json.loads(wg.evidence_path(self.d, "a").read_text())

    def test_node_evidence_runs_the_test_tasks_that_its_diff_affects(self):
        command = [*wg.TEST_RUN, "be:test", "types:test", *wg.TEST_OPTIONS]
        out, popen, record = self.node_evidence(["be:test", "types:test"], code=1)
        self.assertEqual(popen.call_args.args[0], command)
        self.assertEqual((record["command"], record["scope"], record["base"], record["exit"], record["valid"]),
                         (command, "affected", OTHER, 1, True))
        self.assertIn(f"affected tests over {OTHER[:10]}: ", out)
        self.assertEqual(Path(record["log"]).read_text(), out)

    def test_node_evidence_of_a_workspace_change_runs_the_repo_wide_suite(self):
        _, popen, record = self.node_evidence(None)
        self.assertEqual(popen.call_args.args[0], wg.DEFAULT_TEST)
        self.assertEqual((record["command"], record["scope"]), (wg.DEFAULT_TEST, "full"))

    def test_node_evidence_with_no_affected_test_task_passes_and_runs_nothing(self):
        out, popen, record = self.node_evidence([])
        popen.assert_not_called()
        self.assertEqual((record["command"], record["scope"], record["exit"], record["valid"], record["sha"]),
                         ([], "affected", 0, True, SHA))
        self.assertEqual(out, f"no test task is affected by {OTHER[:10]}..{SHA[:10]}\n")

    def test_node_evidence_needs_the_diff_base_of_the_run_row(self):
        self.keymap(rows={})
        with patch.object(wg, "git_output", side_effect=["", SHA]), patch.object(wg.subprocess, "Popen") as popen:
            _, err = self.call(wg.evidence, self.d, self.p, "a", code=2)
        self.assertEqual(err, "a: missing run field lower\n")
        popen.assert_not_called()

    def test_affected_tests_include_dependents_and_stop_at_a_workspace_file(self):
        moon = subprocess.CompletedProcess([], 0, json.dumps({"tasks": {
            "types": {"test": {}, "lint": {}}, "be": {"test": {}}, "docs": {"lint": {}}}}), "")
        with patch.object(wg, "git_output", return_value="packages/types/a.ts\nREADME.md\n") as git, \
             patch.object(wg.subprocess, "run", return_value=moon) as run:
            self.assertEqual(wg.affected_tests(OTHER), ["be:test", "types:test"])
        self.assertEqual(git.call_args.args, ("diff", "--name-only", OTHER, "HEAD"))
        self.assertEqual(run.call_args.args[0], ["moon", "query", "tasks", "--affected", "--downstream", "deep"])
        env = run.call_args.kwargs["env"]
        self.assertEqual((env["MOON_BASE"], env["MOON_HEAD"]), (OTHER, "HEAD"))
        for name in ("pnpm-lock.yaml", "package.json", ".moon/tasks/node.yml"):
            with self.subTest(name=name), patch.object(wg, "git_output", return_value=f"web/a.ts\n{name}\n"), \
                 patch.object(wg.subprocess, "run") as run:
                self.assertIsNone(wg.affected_tests(OTHER))
                run.assert_not_called()
        failed = subprocess.CompletedProcess([], 1, "", "no moon workspace")
        with patch.object(wg, "git_output", return_value="web/a.ts\n"), \
             patch.object(wg.subprocess, "run", return_value=failed):
            with self.assertRaisesRegex(wg.ReadError, "no moon workspace"):
                wg.affected_tests(OTHER)

    def test_phase_evidence_runs_the_repo_wide_suite(self):
        with patch.object(wg, "git_output", side_effect=["", SHA]), patch.object(wg.subprocess, "Popen") as popen:
            proc = popen.return_value.__enter__.return_value
            proc.stdout = iter([f"pushing {SHA[:10]} (main) to the box\n"])
            proc.wait.return_value = 0
            self.call(wg.evidence, self.d, self.p, "@full-1")
        self.assertEqual(popen.call_args.args[0], wg.DEFAULT_TEST)
        record = json.loads(wg.evidence_path(self.d, "@full-1").read_text())
        self.assertEqual((record["command"], record["scope"], record["valid"]), (wg.DEFAULT_TEST, "full", True))
        for key in ("@full-9", "@baseline", "@full-"):
            with self.subTest(key=key), patch.object(wg.subprocess, "Popen") as popen:
                _, err = self.call(wg.evidence, self.d, self.p, key, code=2)
                self.assertIn(f"unknown key {key}", err)
                popen.assert_not_called()

    def test_default_suite_evidence_needs_the_pushed_commit_line(self):
        with patch.object(wg, "git_output", side_effect=["", SHA]), patch.object(wg.subprocess, "Popen") as popen:
            proc = popen.return_value.__enter__.return_value
            proc.stdout = iter(["all tests passed\n"])
            proc.wait.return_value = 0
            _, err = self.call(wg.evidence, self.d, self.p, "@full-1", code=3)
        self.assertIn("did not print the commit that it tested", err)
        self.assertFalse(json.loads(wg.evidence_path(self.d, "@full-1").read_text())["valid"])

    def test_preflight_reports_missing_linear_state_or_label(self):
        with patch.object(wg, "command", return_value=subprocess.CompletedProcess([], 0, "main", "")), \
             patch.object(wg, "gql"), patch.object(wg, "team_info", return_value=("cd", {}, {})), \
             patch.object(wg, "workspace_labels", return_value={}):
            out, _ = self.call(wg.preflight, self.d, plan(), None, code=1)
        self.assertIn("FAIL linear:", out)
        self.assertIn("Ready to Merge", out)
        self.assertIn("agent:claude", out)

    def verify_row(self, row, patch_id="p1", evidence=True, head=SHA, code=0):
        pr = {"state": "OPEN", "baseRefName": "main", "headRefName": "topic", "headRefOid": SHA}
        path = wg.evidence_path(self.d, "a")
        path.parent.mkdir(exist_ok=True)
        wg.save_json(path, {"sha": SHA if evidence else OTHER, "valid": True, "exit": 0, "command": wg.DEFAULT_TEST})
        self.keymap(rows={"a": {"pr": "7", "branch": "topic", "parent": "main", "lower": "origin/main"} | row})
        with patch.object(wg, "pr_view", return_value=pr), patch.object(wg, "git_output", side_effect=[head, ""]), \
             patch.object(wg, "owns_diff", return_value=0), patch.object(wg, "patch_id", return_value=patch_id) as patcher, \
             patch.object(wg, "command", return_value=subprocess.CompletedProcess([], 0, "[]", "")):
            out, _ = self.call(wg.verify, self.d, self.p, "a", code=code)
        self.assertEqual(patcher.called, head == SHA)
        return out, wg.run_row(wg.load_keymap(self.d), "a")

    def test_verify_keeps_the_review_for_a_new_head_with_the_same_patch(self):
        reviewed = {"review": "clean", "merge_review": "accepted", "review_round": "2", "code_done_head": OTHER}
        out, row = self.verify_row(reviewed | {"patch": "p1"})
        self.assertIn("kept the review: new head, same patch", out)
        self.assertEqual((row["review"], row["merge_review"], row["code_done_head"], row["patch"]),
                         ("clean", "accepted", SHA, "p1"))
        out, row = self.verify_row(reviewed | {"patch": "p0", "merge_review_seen": "3"})
        self.assertIn("cleared review, merge_review, merge_review_seen: the patch changed", out)
        self.assertEqual({f: row.get(f) for f in ("review", "merge_review", "review_round", "patch", "code_done_head")},
                         {"review": None, "merge_review": None, "review_round": None, "patch": "p1", "code_done_head": SHA})

    def test_verify_handles_rows_from_before_the_patch_field(self):
        out, row = self.verify_row({"review": "clean", "verified_head": OTHER, "code_done_head": OTHER})
        self.assertIn("cleared review, verified_head: the patch changed", out)
        self.assertNotIn("review", row)
        for old_head in (SHA, None):
            out, row = self.verify_row({"review": "clean"} | ({"code_done_head": old_head} if old_head else {}))
            self.assertNotIn("cleared", out)
            self.assertEqual((row["review"], row["patch"]), ("clean", "p1"))

    def test_a_new_patch_clears_the_review_when_another_check_fails(self):
        out, row = self.verify_row({"review": "clean", "patch": "p0", "code_done_head": OTHER, "review_round": "1"},
                                   evidence=False, code=1)
        self.assertIn("FAIL tests:", out)
        self.assertEqual((row.get("review"), row["patch"], row["code_done_head"]), (None, "p1", OTHER))
        out, row = self.verify_row({"review": "clean", "patch": "p0", "code_done_head": OTHER}, head=OTHER, code=1)
        self.assertIn("FAIL head:", out)
        self.assertEqual((row["review"], row["patch"]), ("clean", "p0"))

    def test_a_head_that_fails_again_is_no_longer_code_done(self):
        out, row = self.verify_row({"code_done_head": SHA, "patch": "p1", "review": "clean"}, evidence=False, code=1)
        self.assertIn(f"a: {SHA[:10]} is no longer code done", out)
        self.assertEqual((row.get("code_done_head"), row["review"]), (None, "clean"))

    def test_patch_id_is_stable_across_a_rebase_and_changes_with_the_diff(self):
        repo = self.d / "repo"

        def git(*args):
            return subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True, check=True).stdout.strip()

        subprocess.run(["git", "init", "-q", "-b", "main", str(repo)], check=True)
        git("config", "user.name", "Work Graph Test")
        git("config", "user.email", "test@example.test")
        (repo / "base.txt").write_text("base\n")
        git("add", ".")
        git("commit", "-q", "-m", "base")
        git("switch", "-q", "-c", "topic")
        (repo / "a.txt").write_text("one\n")
        (repo / "b.bin").write_bytes(bytes(range(256)))
        git("add", ".")
        git("commit", "-q", "-m", "topic")
        first = wg.patch_id("main", repo)
        git("switch", "-q", "main")
        (repo / "other.txt").write_text("moved base\n")
        git("add", ".")
        git("commit", "-q", "-m", "main moves")
        git("switch", "-q", "topic")
        git("rebase", "-q", "main")
        self.assertEqual(wg.patch_id("main", repo), first)
        (repo / "a.txt").write_text("two\n")
        git("commit", "-q", "-am", "fix")
        self.assertNotEqual(wg.patch_id("main", repo), first)
        git("switch", "-q", "-c", "empty", "main")
        self.assertEqual(wg.patch_id("main", repo), "empty")

    def test_patch_id_sees_another_place_and_white_space_and_survives_a_far_base_change(self):
        repo = self.d / "repo"

        def git(*args):
            return subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True, check=True).stdout.strip()

        def write(lines):
            (repo / "config").write_text("\n".join(lines) + "\n")

        subprocess.run(["git", "init", "-q", "-b", "main", str(repo)], check=True)
        git("config", "user.name", "Work Graph Test")
        git("config", "user.email", "test@example.test")
        base = ["[production]", "enabled=false", *"abcdefghij", "[development]", "enabled=false", "tail"]
        write(base)
        git("add", ".")
        git("commit", "-q", "-m", "base")

        def topic(name, lines):
            git("switch", "-q", "-c", name, "main")
            write(lines)
            git("commit", "-q", "-am", name)
            return wg.patch_id("main", repo)

        production = topic("production", ["[production]", "enabled=true", *base[2:]])
        development = topic("development", [*base[:13], "enabled=true", "tail"])
        spaced = topic("spaced", ["[production]", "enabled = true", *base[2:]])
        self.assertEqual(len({production, development, spaced}), 3)
        # the base changes a line far from the hunk: a restack with no conflict keeps the id
        git("switch", "-q", "main")
        write([*base[:14], "TAIL"])
        git("commit", "-q", "-am", "far change")
        git("switch", "-q", "production")
        git("rebase", "-q", "main")
        self.assertEqual(wg.patch_id("main", repo), production)
        # the base changes a line in the context of the hunk: a new id, which costs a review and keeps no wrong one
        git("switch", "-q", "main")
        write(["[production]", "enabled=false", "a", "B", *base[4:14], "TAIL"])
        git("commit", "-q", "-am", "near change")
        git("switch", "-q", "production")
        git("rebase", "-q", "main")
        self.assertNotEqual(wg.patch_id("main", repo), production)

    def test_run_set_allows_two_thorough_reviews_of_a_pr(self):
        self.keymap(rows={"a": {"pr": "7", "patch": "p1", "code_done_head": SHA}})
        with patch.object(wg, "sync_card", return_value=False), \
             patch.object(wg, "pr_view", return_value={"reviews": [], "comments": []}):
            for count in ("1", "2"):
                self.call(wg.run_set, self.d, self.p, "a", ["merge_review=requested"])
                row = wg.run_row(wg.load_keymap(self.d), "a")
                self.assertEqual((row["thorough_count"], row["thorough_head"]), (count, SHA))
            _, err = self.call(wg.run_set, self.d, self.p, "a", ["merge_review=requested"], code=1)
            self.assertIn("a: 2 thorough reviews ran; check the fix yourself", err)
        self.assertEqual(wg.run_row(wg.load_keymap(self.d), "a")["thorough_count"], "2")

    def test_run_set_ties_a_review_result_to_the_patch_that_was_reviewed(self):
        self.keymap(rows={"a": {"pr": "7", "patch": "p1", "code_done_head": SHA}})
        pr = {"reviews": [{}, {"body": "LGTM"}], "comments": [{}, {"body": "@claude-thorough please"}], "headRefOid": SHA}
        with patch.object(wg, "sync_card", return_value=False), patch.object(wg, "sync_ready") as sync, \
             patch.object(wg, "pr_view", return_value=pr) as view:
            self.call(wg.run_set, self.d, self.p, "a", ["review_round=1", "review_dispatch=d1"])
            self.call(wg.run_set, self.d, self.p, "a", ["merge_review=requested"])
            row = wg.run_row(wg.load_keymap(self.d), "a")
            self.assertEqual((row["review_patch"], row["merge_review_patch"], row["merge_review_seen"]), ("p1", "p1", "3"))
            view.assert_called_once_with("7", "reviews,comments", cwd=self.d)
            sync.assert_not_called()
            self.call(wg.run_set, self.d, self.p, "a", ["patch=p2"])
            for field in ("review", "merge_review"):
                out, err = self.call(wg.run_set, self.d, self.p, "a", [f"{field}=clean"], code=1)
                self.assertIn("the patch changed after the review started", err)
            self.call(wg.run_set, self.d, self.p, "a", ["patch=p1"])
            pr["headRefOid"] = OTHER  # a push that wg done did not check yet
            for field in ("review", "merge_review"):
                _, err = self.call(wg.run_set, self.d, self.p, "a", [f"{field}=accepted"], code=1)
                self.assertIn(f"a: the PR head {OTHER[:10]} is not code done; run wg done", err)
            self.assertNotIn("review", wg.run_row(wg.load_keymap(self.d), "a"))
            pr["headRefOid"] = SHA
            self.call(wg.run_set, self.d, self.p, "a", ["review=clean", "merge_review=accepted"])
            sync.assert_not_called()  # the node above started at code done: a review changes no blocker
        self.assertEqual(wg.run_row(wg.load_keymap(self.d), "a"),
                         {"pr": "7", "patch": "p1", "code_done_head": SHA, "review_round": "1", "review": "clean",
                          "merge_review": "accepted", "thorough_count": "1", "thorough_head": SHA})

    def test_run_set_saves_a_review_request_when_github_is_not_read(self):
        self.keymap(rows={"a": {"pr": "7"}})
        with patch.object(wg, "sync_card", return_value=False), patch.object(wg, "pr_view", side_effect=wg.ReadError("no network")):
            _, err = self.call(wg.run_set, self.d, self.p, "a", ["merge_review=requested"])
        self.assertIn("PR #7 not read (no network): merge_review_seen=0", err)
        self.assertEqual(wg.run_row(wg.load_keymap(self.d), "a")["merge_review_seen"], "0")

    def test_run_set_does_not_write_an_approval_and_run_reset_forgets_the_row(self):
        self.keymap(rows={"a": {"approved": "2026-11-19: ok", "review": "clean", "branch": "wg/x"}, "mp": {"state": "running"}})
        with patch.object(wg, "sync_card", return_value=False):
            _, err = self.call(wg.run_set, self.d, self.p, "a", ["approved=2026-11-20: yes"], code=1)
            self.assertIn("an approval is recorded with wg approve", err)
            self.call(wg.run_set, self.d, self.p, "a", ["approved="])
            self.assertNotIn("approved", wg.run_row(wg.load_keymap(self.d), "a"))
            out, _ = self.call(wg.main, ["wg", "run", "reset", str(self.d), "a"])
            self.assertEqual(out, "a: run row removed\n")
            _, err = self.call(wg.main, ["wg", "run", "reset", str(self.d), "mp"], code=1)
            self.assertIn("mp: a job is live (state=running)", err)
        self.assertEqual(wg.load_keymap(self.d)["run"]["nodes"], {"mp": {"state": "running"}})

    def test_run_set_rejects_an_invalid_soak_time(self):
        self.keymap(rows={})
        with patch.object(wg, "sync_card", return_value=False):
            _, err = self.call(wg.run_set, self.d, self.p, "sp", ["soak_until=tomorrow"], code=2)
            self.assertIn("sp: invalid soak_until 'tomorrow'", err)
            self.call(wg.run_set, self.d, self.p, "sp", ["soak_until=2026-11-21T10:00:00Z"])

    def test_verify_explains_missing_owns(self):
        self.p["nodes"][0].pop("owns")
        self.keymap(rows={"a": {"pr": "7", "branch": "topic", "parent": "main", "lower": "origin/main"}})
        pr = {"state": "OPEN", "baseRefName": "main", "headRefName": "topic", "headRefOid": SHA}
        path = wg.evidence_path(self.d, "a")
        path.parent.mkdir()
        wg.save_json(path, {"sha": SHA, "valid": True, "exit": 0, "command": wg.DEFAULT_TEST})
        with patch.object(wg, "pr_view", return_value=pr), patch.object(wg, "git_output", side_effect=[SHA, ""]), \
             patch.object(wg, "owns_diff") as diff, patch.object(wg, "patch_id", return_value="p1"), \
             patch.object(wg, "command", return_value=subprocess.CompletedProcess([], 0, "[]", "")):
            out, _ = self.call(wg.verify, self.d, self.p, "a", code=1)
        self.assertIn("FAIL owns: node has no owns\n", out)
        diff.assert_not_called()

    def test_run_set_copies_card_fields_to_the_node_card(self):
        self.keymap()
        with patch.object(wg, "gql", return_value={"commentCreate": {"comment": {"id": "card"}}}) as request:
            self.call(wg.main, ["wg", "run", "set", str(self.d), "a", "pr=7", "dispatch=d1"])
            self.assertIn('"pr": "7"', request.call_args.args[1]["i"]["body"])
            self.assertNotIn("dispatch", request.call_args.args[1]["i"]["body"])
            self.call(wg.main, ["wg", "run", "set", str(self.d), "a", "dispatch=d2"])
            self.assertEqual(request.call_count, 1)
        self.assertEqual(wg.load_keymap(self.d)["nodes"]["a"]["card"]["id"], "card")
        with patch.object(wg, "gql", side_effect=wg.ReadError("offline")), \
             patch.object(wg, "pr_view", return_value={"headRefOid": None}):
            out, err = self.call(wg.main, ["wg", "run", "set", str(self.d), "a", "review=clean"])
        self.assertEqual(out, "pr=7 dispatch=d2 review=clean\n")
        self.assertIn("node card not updated (offline)", err)
        self.assertEqual(wg.load_keymap(self.d)["run"]["nodes"]["a"]["review"], "clean")

    def test_parallel_run_set_keeps_every_row(self):
        self.p["nodes"] += [node(f"k{i}", lane=f"l{i}") for i in range(12)]
        self.p["edges"] += [edge("mp", f"k{i}") for i in range(12)]
        self.write_plan()
        script = str(Path(__file__).with_name("wg.py"))
        procs = [subprocess.Popen([sys.executable, "-I", script, "run", "set", str(self.d), f"k{i}", "state=running"],
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) for i in range(12)]
        self.assertEqual([proc.wait() for proc in procs], [0] * 12)
        self.assertEqual(len(wg.load_keymap(self.d)["run"]["nodes"]), 12)

    def test_run_set_show_delete_and_unknown(self):
        def cli(*args, code=0):
            return self.call(wg.main, ["wg", *args], code=code)

        self.assertEqual(cli("run", "set", str(self.d), "a", "pr=2", "state=review")[0], "pr=2 state=review\n")
        cli("run", "set", str(self.d), "a", "pr=", "branch=topic")
        cli("run", "set", str(self.d), "@effort", "wave=1")
        self.assertEqual(cli("run", "show", str(self.d))[0], "wave=1\na\tstate=review branch=topic\n")
        self.assertEqual(cli("run", "show", str(self.d), "a")[0], "state=review\nbranch=topic\n")
        self.assertEqual(cli("run", "show", str(self.d), "@effort")[0], "wave=1\n")
        data = json.loads(cli("run", "show", str(self.d), "--json")[0])
        self.assertEqual(data["nodes"]["a"], {"state": "review", "branch": "topic"})
        self.assertIn("unknown key", cli("run", "set", str(self.d), "missing", "pr=1", code=2)[1])
        self.assertIn("unknown key", cli("run", "show", str(self.d), "missing", code=2)[1])
        self.assertIn("invalid run field", cli("run", "set", str(self.d), "a", "X=x", code=2)[1])

    def test_evidence_rejects_dirty_tree_before_running(self):
        with patch.object(wg, "git_output", return_value=" M foo"), patch.object(wg.subprocess, "Popen") as popen:
            _, err = self.call(wg.evidence, self.d, self.p, "a", code=2)
            self.assertIn("tree is not clean", err)
            popen.assert_not_called()

    def test_evidence_streams_and_validates_worktree_sha(self):
        runs = [
            ("a", f"pushing {SHA[:10]} (topic)", 0, True),
            ("a", f"pushing {OTHER[:10]} (topic)", 3, False),
            ("a", f"pushing {SHA[:10]} (topic, with uncommitted changes)", 3, False),
            ("a", f"pushing {OTHER[:10]} (topic, with uncommitted changes)", 3, False),
            ("@full-1", "normal test output", 7, True),
        ]
        self.custom_test()
        for key, line, exit_code, valid in runs:
            with self.subTest(line=line), patch.object(wg, "git_output", side_effect=["", SHA]), \
                 patch.object(wg.subprocess, "Popen") as popen:
                proc = popen.return_value.__enter__.return_value
                proc.stdout = iter([line + "\n", "complete\n"])
                command_exit = 7 if key == "@full-1" else 0
                proc.wait.return_value = command_exit
                out, err = self.call(wg.evidence, self.d, self.p, key, code=exit_code)
                self.assertIn(line, out)
                record = json.loads(wg.evidence_path(self.d, key).read_text())
                self.assertEqual(record["valid"], valid)
                self.assertEqual(record["exit"], command_exit)
                self.assertEqual(record["sha"], SHA)
                self.assertEqual(record["command"], ["test", "--", "arg"])
                self.assertEqual(Path(record["log"]).read_text(), out)
                if "with uncommitted changes" in line:
                    self.assertEqual(err, "evidence invalid: the command tested uncommitted changes\n")
                elif not valid:
                    self.assertIn(f"tested {OTHER[:10]}, not HEAD {SHA[:10]}", err)

    def test_verify_success_and_each_check_failure(self):
        default_pr = {"state": "OPEN", "baseRefName": "main", "headRefName": "topic",
                      "headRefOid": SHA, "isDraft": True}
        row = {"pr": "7", "branch": "topic", "parent": "main", "lower": "origin/main"}
        cases = [
            ("success", {}, [SHA, "", "a/code\nshared\n"], {"sha": SHA, "valid": True, "exit": 0}, [], {}),
            ("pr", {"baseRefName": "wrong"}, [SHA, "", "a/code\n"], None, [], {}),
            ("head", {}, [OTHER, " M a/code", "a/code\n"], None, [], {}),
            ("tests", {}, [SHA, "", "a/code\n"], {"sha": SHA, "valid": False, "exit": 0}, [], {}),
            ("owns", {}, [SHA, "", "extra\nshared\n"], None, [], {}),
            ("checks", {}, [SHA, "", "a/code\n"], None, [{"name": "lint", "bucket": "fail"}], {}),
            ("accepted", {}, [SHA, "", "a/code\n"], {"sha": SHA, "valid": True, "exit": 1},
             [{"name": "queued", "bucket": "pending"}], {"tests_accepted": SHA + ":known failure"}),
            ("tests", {}, [SHA, "", "a/code\n"], {"sha": OTHER, "valid": True, "exit": 1}, [],
             {"tests_accepted": SHA + ":known failure"}),
            ("tests", {}, [SHA, "", "a/code\n"], {"sha": SHA, "valid": True, "exit": 0, "command": ["true"]}, [], {}),
            ("success", {}, [SHA, "", "a/code\n"],
             {"sha": SHA, "valid": True, "exit": 0, "command": [], "scope": "affected"}, [], {}),
        ]
        path = wg.evidence_path(self.d, "a")
        path.parent.mkdir()
        for name, delta, git, evidence, checks, extra in cases:
            with self.subTest(name=name, evidence=evidence):
                self.keymap(rows={"a": row | extra})
                record = evidence if evidence is not None else {"sha": SHA, "valid": True, "exit": 0}
                wg.save_json(path, {"command": wg.DEFAULT_TEST} | record)
                head, dirty, diff = git

                def cli(args, **kwargs):
                    action = args[:3]
                    if action == ("git", "rev-parse", "HEAD"):
                        return subprocess.CompletedProcess(args, 0, head, "")
                    if action == ("git", "status", "--porcelain"):
                        return subprocess.CompletedProcess(args, 0, dirty, "")
                    if action == ("git", "diff", "--name-only"):
                        return subprocess.CompletedProcess(args, 0, diff, "")
                    if action == ("gh", "pr", "view"):
                        return subprocess.CompletedProcess(args, 0, json.dumps(default_pr | delta), "")
                    self.assertEqual(action, ("gh", "pr", "checks"))
                    return subprocess.CompletedProcess(args, 1 if name == "checks" else 0, json.dumps(checks), "")

                with patch.object(wg.subprocess, "run", side_effect=cli), patch.object(wg, "patch_id", return_value="p1"):
                    ok = name in {"success", "accepted"}
                    out, _ = self.call(wg.verify, self.d, self.p, "a", code=0 if ok else 1)
                for check in ("pr", "head", "tests", "owns", "checks"):
                    self.assertIn(f"{'FAIL' if check == name else 'ok'} {check}:", out)
                if "shared" in diff:
                    self.assertIn("SHARED shared", out)
                if name == "accepted":
                    self.assertIn("ok tests: accepted: known failure", out)
                new_row = wg.run_row(wg.load_keymap(self.d), "a")
                self.assertEqual(new_row.get("code_done_head"), SHA if ok else None)

    def test_verify_missing_required_run_field(self):
        self.keymap(rows={"a": {"pr": "7", "branch": "topic", "parent": "main"}})
        _, err = self.call(wg.verify, self.d, self.p, "a", code=2)
        self.assertIn("missing run field lower", err)


class PrGuardTests(unittest.TestCase):
    """wg done refuses a PR that carries foreign commits or sits in a native GitHub stack."""

    def run_with(self, responses):
        def cli(args, **kwargs):
            for prefix, (code, out) in responses.items():
                if tuple(args[:len(prefix)]) == prefix:
                    return subprocess.CompletedProcess(args, code, out, "")
            raise AssertionError(f"unexpected command {args}")
        return patch.object(wg.subprocess, "run", side_effect=cli)

    def test_scope_passes_when_the_pr_carries_the_branch_commits(self):
        with self.run_with({("gh", "pr", "view"): (0, json.dumps({"commits": [{}] * 3})),
                            ("git", "rev-list"): (0, "3\n")}):
            ok, name, detail = wg.pr_scope("7701", "origin/release")
        self.assertEqual((ok, name), (True, "scope"))

    def test_scope_fails_for_a_branch_cut_from_another_base(self):
        # The 2026-11-20 case: knip branch cut from main, PR into release, 518 commits on GitHub.
        with self.run_with({("gh", "pr", "view"): (0, json.dumps({"commits": [{}] * 518})),
                            ("git", "rev-list"): (0, "3\n")}):
            ok, name, detail = wg.pr_scope("7701", "origin/main")
        self.assertFalse(ok)
        self.assertIn("carries 518 commits, the branch has 3", detail)

    def test_stack_fails_when_the_pr_is_in_a_native_stack(self):
        with self.run_with({("gh", "api"): (0, "7738\n")}):
            ok, name, detail = wg.pr_stack("7701")
        self.assertFalse(ok)
        self.assertIn("st stack unlink 7738", detail)

    def test_stack_passes_without_a_native_stack(self):
        with self.run_with({("gh", "api"): (0, "\n")}):
            ok, _, _ = wg.pr_stack("7701")
        self.assertTrue(ok)

class LaneTests(DirTests):
    """a and b are one lane (b on a), c is a second lane, the spike s blocks a."""

    def setUp(self):
        super().setUp()
        self.p["effort"]["slug"] = "ex"
        self.p["phases"][0]["soak"] = "24h"
        self.p["nodes"] += [node("b"), node("c", lane="two"), node("s", "spike"), node("ops", "ops"),
                            node("dec", "decision")]
        self.p["edges"] += [edge("b", "a"), edge("a", "s"), edge("mp", "b"), edge("mp", "c"),
                            edge("ops", "mp"), edge("dec", "ops"), edge("sp", "dec")]
        self.assertEqual(wg.check(self.p), [])
        self.write_plan()
        self.ids = {"a": "CD-1", "mp": "CD-2", "sp": "CD-3", "b": "CD-4", "c": "CD-5", "s": "CD-6",
                    "ops": "CD-7", "dec": "CD-8"}

    def issues(self, live):
        out = {}
        for n in self.p["nodes"]:
            value = (live or {}).get(n["key"], "Todo")
            status, labels = (value, ()) if isinstance(value, str) else value
            out[n["key"]] = live_issue(status, labels, title=n["key"])
        return out


class NextTests(LaneTests):
    def lines(self, live=None, rows=None, prs=None, effort=None, triage=(), checks=(True, "no checks")):
        self.keymap(rows=rows or {})
        km = wg.load_keymap(self.d)
        wg.run_rows(km)["effort"].update(effort or {})
        wg.save_keymap(self.d, km)
        with patch.object(wg, "fetch_nodes", return_value=self.issues(live)), \
             patch.object(wg, "pr_view", side_effect=lambda pr, fields, cwd=None: (prs or {})[pr]) as view, \
             patch.object(wg, "pr_checks", return_value=checks), \
             patch.object(wg, "project_entries", return_value=list(triage)):
            head, lines = wg.next_lines(self.d, self.p)
        for call in view.call_args_list:
            self.assertEqual((call.args[1], call.kwargs["cwd"]), (wg.PR_FIELDS, self.d))
        return head, [f"{level} {text}" for level, text in lines]

    def batch_lines(self, batch, live=None, rows=None, prs=None):
        """next_lines with a batch answer; pr_view answers only the PRs that the batch does not hold."""
        self.keymap(rows=rows or {})
        with patch.object(wg, "fetch_nodes", return_value=self.issues(live)), \
             patch.object(wg, "pr_batch", side_effect=batch) as read, \
             patch.object(wg, "pr_view", side_effect=lambda pr, fields, cwd=None: (prs or {})[pr]) as view, \
             patch.object(wg, "pr_checks", side_effect=AssertionError("pr_checks")) as checks, \
             patch.object(wg, "project_entries", return_value=[]), \
             contextlib.redirect_stderr(io.StringIO()) as err:
            _, lines = wg.next_lines(self.d, self.p)
        return [f"{level} {text}" for level, text in lines], read, view, checks, err.getvalue()

    def test_next_reads_every_pr_in_one_batch(self):
        rows = {"a": {"pr": "7", "code_done_head": SHA, "review": "clean", "merge_review": "clean"},
                "b": {"pr": "8"}}
        pr = {"state": "OPEN", "headRefOid": SHA, "isDraft": False, "mergeCommit": None, "mergeable": "MERGEABLE",
              "baseRefName": "main", "reviews": [], "comments": []}
        merged = dict(pr, state="MERGED", mergeCommit={"oid": OTHER})
        _, expected = self.lines(live={"a": "In Review", "b": "Merged"}, rows=rows, prs={"7": pr, "8": merged},
                                 checks=(False, "ci"))
        lines, read, view, checks, _ = self.batch_lines(
            lambda numbers, cwd=None: {"7": (pr, (False, "ci")), "8": (merged, (True, "no checks"))},
            live={"a": "In Review", "b": "Merged"}, rows=rows)
        self.assertEqual(sorted(read.call_args.args[0]), ["7", "8"])
        self.assertEqual(read.call_args.kwargs["cwd"], self.d)
        self.assertFalse(view.called)
        self.assertFalse(checks.called)
        self.assertIn("do verify a CD-1: #7: a check failed", lines)
        self.assertEqual(lines, expected)

    def test_a_pr_missing_from_the_batch_is_read_alone(self):
        rows = {"a": {"pr": "7"}}
        for live in ("In Review", "Merged"):
            with self.subTest(status=live):
                self.keymap(rows=rows)
                with patch.object(wg, "fetch_nodes", return_value=self.issues({"a": live})), \
                     patch.object(wg, "pr_batch", return_value={}), \
                     patch.object(wg, "pr_view", side_effect=wg.ReadError("no such PR")) as view, \
                     patch.object(wg, "project_entries", return_value=[]):
                    if live == "Merged":
                        with contextlib.redirect_stderr(io.StringIO()) as err:
                            wg.next_lines(self.d, self.p)
                        self.assertIn("warn next: a #7: no such PR", err.getvalue())
                    else:
                        with self.assertRaisesRegex(wg.ReadError, "no such PR"):
                            wg.next_lines(self.d, self.p)
                self.assertEqual(view.call_args.args[:2], ("7", wg.PR_FIELDS))

    def test_a_failed_batch_falls_back_to_one_read_for_each_pr(self):
        pr = {"state": "MERGED", "mergeCommit": {"oid": OTHER}}
        lines, _, view, _, err = self.batch_lines(wg.ReadError("rate limited"), live={"a": "Merged"},
                                                  rows={"a": {"pr": "7"}}, prs={"7": pr})
        self.assertTrue(view.called)
        self.assertIn("warn next: the request for all PRs failed, so each PR is read alone: rate limited", err)

    def test_merged_task_reconciles_only_when_its_pr_is_not_merged(self):
        rows = {"a": {"pr": "7"}, "b": {"pr": "8"}, "c": {"pr": "9"}}
        for state in ("OPEN", "CLOSED"):
            with self.subTest(state=state):
                _, lines = self.lines(live={"a": "Merged", "b": "Merged", "c": "Done"}, rows=rows,
                                      prs={"7": {"state": state}, "8": {"state": "MERGED"}})
                self.assertEqual([line for line in lines if line.startswith("do reconcile")],
                                 [f"do reconcile a CD-1: status Merged, but PR #7 is {state}"])

    def test_merged_pr_lookup_failure_does_not_stop_the_wait_loop(self):
        self.keymap(rows={"a": {"pr": "7"}})
        with patch.object(wg, "fetch_nodes", return_value=self.issues({"a": "Merged"})), \
             patch.object(wg, "pr_view", side_effect=wg.ReadError("gh unavailable")), \
             patch.object(wg, "project_entries", return_value=[]), \
             contextlib.redirect_stderr(io.StringIO()) as err, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(wg.next_command(self.d, self.p, True, 0.1), 0)
        self.assertIn("gh unavailable", err.getvalue())

    def test_invalid_pr_is_a_read_error_even_in_wait_mode(self):
        self.keymap(rows={"a": {"pr": "invalid"}})
        with patch.object(wg, "fetch_nodes", return_value=self.issues({"a": "Merged"})):
            with self.assertRaisesRegex(wg.ReadError, "invalid PR number"):
                wg.next_lines(self.d, self.p, tolerant=True)

    def test_wave_start_needs_the_wave_and_no_approval(self):
        head, lines = self.lines()
        self.assertEqual(head, "phase 1: 3 tasks, 0 code done, 0 reviewed, 0 merged")
        self.assertEqual(lines, ["do wave: pick the next wave from s,c"])
        head, lines = self.lines(effort={"wave": "s,c"})
        self.assertEqual(head, "phase 1: 3 tasks, 0 code done, 0 reviewed, 0 merged; wave s,c")
        self.assertEqual(lines, ["do dispatch s CD-6", "do dispatch c CD-5"])
        _, lines = self.lines(live={"s": "Done"}, effort={"wave": "s"})
        self.assertEqual(lines, ["do wave: pick the next wave from a,c"])

    def test_dispatch_lines_follow_the_worker_limit_and_no_first_pr_gate(self):
        first = {"branch": "wg/ex-one-00-a", "pr": "7", "code_done_head": SHA}
        pr = {"state": "OPEN", "headRefOid": SHA, "isDraft": True}
        live = {"a": "In Review", "s": "Done"}
        rows = {"a": first}
        # The first PR of the effort is in review; the second lane starts at once.
        _, lines = self.lines(live=live, rows=rows, prs={"7": pr}, effort={"wave": "a,c"})
        self.assertEqual(lines, ["do review a CD-1: #7 round 1", "do dispatch c CD-5"])
        self.keymap()
        km = wg.load_keymap(self.d)
        km["run"] = {"effort": {"wave": "a,c"},
                     "nodes": rows | {"b": {"state": "running"}, "mp": {"state": "starting"}}}
        wg.save_keymap(self.d, km)
        issues = self.issues(live | {"b": "In Progress"})
        with patch.object(wg, "fetch_nodes", return_value=issues), patch.object(wg, "pr_view", return_value=pr), \
             patch.object(wg, "project_entries", return_value=[]):
            lines = [text for _, text in wg.next_lines(self.d, self.p)[1]]
            self.assertIn("dispatch c CD-5", lines)
            km["run"]["nodes"]["ops"] = {"state": "creating"}
            wg.save_keymap(self.d, km)
            lines = [text for _, text in wg.next_lines(self.d, self.p)[1]]
            self.assertIn("dispatch c CD-5", lines)

    def test_a_push_after_code_done_holds_only_that_pr(self):
        lines = self.merge_stage(pr={"headRefOid": OTHER})
        self.assertEqual(lines, [f"do verify a CD-1: #7 head {OTHER[:10]} is not code done",
                                 "do undraft b CD-4: #8", "do undraft c CD-5: #9"])

    def test_adopt_and_integration_nodes_get_no_dispatch(self):
        self.p["nodes"][0]["branch"] = "wg/old"
        _, lines = self.lines(live={"s": "Done"}, effort={"wave": "a"})
        self.assertEqual(lines, ["do adopt a CD-1"])
        _, lines = self.lines(live={"s": "Done"}, rows={"a": {"branch": "wg/old"}})
        self.assertEqual(lines, ["do verify a CD-1: no pr in the run row", "do wave: pick the next wave from c"])

    def test_integration_node_is_the_coordinators_own_work(self):
        self.p["phases"][0]["target"] = "effort/ex"
        self.p["nodes"].append(node("int", role="integration", lane=None))
        self.p["edges"] += [edge("int", "mp"), edge("sp", "int")]
        self.assertEqual(wg.check(self.p), [])
        merged = {"a": "Merged", "b": "Merged", "c": "Merged", "s": "Done", "mp": "Done", "ops": "Done", "dec": "Done"}
        for status in ("Todo", "In Progress"):
            self.assertEqual(self.lines(live=merged | {"int": status})[1], ["do integration int CD-9"])
        self.assertEqual(self.lines(live=merged | {"mp": "Todo"})[1], ["do close mp CD-2"])

    def test_job_states_and_claims(self):
        cases = [
            ("In Progress", (), {"state": "running", "job": "dispatch", "dispatch": "d1"},
             "wait worker a CD-1: job=dispatch dispatch=d1"),
            ("In Progress", (), {"state": "creating"}, "do reconcile a CD-1: state=creating: no receipt of the job is recorded"),
            ("In Progress", (), {"state": "failed"}, "wait human a CD-1: state=failed"),
            ("In Progress", ["agent:codex"], {}, "do reconcile a CD-1: agent:codex with no job in the run row"),
            ("In Progress", (), {}, "do reconcile a CD-1: In Progress with no run row"),
            ("In Review", (), {}, "do reconcile a CD-1: In Review with no run row"),
            ("In Progress", (), {"branch": "wg/x"}, "do verify a CD-1: no pr in the run row"),
            ("Needs Human", (), {"pr": "7"}, "wait human a CD-1: a"),
            ("Scoping", (), {}, "do reconcile a CD-1: ENG status Scoping has no twin"),
        ]
        for status, labels, row, expected in cases:
            with self.subTest(expected=expected):
                _, lines = self.lines(live={"a": (status, labels), "s": "Done", "c": "Backlog"}, rows={"a": row})
                self.assertEqual(lines, [expected])

    def test_pr_steps_before_the_merge_point(self):
        done = {"pr": "7", "code_done_head": SHA}
        open_pr = {"state": "OPEN", "headRefOid": SHA, "isDraft": True}
        cases = [
            ({"pr": "7", "code_done_head": OTHER}, open_pr, f"do verify a CD-1: #7 head {SHA[:10]} is not code done"),
            (done, open_pr, "do review a CD-1: #7 round 1"),
            (done | {"review_round": "1"}, open_pr, "do review a CD-1: #7 round 2"),
            (done | {"review_round": "1", "review_dispatch": "r1"}, open_pr, "wait reviewer a CD-1: #7 round 1"),
            (done | {"review_round": "2"}, open_pr,
             "wait human a CD-1: #7: 2 review rounds had blocking findings; only this PR is held "
             "(label 'reviewed' accepts them, or ask for one more fix)"),
            # A reviewed PR goes on to its merge request; it does not wait for the other tasks of the phase.
            (done | {"review": "clean"}, open_pr, "do undraft a CD-1: #7"),
            (done, open_pr | {"isDraft": False}, "do merge-review a CD-1: #7: request the thorough review"),
            (done, {"state": "MERGED", "mergeCommit": {"oid": OTHER}}, f"do merged a CD-1: #7 {OTHER[:10]}"),
            (done, {"state": "CLOSED"}, "do closed a CD-1: #7"),
        ]
        for row, pr, expected in cases:
            with self.subTest(expected=expected):
                _, lines = self.lines(live={"a": "In Review", "s": "Done", "c": "Backlog", "b": "Backlog"},
                                      rows={"a": row}, prs={"7": pr})
                self.assertEqual(lines, [expected])

    def merge_stage(self, row=None, pr=None, live=None, rows=None, effort=None, checks=(True, "no checks")):
        reviewed = {"code_done_head": SHA, "review": "clean"}
        all_rows = {"a": {"pr": "7", "parent": "main"} | reviewed | (row or {}),
                    "b": {"pr": "8", "parent": "wg/ex-one-00-a"} | reviewed,
                    "c": {"pr": "9", "parent": "main"} | reviewed} | (rows or {})
        draft = {"state": "OPEN", "headRefOid": SHA, "isDraft": True, "baseRefName": "main"}
        prs = {"7": draft | (pr or {}), "8": draft, "9": draft}
        statuses = {"a": "In Review", "b": "In Review", "c": "In Review", "s": "Done"} | (live or {})
        return self.lines(live=statuses, rows=all_rows, prs=prs, effort=effort, checks=checks)[1]

    def test_merge_point_steps_for_one_pr(self):
        ready, reviews = {"isDraft": False}, {"reviews": [{}], "comments": []}
        cases = [
            ({}, {}, None, "do undraft a CD-1: #7"),
            ({}, {}, {"merge_prep": "human"}, "do ask-ready a CD-1: #7"),
            ({"draft": "yes"}, {}, None, "wait human a CD-1: mark PR #7 ready for review"),
            ({"draft": "yes"}, ready, None, "do merge-review a CD-1: #7: request the thorough review"),
            ({"merge_review": "requested", "merge_review_seen": "1"}, ready | reviews, None,
             "wait review a CD-1: #7: the thorough review is requested"),
            ({"merge_review": "requested", "merge_review_seen": "0"}, ready | reviews, None,
             "do merge-review a CD-1: #7: read the new review"),
            ({"merge_review": "clean"}, ready, None, "do ask-merge a CD-1: #7"),
            ({"merge_review": "accepted"}, ready | {"mergeable": "CONFLICTING", "baseRefName": "main"}, None,
             "do restack a CD-1: #7 conflicts with main"),
        ]
        for row, pr, effort, expected in cases:
            with self.subTest(expected=expected):
                lines = self.merge_stage(row, pr, effort=effort)
                self.assertIn(expected, lines)
                self.assertEqual(len(lines), 3)
        lines = self.merge_stage({"merge_review": "clean"}, ready, live={"a": "Ready to Merge"})
        self.assertIn("wait human a CD-1: merge PR #7", lines)

    def test_verified_head_of_the_old_flow_counts_as_the_merge_review(self):
        ready = {"isDraft": False}
        self.assertIn("do ask-merge a CD-1: #7", self.merge_stage({"verified_head": SHA}, ready))
        self.assertIn("do merge-review a CD-1: #7: request the thorough review", self.merge_stage({"verified_head": OTHER}, ready))

    def test_ask_merge_uses_the_checks_of_the_move_guard(self):
        ready, reviewed = {"isDraft": False}, {"merge_review": "clean"}
        for status in ("In Review", "Ready to Merge"):
            with self.subTest(status=status):
                lines = self.merge_stage(reviewed, ready, live={"a": status}, checks=(False, "lint"))
                self.assertIn("do verify a CD-1: #7: a check failed", lines)
                lines = self.merge_stage(reviewed, ready | {"baseRefName": "wg/old"}, live={"a": status})
                self.assertIn("do restack a CD-1: #7: its base is wg/old, not main", lines)

    def test_a_push_on_the_node_below_holds_the_node_above(self):
        rows = {"a": {"branch": "wg/ex-one-00-a", "pr": "7", "code_done_head": SHA, "review": "clean"}}
        pr = {"state": "OPEN", "headRefOid": SHA, "isDraft": True}
        effort = {"wave": "a,b"}
        live = {"a": "In Review", "s": "Done", "c": "Backlog"}
        self.assertEqual(self.lines(live=live, rows=rows, prs={"7": pr}, effort=effort)[1],
                         ["do undraft a CD-1: #7", "do dispatch b CD-4"])
        self.assertEqual(self.lines(live=live, rows=rows, prs={"7": pr | {"headRefOid": OTHER}}, effort=effort)[1],
                         [f"do verify a CD-1: #7 head {OTHER[:10]} is not code done",
                          "wait below b CD-4: a has a push that is not code done"])

    def test_the_first_pr_gate_opens_when_human_merged_that_pr(self):
        rows = {"a": {"branch": "wg/ex-one-00-a", "pr": "7"}, "c": {"approved": "2026-11-19: ok"}}
        _, lines = self.lines(live={"a": "Merged", "s": "Done"}, rows=rows, effort={"wave": "c"},
                              prs={"7": {"state": "MERGED"}})
        self.assertEqual(lines, ["do dispatch c CD-5"])

    def test_a_reviewed_draft_is_undrafted_by_the_coordinator_unless_human_kept_it(self):
        rows = {"a": {"branch": "wg/ex-one-00-a", "pr": "7", "code_done_head": SHA, "review": "clean"}}
        pr = {"state": "OPEN", "headRefOid": SHA, "isDraft": True}
        _, lines = self.lines(live={"a": "In Review", "s": "Done", "b": "Canceled", "c": "Canceled"}, rows=rows, prs={"7": pr})
        self.assertEqual(lines, ["do undraft a CD-1: #7"])
        _, lines = self.lines(live={"a": "In Review", "s": "Done", "b": "Canceled", "c": "Canceled"}, rows=rows, prs={"7": pr},
                              effort={"merge_prep": "human"})
        self.assertEqual(lines, ["do ask-ready a CD-1: #7"])

    def test_milestone_lines_use_the_checks_of_the_move_guard(self):
        self.p["edges"].remove(edge("mp", "a"))
        self.assertEqual(wg.check(self.p), [])
        live = {"a": ("In Review", ()), "b": "Merged", "c": "Merged", "s": "Done"}
        _, lines = self.lines(live=live)
        self.assertEqual(lines, ["do reconcile a CD-1: In Review with no run row"])
        shipped = {"a": "In Review", "b": "Merged", "c": "Merged", "s": "Done", "mp": "Done", "ops": "Done",
                   "dec": "Done", "sp": "Verifying"}
        _, lines = self.lines(live=shipped, rows={"sp": {"soak_until": "2020-01-01T00:00:00Z"}})
        self.assertIn("wait blockers sp CD-3: a opened again", lines)
        self.assertNotIn("do ship sp CD-3: the soak passed at 2020-01-01T00:00:00Z", lines)

    def test_the_reviewed_label_skips_the_wave_review_and_the_merge_review(self):
        marked = {"a": ("In Review", ["reviewed"])}
        lines = self.merge_stage({"review": ""}, live=marked)
        self.assertEqual(lines[0], "do undraft a CD-1: #7")
        lines = self.merge_stage({"review": "", "review_round": "2"}, {"isDraft": False}, live=marked)
        self.assertEqual(lines[0], "do ask-merge a CD-1: #7")

    def test_a_held_pr_does_not_hold_the_rest_of_the_phase(self):
        lines = self.merge_stage({"review": "", "review_round": "2"})
        self.assertEqual(lines, ["do undraft b CD-4: #8", "do undraft c CD-5: #9",
                                 "wait human a CD-1: #7: 2 review rounds had blocking findings; only this PR is held "
                                 "(label 'reviewed' accepts them, or ask for one more fix)"])

    def test_a_fix_after_a_thorough_review_gets_a_fix_check_not_another_thorough_review(self):
        lines = self.merge_stage({"thorough_head": OTHER, "thorough_count": "1"}, {"isDraft": False})
        self.assertIn(f"do merge-review a CD-1: #7: check the fix since {OTHER[:10]}, no new thorough review", lines)
        lines = self.merge_stage({"thorough_head": OTHER, "merge_review": "requested", "merge_review_seen": "0"},
                                 {"isDraft": False, "reviews": [{}], "comments": []})
        self.assertIn("do merge-review a CD-1: #7: read the new review", lines)

    def test_a_new_patch_at_the_merge_point_needs_only_the_merge_review_again(self):
        lines = self.merge_stage({"review": ""}, {"isDraft": False})
        self.assertEqual(lines, ["do merge-review a CD-1: #7: request the thorough review",
                                 "do undraft b CD-4: #8", "do undraft c CD-5: #9"])
        lines = self.merge_stage({"review": ""}, {"isDraft": True})
        self.assertEqual(lines, ["do review a CD-1: #7 round 1", "do undraft b CD-4: #8", "do undraft c CD-5: #9"])

    def test_lane_order_restack_and_close_at_the_merge_point(self):
        ready = {"state": "OPEN", "headRefOid": SHA, "isDraft": False, "baseRefName": "main"}
        above = {"pr": "8", "code_done_head": SHA, "review": "clean", "merge_review": "clean"}
        lines = self.merge_stage(rows={"b": above | {"parent": "wg/ex-one-00-a"}})
        self.assertIn("do undraft b CD-4: #8", lines)
        self.keymap()
        base = {"a": {"pr": "7", "code_done_head": SHA, "review": "clean", "parent": "main"},
                "c": {"pr": "9", "code_done_head": SHA, "review": "clean", "parent": "main"}}
        prs = {"7": ready, "8": ready, "9": ready | {"isDraft": True}}
        live = {"a": "In Review", "b": "In Review", "c": "In Review", "s": "Done"}
        _, lines = self.lines(live=live, rows=base | {"b": above | {"parent": "wg/ex-one-00-a"}}, prs=prs)
        self.assertIn("wait below b CD-4: #8 is ready; a merges first", lines)
        merged = live | {"a": "Merged"}
        prs["7"] = {"state": "MERGED"}
        _, lines = self.lines(live=merged, rows=base | {"b": above | {"parent": "wg/ex-one-00-a"}}, prs=prs)
        self.assertIn("do restack b CD-4: #8: the PR below it merged", lines)
        _, lines = self.lines(live=merged, rows=base | {"b": above | {"parent": "main"}}, prs=prs)
        self.assertIn("do ask-merge b CD-4: #8", lines)
        head, lines = self.lines(live={"a": "Merged", "b": "Done", "c": "Merged", "s": "Done"},
                                 rows=base, prs={"7": {"state": "MERGED"}, "9": {"state": "MERGED"}})
        self.assertEqual(lines, ["do close mp CD-2"])
        self.assertEqual(head, "phase 1: 3 tasks, 3 code done, 3 reviewed, 3 merged")

    def test_ops_decision_soak_and_ship_point(self):
        merged = {"a": "Merged", "b": "Merged", "c": "Merged", "s": "Done", "mp": "Done"}
        self.assertEqual(self.lines(live=merged)[1], ["do ask ops CD-7: ops"])
        self.assertEqual(self.lines(live=merged | {"ops": "Needs Human"})[1], ["wait human ops CD-7: ops"])
        self.assertEqual(self.lines(live=merged | {"ops": "Done"})[1], ["do ask dec CD-8: dec"])
        shipped = merged | {"ops": "Done", "dec": "Done"}
        self.assertEqual(self.lines(live=shipped)[1], ["do verifying sp CD-3"])
        verifying = shipped | {"sp": "Verifying"}
        self.assertEqual(self.lines(live=verifying)[1],
                         ["wait human sp CD-3: no soak_until: when did the 24h soak start?"])
        self.assertEqual(self.lines(live=verifying, rows={"sp": {"soak_until": "2999-01-01T00:00:00Z"}})[1],
                         ["wait soak sp CD-3: until 2999-01-01T00:00:00Z"])
        self.assertEqual(self.lines(live=verifying, rows={"sp": {"soak_until": "2020-01-01T00:00:00Z"}})[1],
                         ["do ship sp CD-3: the soak passed at 2020-01-01T00:00:00Z"])
        reopened = self.lines(live=verifying | {"dec": "Needs Human"}, rows={"sp": {"soak_until": "2020-01-01T00:00:00Z"}})[1]
        self.assertEqual(reopened, ["wait human dec CD-8: dec", "wait blockers sp CD-3: dec opened again"])
        self.p["phases"][0].pop("soak")
        self.assertEqual(self.lines(live=verifying)[1], ["do ship sp CD-3"])
        # a merged PR: the phase needs its repo-wide test run, from the Done merge point on
        rows, prs = {"a": {"pr": "7"}}, {"7": {"state": "MERGED", "mergeCommit": {"oid": SHA}}}
        due = f"do full-suite sp CD-3: no repo-wide test run of phase 1; in a clean worktree at origin/main: "
        for live in (merged, shipped, verifying):
            with self.subTest(live=live):
                self.assertTrue(self.lines(live=live, rows=rows, prs=prs)[1][-1].startswith(due))
        self.assertNotIn("full-suite", " ".join(self.lines(live=merged | {"mp": "Ready"}, rows=rows, prs=prs)[1]))
        wg.evidence_path(self.d, "@full-1").parent.mkdir(exist_ok=True)
        wg.save_json(wg.evidence_path(self.d, "@full-1"), {"sha": OTHER, "valid": True, "exit": 0, "command": wg.DEFAULT_TEST})
        with patch.object(wg, "command", return_value=subprocess.CompletedProcess([], 0, "", "")):
            self.assertEqual(self.lines(live=verifying, rows=rows, prs=prs)[1], ["do ship sp CD-3"])
        self.assertEqual(self.lines(live=shipped | {"sp": "Done"}), ("every ship point is Done or Canceled", []))

    def test_ops_node_run_by_the_coordinator_is_not_humans_move(self):
        merged = {"a": "Merged", "b": "Merged", "c": "Merged", "s": "Done", "mp": "Done"}
        next(n for n in self.p["nodes"] if n["key"] == "ops")["by"] = "coordinator"
        self.assertEqual(self.lines(live=merged)[1], ["do ops ops CD-7: ops"])
        self.assertEqual(self.lines(live=merged | {"ops": "In Progress"})[1], ["wait coordinator ops CD-7: ops"])
        inputs = (wg.load_keymap(self.d), {}, {n["key"]: n for n in self.p["nodes"]}, {"ops": "Ready"}, {}, {})
        inputs[0]["nodes"]["ops"] = {"id": "o", "identifier": "CD-7"}
        self.assertEqual(wg.tick_members(inputs, [("do", "ops ops CD-7: ops")], {}), {})

    def test_by_is_only_for_ops_nodes_with_a_known_runner(self):
        for kind, by in (("task", "coordinator"), ("ops", "worker")):
            with self.subTest(kind=kind, by=by):
                plan = copy.deepcopy(self.p)
                node = next(n for n in plan["nodes"] if n["kind"] == kind)
                node["by"] = by
                self.assertTrue(any("by " in e for e in wg.check(plan)), wg.check(plan))

    def test_triage_at_autonomy_full_is_the_coordinators_move(self):
        triage = [{"id": "x", "identifier": "CD-90", "title": "Found work", "state": {"name": "Triage"}}]
        counted = {}
        self.keymap()
        km = wg.load_keymap(self.d)
        wg.run_rows(km)["effort"]["autonomy_seen"] = "full"
        wg.save_keymap(self.d, km)
        with patch.object(wg, "fetch_nodes", return_value=self.issues({"s": "Done", "a": "Backlog", "c": "Backlog"})), \
             patch.object(wg, "project_entries", return_value=triage):
            _, lines = wg.next_lines(self.d, self.p, triage=counted)
        self.assertEqual(lines, [("do", "triage CD-90: Found work")])
        self.assertEqual(counted, {})

    def test_triage_issue_of_the_project_is_a_note(self):
        triage = [{"id": "x", "identifier": "CD-90", "title": "Found work", "state": {"name": "Triage"}},
                  {"id": "a", "identifier": "CD-1", "title": "a", "state": {"name": "Triage"}},
                  {"id": "y", "identifier": "CD-91", "title": "Other", "state": {"name": "Todo"}}]
        _, lines = self.lines(live={"s": "Done", "a": "Backlog", "c": "Backlog"}, triage=triage)
        self.assertEqual(lines, ["note triage CD-90: Found work"])

    def wait(self, fetch, prs, code=0):
        self.keymap(rows={"a": {"pr": "7"}, "c": {"pr": "9"}})
        with patch.object(wg, "fetch_nodes", side_effect=fetch), patch.object(wg, "pr_view", side_effect=prs), \
             patch.object(wg, "project_entries", return_value=[]), patch.object(wg.time, "sleep") as sleep:
            out, err = self.call(wg.next_command, self.d, self.p, True, 1, code=code)
        return out, err, sleep

    def test_wait_returns_when_there_is_something_to_do(self):
        quiet = self.issues({"a": "Needs Human", "c": "Needs Human", "s": "Done"})
        moved = self.issues({"a": "In Review", "c": "Needs Human", "s": "Done"})
        out, err, sleep = self.wait([quiet, wg.ReadError("unavailable"), moved], [{"state": "CLOSED"}])
        self.assertEqual(out.splitlines()[1:], ["do closed a CD-1: #7", "wait human c CD-5: c", f"note page {wg.page_link(self.p)}"])
        self.assertIn("warn next: unavailable", err)
        self.assertEqual(sleep.call_count, 2)

    def test_wait_returns_when_the_effort_is_complete(self):
        done = self.issues({n["key"]: "Done" for n in self.p["nodes"]})
        out, _, sleep = self.wait([done], [])
        self.assertEqual(out, "every ship point is Done or Canceled\n")
        sleep.assert_not_called()

    def test_wait_keeps_an_action_when_another_pr_is_not_read(self):
        live = self.issues({"a": "In Review", "c": "In Review", "s": "Done"})
        out, err, sleep = self.wait([live], [wg.ReadError("failed"), {"state": "CLOSED"}])
        self.assertEqual(out.splitlines()[1:], ["do closed c CD-5: #9", f"note page {wg.page_link(self.p)}"])
        self.assertIn("warn next: a #7: failed", err)
        sleep.assert_not_called()

    def test_next_rejects_an_invalid_soak_time_and_a_failed_read_without_wait(self):
        self.keymap(rows={"sp": {"soak_until": "tomorrow"}})
        with patch.object(wg, "fetch_nodes", return_value=self.issues({})), patch.object(wg.time, "sleep") as sleep:
            _, err = self.call(wg.next_command, self.d, self.p, True, 1, code=2)
            self.assertIn("sp: invalid soak_until 'tomorrow'", err)
            sleep.assert_not_called()
        self.keymap(rows={"a": {"pr": "7"}})
        with patch.object(wg, "fetch_nodes", return_value=self.issues({"a": "In Review", "s": "Done"})), \
             patch.object(wg, "pr_view", side_effect=wg.ReadError("gh failed")):
            with self.assertRaises(wg.ReadError):
                wg.next_lines(self.d, self.p)



STATES = {"team": {"states": {"nodes": [{"name": name, "id": name} for name in sorted(wg.CD_STATUSES)]}}}
BRANCH = {"branch": "wg/ex-one-00-a", "parent": "main", "lower": "origin/main"}


class JobTests(LaneTests):
    def job(self, fn, *args, live=None, rows=None, effort=None, code=0, linear=None, update=None, comments=None):
        self.keymap(rows=rows or {})
        km = wg.load_keymap(self.d)
        wg.run_rows(km)["effort"].update(effort or {})
        wg.save_keymap(self.d, km)
        labels = {"agent:codex": "L-codex", "agent:claude": "L-claude"}
        with patch.object(wg, "fetch_nodes", return_value=self.issues(live)), \
             patch.object(wg, "issue_update", side_effect=update) as self.update, \
             patch.object(wg, "comment", side_effect=comments) as self.comment, \
             patch.object(wg, "sync_card", return_value=False), patch.object(wg, "sync_ready"), \
             patch.object(wg, "workspace_labels", return_value=labels), patch.object(wg, "gql", return_value=STATES, side_effect=linear), \
             patch.object(wg, "start_project"):
            out, err = self.call(fn, self.d, self.p, *args, code=code)
        self.updates = [call.args for call in self.update.call_args_list]
        self.row = lambda key: wg.run_row(wg.load_keymap(self.d), key)
        self.effort = wg.run_row(wg.load_keymap(self.d), "@effort")
        return out, err

    def test_dispatch_refuses_each_missing_condition(self):
        ok = dict(live={"s": "Done"}, rows={"a": {"approved": "x"}}, effort={"wave": "a"})
        cases = [
            (ok | {"effort": {"wave": "c"}}, "a: not in the wave"),
            (ok | {"live": {}}, "a: open blockers: s"),
            (ok | {"live": {"s": "Done", "a": "In Progress"}}, "a: the status is In Progress, not Todo or Ready"),
            (ok | {"rows": {"a": {"approved": "x", "branch": "wg/old"}}}, "a: the run row has state=- branch=wg/old"),
        ]
        for arguments, message in cases:
            with self.subTest(message=message):
                out, err = self.job(wg.dispatch, "a", "codex", None, code=1, **arguments)
                self.assertIn(f"FAIL {message}", out)
                self.assertIn("CD-1: not dispatched", err)
                self.update.assert_not_called()
        _, err = self.job(wg.dispatch, "a", "codex", None, code=1, **(ok | {"live": {"s": "Done", "a": ("Todo", ["agent:claude"])}}))
        self.assertIn("CD-1: agent:claude holds the claim", err)
        self.p["nodes"][0]["pr"] = "7"
        out, _ = self.job(wg.dispatch, "a", "codex", None, code=1, **ok)
        self.assertIn("FAIL a: its branch or PR exists: adopt it", out)
        for key, message in (("mp", "only a task or a spike gets a worker"), ("zz", "unknown key zz")):
            _, err = self.job(wg.dispatch, key, "codex", None, code=2, **ok)
            self.assertIn(message, err)

    def test_dispatch_claims_and_prints_the_orca_commands_with_every_name(self):
        out, _ = self.job(wg.dispatch, "a", "codex", None, live={"s": "Done"},
                          rows={"a": {"approved": "x"}}, effort={"wave": "a"})
        self.assertEqual(self.updates, [("a", {"addedLabelIds": ["L-codex"]}), ("a", {"stateId": "In Progress"})])
        self.assertEqual(self.row("a"), {"approved": "x", "state": "creating", "job": "dispatch", "agent": "codex"} | BRANCH)
        here = wg.shlex.quote(str(self.d.resolve()))
        for text in ("claimed CD-1 agent:codex\n", "branch wg/ex-one-00-a on origin/main, stax parent main\n",
                     "  orca worktree list --json    # find the parent worktree ex-one and the coordinator ex-core\n",
                     "  orca worktree create --name ex-one --branch wg/ex-one --parent-worktree id:<core-id> "
                     "--base-branch origin/main --setup skip --json    # only when ex-one is missing\n",
                     "  orca worktree create --name ex-one-00-a --branch wg/ex-one-00-a --base-branch origin/main "
                     "--parent-worktree id:<parent-id> --setup run --json\n",
                     "  orca worktree set --worktree id:<child-id> --display-name '00 a' --json\n",
                     '  (cd "<child-path>" && st branch track --parent main)\n',
                     f' dispatch {here} a --worktree "<child-path>"\n'):
            self.assertIn(text, out)
        again, _ = self.job(wg.dispatch, "a", "claude", None, live={"s": "Done", "a": "In Progress"}, rows={"a": self.row("a")})
        self.update.assert_not_called()
        self.assertEqual(again, out.split("\n", 2)[2])

    def test_dispatch_stacks_on_the_node_below_and_names_a_spike(self):
        rows = {"a": BRANCH | {"code_done_head": SHA}}  # code done, not reviewed yet: b stacks on it now
        effort = {"wave": "b"}
        out, _ = self.job(wg.dispatch, "b", "claude", None, live={"a": "In Review", "s": "Done"}, rows=rows, effort=effort)
        self.assertIn("branch wg/ex-one-01-b on wg/ex-one-00-a, stax parent wg/ex-one-00-a\n", out)
        self.assertIn("--name ex-one-01-b --branch wg/ex-one-01-b --base-branch wg/ex-one-00-a ", out)
        self.assertIn("--base-branch origin/main --setup skip", out)
        self.assertEqual(self.updates[0], ("b", {"addedLabelIds": ["L-claude"]}))
        out, _ = self.job(wg.dispatch, "b", "codex", None, live={"a": "Merged", "s": "Done"}, rows=rows, effort=effort)
        self.assertIn("branch wg/ex-one-01-b on origin/main, stax parent main\n", out)
        claimed = rows | {"b": self.row("b")}
        self.job(wg.dispatch, "b", "codex", None, live={"a": "In Review", "b": "In Progress", "s": "Done"}, rows=rows, effort=effort,
                 code=1)
        claimed["b"] |= {"parent": "wg/ex-one-00-a", "lower": "wg/ex-one-00-a"}
        for below in ("Merged", "Canceled"):
            out, _ = self.job(wg.dispatch, "b", "codex", None, live={"a": below, "b": "In Progress", "s": "Done"},
                              rows=claimed, effort=effort)
            self.assertIn("branch wg/ex-one-01-b on wg/ex-one-00-a, stax parent wg/ex-one-00-a\n", out)
            self.assertIn("--base-branch wg/ex-one-00-a --parent-worktree", out)

    def test_dispatch_and_claim_hold_a_node_above_an_unchecked_push_and_no_approval_gate(self):
        rows = {"a": BRANCH | {"review": "clean", "pr": "7", "code_done_head": SHA}, "b": {"approved": "x"}}
        effort = {"wave": "b", "first_pr": "2026-11-19: #7: ok"}
        with patch.object(wg, "pr_view", return_value={"headRefOid": OTHER}):
            out, _ = self.job(wg.dispatch, "b", "codex", None, live={"a": "In Review", "s": "Done"}, rows=rows, effort=effort,
                              code=1)
        self.assertIn("FAIL b: a below it has a push that is not code done (wg done)", out)
        adopted = {"a": BRANCH | {"pr": "7"}, "c": {"branch": "wg/ex-two-00-c", "parent": "main", "lower": "origin/main",
                                                     "approved": "x"}}
        # A second task starts while the first PR of the effort is still open and unreviewed.
        self.job(wg.claim, "c", "dispatch", "codex", live={"a": "In Review", "c": "In Progress", "s": "Done"}, rows=adopted)
        out, _ = self.job(wg.dispatch, "s", "codex", None, rows={"s": {"approved": "x"}}, effort={"wave": "s"})
        self.assertIn("branch wg/ex-spike-s on origin/main, not tracked by stax\n", out)
        self.assertIn("# find the parent worktree ex-core\n", out)
        self.assertNotIn("--no-parent", out)
        self.assertNotIn("<core-id>", out)
        self.assertNotIn("st branch track", out)
        _, err = self.job(wg.dispatch, "b", "codex", None, code=1, live={"a": "Canceled", "s": "Done"}, rows=rows, effort=effort)
        self.assertIn("b: a below it in the lane is Canceled", err)

    def test_release_phase_branch_names(self):
        p = plan("release")
        p["effort"]["slug"] = "z"
        p["nodes"][0].update(role="hotfix", lane="fix")
        p["nodes"].append(node("sync1", role="sync", lane="sync"))
        p["edges"] += [edge("sync1", "mp"), edge("sp", "sync1")]
        self.assertEqual(wg.check(p), [])
        nodes = {n["key"]: n for n in p["nodes"]}
        deps = {"a": [], "sync1": ["mp"]}
        fix = wg.branch_plan(p, "a", nodes, deps, {}, {})
        self.assertEqual((fix["branch"], fix["lower"], fix["parent"], fix["stax"], fix["child"]),
                         ("hotfix/z-a", "origin/release", "release", False, "z-fix-00-a"))
        sync = wg.branch_plan(p, "sync1", nodes, deps, {}, {})
        self.assertEqual((sync["branch"], sync["lower"], sync["parent"], sync["stack"], sync["child"]),
                         ("sync/z-p1", "origin/main", "main", "z-p1-sync", "z-p1-sync-00-sync"))

    def worktree(self, *, branch="wg/ex-one-00-a", dirty="", ancestor=True, parent="main", effort=None, code=0,
                 linear=None):
        rows = {"a": BRANCH | {"state": "creating", "job": "dispatch", "agent": "claude"}}
        (self.d / "specs" / "a.md").unlink(missing_ok=True)
        values = {("branch", "--show-current"): branch, ("rev-parse", "HEAD"): SHA, ("status", "--porcelain"): dirty,
                  ("rev-parse", "--git-common-dir"): "/repo/.git"}
        with patch.object(wg, "git_output", side_effect=lambda *args, cwd=None: values[args]), \
             patch.object(wg, "command", return_value=subprocess.CompletedProcess([], 0 if ancestor else 1, "", "")), \
             patch.object(wg, "branch_metadata", return_value={"parentBranchName": parent} if parent else None):
            return self.job(wg.dispatch, "a", "codex", str(self.d / "child"), live={"a": "In Progress", "s": "Done"},
                            rows=rows, effort={"wave": "a"} | (effort or {}), code=code, linear=linear)

    def test_dispatch_checks_the_new_worktree_before_it_writes_the_spec(self):
        cases = [
            (dict(branch="wg/ex-one-00-a-2"), "a: the worktree is on wg/ex-one-00-a-2, not wg/ex-one-00-a"),
            (dict(branch=""), "a: the worktree is on a detached HEAD, not wg/ex-one-00-a"),
            (dict(ancestor=False), "a: HEAD does not contain origin/main"),
            (dict(dirty="T  .husky/post-checkout"), "a: the new worktree is not clean: .husky/post-checkout"),
            (dict(parent=None), "a: stax does not track wg/ex-one-00-a on main"),
        ]
        for arguments, message in cases:
            with self.subTest(message=message):
                out, err = self.worktree(code=1, **arguments)
                self.assertIn(f"FAIL {message}", out)
                self.assertIn("CD-1: no worker spec", err)
                self.assertEqual(self.row("a")["state"], "creating")
                self.assertFalse((self.d / "specs" / "a.md").exists())

    def test_dispatch_writes_the_spec_and_prints_the_worker_start(self):
        out, _ = self.worktree(effort={"baseline": f"{OTHER[:10]}: frontend:test"})
        self.assertEqual(self.effort["baseline"], f"{OTHER[:10]}: frontend:test")  # the coordinator's field stays
        spec = self.d.resolve() / "specs" / "a.md"
        self.assertIn(f"spec {wg.shlex.quote(str(spec))}\n", out)
        self.assertIn(f"--task-title 'CD-1: a' --worktree id:<child-id> --agent claude --json\n", out)
        self.assertIn(" a dispatch=<dispatch_id> task=<task_id> worktree=<worktree id> run_id=<run_id>\n", out)
        self.assertEqual((self.row("a")["state"], self.row("a")["path"]), ("starting", str((self.d / "child").resolve())))
        text = spec.read_text()
        for part in ("Linear issue `CD-1`", "node `a`", "branch `wg/ex-one-00-a`", "diff base `origin/main`",
                     "st branch submit --draft --no-restack", f"evidence {wg.shlex.quote(str(self.d.resolve()))} a`",
                     f"base {wg.shlex.quote(str(self.d.resolve()))}`. It fast-forwards",
                     "in project `Example`"):
            self.assertIn(part, text)
        self.assertNotRegex(text, r"\{[a-z_]+\}")
        self.assertNotIn("HOTFIX", text)
        _, err = self.job(wg.dispatch, "a", "codex", "child", code=1, rows={"a": BRANCH})
        self.assertIn("a: run 'wg dispatch", err)

    def test_the_dispatch_spec_holds_the_design_the_node_card_and_the_rules(self):
        reads = []

        def linear(query, variables=None):
            if "description" not in query:
                return STATES
            reads.append(variables["id"])
            return {"issue": {"description": "Do {this} first.\n\n+++ Agent notes\n\nwork-graph node `a`\n\n+++"}}

        self.p["nodes"][0]["acceptance"] = "The spec has a design."
        self.worktree(linear=linear)
        text = (self.d / "specs" / "a.md").read_text()
        first, rest = text.split("\n", 1)
        self.assertRegex(first, r"^Written by `wg dispatch` at \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ: a copy of Linear "
                                r"issue `CD-1` and of the node `a` of plan\.json\. The issue stays the record\.$")
        self.assertEqual(reads, ["a"])  # one read, for this issue only
        self.assertIn("\n\n## Design\n\nDo {this} first.\n\n## Node card\n\n**Acceptance**\n\nThe spec has a design."
                      "\n\n**Files**\n\n- owns `a/*`\n- shares `shared` (additive only)\n", rest)
        self.assertNotIn("Agent notes", text)
        self.assertNotIn("\n\n## Repository rules", text)
        self.assertIn(f"2. Your dispatch spec {wg.shlex.quote(str(self.d.resolve() / 'specs' / 'a.md'))} holds the design",
                      text)
        self.assertNotIn("get_issue", text)
        self.assertNotIn("moon run", text)  # no lint command in the config or the plan: no lint step
        self.assertIn("in this order: with a clean tree, `", text)

        self.p["effort"] |= {"lint": ["moon", "run", ":lint", "--base", "{lower}"], "rules": "Run no moon.\n"}
        self.worktree(linear=linear)
        text = (self.d / "specs" / "a.md").read_text()
        self.assertIn("in this order: one lint of what your diff affects, `moon run :lint --base origin/main`; "
                      "commit, also what the lint fixed; then, with a clean tree, `", text)
        self.assertTrue(text.endswith("\n\n## Repository rules\n\nRun no moon.\n"))

    def test_the_lint_step_comes_from_the_plan_or_the_config(self):
        runner = wg.TEST_RUNNER | {"lint": ["lint", "--base={lower}"]}
        with patch.object(wg, "TEST_RUNNER", runner):
            self.assertIn("`lint --base=wg/x`", wg.lint_step({"effort": {}}, "wg/x"))
            self.assertEqual(wg.lint_step({"effort": {"test": ["pnpm", "test"]}}, "wg/x"), "")  # another repository
            self.assertEqual(wg.lint_step({"effort": {"lint": []}}, "wg/x"), "")
            self.assertIn("`ruff check`", wg.lint_step({"effort": {"lint": ["ruff", "check"], "test": ["t"]}}, "wg/x"))
        self.assertEqual(wg.lint_step({"effort": {}}, "wg/x"), "")
        _, err = self.call(wg.lint_step, {"effort": {"lint": "moon run"}}, "wg/x", code=2)
        self.assertIn("the lint command must be a list of strings", err)

    def test_check_takes_the_lint_and_the_rules_of_the_effort(self):
        p = plan()
        p["effort"] |= {"lint": ["moon", "run", ":lint"], "rules": "Run no moon."}
        self.assertEqual(wg.check(p), [])
        p["effort"] |= {"lint": "moon run :lint", "rules": ["Run no moon."]}
        self.assertEqual([e for e in wg.check(p) if e.startswith("effort.")],
                         ["effort.lint: a list of strings", "effort.rules: a text"])

    def test_render_stops_on_a_name_with_no_value(self):
        _, err = self.call(wg.render, "a {key} and {other_name}", {"key": "k"}, code=2)
        self.assertIn("worker-spec.md: no value for {other_name}", err)
        sections = wg.spec_sections()
        self.assertEqual(set(sections), {"task", "submit lane", "submit hotfix", "submit sync", "spike", "job"})

    def test_claim_starts_a_follow_up_job_on_the_same_dispatch(self):
        row = BRANCH | {"pr": "7", "dispatch": "d1", "review_dispatch": "r1", "review_patch": "p1"}
        out, _ = self.job(wg.claim, "a", "review", "codex", live={"a": "In Review", "s": "Done"}, rows={"a": row})
        self.assertEqual(self.updates, [("a", {"addedLabelIds": ["L-codex"]})])
        self.assertEqual(self.row("a"), BRANCH | {"pr": "7", "dispatch": "d1", "state": "starting", "job": "review", "agent": "codex"})
        spec = self.d.resolve() / "specs" / "a-review.md"
        self.assertIn("claimed CD-1 agent:codex for job review\n", out)
        self.assertIn(f"  orca orchestration send --to dispatch:d1 --subject 'review: #7' --body \"$(cat {wg.shlex.quote(str(spec))})\"\n", out)
        self.assertIn(" a dispatch=<dispatch_id> task=<task_id>\n", out)
        text = spec.read_text()
        self.assertTrue(text.startswith("**Job `review`:** Linear issue `CD-1`, node `a`."))
        self.assertIn("PR #7", text)
        self.assertNotIn("**Task:**", text)
        for part in ("## Design", "## Node card", "## Repository rules", "Written by"):
            self.assertNotIn(part, text)  # a job spec is one header and the work

    def test_claim_gives_a_new_worker_the_task_contract_and_pins_a_restack(self):
        with patch.object(wg, "restack_line", return_value="target main at abc; base: frozen; parent merged: yes"):
            out, _ = self.job(wg.claim, "a", "restack", "claude", live={"a": "In Review", "s": "Done"},
                              rows={"a": BRANCH | {"pr": "7"}})
        self.assertIn("target main at abc; base: frozen; parent merged: yes\n", out)
        self.assertIn("orca orchestration worker-start --spec-file ", out)
        self.assertIn("--task-title 'CD-1: a' --worktree id:<child-id> --agent claude --json\n", out)
        self.assertIn(" a dispatch=<dispatch_id> task=<task_id> worktree=<worktree id> run_id=<run_id>\n", out)
        text = (self.d / "specs" / "a-restack.md").read_text()
        self.assertTrue(text.startswith("**Task:** Linear issue `CD-1`"))
        self.assertIn("Restack: `target main at abc; base: frozen; parent merged: yes`.", text)
        self.assertNotRegex(text, r"\{[a-z_]+\}")

    def test_claim_dispatch_continues_a_failed_first_job_on_the_same_dispatch(self):
        row = BRANCH | {"dispatch": "d1", "state": "failed", "job": "dispatch", "started_at": "2026-01-01T00:00:00Z"}
        out, _ = self.job(wg.claim, "a", "dispatch", "codex", live={"a": "In Progress", "s": "Done"}, rows={"a": row})
        self.assertIn("orca orchestration send --to dispatch:d1 --subject 'dispatch: wg/ex-one-00-a'", out)
        self.assertEqual(self.row("a")["state"], "starting")
        self.assertNotIn("started_at", self.row("a"))

    def test_claim_refuses_a_second_job_and_a_second_restack(self):
        row = BRANCH | {"pr": "7", "dispatch": "d1"}
        cases = [
            ("review", {"a": row | {"state": "running", "job": "ci"}}, "a: a job is live: state=running job=ci"),
            ("ci", {"a": BRANCH | {"dispatch": "d1"}}, "a: no pr in the run row"),
            ("ci", {"a": {"pr": "7"}}, "a: missing run field lower"),
            ("dispatch", {"a": row}, "a: it has a PR; send a follow-up job"),
            ("restack", {"a": row, "b": {"state": "running", "job": "restack"}}, "one restack job at a time: b is live"),
        ]
        for job, rows, message in cases:
            with self.subTest(message=message):
                out, err = self.job(wg.claim, "a", job, "codex", live={"a": "In Review"}, rows=rows, code=1)
                self.assertIn(f"FAIL {message}", out)
                self.assertIn("CD-1: not claimed", err)
                self.update.assert_not_called()

    def test_a_squash_restack_uses_the_old_parent_tip_and_the_new_target(self):
        repo, origin = self.d / "repo", self.d / "origin.git"

        def git(*args, cwd=repo):
            return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()

        def commit(name):
            (repo / name).write_text(name)
            git("add", name)
            git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", name)

        git("init", "-q", "--bare", str(origin), cwd=self.d)
        git("init", "-q", "-b", "main", str(repo), cwd=self.d)
        git("remote", "add", "origin", str(origin))
        git("config", "user.name", "t")  # the rebase commits: no global identity on a CI runner
        git("config", "user.email", "t@t")
        commit("base")
        git("checkout", "-qb", "wg/ex-one-00-a")
        commit("parent")
        git("checkout", "-qb", "wg/ex-one-01-b")
        commit("child")
        git("checkout", "-q", "main")
        git("merge", "-q", "--squash", "wg/ex-one-00-a")
        git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "squash a")
        git("push", "-q", "origin", "main")
        git("branch", "keep", "wg/ex-one-01-b")
        nodes = {n["key"]: n for n in self.p["nodes"]}
        row = {"branch": "wg/ex-one-01-b", "parent": "wg/ex-one-00-a"}
        with patch.object(wg, "stax_trunk", return_value="main"):
            line = wg.restack_line(repo, self.p, nodes["b"], row, nodes, {"b": ["a"]}, {"a": "Merged"})
        rebase = line.split("refresh: ")[1].split(", then")[0]
        git("checkout", "-q", "wg/ex-one-01-b")
        git(*rebase.split()[1:])
        self.assertEqual(git("rev-list", "--count", "origin/main..HEAD"), "1")  # only the child's own commit
        self.assertEqual(git("diff", "--name-only", "origin/main...HEAD"), "child")
        # A rewritten parent whose ref is gone: the merge base of the branch and the parent's last head.
        git("checkout", "-q", "wg/ex-one-00-a")
        git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--amend", "-m", "parent 2")
        last = git("rev-parse", "HEAD")
        git("checkout", "-q", "main")
        git("branch", "-qD", "wg/ex-one-00-a")
        self.keymap(rows={"a": {"code_done_head": last}})
        km = wg.load_keymap(self.d)
        with patch.object(wg, "stax_trunk", return_value="main"), patch.object(wg, "load_keymap", return_value=km):
            line = wg.restack_line(repo, self.p, nodes["b"], row | {"branch": "keep"}, nodes, {"b": ["a"]},
                                   {"a": "Merged"})
        fork = git("merge-base", "keep", last)
        self.assertNotEqual(fork, last)
        self.assertIn(f"git rebase --onto origin/main {fork},", line)

    def test_a_restack_after_a_merged_parent_checks_from_the_new_target(self):
        rows = {"a": {"code_done_head": SHA}, "b": {"branch": "wg/ex-one-01-b", "parent": "wg/ex-one-00-a",
                                                    "lower": "wg/ex-one-00-a", "pr": "8", "dispatch": "d2"}}
        line = "target main at abc; base: trunk; parent merged: yes; refresh: git rebase --onto origin/main x, then y"
        with patch.object(wg, "restack_line", return_value=line):
            self.job(wg.claim, "b", "restack", "codex", live={"a": "Merged", "b": "In Review", "s": "Done"}, rows=rows)
        self.assertEqual((self.row("b")["lower"], self.row("b")["parent"]), ("origin/main", "wg/ex-one-00-a"))
        text = (self.d / "specs" / "b-restack.md").read_text()
        self.assertIn("diff base `origin/main`", text)

    def test_a_first_claim_of_an_adopted_node_writes_its_dispatch_spec(self):
        self.p["nodes"][0]["acceptance"] = "Adopted work."
        self.job(wg.claim, "a", "dispatch", "codex", live={"a": "In Progress", "s": "Done"}, rows={"a": BRANCH})
        dispatch = (self.d / "specs" / "a.md").read_text()
        self.assertIn("## Node card\n\n**Acceptance**\n\nAdopted work.\n\n**Files**\n\n- owns `a/*`", dispatch)
        text = (self.d / "specs" / "a-dispatch.md").read_text()
        self.assertTrue(text.startswith("**Task:**"))
        self.assertIn(f"Your dispatch spec {wg.shlex.quote(str(self.d.resolve() / 'specs' / 'a.md'))}", text)
        self.assertIn("**Job `dispatch`:**", text)
        self.assertNotIn("\n\n## Design", text)  # the job spec stays the contract, one header, and the work

    def test_the_design_keeps_the_text_around_the_notes_block(self):
        text = ("First.\n\n+++ Agent notes\n\nwork-graph node `a` · kind `task`\n\nThe graph lives in plan.json.\n\n+++"
                "\n\nA later line.\n\n+++ Agent notes\n\nOther notes.\n\n+++")
        self.assertEqual(wg.issue_design({}, {"description": text}),
                         "First.\n\nA later line.\n\n+++ Agent notes\n\nOther notes.\n\n+++")

    def test_a_lint_command_keeps_braces_as_text(self):
        values = {"lint": wg.Literal(wg.lint_step({"effort": {"lint": ["sh", "-c", 'lint "${file}"']}}, "x")), "key": "k"}
        self.assertIn("""`sh -c 'lint "${file}"'`""", wg.render("{key}: {lint}", values))
        _, err = self.call(wg.render, "{key} {lint} {other}", values, code=2)
        self.assertIn("no value for {other}", err)

    def test_restack_line_pins_the_target_and_refreshes_a_frozen_base(self):
        nodes = {n["key"]: n for n in self.p["nodes"]}
        deps = {"b": ["a"], "a": ["s"]}
        row = {"parent": "wg/ex-one-00-a"}
        with patch.object(wg, "stax_trunk", return_value="release"), patch.object(wg, "refresh_base") as refresh, \
             patch.object(wg, "git_output", return_value=SHA) as git:
            line = wg.restack_line(self.d, self.p, nodes["b"], row, nodes, deps, {"a": "Merged"})
            refresh.assert_called_once_with(self.d, "main")
            self.assertEqual(line, f"target main at {SHA}; base: frozen; parent merged: yes; refresh: "
                                   f"git rebase --onto origin/main {SHA}, then st branch reparent --parent main")
            self.assertEqual(git.call_args_list[-1].args, ("rev-parse", "wg/ex-one-00-a"))
            git.reset_mock()
            wg.restack_line(self.d, self.p, nodes["b"], row | {"branch": "wg/ex-one-01-b"}, nodes, deps, {"a": "Merged"})
            self.assertEqual(git.call_args_list[-1].args, ("merge-base", "wg/ex-one-01-b", "wg/ex-one-00-a"))
            git.side_effect = [SHA, OTHER]
            with self.assertRaises(wg.ReadError):
                wg.restack_line(self.d, self.p, nodes["b"], row, nodes, deps, {"a": "Merged"})
        with patch.object(wg, "stax_trunk", return_value="main"), patch.object(wg, "refresh_base") as refresh, \
             patch.object(wg, "git_output", return_value=SHA) as git:
            line = wg.restack_line(self.d, self.p, nodes["b"], row, nodes, deps, {"a": "In Review"})
            refresh.assert_not_called()
            self.assertEqual(line, f"target main at {SHA}; base: trunk; parent merged: no")
            self.assertEqual(git.call_args_list[0].args[-1], "+refs/heads/main:refs/remotes/origin/main")

    def test_started_records_the_orca_ids_and_comments_the_claim(self):
        row = BRANCH | {"state": "starting", "job": "review", "dispatch": "d1", "path": "/work/child",
                        "started_at": "2025-12-31T23:59:59Z"}
        with patch.object(wg, "utc_now", return_value=datetime(2026, 1, 1, tzinfo=timezone.utc)):
            out, _ = self.job(wg.started, "a", ["dispatch=d2", "task=t2", "run_id=run_1"], rows={"a": row})
        self.assertEqual(self.row("a"), row | {"state": "running", "dispatch": "d2", "task": "t2",
                                              "started_at": "2026-01-01T00:00:00Z"})
        self.assertEqual(self.effort, {"run_id": "run_1"})
        self.assertEqual(self.comment.call_args.args, ("a", "Claimed: dispatch d2, worktree /work/child, job review"))
        _, err = self.job(wg.started, "a", ["dispatch=d2"], rows={"a": BRANCH | {"state": "creating"}}, code=1)
        self.assertIn("a: no job is starting (state=creating)", err)
        _, err = self.job(wg.started, "a", ["task=t2"], rows={"a": row}, code=2)
        self.assertIn("wg started needs dispatch=<id>", err)
        self.comment.assert_not_called()

    def done(self, key="a", *, row=None, live=None, verify=0, prs='[{"number": 7}]', base="main", code=0, linear=None, **kwargs):
        rows = {key: BRANCH | {"state": "running", "job": "dispatch", "dispatch": "d1", "path": "/work/child"} | (row or {})}
        statuses = {"a": ("In Progress", ["agent:codex"]), "s": "Done"} | (live or {})
        url = "https://github.com/example/repo/pull/7"
        if linear is None:
            def linear(query, variables):
                if "attachments(" in query:
                    return {"issue": {"attachments": {
                        "nodes": [{"url": url}], "pageInfo": {"hasNextPage": False},
                    }}}
                return STATES
        with patch.object(wg, "verify", return_value=verify) as self.verify, \
             patch.object(wg, "command", return_value=subprocess.CompletedProcess([], 0, prs, "")) as self.command, \
             patch.object(wg, "pr_view", return_value={"baseRefName": base, "url": url}):
            return self.job(wg.done, key, kwargs.get("failed"), kwargs.get("worktree"), kwargs.get("dispatch", "d1"),
                            live=statuses, rows=rows, code=code, linear=linear)

    def test_done_releases_the_claim_finds_the_pr_and_moves_to_in_review(self):
        out, _ = self.done()
        self.assertEqual(self.updates, [("a", {"removedLabelIds": ["agent:codex"]}), ("a", {"stateId": "In Review"})])
        self.assertEqual(self.command.call_args.args, ("gh", "pr", "list", "--head", "wg/ex-one-00-a", "--state", "open",
                                                       "--json", "number"))
        self.verify.assert_called_once_with(self.d, self.p, "a", cwd="/work/child")
        self.assertEqual(self.row("a"), BRANCH | {"job": "dispatch", "dispatch": "d1", "path": "/work/child", "pr": "7"})
        self.assertIn("released agent:codex\n", out)
        self.assertIn("CD-1: In Progress -> In Review\n", out)

    def test_done_attaches_the_pr_once_even_if_verification_fails(self):
        urls = []

        def linear(query, variables):
            if "attachments(" in query:
                self.assertEqual(variables["id"], "a")
                return {"issue": {"attachments": {
                    "nodes": [{"url": url} for url in urls], "pageInfo": {"hasNextPage": False},
                }}}
            if "attachmentLinkGitHubPR" in query:
                self.assertEqual(variables["id"], "a")
                urls.append(variables["url"])
                return {"attachmentLinkGitHubPR": {"success": True}}
            return STATES

        self.done(linear=linear, verify=1, code=1)
        self.done(linear=linear, row={"pr": "7"})
        self.assertEqual(urls, ["https://github.com/example/repo/pull/7"])

    def test_done_uses_a_generic_attachment_for_an_eng_issue_if_github_linking_is_refused(self):
        keymap = self.keymap
        next(n for n in self.p["nodes"] if n["key"] == "a")["eng"] = "ENG-123"

        def eng_keymap(**kwargs):
            km = keymap(**kwargs)
            km["nodes"]["a"]["identifier"] = "ENG-123"
            wg.save_keymap(self.d, km)
            return km

        created = []

        def linear(query, variables):
            if "attachments(" in query:
                return {"issue": {"attachments": {"nodes": [], "pageInfo": {"hasNextPage": False}}}}
            if "attachmentLinkGitHubPR" in query:
                raise wg.ReadError("GitHub integration refused the link")
            if "attachmentCreate" in query:
                created.append(variables["input"])
                return {"attachmentCreate": {"success": True}}
            return STATES

        with patch.object(self, "keymap", side_effect=eng_keymap):
            _, err = self.done(linear=linear, live={"a": "In Review"})
        self.assertEqual(err, "")
        self.assertEqual(created, [{"issueId": "a", "title": "PR #7",
                                    "url": "https://github.com/example/repo/pull/7"}])

    def test_done_warns_when_linear_cannot_attach_the_pr(self):
        def linear(query, variables):
            if "attachments(" in query:
                return {"issue": {"attachments": {"nodes": [], "pageInfo": {"hasNextPage": False}}}}
            if "attachmentLinkGitHubPR" in query:
                return {"attachmentLinkGitHubPR": {"success": False}}
            if "attachmentCreate" in query:
                raise wg.ReadError("permission denied")
            return STATES

        out, err = self.done(linear=linear)
        self.assertIn("Warning: could not attach PR #7 to CD-1: permission denied", err)
        self.assertIn("CD-1: In Progress -> In Review", out)

    def test_done_keeps_the_status_when_code_done_fails(self):
        self.done(verify=1, code=1)
        self.assertEqual(self.updates, [("a", {"removedLabelIds": ["agent:codex"]})])
        self.assertNotIn("state", self.row("a"))
        out, _ = self.done(prs='[{"number": 7}, {"number": 8}]', code=1)
        self.assertIn("FAIL pr: 2 open PRs have the head wg/ex-one-00-a\n", out)
        self.verify.assert_not_called()

    def test_done_takes_a_pr_with_a_new_patch_out_of_the_merge_queue(self):
        merged_row = {"pr": "7", "merge_review": "clean"}
        self.done(row=merged_row, live={"a": "Ready to Merge"})
        self.assertEqual(self.updates, [])
        self.done(row={"pr": "7"}, live={"a": "Ready to Merge"})
        self.assertEqual(self.updates, [("a", {"stateId": "In Review"})])
        self.done(row=merged_row, live={"a": "Ready to Merge"}, verify=1, code=1)
        self.assertEqual(self.updates, [("a", {"stateId": "In Review"})])

    def test_done_moves_the_parent_to_the_target_after_the_pr_below_merged(self):
        row = {"branch": "wg/ex-one-01-b", "parent": "wg/ex-one-00-a", "lower": "wg/ex-one-00-a", "pr": "8", "job": "restack"}
        out, _ = self.done("b", row=row, live={"a": "Merged", "b": "In Review"})
        self.assertIn("the PR below merged: parent main, lower origin/main\n", out)
        self.assertEqual((self.row("b")["parent"], self.row("b")["lower"]), ("main", "origin/main"))
        out, _ = self.done("b", row=row, live={"a": "Merged", "b": "In Review"}, base="wg/ex-one-00-a", code=1)
        self.assertIn("FAIL pr: a below it merged, but the base of PR #8 is wg/ex-one-00-a, not main: restack it\n", out)
        self.assertEqual(self.row("b")["parent"], "wg/ex-one-00-a")
        self.verify.assert_not_called()
        self.done("b", row=row, live={"a": "In Review", "b": "In Review"})
        self.assertEqual(self.row("b")["parent"], "wg/ex-one-00-a")

    def test_done_records_a_failed_job_and_closes_a_spike(self):
        out, _ = self.done(failed="vitest: 3 failed")
        self.assertEqual(out, "released agent:codex\na: state=failed\n")
        self.assertEqual(self.row("a")["state"], "failed")
        self.assertEqual(self.comment.call_args.args, ("a", "Job `dispatch` failed: vitest: 3 failed"))
        self.verify.assert_not_called()
        out, _ = self.done("s", row={"job": "dispatch"}, live={"s": ("In Progress", ["agent:claude"])})
        self.assertEqual(self.updates, [("s", {"removedLabelIds": ["agent:claude"]}), ("s", {"stateId": "Done"})])
        self.verify.assert_not_called()

    def test_done_counts_only_for_the_job_in_the_run_row(self):
        _, err = self.done(dispatch=None, code=2)
        self.assertIn("a: a job is live (dispatch d1): pass --dispatch <id> of the worker_done, or --failed", err)
        for failed in (None, "old worker failed"):
            _, err = self.done(dispatch="d0", failed=failed, code=1)
            self.assertIn("a: this worker_done is from d0; the job in the run row is d1", err)
            self.update.assert_not_called()
            self.assertEqual(self.row("a")["state"], "running")
        _, err = self.done(dispatch="d0", row={"state": "", "pr": "7"}, live={"a": "In Review"}, code=1)
        self.assertIn("a: this worker_done is from d0; the job in the run row is d1", err)
        self.verify.assert_not_called()

    def test_done_takes_a_pr_on_the_merged_branch_out_of_the_merge_queue(self):
        row = {"branch": "wg/ex-one-01-b", "parent": "wg/ex-one-00-a", "lower": "wg/ex-one-00-a", "pr": "8", "state": ""}
        out, _ = self.done("b", row=row, live={"a": "Merged", "b": "Ready to Merge"}, base="wg/ex-one-00-a", code=1)
        self.assertIn("FAIL pr: a below it merged, but the base of PR #8 is wg/ex-one-00-a, not main", out)
        self.assertEqual(self.updates, [("b", {"stateId": "In Review"})])

    def test_done_leaves_a_claim_that_has_no_job_in_the_run_row(self):
        _, err = self.done(row={"state": ""}, code=1)
        self.assertIn("CD-1: agent:codex has no job in the run row", err)
        self.update.assert_not_called()
        self.done(row={"state": "", "pr": "7"}, live={"a": "In Review"})
        self.verify.assert_called_once()

    def test_approve_records_humans_words(self):
        _, err = self.job(wg.approve, ["a"], " ", code=2)
        self.assertIn("--quote needs Human's own words", err)
        today = f"{wg.utc_now():%Y-%m-%d}"
        out, _ = self.job(wg.approve, ["a", "c"], "wave 1 is\n approved", live={"a": "Needs Human"})
        self.assertEqual(out, "approved a CD-1\nCD-1: Needs Human -> Todo\napproved c CD-5\n")
        self.assertEqual((self.row("a")["approved"], self.row("c")["approved"]), (f"{today}: wave 1 is approved",) * 2)
        self.assertEqual(self.comment.call_args_list[0].args,
                         ("a", f'**wg approve** Human, {today}. Their words: "wave 1 is approved"'))
        self.assertEqual(self.updates, [("a", {"stateId": "Todo"})])
        self.comment.reset_mock()
        _, err = self.job(wg.approve, ["@first-pr"], "PR 12 looks right", code=1)
        self.assertIn("no gate waits for an approval of the effort", err)
        self.comment.assert_not_called()
        _, err = self.job(wg.approve, ["a", "zz"], "ok", code=2)
        self.assertIn("unknown key zz", err)

    def test_job_commands_run_from_the_command_line(self):
        self.keymap(rows={"a": BRANCH | {"state": "starting", "job": "ci"}})
        with patch.object(wg, "comment"), patch.object(wg, "sync_card", return_value=False):
            out, _ = self.call(wg.main, ["wg", "started", str(self.d), "a", "dispatch=d9"])
        self.assertIn("state=running", out)
        with patch.object(wg, "fetch_nodes", return_value=self.issues({"a": "In Progress"})), \
             patch.object(wg, "project_entries", return_value=[]):
            out, _ = self.call(wg.main, ["wg", "next", str(self.d)])
        self.assertIn("wait worker a CD-1: job=ci dispatch=d9\n", out)
        _, err = self.call(wg.main, ["wg", "next", str(self.d), "--interval", "0"], code=2)
        self.assertIn("--interval must be a positive number", err)
        with patch.object(wg, "fetch_nodes", return_value=self.issues({"a": "In Progress"})), \
             patch.object(wg, "project_entries", return_value=[]):
            old, err = self.call(wg.main, ["wg", "watch", str(self.d)])
        self.assertEqual(old, out)
        self.assertIn("wg watch is now wg next", err)



ORCA_WORKTREES = wg.orca_worktrees

# A fake `orca` and a fake `st` for the one-command jobs. The state file holds the worktrees, the calls, and the
# failures to give: "fail" maps a call ("worktree create", or "worktree create:<name>") to a mode:
# "error" (a refusal), "lost" (a lost reply with a request id), "garbage" (it acts, then gives no JSON),
# or "warn" (it acts, with two warning lines on stderr).
FAKE_ORCA = r'''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
state_path = Path(os.environ["FAKE_STATE"])
state = json.loads(state_path.read_text())
args = sys.argv[1:]
state["calls"].append(["orca"] + args)
def value(flag):
    return args[args.index(flag) + 1] if flag in args else None
verb = " ".join(args[:2])
name = value("--name") or ""
fail = state["fail"].pop(f"{verb}:{name}", None) or state["fail"].pop(verb, None)
def out(code, answer, err=""):
    state_path.write_text(json.dumps(state))
    print(answer if fail == "garbage" else json.dumps(answer))
    if err:
        print(err, file=sys.stderr)
    sys.exit(code)
replay = value("--retry-request")
if fail is None and replay in state.get("requests", {}):
    out(0, {"ok": True, "result": state["requests"][replay]})  # a replay gives the first result again
if fail == "error":
    out(1, {"ok": False, "error": {"code": "refused", "message": "refused"}}, "error: refused: refused")
if fail == "lost-acted":  # the call acts, then its reply is lost
    request = f"req_{len(state['calls'])}"
    state["jobs"] += 1
    n = state["jobs"]
    state.setdefault("requests", {})[request] = {"dispatchId": f"ctx_{n}", "taskId": f"task_{n}", "runId": "run_1",
                                                 "state": "ready", "workspace": (value("--worktree") or "id:-")[3:]}
    out(1, {"ok": False, "error": {"code": "runtime_timeout", "message": "timeout", "data": {"recovery": {
        "orchestrationRequestId": request, "disposition": "outcome_unknown"}}}}, "error: runtime_timeout: timeout")
if fail == "lost":
    request = f"req_{len(state['calls'])}"
    out(1, {"ok": False, "error": {"code": "runtime_timeout", "message": "timeout", "data": {"recovery": {
        "orchestrationRequestId": request, "disposition": "outcome_unknown",
        "queryCommand": f"orchestration request-show --request {request} --json"}}}}, "error: runtime_timeout: timeout")
if fail == "garbage":
    out = (lambda out: lambda code, answer, err="": out(1, "socket closed", "error: socket closed"))(out)
if fail == "multiline":
    out(1, {"ok": False, "error": {"code": "refused", "message": "first line\nsecond line"}},
        "error: first line\nsecond line")
warn = "warning: one\nwarning: two" if fail == "warn" else ""
if verb == "worktree list":
    out(0, {"ok": True, "result": {"worktrees": state["trees"]}})
if verb == "worktree create":
    path = str(Path(state["root"]) / name)
    Path(path).mkdir(parents=True, exist_ok=True)
    tree = {"id": f"repo::{path}", "path": path, "branch": "refs/heads/" + value("--branch") + ("-2" if fail == "suffix" else ""),
            "parentWorktreeId": value("--parent-worktree")[3:]}
    state["trees"].append(tree)
    out(0, {"ok": True, "result": {"worktree": tree}})
if verb == "worktree set":
    state["names"][value("--worktree")[3:]] = value("--display-name")
    out(0, {"ok": True, "result": {"worktree": {"id": value("--worktree")[3:]}}})
if verb in ("orchestration worker-start", "orchestration send"):
    state["jobs"] += 1
    n = state["jobs"]
    answer = {"dispatchId": f"ctx_{n}", "taskId": f"task_{n}", "runId": "run_1", "state": "ready"}
    if verb.endswith("worker-start"):
        answer["workspace"] = value("--worktree")[3:]
    out(0, {"ok": True, "result": answer}, warn)
out(2, {"ok": False, "error": {"code": "unknown", "message": verb}}, "error: unknown")
'''

FAKE_ST = r'''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
state_path = Path(os.environ["FAKE_STATE"])
state = json.loads(state_path.read_text())
state["calls"].append(["st"] + sys.argv[1:] + ["@" + os.getcwd()])
fail = state["fail"].pop("st", None)
state_path.write_text(json.dumps(state))
if fail:
    print("st: not a stax repository", file=sys.stderr)
    sys.exit(1)
'''


def refuse_once(match):
    """A side effect that fails the first call whose second argument contains `match`."""
    seen = []

    def effect(*args):
        if not seen and match in json.dumps(args[1:]):
            seen.append(args)
            raise wg.ReadError("Linear is down")
    return effect


class OneCommandTests(LaneTests):
    """`wg dispatch --run` and `wg claim --send` run the Orca and stax steps themselves, with a fake orca and st."""

    job = JobTests.job

    def setUp(self):
        super().setUp()
        self.bin = self.d / "bin"
        self.bin.mkdir()
        for name, text in (("orca", FAKE_ORCA), ("st", FAKE_ST)):
            (self.bin / name).write_text(text)
            (self.bin / name).chmod(0o755)
        self.state_path = self.d / "fake.json"
        self.core = {"id": f"repo::{self.d.resolve()}", "path": str(self.d.resolve()), "branch": "refs/heads/wg/ex-core"}
        self.fake(trees=[self.core])
        env = {"ORCA_CLI_COMMAND": str(self.bin / "orca"), "FAKE_STATE": str(self.state_path),
               "PATH": f"{self.bin}{os.pathsep}{os.environ.get('PATH', '')}", "ORCA_TERMINAL_HANDLE": "term_1"}
        self.problems = patch.object(wg, "worktree_problems", return_value=[])
        for patcher in (patch.dict(os.environ, env), patch.object(wg, "orca_worktrees", ORCA_WORKTREES),
                        patch.object(wg, "branch_metadata", return_value=None),
                        patch.object(wg, "git_common_dir", return_value="/repo/.git"), self.problems,
                        patch.object(wg, "checked_out", side_effect=self.checked_out)):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.child = str((self.d / "trees" / "ex-one-00-a").resolve())
        self.lane_id = f"repo::{self.d / 'trees' / 'ex-one'}"

    def checked_out(self, path):
        """The branch of the fake worktree at `path`, as git would give it."""
        tree = next(t for t in self.state()["trees"] if Path(t["path"]).resolve() == Path(path).resolve())
        return wg.short_branch(tree["branch"])

    def fake(self, trees=None, fail=None):
        state = json.loads(self.state_path.read_text()) if self.state_path.exists() else {
            "calls": [], "trees": [], "jobs": 0, "names": {}, "root": str(self.d / "trees"), "fail": {}}
        if trees is not None:
            state["trees"] = trees
        state["fail"] = fail or {}
        state["calls"] = []
        self.state_path.write_text(json.dumps(state))

    def state(self):
        return json.loads(self.state_path.read_text())

    def calls(self):
        return [" ".join(call) for call in self.state()["calls"]]

    def run_dispatch(self, code=0, fail=None, agent="claude", model="opus-x", key="a", **kwargs):
        """One call of `wg dispatch --run`. The run row and the Linear status of the last call stay."""
        self.fake(fail=fail)
        row = self.row(key) if hasattr(self, "row") else {}
        status = getattr(self, "status", ("Todo", []))
        rows = {key: row or {"approved": "x"}}
        return self.job(wg.dispatch_run, key, agent, model, live={"s": "Done", key: status}, rows=rows,
                        effort={"wave": key}, code=code, **kwargs)

    def linear_after(self, key="a", agent="claude"):
        """The Linear status after the claim and the move that the last call made."""
        labels = [f"agent:{agent}"] if any("addedLabelIds" in str(u) for u in self.updates) else self.status[1]
        moved = any("stateId" in str(u) for u in self.updates)
        self.status = ("In Progress" if moved else self.status[0], labels)

    def run_again(self, code=0, fail=None, **kwargs):
        self.linear_after()
        return self.run_dispatch(code=code, fail=fail, **kwargs)

    def assert_one_of_each(self):
        state = self.state()
        self.assertEqual(sorted(t["branch"] for t in state["trees"]),
                         ["refs/heads/wg/ex-core", "refs/heads/wg/ex-one", "refs/heads/wg/ex-one-00-a"])
        self.assertEqual(state["jobs"], 1)  # one worker
        self.assertEqual(state["names"], {f"repo::{self.d / 'trees' / 'ex-one-00-a'}": "00 a"})

    def test_dispatch_run_does_every_step_and_prints_two_lines(self):
        self.status = ("Todo", [])
        out, err = self.run_dispatch()
        self.assertEqual(out.splitlines(), ["claimed CD-1 agent:claude", f"started a dispatch=ctx_1 worktree={self.child}"])
        self.assertEqual(err, "")
        self.assertEqual(self.updates, [("a", {"addedLabelIds": ["L-claude"]}), ("a", {"stateId": "In Progress"})])
        calls = self.calls()
        self.assertEqual([c.split(" --")[0] for c in calls], [
            "orca worktree list", "orca worktree create", "orca worktree create", "orca worktree set",
            "st branch track", "orca orchestration worker-start"])
        self.assertIn(f"--name ex-one --branch wg/ex-one --parent-worktree id:{self.core['id']} "
                      "--base-branch origin/main --setup skip --json", calls[1])
        self.assertIn(f"--name ex-one-00-a --branch wg/ex-one-00-a --base-branch origin/main "
                      f"--parent-worktree id:{self.lane_id} --setup run --json", calls[2])
        self.assertIn("--display-name 00 a --json", calls[3])
        self.assertEqual(calls[4], f"st branch track --parent main @{self.child}")
        spec = self.d.resolve() / "specs" / "a.md"
        self.assertIn(f"--spec-file {spec} --task-title CD-1: a --worktree id:repo::{self.d / 'trees' / 'ex-one-00-a'} "
                      "--agent claude --environment local --model opus-x --json", calls[5])
        row = self.row("a")
        self.assertEqual((row["state"], row["dispatch"], row["task"], row["path"], row["model"]),
                         ("running", "ctx_1", "task_1", self.child, "opus-x"))
        self.assertNotIn("step", row)
        self.assertEqual(self.effort["run_id"], "run_1")
        self.assertEqual(self.comment.call_args.args, ("a", f"Claimed: dispatch ctx_1, worktree {self.child}, job dispatch"))
        self.assertIn("Linear issue `CD-1`", spec.read_text())
        self.assert_one_of_each()

    def test_a_failure_at_each_step_stops_and_the_next_run_continues_there(self):
        # (what fails, the step in the row after the failure)
        cases = [
            ({"update": refuse_once("addedLabelIds")}, "claim"),
            ({"update": refuse_once("stateId")}, "status"),
            ({"fail": {"worktree list": "error"}}, "parent"),
            ({"fail": {"worktree create:ex-one": "error"}}, "parent"),
            ({"fail": {"worktree create:ex-one": "garbage"}}, "parent"),  # made, reply lost
            ({"fail": {"worktree create:ex-one-00-a": "error"}}, "child"),
            ({"fail": {"worktree create:ex-one-00-a": "garbage"}}, "child"),  # made, reply lost
            ({"fail": {"worktree set": "error"}}, "child"),
            ({"fail": {"st": "error"}}, "track"),
            ({"spec": OSError("disk full")}, "spec"),
            ({"fail": {"orchestration worker-start": "error"}}, "spec"),  # a refusal: start again
            ({"comments": wg.ReadError("Linear is down")}, "receipt"),
        ]
        for failure, step in cases:
            with self.subTest(failure=failure, step=step):
                self.fake(trees=[self.core])
                self.keymap(rows={})
                self.status = ("Todo", [])
                state = self.state()
                state["jobs"], state["names"] = 0, {}
                self.state_path.write_text(json.dumps(state))
                kwargs = {k: v for k, v in failure.items() if k in ("update", "comments", "fail")}
                spec = patch.object(wg, "write_spec", side_effect=failure["spec"]) if "spec" in failure else contextlib.nullcontext()
                with spec:
                    out, err = self.run_dispatch(code=1, **kwargs)
                lines = out.splitlines()
                self.assertLessEqual(len(lines) + len(err.splitlines()), 3, out + err)
                self.assertTrue(lines[-1].startswith(f"FAIL {'start' if failure.get('fail', {}).get('orchestration worker-start') else step}: "), out)
                self.assertEqual(self.row("a")["step"], step)
                out, _ = self.run_again()
                self.assertTrue(out.endswith(f"started a dispatch=ctx_1 worktree={self.child}\n"), out)
                self.assert_one_of_each()
                self.assertEqual(self.row("a")["state"], "running")
                self.assertNotIn("step", self.row("a"))
                self.assertEqual(self.comment.call_count, 1)

    def test_resume_takes_no_second_claim_and_no_second_move(self):
        self.status = ("Todo", [])
        self.run_dispatch(code=1, fail={"worktree list": "error"})
        self.run_again()
        self.update.assert_not_called()
        self.status = ("Todo", [])  # a claim whose move failed: the next call moves it, then starts
        self.keymap(rows={})
        self.fake(trees=[self.core])
        self.run_dispatch(code=1, update=refuse_once("stateId"))
        self.assertEqual(self.updates, [("a", {"addedLabelIds": ["L-claude"]}), ("a", {"stateId": "In Progress"})])
        self.status = ("Todo", ["agent:claude"])
        out, _ = self.run_dispatch()
        self.assertEqual(self.updates, [("a", {"stateId": "In Progress"})])
        self.assertIn("started a", out)

    def test_existing_worktrees_of_the_effort_are_reused_and_others_are_not(self):
        lane = {"id": "repo::lane", "path": str(self.d / "lane"), "branch": "refs/heads/wg/ex-one",
                "parentWorktreeId": self.core["id"]}
        other = {"id": "other::/x", "path": "/x", "branch": "refs/heads/wg/ex-one-00-a", "parentWorktreeId": "repo::lane"}
        self.fake(trees=[self.core, lane, other])
        self.status = ("Todo", [])
        self.run_dispatch()
        calls = self.calls()
        self.assertEqual(len([c for c in calls if c.startswith("orca worktree create")]), 1)
        self.assertIn("--name ex-one-00-a", calls[1])
        self.assertIn("--parent-worktree id:repo::lane", calls[1])
        self.assertNotIn("other::", " ".join(calls))

    def test_a_worktree_in_the_wrong_place_stops_before_wg_changes_it(self):
        lane = {"id": "repo::lane", "path": str(self.d / "lane"), "branch": "refs/heads/wg/ex-one", "parentWorktreeId": None}
        child = {"id": "repo::c", "path": str(self.d / "c"), "branch": "refs/heads/wg/ex-one-00-a",
                 "parentWorktreeId": "repo::elsewhere"}
        cases = [([self.core, lane], "parent", "is not under the coordinator: orca worktree set --worktree id:repo::lane "
                  f"--parent-worktree id:{self.core['id']} --json"),
                 ([self.core, lane | {"parentWorktreeId": self.core["id"]}, child], "child", "is not under"),
                 ([self.core, child], "parent", "has no lane parent ex-one")]
        for trees, step, message in cases:
            with self.subTest(message=message):
                self.keymap(rows={})
                self.fake(trees=trees)
                self.status = ("Todo", [])
                out, _ = self.run_dispatch(code=1)
                self.assertIn(f"FAIL {step}: ", out)
                self.assertIn(message, out)
                self.assertEqual([c.split(" --")[0] for c in self.calls()], ["orca worktree list"])

    def test_a_checkout_of_another_repository_gets_no_display_name_and_no_stax_change(self):
        self.status = ("Todo", [])
        with patch.object(wg, "git_common_dir", side_effect=lambda path: "/other/.git" if "trees" in str(path) else "/repo/.git"):
            out, _ = self.run_dispatch(code=1)
        self.assertIn(f"FAIL child: a: {self.child} is not a checkout of the repository of", out)
        self.assertFalse(any(c.startswith(("orca worktree set", "st ")) for c in self.calls()))

    def test_the_branch_plan_decides_stax_also_for_a_stacked_hotfix(self):
        node = self.p["nodes"][0]
        node["role"] = "hotfix"
        for stacked, tracked in ((True, True), (False, False)):
            with self.subTest(stacked=stacked):
                self.p["effort"]["stacked_hotfix"] = stacked
                self.keymap(rows={})
                self.fake(trees=[self.core])
                self.status = ("Todo", [])
                self.run_dispatch()
                self.assertEqual(any(c.startswith("st branch track") for c in self.calls()), tracked)
                self.assertEqual(self.problems.target.worktree_problems.call_args.args[3], tracked)

    def test_a_check_of_the_new_worktree_stops_before_the_spec_on_one_line(self):
        self.status = ("Todo", [])
        with patch.object(wg, "worktree_problems", return_value=["a: HEAD does not contain origin/main", "a: not clean"]):
            out, err = self.run_dispatch(code=1)
        self.assertEqual(out.splitlines()[1], "FAIL spec: a: HEAD does not contain origin/main; a: not clean")
        self.assertEqual(len(err.splitlines()), 1)
        self.assertIn("CD-1: no worker spec", err)
        self.assertEqual((self.row("a")["state"], self.row("a")["step"]), ("creating", "spec"))
        self.assertFalse(any("worker-start" in c for c in self.calls()))
        self.run_again()  # it continues at spec: the track step that passed runs no second time
        self.assertEqual([c.split(" --")[0] for c in self.calls()], ["orca orchestration worker-start"])

    def test_orca_warnings_are_one_line(self):
        self.status = ("Todo", [])
        out, err = self.run_dispatch(fail={"orchestration worker-start": "warn"})
        self.assertEqual(err, "warning: warning: one; warning: two\n")
        self.assertEqual(len(out.splitlines()), 2)

    def test_a_lost_start_reply_is_retried_with_its_request_id_until_orca_answers(self):
        self.status = ("Todo", [])
        _, err = self.run_dispatch(code=1, fail={"orchestration worker-start": "lost"})
        self.assertEqual(self.row("a")["retry_request"], "req_6")
        self.assertIn("orca orchestration request-show --request req_6 --json", err)
        _, err = self.run_again(code=1, fail={"orchestration worker-start": "garbage"})
        self.assertEqual((self.row("a")["retry_request"], self.row("a")["step"]), ("req_6", "start"))
        self.assertIn("the next call retries request req_6", err)
        out, _ = self.run_again()
        self.assertTrue(out.startswith("started a dispatch=ctx_2 "), out)
        self.assertEqual(len(self.calls()), 1)
        self.assertTrue(self.calls()[0].endswith("--json --retry-request req_6"))
        self.assertNotIn("retry_request", self.row("a"))

    def test_a_replay_that_cannot_run_keeps_its_request_id(self):
        self.status = ("Todo", [])
        self.run_dispatch(code=1, fail={"orchestration worker-start": "lost"})
        real = wg.command

        def command(*args, cwd=None):
            if "worker-start" in args:
                raise FileNotFoundError(2, "No such file or directory", args[0])
            return real(*args, cwd=cwd)
        with patch.object(wg, "command", side_effect=command):
            out, err = self.run_again(code=1)
        self.assertIn("FAIL start: orca did not run", out)
        self.assertIn("the next call retries request req_6", err)
        self.assertEqual((self.row("a")["retry_request"], self.row("a")["step"]), ("req_6", "start"))
        self.run_again()
        self.assertTrue(self.calls()[0].endswith("--json --retry-request req_6"), self.calls())
        self.assertEqual(self.state()["jobs"], 1)

    def test_multiline_errors_stay_within_three_lines(self):
        for failing, step in (("worktree create:ex-one", "parent"), ("orchestration worker-start", "start")):
            with self.subTest(failing=failing):
                self.keymap(rows={})
                self.fake(trees=[self.core])
                self.status = ("Todo", [])
                out, err = self.run_dispatch(code=1, fail={failing: "multiline"})
                lines = (out + err).splitlines()
                self.assertLessEqual(len(lines), 3, lines)
                self.assertEqual(lines[0], "claimed CD-1 agent:claude")
                self.assertTrue(lines[1].startswith(f"FAIL {step}: "), lines)
                self.assertIn("first line second line", lines[1])
                self.assertTrue(all(line.startswith("warning: ") for line in lines[2:]), lines)

    def test_a_failed_receipt_save_prints_the_wg_started_command_that_records_it(self):
        self.status = ("Todo", [])
        real, seen = wg.save_keymap, []

        def save(plan_dir, km):
            if not seen and any(r.get("step") == "receipt" for r in wg.run_rows(km)["nodes"].values()):
                seen.append(km)
                raise OSError("disk full")
            return real(plan_dir, km)
        with patch.object(wg, "save_keymap", side_effect=save):
            out, err = self.run_dispatch(code=1)
        self.assertEqual(len((out + err).splitlines()), 3)
        self.assertIn("FAIL receipt: disk full", out)
        self.assertEqual((self.row("a")["state"], self.row("a")["step"]), ("starting", "start"))
        command = wg.shlex.split(err.split("record them with: ", 1)[1])
        self.assertEqual(command[-6:-4], [str(self.d.resolve()), "a"])
        out, _ = self.job(wg.started, "a", command[-4:], rows={"a": self.row("a")})
        row = self.row("a")
        self.assertEqual((row["state"], row["dispatch"], row["task"], row["worktree"]),
                         ("running", "ctx_1", "task_1", f"repo::{self.d / 'trees' / 'ex-one-00-a'}"))
        self.assertNotIn("step", row)
        self.assertEqual(self.effort["run_id"], "run_1")
        self.assertEqual(self.comment.call_count, 1)
        self.assertEqual(self.state()["jobs"], 1)

    def test_wg_started_finishes_a_recorded_receipt_of_its_own_dispatch(self):
        self.status = ("Todo", [])
        self.run_dispatch(code=1, comments=wg.ReadError("Linear is down"))
        row = self.row("a")
        self.assertEqual((row["state"], row["step"]), ("running", "receipt"))
        _, err = self.job(wg.started, "a", ["dispatch=ctx_9"], rows={"a": row}, code=1)
        self.assertIn("a: no job is starting (state=running)", err)
        self.comment.assert_not_called()
        self.job(wg.started, "a", ["dispatch=ctx_1"], rows={"a": row})
        self.assertEqual(self.comment.call_args.args, ("a", f"Claimed: dispatch ctx_1, worktree {self.child}, job dispatch"))
        self.assertNotIn("step", self.row("a"))
        self.assertEqual(self.state()["jobs"], 1)

    def test_the_printed_forms_start_no_second_worker_after_a_lost_start_reply(self):
        self.status = ("Todo", [])
        self.run_dispatch(code=1, fail={"orchestration worker-start": "lost-acted"})
        self.assertEqual(self.state()["jobs"], 1)
        live = {"s": "Done", "a": ("In Progress", ["agent:claude"])}
        for worktree in (None, self.child):
            with self.subTest(worktree=worktree):
                out, err = self.job(wg.dispatch, "a", "claude", worktree, live=live, rows={"a": self.row("a")}, code=1)
                self.assertNotIn("worker-start", out)
                self.assertIn("worker-start request req_6 has no known result", err)
                self.assertIn("--run (it retries with --retry-request req_6)", err)
        row = self.row("a")
        row.pop("retry_request")
        _, err = self.job(wg.dispatch, "a", "claude", self.child, live=live, rows={"a": row}, code=1)
        self.assertIn("an earlier start stopped with no known outcome", err)
        self.status = ("In Progress", ["agent:claude"])
        self.keymap(rows={"a": row | {"retry_request": "req_6"}})
        out, _ = self.run_dispatch()
        self.assertEqual(out, f"started a dispatch=ctx_1 worktree={self.child}\n")
        self.assertEqual(self.state()["jobs"], 1)

    def test_an_error_of_a_replay_keeps_the_request_id_of_a_call_that_acted(self):
        self.status = ("Todo", [])
        self.run_dispatch(code=1, fail={"orchestration worker-start": "lost-acted"})
        _, err = self.run_again(code=1, fail={"orchestration worker-start": "error"})
        self.assertEqual((self.row("a")["retry_request"], self.row("a")["step"]), ("req_6", "start"))
        self.assertIn("the next call retries request req_6", err)
        out, _ = self.run_again()
        self.assertEqual(out, f"started a dispatch=ctx_1 worktree={self.child}\n")
        self.assertTrue(self.calls()[0].endswith("--retry-request req_6"))
        self.assertEqual(self.state()["jobs"], 1)

    def test_a_resume_writes_a_removed_claim_and_status_before_it_starts(self):
        self.status = ("Todo", [])
        self.run_dispatch(code=1, fail={"worktree list": "error"})
        self.status = ("Todo", [])  # the label and the move are gone from Linear
        out, _ = self.run_dispatch()
        self.assertEqual(self.updates, [("a", {"addedLabelIds": ["L-claude"]}), ("a", {"stateId": "In Progress"})])
        self.assertTrue(out.endswith(f"started a dispatch=ctx_1 worktree={self.child}\n"), out)
        self.status = ("Todo", ["agent:codex"])  # another claim: no start
        self.keymap(rows={})
        self.fake(trees=[self.core])
        self.run_dispatch(code=1, fail={"worktree list": "error"}, agent="claude")
        _, err = self.run_dispatch(code=1)
        self.assertIn("agent:codex holds the claim", err)
        self.assertFalse(any("worker-start" in c for c in self.calls()))

    def test_a_worktree_on_another_branch_is_not_taken_and_not_tracked(self):
        self.status = ("Todo", [])
        out, _ = self.run_dispatch(code=1, fail={"worktree create:ex-one-00-a": "suffix"})
        self.assertIn("FAIL child: Orca made ", out)
        self.assertIn("on wg/ex-one-00-a-2, not wg/ex-one-00-a (Orca adds a number to a taken name)", out)
        self.assertNotIn("worktree", self.row("a"))
        self.assertFalse(any(c.startswith(("orca worktree set", "st ")) for c in self.calls()))
        self.keymap(rows={})
        self.fake(trees=[self.core])
        with patch.object(wg, "checked_out", return_value="main"):  # a checkout that moved to another branch
            out, _ = self.run_dispatch(code=1)
        self.assertIn(f"FAIL child: a: {self.child} is on main, not wg/ex-one-00-a", out)
        self.assertFalse(any(c.startswith(("orca worktree set", "st ")) for c in self.calls()))

    def test_a_failed_spec_write_resumes_with_no_second_track(self):
        self.status = ("Todo", [])
        with patch.object(wg, "write_spec", side_effect=OSError("disk full")):
            self.run_dispatch(code=1)
        self.assertEqual(self.row("a")["step"], "spec")
        self.run_again()  # stax metadata still reads as missing: the resume does not track again
        self.assertEqual([c.split(" --")[0] for c in self.calls()], ["orca orchestration worker-start"])

    def test_claim_send_on_a_held_claim_changes_nothing(self):
        row = BRANCH | {"pr": "7", "dispatch": "d1", "path": "/w"}
        _, err = self.send(row, code=1, live={"a": ("In Review", ["agent:codex"]), "s": "Done"})
        self.assertIn("CD-1: agent:codex holds the claim", err)
        self.assertEqual(self.row("a"), row)
        self.assertEqual(self.calls(), [])
        self.update.assert_not_called()

    def test_a_pending_send_keeps_the_spec_it_sent(self):
        row = BRANCH | {"pr": "7", "dispatch": "d1", "path": "/w"}
        self.send(row, code=1, fail={"orchestration send": "lost-acted"})
        spec = self.d.resolve() / "specs" / "a-review.md"
        sent = spec.read_text()
        work = self.d / "work.md"
        work.write_text("Other work.\n")
        self.fake()
        self.job(wg.claim, "a", "review", "codex", True, str(work), live={"a": ("In Review", ["agent:codex"]), "s": "Done"},
                 rows={"a": self.row("a")})
        self.assertEqual(spec.read_text(), sent)
        self.assertTrue(self.calls()[0].endswith("--retry-request req_1"))
        self.assertEqual(self.state()["jobs"], 1)

    def test_warnings_of_a_first_claim_reach_the_warning_line(self):
        self.status = ("Todo", [])
        real = wg.move

        def move(*args, **kwargs):
            print("node card not updated (down)", file=sys.stderr)
            return real(*args, **kwargs)
        with patch.object(wg, "move", side_effect=move):
            out, err = self.run_dispatch()
        self.assertEqual(err, "warning: node card not updated (down)\n")
        self.assertEqual(len(out.splitlines()), 2)

    def test_an_unknown_start_outcome_with_no_request_id_is_not_started_again(self):
        for failure in ("garbage", "timeout"):
            with self.subTest(failure=failure):
                self.keymap(rows={})
                self.fake(trees=[self.core])
                self.status = ("Todo", [])
                real = wg.command

                def command(*args, cwd=None):
                    if "worker-start" in args:
                        raise subprocess.TimeoutExpired(args, 1)
                    return real(*args, cwd=cwd)
                with patch.object(wg, "command", side_effect=command) if failure == "timeout" else contextlib.nullcontext():
                    out, err = self.run_dispatch(code=1, fail={"orchestration worker-start": "garbage"} if failure == "garbage" else None)
                self.assertIn("FAIL start: ", out)
                self.assertIn("the next call refuses until you look in Orca", err)
                self.assertEqual(self.row("a")["step"], "start")
                self.assertNotIn("retry_request", self.row("a"))
                jobs = self.state()["jobs"]
                _, err = self.run_again(code=1)
                self.assertIn("a: an earlier start stopped with no known outcome from Orca, so a worker may run", err)
                self.assertEqual(self.calls(), [])
                self.assertEqual(self.state()["jobs"], jobs)

    def test_run_and_send_refuse_outside_an_orca_terminal_before_the_claim(self):
        self.status = ("Todo", [])
        with patch.dict(os.environ, {"ORCA_TERMINAL_HANDLE": "", "ORCA_AGENT_SESSION_ID": ""}):
            _, err = self.run_dispatch(code=1)
            self.assertIn("--run needs an Orca terminal", err)
            work = self.d / "work.md"
            work.write_text("Fix it.")
            _, err = self.job(wg.claim, "a", "review", "codex", True, str(work), rows={"a": BRANCH | {"pr": "7", "dispatch": "d1"}},
                              code=1)
            self.assertIn("--send needs an Orca terminal", err)
        self.update.assert_not_called()
        self.assertEqual(self.calls(), [])

    def send(self, row, code=0, fail=None, job="review", live=None, **kwargs):
        self.fake(fail=fail)
        work = self.d / "work.md"
        work.write_text("Fix the two review findings.\n")
        return self.job(wg.claim, "a", job, "codex", True, str(work), live=live or {"a": "In Review", "s": "Done"},
                        rows={"a": row}, code=code, **kwargs)

    def test_claim_send_appends_the_work_sends_the_job_and_records_the_new_ids(self):
        out, _ = self.send(BRANCH | {"pr": "7", "dispatch": "d1", "task": "t1", "worktree": "repo::x", "path": "/w"})
        self.assertEqual(out.splitlines(), ["claimed CD-1 agent:codex for job review", "started a dispatch=ctx_1 job=review"])
        spec = self.d.resolve() / "specs" / "a-review.md"
        self.assertEqual(self.calls(), [f"orca orchestration send --to dispatch:d1 --subject review: #7 --body-file {spec} --json"])
        self.assertTrue(spec.read_text().endswith("\n\nFix the two review findings.\n"))
        row = self.row("a")
        self.assertEqual((row["state"], row["dispatch"], row["task"], row["job"]), ("running", "ctx_1", "task_1", "review"))
        self.assertEqual(self.comment.call_args.args, ("a", "Claimed: dispatch ctx_1, worktree /w, job review"))

    def test_claim_send_resumes_a_lost_send_and_starts_a_new_worker_in_the_recorded_worktree(self):
        row = BRANCH | {"pr": "7", "dispatch": "d1", "path": "/w"}
        self.send(row, code=1, fail={"orchestration send": "lost"})
        self.assertEqual((self.row("a")["state"], self.row("a")["retry_request"]), ("starting", "req_1"))
        self.send(self.row("a"), code=1, fail={"orchestration send": "garbage"},
                  live={"a": ("In Review", ["agent:codex"]), "s": "Done"})
        self.assertEqual(self.row("a")["retry_request"], "req_1")
        out, _ = self.send(self.row("a"), live={"a": ("In Review", ["agent:codex"]), "s": "Done"})
        self.update.assert_not_called()
        self.assertTrue(self.calls()[0].endswith("--json --retry-request req_1"))
        self.assertIn("started a dispatch=ctx_2 job=review", out)
        with patch.object(wg, "restack_line", return_value="target main at abc; base: frozen; parent merged: no"):
            out, _ = self.send(BRANCH | {"pr": "7", "worktree": "repo::w", "model": "m1"}, job="restack")
        self.assertIn("target main at abc; base: frozen; parent merged: no\n", out)
        self.assertIn("orca orchestration worker-start --spec-file ", self.calls()[0])
        self.assertIn("--worktree id:repo::w --agent codex --environment local --model m1 --json", self.calls()[0])
        self.assertEqual((self.row("a")["dispatch"], self.row("a")["worktree"], self.effort["run_id"]), ("ctx_3", "repo::w", "run_1"))

    def test_claim_send_finishes_a_failed_label_and_a_failed_comment_without_a_second_send(self):
        row = BRANCH | {"pr": "7", "dispatch": "d1", "path": "/w"}
        self.send(row, code=1, update=refuse_once("addedLabelIds"))
        self.assertEqual((self.row("a")["state"], self.row("a")["job"]), ("starting", "review"))
        self.assertEqual(self.calls(), [])
        self.send(self.row("a"))  # the label is added now, then the job is sent
        self.assertEqual(self.updates, [("a", {"addedLabelIds": ["L-codex"]})])
        self.assertEqual(self.state()["jobs"], 1)
        self.send(BRANCH | {"pr": "7", "dispatch": "d1", "path": "/w"}, code=1, comments=wg.ReadError("Linear is down"))
        self.assertEqual((self.row("a")["state"], self.row("a")["step"]), ("running", "receipt"))
        out, _ = self.send(self.row("a"), live={"a": ("In Review", ["agent:codex"]), "s": "Done"})
        self.assertEqual(out, "started a dispatch=ctx_2 job=review\n")
        self.assertEqual(self.calls(), [])
        self.assertEqual(self.state()["jobs"], 2)
        self.assertNotIn("step", self.row("a"))

    def test_claim_send_refusals(self):
        out, _ = self.send(BRANCH | {"pr": "7"}, job="ci", code=1)
        self.assertIn("FAIL a: no worktree in the run row for a new worker", out)
        self.send(BRANCH | {"pr": "7", "dispatch": "d1"}, code=1, fail={"orchestration send": "error"})
        self.assertNotIn("step", self.row("a"))
        self.send(self.row("a"), live={"a": ("In Review", ["agent:codex"]), "s": "Done"})  # a refused send is sent again
        _, err = self.send(self.row("a") | {"state": "starting", "step": "send"}, code=1,
                           live={"a": ("In Review", ["agent:codex"]), "s": "Done"})
        self.assertIn("a: an earlier send stopped with no known outcome from Orca", err)

    def test_next_reconciles_a_job_whose_claim_comment_is_missing(self):
        self.send(BRANCH | {"pr": "7", "dispatch": "d1", "path": "/w"}, code=1, comments=wg.ReadError("Linear is down"))
        rows = {"a": self.row("a")}
        with patch.object(wg, "fetch_nodes", return_value=self.issues({"a": ("In Review", ["agent:codex"]), "s": "Done"})), \
             patch.object(wg, "pr_view", return_value={"state": "OPEN"}), patch.object(wg, "project_entries", return_value=[]):
            self.keymap(rows=rows)
            _, lines = wg.next_lines(self.d, self.p)
        self.assertTrue(any("its claim comment is not written" in line for _, line in lines), lines)

    def test_the_cli_needs_a_work_file_for_send_and_one_of_run_and_worktree(self):
        self.keymap()
        _, err = self.call(wg.main, ["wg", "claim", str(self.d), "a", "review", "--send"], code=2)
        self.assertIn("wg claim --send needs --work-file <file>", err)
        _, err = self.call(wg.main, ["wg", "dispatch", str(self.d), "a", "--run", "--worktree", "x"], code=2)
        self.assertIn("not allowed with argument", err)
        self.assertEqual(self.calls(), [])

    def test_printed_forms_keep_the_model_and_the_work_file(self):
        self.job(wg.dispatch, "a", "codex", None, "m2", live={"s": "Done"}, rows={"a": {"approved": "x"}}, effort={"wave": "a"})
        self.assertEqual(self.row("a")["model"], "m2")
        self.assertNotIn("step", self.row("a"))
        out, _ = self.job(wg.dispatch, "a", "codex", str(self.d), live={"s": "Done", "a": "In Progress"}, rows={"a": self.row("a")})
        self.assertIn("--worktree id:<child-id> --agent codex --model m2 --json\n", out)
        work = self.d / "work.md"
        work.write_text("Rebase it.")
        out, _ = self.job(wg.claim, "a", "review", "codex", False, str(work), live={"a": "In Review", "s": "Done"},
                          rows={"a": BRANCH | {"pr": "7", "dispatch": "d1"}})
        self.assertIn("# the work of this job is at its end; then:\n", out)
        self.assertIn("--body \"$(cat ", out)
        self.assertTrue((self.d / "specs" / "a-review.md").read_text().endswith("\n\nRebase it.\n"))
        self.assertEqual(self.calls(), [])

    def test_the_printed_form_finishes_a_claim_whose_move_failed(self):
        with self.assertRaises(wg.ReadError):
            self.job(wg.dispatch, "a", "codex", None, live={"s": "Done"}, rows={"a": {"approved": "x"}}, effort={"wave": "a"},
                     update=refuse_once("stateId"))
        self.assertEqual(wg.run_row(wg.load_keymap(self.d), "a")["step"], "status")
        self.row = lambda key: wg.run_row(wg.load_keymap(self.d), key)
        _, err = self.job(wg.dispatch, "a", "codex", str(self.d), live={"s": "Done", "a": ("Todo", ["agent:codex"])},
                          rows={"a": self.row("a")}, code=1)
        self.assertIn("the claim is not complete", err)
        out, _ = self.job(wg.dispatch, "a", "codex", None, live={"s": "Done", "a": ("Todo", ["agent:codex"])},
                          rows={"a": self.row("a")})
        self.assertEqual(self.updates, [("a", {"stateId": "In Progress"})])
        self.assertNotIn("step", self.row("a"))
        self.assertIn("orca worktree create", out)


class RehearsalTests(unittest.TestCase):
    """One lane of two tasks, an ops node, and a ship point, run with the commands of the skill text, in order.

    Git is real. Linear and GitHub are in memory. Each step asserts what `wg next` prints.
    """

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        # The PR scope and native-stack checks call GitHub; their own tests are PrGuardTests.
        for name, check in (("pr_scope", "scope"), ("pr_stack", "stack")):
            patcher = patch.object(wg, name, return_value=(True, check, "faked"))
            patcher.start()
            self.addCleanup(patcher.stop)
        self.origin, self.d, self.human = self.root / "origin.git", self.root / "ex-core", self.root / "human"
        self.git("init", "-q", "--bare", "-b", "main", str(self.origin), cwd=self.root)
        self.git("clone", "-q", str(self.origin), str(self.d), cwd=self.root)
        for name, value in (("user.name", "Work Graph Test"), ("user.email", "test@example.test")):
            self.git("config", name, value)
        (self.d / "README").write_text("base\n")
        self.git("add", "README")
        self.git("commit", "-q", "-m", "base")
        self.git("push", "-q", "origin", "HEAD:main")
        self.git("clone", "-q", str(self.origin), str(self.human), cwd=self.root)
        self.blob_ref("refs/stax/trunk", "main")
        (self.d / ".git" / "info" / "exclude").write_text("plan.json\nkeymap.json\nevidence/\nspecs/\n")
        keys = ["a", "b", "mp", "ops", "sp"]
        plan = {"effort": {"name": "Example", "slug": "ex", "test": ["sh", "-c", "test ! -f FAIL"]},
                "phases": [{"key": "1", "name": "Phase 1", "target": "main"}],
                "nodes": [node("a", owns=["a/**"]), node("b", owns=["b/**"]), node("mp", "merge-point"),
                          node("ops", "ops"), node("sp", "ship-point")],
                "edges": [edge("b", "a"), edge("mp", "a"), edge("mp", "b"), edge("ops", "mp"), edge("sp", "ops")]}
        self.assertEqual(wg.check(plan), [])
        wg.save_json(self.d / "plan.json", plan)
        wg.save_keymap(self.d, {"project": {"id": "project"}, "milestones": {"1": "p1"},
                                "nodes": {k: {"id": k, "identifier": f"CD-{i + 1}"} for i, k in enumerate(keys)}})
        self.issues = {k: {"state": "Todo", "labels": set()} for k in keys}
        self.comments, self.prs = [], {}
        real_command = wg.command

        def command(*args, cwd=None):
            if args[:3] == ("gh", "pr", "list"):
                found = [{"number": int(n)} for n, pr in self.prs.items()
                         if pr["headRefName"] == args[4] and pr["state"] == "OPEN"]
                return subprocess.CompletedProcess(args, 0, json.dumps(found), "")
            if args[:3] == ("gh", "pr", "checks"):
                return subprocess.CompletedProcess(args, 0, "[]", "")
            if args[0] == wg.orca_cli():
                return self.orca(args[1:], real_command)
            self.assertEqual(args[0], "git")
            return real_command(*args, cwd=cwd)

        for name, fake in (("fetch_nodes", self.fetch_nodes), ("issue_update", self.issue_update), ("gql", self.gql),
                           ("team_info", lambda team: ("cd", {s: s for s in wg.CD_STATUSES}, {})),
                           ("workspace_labels", lambda names: {n: n for n in names}),
                           ("project_entries", lambda *args: []), ("command", command),
                           ("pr_view", lambda pr, fields, cwd=None: self.prs[pr])):
            patcher = patch.object(wg, name, side_effect=fake)
            patcher.start()
            self.addCleanup(patcher.stop)

    # --- the fakes
    def orca(self, args, real_command):
        """Orca's worktree list and rm, on the real git worktrees of the coordinator's repository."""
        if args[:2] == ("worktree", "list"):
            listed = real_command("git", "worktree", "list", "--porcelain", cwd=self.d).stdout.split("\n\n")
            trees = []
            for block in filter(None, (b.strip() for b in listed)):
                fields = dict(line.partition(" ")[::2] for line in block.splitlines())
                path = str(Path(fields["worktree"]).resolve())
                trees.append({"id": f"repo::{path}", "path": path, "branch": fields.get("branch"),
                              "isMainWorktree": path == str(self.d), "childWorktreeIds": []})
            result = {"worktrees": trees, "truncated": False}
        elif args[:3] == ("worktree", "rm", "--worktree"):
            self.assertNotIn("--force", args)
            self.assertNotIn("--delete-branch", args)
            done = real_command("git", "worktree", "remove", args[3].partition("::")[2], cwd=self.d)
            if done.returncode:
                return done
            result = {}
        else:
            self.fail(f"unexpected orca {args}")
        return subprocess.CompletedProcess(args, 0, json.dumps({"ok": True, "result": result}), "")

    def fetch_nodes(self, km):
        kinds = {"Done": "completed", "Canceled": "canceled"}
        return {k: {"state": {"name": i["state"], "type": kinds.get(i["state"], "started")},
                    "labels": {"nodes": [{"name": name, "id": name} for name in sorted(i["labels"])]},
                    "team": {"id": "cd"}, "title": k, "url": f"https://linear.test/{k}"}
                for k, i in self.issues.items()}

    def issue_update(self, issue_id, fields):
        issue = self.issues[issue_id]
        issue["state"] = fields.get("stateId", issue["state"])
        issue["labels"] |= set(fields.get("addedLabelIds", []))
        issue["labels"] -= set(fields.get("removedLabelIds", []))

    def gql(self, query, variables=None):
        if "states(first:50)" in query:
            return {"team": {"states": {"nodes": [{"id": s, "name": s} for s in wg.CD_STATUSES]}}}
        if "issueUpdate" in query:
            self.issues[variables["id"]]["state"] = variables["s"]
            return {"issueUpdate": {"success": True}}
        if "commentCreate" in query:
            self.comments.append((variables["i"]["issueId"], variables["i"]["body"]))
            return {"commentCreate": {"comment": {"id": f"c{len(self.comments)}"}}}
        if "commentUpdate" in query:
            return {"commentUpdate": {"comment": {"id": variables["id"]}}}
        if "projectStatuses" in query:
            return {"project": {"status": {"id": "started", "type": "started", "createdAt": "t"}},
                    "projectStatuses": {"nodes": []}}
        if "issue(id:$id){ description }" in query:
            return {"issue": {"description": f"The design of {variables['id']}."}}
        raise AssertionError(query)

    # --- the people and the tools
    def git(self, *args, cwd=None, input=None):
        return subprocess.run(["git", *args], cwd=cwd or self.d, input=input, capture_output=True, text=True,
                              check=True).stdout.strip()

    def blob_ref(self, ref, value):
        self.git("update-ref", ref, self.git("hash-object", "-w", "--stdin", input=value))

    def wg(self, *args, code=0, cwd=None):
        stdout, stderr = io.StringIO(), io.StringIO()
        head = 2 if args[0] == "run" else 1  # `wg run set <dir>`: the plan directory follows the mode
        argv = ["wg", *args[:head], str(self.d), *args[head:]]
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr), contextlib.chdir(cwd or self.d):
            try:
                self.assertEqual(wg.main(argv), code, stdout.getvalue() + stderr.getvalue())
            except SystemExit as e:
                self.assertEqual(e.code, code, stdout.getvalue() + stderr.getvalue())
        return stdout.getvalue() + stderr.getvalue()

    def next(self):
        """The lines of `wg next`, without the link of the page, which is the last line of each open effort."""
        lines = self.wg("next", "--no-publish").splitlines()
        if lines == [wg.COMPLETE]:
            return lines
        self.assertTrue(lines[-1].startswith("note page https://wg.example.com/?project="), lines[-1])
        # A `do` line that one `wg` command does ends with that command; the lines below compare the rest.
        here, out = wg.shlex.quote(str(Path(self.d).resolve())), []
        for line in lines[:-1]:
            text, arrow, command = line.partition(" -> ")
            if arrow:
                _, verb, key = text.split(" ", 3)[:3]
                self.assertEqual(command, "wg " + wg.DO_COMMANDS[verb.rstrip(":")].format(dir=here, key=key))
            out.append(text)
        return out

    def orca_worktree(self, key, parent):
        """The printed `orca worktree create` and `st branch track` commands."""
        row = wg.run_row(wg.load_keymap(self.d), key)
        path = self.root / row["branch"].replace("/", "-")
        self.git("worktree", "add", "-q", "-b", row["branch"], str(path), row["lower"])
        self.blob_ref(f"refs/branch-metadata/{row['branch']}", json.dumps({"parentBranchName": parent}))
        return path

    def worker(self, key, path, number, base):
        """The worker contract: a commit in owns, the push checks, the push, and the draft PR."""
        (path / key).mkdir(exist_ok=True)
        (path / key / "file.txt").write_text(f"work of {key}\n")
        self.git("add", ".", cwd=path)
        self.git("commit", "-q", "-m", f"feat: {key}", cwd=path)
        self.push(key, path, number, base)

    def push(self, key, path, number, base):
        self.wg("evidence", key, cwd=path)
        branch = self.git("branch", "--show-current", cwd=path)
        self.git("push", "-q", "--force", "origin", branch, cwd=path)
        old = self.prs.get(number, {"isDraft": True, "reviews": [], "comments": []})
        self.prs[number] = old | {"state": "OPEN", "headRefName": branch, "baseRefName": base,
                                  "headRefOid": self.git("rev-parse", "HEAD", cwd=path)}

    def human_merges(self, number):
        pr = self.prs[number]
        self.git("fetch", "-q", "origin", cwd=self.human)
        self.git("checkout", "-q", "-B", "main", "origin/main", cwd=self.human)
        self.git("merge", "-q", "--squash", f"origin/{pr['headRefName']}", cwd=self.human)
        self.git("-c", "user.name=Human", "-c", "user.email=c@example.test", "commit", "-q", "-m", f"squash #{number}",
                 cwd=self.human)
        self.git("push", "-q", "origin", "main", cwd=self.human)
        pr.update(state="MERGED", mergeCommit={"oid": self.git("rev-parse", "HEAD", cwd=self.human)})
        return pr["mergeCommit"]["oid"]

    def test_a_lane_of_two_tasks_from_the_wave_to_the_ship_point(self):
        # SKILL.md step 3: the wave; no approval gate
        self.assertEqual(self.next(), ["phase 1: 2 tasks, 0 code done, 0 reviewed, 0 merged",
                                       "do wave: pick the next wave from a"])
        self.wg("run", "set", "@effort", "wave=a,b")
        self.assertEqual(self.next()[1:], ["do dispatch a CD-1"])

        # coordinator.md "Dispatch"
        out = self.wg("dispatch", "a")
        self.assertIn("orca worktree create --name ex-one-00-a --branch wg/ex-one-00-a --base-branch origin/main", out)
        self.assertEqual(self.issues["a"], {"state": "In Progress", "labels": {"agent:codex"}})
        path_a = self.orca_worktree("a", "main")
        self.assertIn("orca orchestration worker-start --spec-file", self.wg("dispatch", "a", "--worktree", str(path_a)))
        self.assertIn("**Task:** Linear issue `CD-1` (https://linear.test/a), node `a`.", (self.d / "specs" / "a.md").read_text())
        self.assertEqual(self.next()[1:], ["do reconcile a CD-1: state=starting: no receipt of the job is recorded"])
        self.wg("started", "a", "dispatch=d1", "task=t1", "worktree=w1", "run_id=run_1")
        self.assertEqual(self.next()[1:], ["wait worker a CD-1: job=dispatch dispatch=d1"])
        self.assertIn(("a", f"Claimed: dispatch d1, worktree {path_a}, job dispatch"), self.comments)

        # coordinator.md "Job end", then review-and-merge.md "Review"
        self.worker("a", path_a, "1", "main")
        self.assertIn("pass --dispatch <id> of the worker_done", self.wg("done", "a", code=2))
        out = self.wg("done", "a", "--dispatch", "d1")
        self.assertIn("released agent:codex\n", out)
        self.assertIn("code done: a #1 ", out)
        self.assertEqual(self.issues["a"], {"state": "In Review", "labels": set()})
        # code done: the review of a and the dispatch of b, which stacks on a, start at the same time
        self.assertEqual(self.issues["b"]["state"], "Ready")
        self.assertEqual(self.next(), ["phase 1: 2 tasks, 1 code done, 0 reviewed, 0 merged; wave a,b",
                                       "do review a CD-1: #1 round 1", "do dispatch b CD-2"])
        self.wg("run", "set", "a", "review_round=1", "review_dispatch=r1")
        self.assertEqual(self.next()[1:], ["do dispatch b CD-2", "wait reviewer a CD-1: #1 round 1"])
        self.assertIn("branch wg/ex-one-01-b on wg/ex-one-00-a, stax parent wg/ex-one-00-a", self.wg("dispatch", "b"))
        path_b = self.orca_worktree("b", "wg/ex-one-00-a")
        self.wg("dispatch", "b", "--worktree", str(path_b))
        self.wg("started", "b", "dispatch=d2", "task=t2")
        self.wg("run", "set", "a", "review=clean")
        self.assertEqual(self.next()[1:], ["do undraft a CD-1: #1", "wait worker b CD-2: job=dispatch dispatch=d2"])
        self.worker("b", path_b, "2", "wg/ex-one-00-a")
        self.assertIn("code done: b #2 ", self.wg("done", "b", "--dispatch", "d2"))
        self.wg("run", "set", "b", "review_round=1", "review_dispatch=r2")
        self.wg("run", "set", "b", "review=clean")

        # review-and-merge.md "Merge point" steps 1 and 2
        self.assertEqual(self.next(), ["phase 1: 2 tasks, 2 code done, 2 reviewed, 0 merged; wave a,b",
                                       "do undraft a CD-1: #1", "do undraft b CD-2: #2"])
        self.wg("run", "set", "@effort", "merge_prep=human")
        self.assertEqual(self.next()[1:], ["do ask-ready a CD-1: #1", "do ask-ready b CD-2: #2"])
        for key in ("a", "b"):
            self.wg("run", "set", key, "draft=yes")
        self.assertEqual(self.next()[1:], ["wait human: a (mark PR #1 ready for review), b (mark PR #2 ready for review)"])
        for number in ("1", "2"):
            self.prs[number]["isDraft"] = False
        self.assertEqual(self.next()[1:], ["do merge-review a CD-1: #1: request the thorough review",
                                           "do merge-review b CD-2: #2: request the thorough review"])
        for key, number in (("a", "1"), ("b", "2")):
            self.wg("run", "set", key, "merge_review=requested")
            self.prs[number]["reviews"] = [{"body": "thorough review"}]
        self.assertEqual(self.next()[1:], ["do merge-review a CD-1: #1: read the new review",
                                           "do merge-review b CD-2: #2: read the new review"])
        self.assertIn("FAIL a: no merge review of this patch", self.wg("move", "a", "Ready to Merge", code=1))
        for key in ("a", "b"):
            self.wg("run", "set", key, "merge_review=clean")
        self.assertEqual(self.next()[1:], ["do ask-merge a CD-1: #1", "wait below b CD-2: #2 is ready; a merges first"])

        # steps 4 and 5: the merge request, the merge, and the restack of the node above
        self.assertIn("FAIL b: a is below it in the lane and is not merged", self.wg("move", "b", "Ready to Merge", code=1))
        self.wg("move", "a", "Ready to Merge")
        self.assertEqual(self.next()[1], "wait human a CD-1: merge PR #1")
        self.assertIn("FAIL a: PR #1 is OPEN, not MERGED", self.wg("move", "a", "Merged", code=1))
        merged_a = self.human_merges("1")
        self.assertEqual(self.next()[1], f"do merged a CD-1: #1 {merged_a[:10]}")
        out = self.wg("move", "a", "Merged")
        self.assertIn(("a", f"PR #1 merged to `main` as `{merged_a}`."), self.comments)
        # The merged node's worktree goes; its branch stays for stax and the PR.
        self.assertIn(f"removed worktree {path_a} (a)", out)
        self.assertFalse(path_a.exists())
        self.assertEqual(self.git("branch", "--list", "wg/ex-one-00-a").strip(" *\n"), "wg/ex-one-00-a")
        self.assertEqual(self.next()[1:], ["do restack b CD-2: #2: the PR below it merged"])
        out = self.wg("claim", "b", "restack")
        self.assertIn(f"target main at {merged_a}; base: trunk; parent merged: yes", out)
        self.assertIn("orca orchestration send --to dispatch:d2 --subject 'restack: #2'", out)
        self.wg("started", "b", "dispatch=d3")
        # the owner worker: a restack with no conflict, the push checks, the update push
        self.git("fetch", "-q", "origin", cwd=path_b)
        self.git("rebase", "-q", "--onto", "origin/main", "wg/ex-one-00-a", cwd=path_b)
        self.blob_ref("refs/branch-metadata/wg/ex-one-01-b", json.dumps({"parentBranchName": "main"}))
        self.push("b", path_b, "2", "wg/ex-one-00-a")
        self.assertIn("FAIL pr: a below it merged, but the base of PR #2 is wg/ex-one-00-a, not main: restack it",
                      self.wg("done", "b", "--dispatch", "d3", code=1))
        self.assertIn("FAIL b: the base of PR #2 is wg/ex-one-00-a, not main", self.wg("move", "b", "Ready to Merge", code=1))
        self.prs["2"]["baseRefName"] = "main"
        out = self.wg("done", "b")
        self.assertIn("the PR below merged: parent main, lower origin/main\n", out)
        self.assertIn("kept the review: new head, same patch\n", out)
        self.assertEqual(self.next()[1:], ["do ask-merge b CD-2: #2"])
        self.wg("move", "b", "Ready to Merge")
        self.human_merges("2")
        self.wg("move", "b", "Merged")

        # step 6, then review-and-merge.md "Ship point"
        self.assertEqual(self.next(), ["phase 1: 2 tasks, 2 code done, 2 reviewed, 2 merged; wave a,b", "do close mp CD-3"])
        self.wg("move", "mp", "Done")
        self.assertIn(("mp", "All pre-merge PRs are merged to `main`."), self.comments)
        ask, suite = self.next()[1:]
        self.assertEqual(ask, "do ask ops CD-4: ops")
        self.assertIn("do full-suite sp CD-5: no repo-wide test run of phase 1; in a clean worktree at origin/main: ", suite)
        self.assertIn(" evidence ", suite)
        self.git("pull", "-q", "origin", "main", cwd=self.human)  # a clean checkout of the merged target
        self.wg("evidence", "@full-1", cwd=self.human)
        self.assertEqual(self.next()[1:], ["do ask ops CD-4: ops"])
        self.wg("move", "ops", "Needs Human")
        self.assertIn("FAIL ops: a Done ops needs --note", self.wg("move", "ops", "Done", code=1))
        self.wg("move", "ops", "Done", "--note", "be to beta at 10:00; check: smoke; result: pass")
        self.assertEqual(self.next()[1:], ["do verifying sp CD-5"])
        self.wg("move", "sp", "Verifying")
        self.assertEqual(self.next()[1:], ["do ship sp CD-5"])
        self.wg("move", "sp", "Done")
        self.assertEqual({k: i["state"] for k, i in self.issues.items()}, dict.fromkeys(["a", "b", "mp", "ops", "sp"], "Done"))
        self.assertEqual(self.next(), ["every ship point is Done or Canceled"])
        self.assertTrue(all(not i["labels"] for i in self.issues.values()))

    def test_a_review_fix_changes_the_patch_and_brings_the_review_back(self):
        self.wg("run", "set", "@effort", "wave=a")
        self.wg("approve", "a", "--quote", "go")
        self.wg("dispatch", "a")
        path = self.orca_worktree("a", "main")
        self.wg("dispatch", "a", "--worktree", str(path))
        self.wg("started", "a", "dispatch=d1")
        self.worker("a", path, "1", "main")
        self.wg("done", "a", "--dispatch", "d1")
        self.wg("run", "set", "a", "review_round=1", "review_dispatch=r1")
        # blocking findings in round 1: the fix job
        out = self.wg("claim", "a", "review")
        self.assertIn("orca orchestration send --to dispatch:d1 --subject 'review: #1'", out)
        self.assertIn("FAIL a: a job is live: state=starting job=review", self.wg("claim", "a", "ci", code=1))
        self.wg("started", "a", "dispatch=d4")
        (path / "a" / "file.txt").write_text("work of a, fixed\n")
        (path / "FAIL").write_text("the suite fails\n")
        self.git("add", ".", cwd=path)
        self.git("commit", "-q", "-m", "fix: review", cwd=path)
        self.wg("evidence", "a", cwd=path, code=1)
        self.git("push", "-q", "origin", "wg/ex-one-00-a", cwd=path)
        self.prs["1"]["headRefOid"] = self.git("rev-parse", "HEAD", cwd=path)
        self.assertIn("a: the PR head", self.wg("run", "set", "a", "review=clean", code=1))
        self.assertIn("this worker_done is from d1; the job in the run row is d4", self.wg("done", "a", "--dispatch", "d1", code=1))
        out = self.wg("done", "a", "--dispatch", "d4", code=1)
        self.assertIn("FAIL tests: command exit: 1", out)
        self.assertIn("OUT FAIL", out)
        self.assertEqual(self.issues["a"], {"state": "In Review", "labels": set()})
        self.assertEqual(self.next()[1], f"do verify a CD-1: #1 head {self.prs['1']['headRefOid'][:10]} is not code done")
        # the repair job, then round 2
        self.wg("claim", "a", "ci")
        self.wg("started", "a", "dispatch=d5")
        self.git("rm", "-q", "FAIL", cwd=path)
        self.git("commit", "-q", "-m", "fix: suite", cwd=path)
        self.push("a", path, "1", "main")
        out = self.wg("done", "a", "--dispatch", "d5")
        self.assertIn("code done: a #1 ", out)
        self.assertEqual(self.next()[1], "do review a CD-1: #1 round 2")
        row = wg.run_row(wg.load_keymap(self.d), "a")
        self.assertEqual((row.get("state"), row["job"], row["dispatch"]), (None, "ci", "d5"))




class PageTests(unittest.TestCase):
    def test_home_page_link_keeps_the_workspace(self):
        p = {"effort": {"name": "Home project", "workspace": "home"}}
        with patch.dict(wg.os.environ, {}, clear=True):
            self.assertEqual(wg.page_link(p, "HOM-7"), "https://wg.example.com/?project=Home%20project&workspace=home&issue=HOM-7")

    def test_page_link_names_the_effort_and_one_issue(self):
        p = {"effort": {"name": "Migrate X to Y"}}
        with patch.dict(wg.os.environ, {}, clear=False):
            wg.os.environ.pop("WG_UI_URL", None)
            self.assertEqual(wg.page_link(p), "https://wg.example.com/?project=Migrate%20X%20to%20Y")
            self.assertEqual(wg.page_link(p, "CD-7"), "https://wg.example.com/?project=Migrate%20X%20to%20Y&issue=CD-7")
        with patch.dict(wg.os.environ, {"WG_UI_URL": "http://127.0.0.1:4747/"}):
            self.assertEqual(wg.page_link(p), "http://127.0.0.1:4747/?project=Migrate%20X%20to%20Y")

    def test_ui_installs_again_when_the_lockfile_is_newer(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "pnpm-lock.yaml").write_text("a")
            self.assertTrue(wg.ui_needs_install(root))  # no install yet
            (root / "node_modules").mkdir()
            marker = root / "node_modules" / ".modules.yaml"
            marker.write_text("x")
            wg.os.utime(marker, (2000, 2000))
            wg.os.utime(root / "pnpm-lock.yaml", (1000, 1000))
            self.assertFalse(wg.ui_needs_install(root))
            wg.os.utime(root / "pnpm-lock.yaml", (3000, 3000))
            self.assertTrue(wg.ui_needs_install(root))

    def test_ui_uses_the_server_that_already_runs(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "server").mkdir()
            (root / "server" / "main.ts").write_text("")
            out = io.StringIO()
            with patch.dict(wg.os.environ, {"WG_UI_DIR": tmp}), patch.object(wg, "ui_running", return_value=True), \
                    patch.object(wg.subprocess, "run") as run, contextlib.redirect_stdout(out):
                self.assertEqual(wg.ui(4747, "Migrate X", True), 0)
            run.assert_not_called()  # no install, no build, no second server, and --no-open opens nothing
            self.assertIn("already runs: http://127.0.0.1:4747/?project=Migrate%20X", out.getvalue())

    def test_ui_starts_with_only_the_home_key(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "server").mkdir()
            (root / "server" / "main.ts").touch()
            (root / "index.html").touch()
            (root / "dist").mkdir()
            (root / "dist" / "index.html").touch()
            with patch.dict(wg.os.environ, {"WG_UI_DIR": tmp, "LINEAR_HOME_API_KEY": "home"}, clear=True), \
                 patch.object(wg, "ui_running", return_value=False), \
                 patch.object(wg, "ui_needs_install", return_value=False), \
                 patch.object(wg.subprocess, "run") as run:
                run.return_value.returncode = 0
                self.assertEqual(wg.main(["wg", "ui", "--workspace", "home", "--no-open"]), 0)
            run.assert_called_once()
            self.assertEqual(run.call_args.args[0][-3:], ["--workspace", "home", "--no-open"])

    def test_ui_with_only_the_work_key(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "server").mkdir()
            (root / "server/main.ts").touch()
            (root / "index.html").touch()
            (root / "dist").mkdir()
            (root / "dist/index.html").touch()
            with patch.dict(wg.os.environ, {"WG_UI_DIR": tmp, "LINEAR_API_KEY": "ig"}, clear=True), \
                 patch.object(Path, "home", return_value=root), \
                 patch.object(wg, "ui_running", return_value=False), \
                 patch.object(wg, "ui_needs_install", return_value=False), \
                 patch.object(wg.subprocess, "run") as run:
                run.return_value.returncode = 0
                with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
                    wg.main(["wg", "ui", "--workspace", "home", "--no-open"])
                run.assert_not_called()
                self.assertEqual(wg.main(["wg", "ui", "--no-open"]), 0)
                run.assert_called_once()

    def test_ui_running_is_false_when_nothing_answers(self):
        with patch.object(wg.urllib.request, "urlopen", side_effect=OSError("refused")):
            self.assertFalse(wg.ui_running(4747))



class ConfigTests(unittest.TestCase):
    def config(self, data):
        path = Path(tempfile.mkdtemp()) / "config.json"
        if data is not None:
            path.write_text(json.dumps(data))
        return wg.read_config(path)

    def test_no_file_gives_one_default_workspace_and_the_default_human(self):
        config = self.config(None)
        self.assertEqual(config["human"], "Human")
        self.assertEqual([w["id"] for w in config["workspaces"]], ["default"])
        self.assertEqual(config["workspaces"][0]["key_env"], ["LINEAR_API_KEY"])
        self.assertIsNone(config["test_runner"])

    def test_bad_config_stops_with_its_path(self):
        for data in ({"workspaces": [{"id": "A"}]}, {"workspaces": [{"id": "a"}, {"id": "a"}]}, {"human": "x!"}, []):
            with self.assertRaises(SystemExit):
                self.config(data)

    def test_plan_workspace_keeps_each_team_in_its_workspace(self):
        self.assertEqual(wg.plan_workspace({"effort": {}}), "work")
        self.assertEqual(wg.plan_workspace({"effort": {"workspace": "home", "team": "HOM"}}), "home")
        self.assertEqual(wg.plan_workspace({"effort": {"team": "ENG"}}), "work")
        for effort, message in [({"workspace": "home", "team": "CD"}, "home plans must use team HOM"),
                                ({"team": "HOM"}, "team HOM requires effort.workspace home"),
                                ({"workspace": "x"}, "effort.workspace must be one of work, home")]:
            with self.assertRaises(ValueError) as caught:
                wg.plan_workspace({"effort": effort})
            self.assertIn(message, str(caught.exception))

    def test_the_human_name_makes_the_status_label_and_ops_names(self):
        self.assertEqual((wg.WAIT_STATUS, wg.WAIT_LABEL), ("Needs Human", "needs-human"))
        self.assertEqual(wg.human_slug("Ada  Lovelace!"), "ada-lovelace")
        self.assertEqual(wg.OPS_BY, {"human", "coordinator"})

    def test_wg_config_prints_the_config_and_the_rules_path(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(wg.show_config(), 0)
        data = json.loads(out.getvalue())
        self.assertEqual((data["path"], data["wait_status"]), (str(TEST_CONFIG), "Needs Human"))
        self.assertEqual([w["id"] for w in data["config"]["workspaces"]], ["work", "home"])
        self.assertTrue(data["rules"].endswith("rules.md"))

    def test_the_contract_does_not_depend_on_the_config(self):
        with patch.object(wg, "HUMAN", "Ada"), patch.object(wg, "WAIT_LABEL", "needs-ada"):
            self.assertEqual(wg.contract()["labels"]["needs_human"], "needs-human")
            self.assertIn("Needs Human", wg.contract()["statuses"])


class ContractTests(unittest.TestCase):
    def test_v3_exposes_heartbeat_fields_and_tests_both_edge_cases(self):
        contract = wg.contract()
        self.assertEqual(contract["version"], 3)
        self.assertIn("started_at", contract["card"]["fields"])
        self.assertEqual(contract["status_doc"]["fields"],
                         ["status", "wave", "lines", "at", "ran", "wait_interval", "contract"])
        same_lane = next(edge for edge in contract["satisfied"] if edge["name"] == "a task of the same lane")
        self.assertIn("In Review", same_lane["clear"])
        self.assertEqual(same_lane["clear_without_code_done"], ["Merged", "Done", "Canceled"])
        for edge in contract["satisfied"]:
            self.assertLessEqual(set(edge["clear_without_code_done"]), set(edge["clear"]))

    def test_contract_json_is_what_the_code_does(self):
        # A change of a name, the card, or the rule of `satisfied` must come with `wg contract --write`,
        # and with the same file in octo/wg-ui (src/lib/contract.json).
        path = Path(wg.__file__).resolve().parent.parent / "contract.json"
        self.assertEqual(path.read_text(), wg.contract_text(), "run: wg contract --write")

    def test_each_sample_card_carries_its_data_block(self):
        for sample in wg.contract()["card"]["samples"]:
            self.assertTrue(sample["body"].startswith("**work-graph node card**"))
            self.assertIn(json.dumps(sample["data"]), sample["body"])



class PublishTests(unittest.TestCase):
    """`wg next` copies its result to Linear for the page: the node cards and one document of the project."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.d = self.tmp.name
        self.p = {"effort": {"name": "Example"}, "phases": [{"key": "1", "target": "main"}],
                  "nodes": [node("a", lane="x", title="A"), node("b", lane="x", title="B")], "edges": []}
        wg.save_keymap(self.d, {"project": {"id": "proj"}, "milestones": {}, "run": {"effort": {"wave": "a"}, "nodes": {
            "a": {"pr": "7", "code_done_head": "abc", "merge_review": "requested", "job": "review", "state": "failed",
                  "started_at": "2026-01-01T00:00:00Z"},
            "b": {"job": "ci", "state": "running", "started_at": "2026-01-01T00:00:00Z"}}},
            "nodes": {"a": {"id": "ia", "identifier": "CD-1"}, "b": {"id": "ib", "identifier": "CD-2"}}})
        self.lines = [("do", "review a CD-1: #7 round 1"), ("wait", "below b CD-2"), ("note", "triage CD-9: Found")]

    def publish(self, head="phase 1: 2 tasks", *, wait=False, second=0, old_content=None):
        calls = []

        def gql(query, variables=None):
            calls.append((query.split("(")[0].split()[0] + " " + re.search(r"\{\s*(\w+)", query).group(1), variables))
            if query.startswith("query"):
                return {"document": {"content": old_content}}
            return {"commentCreate": {"comment": {"id": "card-" + variables["i"]["issueId"]}}} if "commentCreate" in query else \
                {"commentUpdate": {"comment": {"id": variables.get("id")}}} if "commentUpdate" in query else \
                {"documentCreate": {"document": {"id": "doc"}}, "documentUpdate": {"success": True}}
        err = io.StringIO()
        with patch.object(wg, "gql", side_effect=gql), contextlib.redirect_stderr(err), \
             patch.object(wg, "utc_now", return_value=datetime(2026, 1, 1, 0, 0, second, tzinfo=timezone.utc)), \
             patch.object(wg, "next_lines", return_value=(head, self.lines)), contextlib.redirect_stdout(io.StringIO()):
            wg.next_command(self.d, self.p, wait, 2.5, copy=True)
        self.assertEqual(err.getvalue(), "")
        return calls

    def test_cards_get_the_wave_the_next_action_and_the_run_state(self):
        calls = self.publish()
        cards = {v["i"]["issueId"]: v["i"]["body"] for name, v in calls if name == "mutation commentCreate"}
        a = json.loads(re.search(r"```json\n(.*)\n```", cards["ia"]).group(1))
        self.assertEqual({f: a.get(f) for f in ("pr", "merge_review", "code_done", "wave", "next", "job")},
                         {"pr": "7", "merge_review": "requested", "code_done": "yes", "wave": "yes",
                          "next": "do review: #7 round 1", "job": None})  # the job is over, so the card has none
        b = json.loads(re.search(r"```json\n(.*)\n```", cards["ib"]).group(1))
        self.assertEqual((b.get("wave"), b.get("next")), (None, "wait below"))
        self.assertNotIn("started_at", a)
        self.assertEqual(b["started_at"], "2026-01-01T00:00:00Z")

    def test_first_heartbeat_keeps_the_timestamp_from_a_v1_document(self):
        self.publish()
        km = wg.load_keymap(self.d)
        km["status_doc"].pop("at")
        wg.save_keymap(self.d, km)
        old_content = 'phase 1: 2 tasks\n\n```json\n{"at": "2026-01-01T00:00:00Z"}\n```\n'
        calls = self.publish(second=3, old_content=old_content)
        self.assertEqual([name for name, _ in calls], ["query document", "mutation documentUpdate"])
        heartbeat = json.loads(re.search(r"```json\n(.*)\n```", calls[-1][1]["i"]["content"]).group(1))
        self.assertEqual((heartbeat["at"], heartbeat["ran"]), ("2026-01-01T00:00:00Z", "2026-01-01T00:00:03Z"))

    def test_first_heartbeat_uses_run_time_if_v1_timestamp_is_unavailable(self):
        self.publish()
        km = wg.load_keymap(self.d)
        km["status_doc"].pop("at")
        for read in (wg.ReadError("down"), {"document": {"content": "```json\n{broken}\n```"}}):
            with self.subTest(read=read):
                wg.save_keymap(self.d, km)
                update = {"documentUpdate": {"success": True}}
                with patch.object(wg, "gql", side_effect=[read, update]) as gql, \
                     patch.object(wg, "utc_now", return_value=datetime(2026, 1, 1, 0, 0, 3, tzinfo=timezone.utc)):
                    wg.publish(self.d, self.p, "phase 1: 2 tasks", self.lines)
                self.assertEqual(gql.call_count, 2)
                self.assertEqual(wg.load_keymap(self.d)["status_doc"]["at"], "2026-01-01T00:00:03Z")

    def test_unsuccessful_document_update_warns_and_keeps_the_saved_hash(self):
        self.publish()
        before = wg.load_keymap(self.d)["status_doc"]
        err = io.StringIO()
        with patch.object(wg, "gql", return_value={"documentUpdate": {"success": False}}) as gql, \
             contextlib.redirect_stderr(err):
            wg.publish(self.d, self.p, "phase 1: changed", self.lines)
        self.assertIn("documentUpdate", gql.call_args.args[0])
        self.assertIn("warn next: result not copied to Linear for the page (could not update the status document)",
                      err.getvalue())
        self.assertEqual(wg.load_keymap(self.d)["status_doc"], before)

    def test_two_lines_about_one_node_stay_two_lines(self):
        said = wg.node_next([("do", "ask-merge a CD-1: #7"), ("wait", "human a CD-1: 2 rounds; accept or fix")], {"a": {}})
        self.assertEqual(said, {"a": "do ask-merge: #7\nwait human: 2 rounds; accept or fix"})

    def test_the_status_document_records_each_run_and_dates_result_changes(self):
        first = self.publish()
        doc = next(v["i"] for name, v in first if name == "mutation documentCreate")
        self.assertEqual((doc["title"], doc["projectId"]), ("work-graph status", "proj"))
        data = json.loads(re.search(r"```json\n(.*)\n```", doc["content"]).group(1))
        self.assertEqual((data["status"], data["wave"], data["lines"][2]),
                         ("phase 1: 2 tasks", ["a"], {"level": "note", "text": "triage CD-9: Found"}))
        self.assertEqual(data["at"], "2026-01-01T00:00:00Z")
        self.assertEqual(data["ran"], data["at"])
        self.assertEqual(data["contract"], hashlib.sha256(wg.contract_text().encode()).hexdigest()[:12])
        self.assertNotIn("wait_interval", data)
        [(name, update)] = self.publish(wait=True, second=3)
        self.assertEqual(name, "mutation documentUpdate")
        heartbeat = json.loads(re.search(r"```json\n(.*)\n```", update["i"]["content"]).group(1))
        self.assertEqual(heartbeat, data | {"ran": "2026-01-01T00:00:03Z", "wait_interval": 2.5})
        self.lines[0] = ("do", "ask-merge a CD-1: #7")
        again = self.publish(second=6)
        self.assertEqual([name for name, _ in again], ["mutation commentUpdate", "mutation documentUpdate"])
        changed = json.loads(re.search(r"```json\n(.*)\n```", again[-1][1]["i"]["content"]).group(1))
        self.assertEqual(changed["at"], "2026-01-01T00:00:06Z")
        self.assertEqual(changed["ran"], changed["at"])
        self.assertNotIn("wait_interval", changed)

    def test_tick_publishes_with_or_without_a_run_section(self):
        for has_run in (True, False):
            with self.subTest(has_run=has_run):
                self.check_tick_publication(has_run)

    def check_tick_publication(self, has_run):
        home = Path(self.d) / str(has_run)
        home.mkdir()
        path = home / "example-core"
        path.mkdir()
        p = self.p | {"nodes": self.p["nodes"] + [node("ship", kind="ship-point")]}
        wg.save_json(path / "plan.json", p)
        km = wg.load_keymap(self.d)
        km["nodes"]["ship"] = {"id": "is", "identifier": "CD-3"}
        km["run"]["nodes"] = {}
        km["run"]["effort"]["wave"] = "a"
        if not has_run:
            del km["run"]
        wg.save_keymap(path, km)
        statuses = {"ia": "Ready", "ib": "Needs Human", "is": "Todo"}
        mutations, pending, state = [], [], home / ".local/state/work-graph/tick.json"
        status_doc = {}
        fail_cards = False
        add_triage = False
        accept = True

        def gql(query, variables=None):
            if "issues(first:25" in query:
                return {"issues": {"nodes": [
                    {"id": key, "identifier": "CD-" + str(i), "title": key, "state": {
                        "name": name, "type": "completed" if name == "Done" else "started"}}
                    for i, (key, name) in enumerate(statuses.items(), 1)
                ]}}
            if query.startswith("query") and "document" in query:
                return {"document": {"content": status_doc["content"]}}
            if query.startswith("query") and "project" in query:
                rows = [{"id": "it", "identifier": "CD-9", "title": "Triage", "state": {"name": "Triage"}}] if add_triage else []
                return {"project": {"issues": {"nodes": rows, "pageInfo": {"hasNextPage": False}}}}
            name = re.search(r"\{\s*(\w+)", query).group(1)
            mutations.append(name)
            if name in {"commentCreate", "commentUpdate"}:
                return {name: {"success": not fail_cards, "comment": {"id": variables.get("id", "card")}}}
            if name in {"documentCreate", "documentUpdate"}:
                status_doc.update(variables["i"])
                return {name: {"success": True, "document": {"id": "doc"}}}
            self.fail(f"unexpected mutation {name}")

        def acknowledge(page, entries):
            pending.append((page, [item["issue"] for item in entries]))
            self.assertTrue(json.loads(state.read_text())["work/proj"]["pending"])
            return accept

        def tick(code=0):
            with contextlib.redirect_stdout(io.StringIO()) as out:
                self.assertEqual(wg.main(["wg", "tick", "--root", str(home), "--root", str(home)]), code,
                                 out.getvalue())
            self.assertEqual(len(out.getvalue().splitlines()), 1)
            return out.getvalue()

        now = datetime(2026, 1, 1, tzinfo=timezone.utc)
        with patch.object(Path, "home", return_value=home), patch.dict(wg.os.environ, {"LINEAR_API_KEY": "ig"}, clear=True), \
             patch.object(wg, "gql", side_effect=gql), patch.dict(wg.TICK_CHANNELS, {"none": acknowledge}), \
             patch.object(wg, "utc_now", return_value=now) as clock, patch.object(wg.subprocess, "run") as run:
            tick()
            action = "`do` dispatch a CD-1" if has_run else "`do` wave: pick the next wave"
            self.assertIn(action, status_doc["content"])
            self.assertFalse(pending)
            self.assertEqual(state.stat().st_mode & 0o777, 0o600)
            mutations.clear()
            clock.return_value = now.replace(second=10)
            tick()
            self.assertEqual(mutations, ["documentUpdate"])
            self.assertIn('"ran": "2026-01-01T00:00:10Z"', status_doc["content"])
            mutations.clear()
            status_doc["content"] = status_doc["content"].replace('"ran":', '"wait_interval": 60, "ran":')
            self.assertIn("coordinator listening", tick())
            self.assertFalse(mutations)

            clock.return_value = now.replace(minute=4)
            statuses["ia"] = "Ready to Merge"
            fail_cards = True
            self.assertIn("could not write the node card", tick(1))
            self.assertNotIn("documentUpdate", mutations)
            self.assertFalse(pending)
            fail_cards = False
            accept = False
            self.assertIn("channel did not accept", tick(1))
            self.assertEqual(pending[-1][1], ["CD-1"])
            accept = True
            tick()
            self.assertEqual(pending[-1][1], ["CD-1"])
            self.assertEqual(len(pending), 2)
            tick()
            statuses["ia"] = "Ready"
            tick()
            statuses["ia"] = "Ready to Merge"
            add_triage = True
            tick()
            self.assertEqual(pending[-1][1], ["CD-1", "CD-9"])
            self.assertEqual(len(pending), 3)

            statuses["is"] = "Done"
            tick()
            self.assertIn(wg.COMPLETE, status_doc["content"])
            mutations.clear()
            self.assertIn("skipped: complete", tick())
            self.assertFalse(mutations)
            statuses["is"] = "Todo"
            tick()
            self.assertIn("documentUpdate", mutations)
            run.assert_not_called()
            self.assertEqual(wg.load_keymap(path).get("run"), km.get("run"))

    def test_tick_discards_stale_results_before_publishing(self):
        path = Path(self.d)
        wg.save_json(path / "plan.json", self.p)
        before = wg.load_keymap(path)
        changed = wg.load_keymap(path)
        changed["run"]["effort"]["wave"] = "b"
        wg.save_keymap(path, changed)
        with patch.object(wg, "gql") as gql:
            self.assertEqual(wg.publish(path, self.p, "phase 1", self.lines, expected=before), "inputs changed")
        gql.assert_not_called()

    def test_tick_none_clears_pending_without_delivery(self):
        path = Path(self.d)
        wg.save_json(path / "plan.json", self.p)
        state = {"work/proj": {"members": {}}}
        items = {"ia": {"issue": "CD-1", "reason": "Needs Human"}}
        saved = []

        def save():
            saved.append(bool(state["work/proj"]["pending"]))

        with patch.dict(wg.os.environ, {"LINEAR_API_KEY": "ig"}, clear=True), \
             patch.object(wg, "tick_refresh", return_value=(None, items)):
            self.assertEqual(wg.tick_effort(path, state, save, wg.TICK_CHANNELS["none"]), "ok")
        self.assertEqual(saved, [True, False])
        self.assertEqual(state["work/proj"]["members"], items)

    def test_tick_continues_after_a_missing_key_and_a_failed_effort(self):
        home = Path(self.d)
        for name, workspace in (("a", "home"), ("b", "work"), ("c", "work")):
            path = home / f"{name}-core"
            path.mkdir()
            wg.save_json(path / "plan.json", {"effort": {"name": name, "workspace": workspace}})
            wg.save_keymap(path, {"project": {"id": name}, "nodes": {"a": {"id": "ia"}}})

        def refresh(path, plan, km, record):
            self.assertEqual(wg.LINEAR_WORKSPACE.get(), "work")
            if path.name == "b-core":
                raise wg.ReadError("request failed")
            return None, {}

        with patch.object(Path, "home", return_value=home), patch.dict(wg.os.environ, {}, clear=True), \
             patch.object(wg, "tick_refresh", side_effect=refresh), contextlib.redirect_stdout(io.StringIO()) as out:
            key = home / ".config/work-graph/work-linear-api-key"
            key.parent.mkdir(parents=True)
            key.write_text("test")
            key.chmod(0o600)
            self.assertEqual(wg.main(["wg", "tick", "--root", str(home)]), 1)
            self.assertEqual([line.split(": ", 1)[1] for line in out.getvalue().splitlines()],
                             ["error: ReadError: no Linear key for home: set LINEAR_HOME_API_KEY",
                              "error: ReadError: request failed", "ok"])

    def test_tick_reports_disappearing_plan_and_unexpected_errors_then_continues(self):
        home = Path(self.d).resolve()
        for name in ("a", "b", "c", "d", "e"):
            path = home / f"{name}-core"
            path.mkdir()
            wg.save_json(path / "plan.json", {"effort": {"name": name}})
            wg.save_keymap(path, {"project": {"id": name}, "nodes": {"a": {"id": "ia"}}})

        def refresh(path, plan, km, record):
            if path.name == "a-core":
                wg.shutil.rmtree(home / "b-core")
            if path.name == "c-core":
                raise RuntimeError("refresh failed")
            if path.name == "d-core":
                raise SystemExit("cannot refresh")
            return None, {}

        with patch.object(Path, "home", return_value=home), \
             patch.dict(wg.os.environ, {"LINEAR_API_KEY": "ig"}, clear=True), \
             patch.object(wg, "tick_refresh", side_effect=refresh), \
             contextlib.redirect_stderr(io.StringIO()), contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(wg.main(["wg", "tick", "--root", str(home)]), 1)
        self.assertEqual([line.removeprefix(f"{home}/") for line in out.getvalue().splitlines()],
                         ["a-core: ok", f"b-core: error: FileNotFoundError: no plan.json in {home / 'b-core'}",
                          "c-core: error: RuntimeError: refresh failed",
                          "d-core: error: SystemExit: cannot refresh", "e-core: ok"])

    def test_tick_trims_only_logs_over_one_megabyte(self):
        home = Path(self.d)
        log = home / "Library/Logs/wg-tick"
        log.mkdir(parents=True)
        out, err = log / "out.log", log / "error.log"
        tail = b"b" * (200 * 1024)
        out.write_bytes(b"a" * (1024 * 1024) + tail)
        err.write_bytes(b"c" * (1024 * 1024))
        with patch.object(Path, "home", return_value=home):
            self.assertEqual(wg.main(["wg", "tick", "--root", str(home)]), 0)
            self.assertEqual(out.read_bytes(), tail)
            self.assertEqual(err.read_bytes(), b"c" * (1024 * 1024))
            err.write_bytes(b"d" * (1024 * 1024) + tail)
            self.assertEqual(wg.main(["wg", "tick", "--root", str(home)]), 0)
            self.assertEqual(err.read_bytes(), tail)

    def test_key_file_warns_for_group_or_other_read_permissions(self):
        home = Path(self.d)
        key = home / ".config/work-graph/work-linear-api-key"
        key.parent.mkdir(parents=True)
        key.write_text("test-secret")
        with patch.object(Path, "home", return_value=home), patch.dict(wg.os.environ, {}, clear=True):
            for mode in (0o600, 0o640, 0o604):
                with self.subTest(mode=oct(mode)), contextlib.redirect_stderr(io.StringIO()) as err:
                    key.chmod(mode)
                    self.assertEqual(wg.linear_key("work"), "test-secret")
                    if mode == 0o600:
                        self.assertEqual(err.getvalue(), "")
                    else:
                        self.assertIn(f"warn: {key}", err.getvalue())
                        self.assertNotIn("test-secret", err.getvalue())

    def test_tick_install_writes_an_unloaded_calendar_agent(self):
        home = Path(self.d)
        cellar = home / "Cellar"
        (home / "python-bin").mkdir()
        cellar.mkdir()
        python, gh = home / "python-bin/python3", home / "gh"
        python.symlink_to(cellar / "python3")
        gh.symlink_to(cellar / "gh")
        with patch.object(Path, "home", return_value=home), \
             patch.object(wg.sys, "executable", str(python)), \
             patch.object(wg.shutil, "which", return_value=str(gh)), \
             patch.object(wg, "command", return_value=Mock(returncode=0, stdout="octo\n")), \
             contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(wg.main(["wg", "tick", "--install"]), 0)
            path = Path(self.d) / "Library/LaunchAgents/dev.work-graph.tick.plist"
            data = wg.plistlib.loads(path.read_bytes())
            self.assertEqual(data["StartCalendarInterval"], [{"Minute": m} for m in (0, 15, 30, 45)])
            self.assertTrue(data["RunAtLoad"])
            args = data["ProgramArguments"]
            self.assertEqual(args[0], str(python))
            self.assertEqual(args[-1], "tick")
            env = data["EnvironmentVariables"]
            self.assertEqual(env, {"PATH": f"{home}:{python.parent}:/usr/bin:/bin:/usr/sbin:/sbin", "GH_PROMPT_DISABLED": "1"})
            for value in (args[0], args[2], data["StandardOutPath"], data["StandardErrorPath"],
                          *env["PATH"].split(":")):
                self.assertTrue(Path(value).is_absolute(), value)
            self.assertIn("launchctl bootstrap", out.getvalue())
            self.assertEqual(wg.main(["wg", "tick", "--uninstall"]), 0)
            self.assertFalse(path.exists())
            self.assertIn("launchctl bootout", out.getvalue())

    def test_a_linear_failure_is_a_warning(self):
        err = io.StringIO()
        with patch.object(wg, "gql", side_effect=wg.ReadError("down")), contextlib.redirect_stderr(err):
            wg.publish(self.d, self.p, "phase 1", self.lines)
        self.assertIn("warn next: result not copied to Linear for the page (down)", err.getvalue())


class AutonomyTests(DirTests):
    def setUp(self):
        super().setUp()
        km = wg.load_keymap(self.d)
        km["project"] = {"id": "p", "url": "u"}
        wg.save_keymap(self.d, km)
        self.plan = {"effort": {"name": "Example", "team": "CD"}}
        self.level = None
        self.sets = []

    def gql(self, query, variables=None):
        if "project(id" in query:
            on = [{"name": self.level, "parent": {"name": "Autonomy"}}] if self.level else []
            return {"project": {"labels": {"nodes": on + [{"name": "Tooling", "parent": {"name": "initiative"}}]}}}
        raise AssertionError(query)

    def sync(self, group, description, noun, team_id, project_id, name, apply, changes, team_scoped=True):
        self.sets.append((group, name, team_scoped))
        self.level = name

    def lines(self):
        with patch.object(wg, "gql", side_effect=self.gql), patch.object(wg, "sync_project_label", side_effect=self.sync), \
             patch.object(wg, "team_info", return_value=("cd", {}, {})):
            return AUTONOMY_LINES(self.d, self.plan)

    def test_no_label_is_standard_and_a_change_on_the_page_is_a_do_line(self):
        self.assertEqual(self.lines(), [("note", "autonomy @effort -: standard")])
        self.assertEqual(self.lines(), [("note", "autonomy @effort -: standard")])
        self.level = "full"
        [(level, text)] = self.lines()
        self.assertEqual(level, "do")
        self.assertIn("to full (was standard)", text)
        self.assertEqual(self.lines(), [("note", "autonomy @effort -: full")])

    def test_the_old_run_row_level_moves_to_the_project_label(self):
        km = wg.load_keymap(self.d)
        wg.run_rows(km)["effort"].update(autonomy="supervised", autonomy_seen="supervised")
        wg.save_keymap(self.d, km)
        self.assertEqual(self.lines(), [("note", "autonomy @effort -: supervised")])
        self.assertEqual(self.sets, [("autonomy", "supervised", True)])
        self.assertNotIn("autonomy", wg.run_rows(wg.load_keymap(self.d))["effort"])

    def test_wg_autonomy_sets_the_label_and_marks_it_seen(self):
        out = io.StringIO()
        with patch.object(wg, "gql", side_effect=self.gql), patch.object(wg, "sync_project_label", side_effect=self.sync), \
             patch.object(wg, "team_info", return_value=("cd", {}, {})), contextlib.redirect_stdout(out):
            wg.autonomy_command(self.d, self.plan, "full")
            wg.autonomy_command(self.d, self.plan, None)
        self.assertEqual(out.getvalue(), "autonomy full (was standard)\nautonomy full\n")
        self.assertEqual(self.sets, [("autonomy", "full", True)])
        self.assertEqual(self.lines(), [("note", "autonomy @effort -: full")])

    def test_a_read_error_keeps_the_last_level(self):
        with patch.object(wg, "gql", side_effect=wg.ReadError("down")):
            [(level, text)] = AUTONOMY_LINES(self.d, self.plan)
        self.assertEqual(level, "note")
        self.assertIn("level not read", text)

    def test_the_page_command_autonomy_gives_no_line_of_its_own(self):
        lines, settled = wg.link_lines([{"id": "m", "type": "command", "payload": {"name": "autonomy", "key": None, "issue": None}}], {}, self.d)
        self.assertEqual((lines, settled), ([], ["m"]))


if __name__ == "__main__":
    unittest.main()


try:
    import websockets.sync.server as ws_server
except ImportError:  # run with `uv run --script` or with websockets installed
    ws_server = None


@unittest.skipUnless(ws_server, "the websockets package is not installed")
class LinkTests(unittest.TestCase):
    """`wg next` and the page server (`/api/link`, protocol wg-link/1)."""

    def setUp(self):
        import threading
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.d = self.tmp.name
        self.p = {"effort": {"name": "Example"}, "phases": [{"key": "1", "target": "main"}],
                  "nodes": [node("a", lane="x", title="A")], "edges": []}
        wg.save_keymap(self.d, {"project": {"id": "proj"}, "milestones": {}, "nodes": {"a": {"id": "ia", "identifier": "CD-1"}}})
        self.got, self.requests, self.to_send, self.conns = [], [], [], []
        self.event = threading.Event()

        def handler(conn):
            self.requests.append(conn.request)
            self.conns.append(conn)
            for raw in conn:
                m = json.loads(raw)
                self.got.append(m)
                self.event.set()
                if m["type"] == "state" and m["payload"]["mode"] == "waiting":
                    while self.to_send:
                        conn.send(json.dumps(self.to_send.pop(0)))
        self.server = ws_server.serve(handler, "127.0.0.1", 0)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.shutdown)
        port = self.server.socket.getsockname()[1]
        env = patch.dict(os.environ, {"WG_LINK": "on", "WG_UI_URL": f"http://127.0.0.1:{port}"})
        env.start()
        self.addCleanup(env.stop)

    def run_next(self, results, *, wait=False, interval=30):
        out, err = io.StringIO(), io.StringIO()
        with patch.object(wg, "next_lines", side_effect=results), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            start = time.monotonic()
            wg.next_command(self.d, self.p, wait, interval)
        return out.getvalue(), err.getvalue(), time.monotonic() - start

    def types(self):
        return [m["type"] for m in self.got]

    def test_next_says_hello_and_reports_its_state_without_an_origin(self):
        out, err, _ = self.run_next([("phase 1: 1 task", [("do", "dispatch a CD-1")])])
        self.assertIn("do dispatch a CD-1", out)
        self.assertEqual(err, "")
        for _ in range(50):
            if "state" in self.types():
                break
            time.sleep(0.02)
        self.assertEqual(self.types()[:2], ["hello", "state"])
        hello = self.got[0]["payload"]
        self.assertEqual((hello["plan"], len(hello["session"])), (str(Path(self.d).resolve()), 12))
        self.assertEqual(self.got[1]["payload"]["mode"], "working")
        query = dict(urllib.parse.parse_qsl(self.requests[0].path.split("?", 1)[1]))
        self.assertEqual(query, {"role": "coordinator", "workspace": "work", "project": "proj"})
        self.assertIsNone(self.requests[0].headers.get("Origin"))

    def test_a_change_wakes_a_waiting_next_at_once_and_is_acknowledged(self):
        self.to_send.append({"v": 1, "type": "changed", "id": "m1", "project": {"workspace": "work", "id": "proj"},
                             "at": "", "payload": {"by": "page", "what": "status", "issues": ["CD-1"]}})
        out, _, took = self.run_next([("phase 1", [("wait", "human a CD-1: A")]),
                                      ("phase 1", [("do", "dispatch a CD-1")])], wait=True, interval=30)
        self.assertIn("do dispatch a CD-1", out)
        self.assertLess(took, 5)  # not the 30 s poll
        for _ in range(50):
            if "ack" in self.types():
                break
            time.sleep(0.02)
        self.assertIn({"ids": ["m1"]}, [m["payload"] for m in self.got if m["type"] == "ack"])

    def test_without_a_server_next_polls_and_warns_once(self):
        self.server.shutdown()
        self.server.socket.close()
        out, err, _ = self.run_next([("phase 1", [("wait", "worker a")]), ("phase 1", [("do", "dispatch a CD-1")])],
                                    wait=True, interval=0.1)
        self.assertIn("do dispatch a CD-1", out)
        self.assertEqual(err.count("warn link:"), 1)
        self.assertIn("Polling Linear instead", err)

    def wait_for(self, kind):
        for _ in range(100):
            if kind in self.types():
                return True
            time.sleep(0.02)
        return False

    def test_after_a_reconnect_the_link_sends_its_last_state_asks_and_progress_again(self):
        # A deploy restarts the server, which forgets the state; without it the page says "not listening".
        link = wg.Link.open(self.d, self.p)
        self.addCleanup(link.close)
        state = {"mode": "waiting", "head": "phase 1", "lines": [{"level": "wait", "text": "worker a"}]}
        link.send("state", state)
        link.send("asks", {"asks": []})
        link.send("progress", {"nodes": []})
        self.assertTrue(self.wait_for("progress"))
        self.got.clear()
        self.conns[0].close()
        for _ in range(100):
            if link.ws is None:
                break
            time.sleep(0.02)
        self.assertIsNone(link.ws)
        link.retry_at = 0
        self.assertTrue(link.connect())
        self.assertTrue(self.wait_for("progress"))
        self.assertEqual(self.types(), ["hello", "state", "asks", "progress"])
        self.assertEqual(self.got[1]["payload"], state)
        link.send("state", state)  # a send that does not reconnect sends once
        for _ in range(100):
            if len(self.got) >= 5:
                break
            time.sleep(0.02)
        time.sleep(0.1)
        self.assertEqual(self.types(), ["hello", "state", "asks", "progress", "state"])

    def test_a_write_to_linear_is_reported_with_wrote_and_no_hello(self):
        wg.LINEAR_WRITES.update(any=False, ids=set())
        wg.note_write("query($id:String!){ issue(id:$id){ id } }", {"id": "ia"}, {})
        wg.note_write("mutation($i:DocumentUpdateInput!){ documentUpdate(id:$id,input:$i){ success } }", {"id": "doc"}, {})
        self.assertFalse(wg.flush_writes(self.d, self.p))  # reads and the status document are not writes for the page
        wg.note_write("mutation($id:String!,$s:String!){ issueUpdate(id:$id, input:{stateId:$s}){ success } }",
                      {"id": "ia", "s": "state"}, {"issueUpdate": {"success": True}})
        wg.note_write("mutation($i:CommentCreateInput!){ commentCreate(input:$i){ comment{id} } }",
                      {"i": {"issueId": "unknown", "body": "x"}}, {})
        self.assertTrue(wg.flush_writes(self.d, self.p))
        self.assertTrue(self.wait_for("wrote"))
        self.assertEqual(self.types(), ["wrote"])
        self.assertEqual(self.got[0]["payload"], {"issues": ["CD-1"]})
        self.assertIsNone(self.requests[0].headers.get("Origin"))
        self.assertEqual(wg.LINEAR_WRITES, {"any": False, "ids": set()})
        self.assertFalse(wg.flush_writes(self.d, self.p))  # sent once

    def test_next_reports_a_write_on_its_open_link(self):
        wg.LINEAR_WRITES.update(any=True, ids={"ia"})
        self.run_next([("phase 1", [("do", "dispatch a CD-1")])])
        self.assertTrue(self.wait_for("state"))
        self.assertEqual(self.types()[:3], ["hello", "wrote", "state"])
        self.assertEqual(len(self.requests), 1)

    def test_a_write_is_not_reported_without_a_link(self):
        wg.LINEAR_WRITES.update(any=True, ids={"ia"})
        with patch.dict(os.environ, {"WG_LINK": "off"}):
            self.assertFalse(wg.flush_writes(self.d, self.p))
        self.assertEqual(self.got, [])

    def test_the_link_is_off_on_request(self):
        with patch.dict(os.environ, {"WG_LINK": "off"}):
            self.assertIsNone(wg.Link.open(self.d, self.p))

    def test_an_answer_in_the_page_wakes_the_coordinator_with_a_do_line(self):
        self.to_send.append({"v": 1, "type": "answer", "id": "m2", "project": {"workspace": "work", "id": "proj"},
                             "at": "", "payload": {"issue": "CD-1", "key": "a", "body": "Use the v2 API.\nKeep v1 for a week."}})
        out, _, took = self.run_next([("phase 1", [("wait", "human a CD-1: A")])] * 2, wait=True, interval=30)
        self.assertIn("do answer a CD-1: Use the v2 API. / Keep v1 for a week.", out)
        self.assertLess(took, 5)
        for _ in range(50):
            if "ack" in self.types():
                break
            time.sleep(0.02)
        self.assertIn({"ids": ["m2"]}, [m["payload"] for m in self.got if m["type"] == "ack"])
        self.assertEqual(wg.node_next([("do", "answer a CD-1: Use the v2 API.")], {"a": {}}), {"a": "do answer: Use the v2 API."})

    def test_an_answer_in_linear_and_its_message_give_one_line(self):
        self.to_send.append({"v": 1, "type": "answer", "id": "m3", "project": {"workspace": "work", "id": "proj"},
                             "at": "", "payload": {"issue": "CD-1", "key": "a", "body": "Use v2."}})
        # The first round waits, so the server sends the message; the second round has both the label and the message.
        with patch.object(wg, "answer_lines", side_effect=[[], [("do", "answer a CD-1: Use v2.")]]):
            out, _, _ = self.run_next([("phase 1", [("wait", "human a CD-1: A")])] * 3, wait=True, interval=30)
        self.assertEqual(out.count("do answer a CD-1"), 1)

    def test_an_answer_with_no_key_takes_the_key_of_its_issue_from_the_keymap(self):
        lines, settled = wg.link_lines([{"id": "m", "type": "answer", "payload": {"issue": "CD-1", "key": None, "body": "ok"}}], {"CD-1": "a"})
        self.assertEqual((lines, settled), ([("do", "answer a CD-1: ok")], ["m"]))


class AskTests(unittest.TestCase):
    """Worker questions in Orca, shown on the page, and the replies that come back from it."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.d = self.tmp.name
        wg.save_keymap(self.d, {"project": {"id": "proj"}, "milestones": {}, "nodes": {"a": {"id": "ia", "identifier": "CD-1"}},
                                "run": {"effort": {}, "nodes": {"a": {"dispatch": "ctx_1", "run_id": "run_1", "state": "running"}}}})
        self.inbox = {"ok": True, "result": {"messages": [
            {"id": "msg_q", "type": "question", "from": "ctx_1", "handled": False, "body": "Which API?", "payload": {"dispatchId": "ctx_1"}},
            {"id": "msg_done", "type": "question", "from": "ctx_1", "handled": True, "body": "Old", "payload": {"dispatchId": "ctx_1"}},
            {"id": "msg_other", "type": "question", "from": "ctx_9", "handled": False, "body": "Not ours", "payload": {"dispatchId": "ctx_9"}},
            {"id": "msg_s", "type": "status", "from": "run:run_1", "handled": False, "body": "x"}]}}

    def test_open_asks_are_the_unhandled_questions_of_the_effort_workers(self):
        calls = []

        def fake(*args, cwd=None):
            calls.append(args)
            return subprocess.CompletedProcess(args, 0, json.dumps(self.inbox), "")
        with patch.object(wg, "command", side_effect=fake):
            asks = wg.open_asks(self.d)
        self.assertEqual([(a["id"], a["key"], a["issue"], a["body"], a["run"]) for a in asks], [("msg_q", "a", "CD-1", "Which API?", "run_1")])
        self.assertEqual(calls[0][1:5], ("orchestration", "inbox", "--run", "run_1"))

    def test_a_failing_orca_gives_no_asks(self):
        with patch.object(wg, "command", side_effect=OSError("no orca")):
            self.assertEqual(wg.open_asks(self.d), [])

    def test_a_reply_goes_to_the_worker_and_is_a_note(self):
        ran = []

        def run(args, input=None, **kw):
            ran.append((args, input))
            return subprocess.CompletedProcess(args, 0, "{}", "")
        with patch.object(wg.subprocess, "run", side_effect=run):
            line = wg.relay_reply(self.d, {"ask": "msg_q", "key": "a", "issue": "CD-1", "body": "Use v2.", "run": "run_1"})
        self.assertEqual(line, ("note", "replied a CD-1: Use v2."))
        self.assertEqual(ran[0][0][1:5], ["orchestration", "reply", "--id", "msg_q"])
        self.assertIn("--run", ran[0][0])
        self.assertEqual(ran[0][1], "Use v2.")

    def test_a_reply_that_orca_refuses_is_a_do_line_for_the_coordinator(self):
        with patch.object(wg.subprocess, "run", return_value=subprocess.CompletedProcess([], 1, "", "no such message")):
            level, text = wg.relay_reply(self.d, {"ask": "msg_q", "key": "a", "issue": "CD-1", "body": "Use v2.", "run": "run_1"})
        self.assertEqual(level, "do")
        self.assertTrue(text.startswith("relay a CD-1: send this reply to msg_q yourself (no such message): Use v2."))


class CommandTests(unittest.TestCase):
    """Commands from the page: dispatch, pause, resume, next."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.d = self.tmp.name
        wg.save_keymap(self.d, {"project": {"id": "proj"}, "milestones": {}, "nodes": {"a": {"id": "ia", "identifier": "CD-1"}}})

    def command(self, name, key=None):
        return wg.link_lines([{"id": name, "type": "command", "payload": {"name": name, "key": key, "issue": "CD-1" if key else None}}], {}, self.d)

    def test_dispatch_is_a_do_line(self):
        self.assertEqual(self.command("dispatch", "a"), ([("do", "dispatch a CD-1: Human asked for it on the page")], ["dispatch"]))

    def test_next_gives_no_line(self):
        self.assertEqual(self.command("next"), ([], ["next"]))

    def test_the_pause_label_holds_the_do_lines_until_resume(self):
        lines = [("do", "dispatch a CD-1"), ("wait", "worker b CD-2")]
        plan = {"effort": {"name": "Example"}}
        self.assertEqual(self.command("pause")[0], [("note", "paused @effort -: on the page")])
        self.assertNotIn("paused", wg.run_rows(wg.load_keymap(self.d))["effort"])  # the page set the label
        with patch.object(wg, "project_paused", return_value=True):
            self.assertEqual(wg.paused_lines(self.d, plan, lines), [("wait", "worker b CD-2"),
                             ("wait", "paused @effort -: Human paused this effort on the page; 1 action(s) wait for Resume")])
        with patch.object(wg, "project_paused", return_value=False):
            # The first run after Resume wakes the coordinator with one `do resumed` line; later runs do not.
            resumed = wg.paused_lines(self.d, plan, lines)
            self.assertEqual(resumed[0][0], "do")
            self.assertTrue(resumed[0][1].startswith("resumed @effort -: Human resumed"))
            self.assertEqual(resumed[1:], lines)
            self.assertEqual(wg.paused_lines(self.d, plan, lines), lines)

    def test_a_run_row_pause_from_before_the_label_moves_to_the_label(self):
        km = wg.load_keymap(self.d)
        wg.run_rows(km)["effort"]["paused"] = "yes"
        wg.save_keymap(self.d, km)
        plan = {"effort": {"name": "Example"}}
        with patch.object(wg, "project_paused", return_value=False), patch.object(wg, "set_project_paused") as label:
            self.assertTrue(wg.effort_paused(self.d, plan))
        label.assert_called_once_with(plan, "proj", True)
        effort = wg.run_rows(wg.load_keymap(self.d))["effort"]
        self.assertEqual((effort.get("paused"), effort.get("paused_seen")), (None, "yes"))

    def test_when_linear_cannot_be_read_the_last_pause_stands(self):
        plan = {"effort": {"name": "Example"}}
        with patch.object(wg, "project_paused", return_value=True):
            self.assertTrue(wg.effort_paused(self.d, plan))
        with patch.object(wg, "project_paused", side_effect=wg.ReadError("Linear request failed")):
            self.assertTrue(wg.effort_paused(self.d, plan))


class WakeTests(unittest.TestCase):
    """`wg wake`: the precheck that lets the autostart automation start a coordinator agent."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.d = str(Path(self.tmp.name, "effort-core").resolve())
        Path(self.d).mkdir()
        wg.save_keymap(self.d, {"project": {"id": "proj"}, "milestones": {}, "nodes": {"a": {"id": "ia", "identifier": "CD-1"}}})
        self.plan = {"effort": {"name": "Example"}}
        self.state = Path(self.tmp.name, "wake.json")
        self.agents, self.waiting, self.level, self.paused = [], 0, "standard", False
        self.result = ("phase 1", [("do", "dispatch a CD-1")])
        for name, value in [("wake_state_path", lambda: self.state), ("live_agents", lambda: self.agents),
                            ("page_waiting", lambda plan, pid: self.waiting),
                            ("effort_autonomy", lambda d, plan, km=None: self.level),
                            ("effort_paused", lambda d, plan: self.paused),
                            ("next_lines", lambda d, plan, tolerant=False: self.result)]:
            patcher = patch.object(wg, name, side_effect=value) if name != "wake_state_path" else patch.object(wg, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def wake(self, now=10_000):
        return wg.wake_reason(self.d, self.plan, now=now)

    def test_work_and_no_coordinator_starts_one_and_counts_the_start(self):
        self.assertEqual(self.wake(), (True, "dispatch a CD-1"))
        self.assertEqual(json.loads(self.state.read_text()), {self.d: [10_000]})

    def test_a_running_coordinator_or_no_work_starts_nothing(self):
        self.agents = [{"path": self.d, "state": "working"}]
        self.assertEqual(self.wake(), (False, "a coordinator agent runs in this worktree"))
        self.agents = []
        self.result = ("phase 1", [("wait", "worker a CD-1")])
        self.assertEqual(self.wake(), (False, "nothing to do: phase 1"))
        self.result = (wg.COMPLETE, [])
        self.assertEqual(self.wake(), (False, "the effort is complete"))
        self.assertFalse(self.state.exists())

    def test_supervised_and_paused_efforts_wait_for_human(self):
        self.level = "supervised"
        self.assertEqual(self.wake()[0], False)
        self.level, self.paused = "full", True
        self.assertEqual(self.wake(), (False, "the effort is paused"))

    def test_page_messages_start_a_coordinator_before_linear_is_read(self):
        self.waiting = 2
        self.result = ("phase 1", [])
        self.assertEqual(self.wake(), (True, "2 page message(s) wait for the coordinator"))

    def test_the_caps_hold(self):
        other = Path(self.tmp.name, "other-core")
        third = Path(self.tmp.name, "third-core")
        for path in (other, third):
            path.mkdir()
            (path / "plan.json").write_text("{}")
            (path / "keymap.json").write_text("{}")
        self.agents = [{"path": str(other)}, {"path": str(third)}]
        self.assertEqual(self.wake(), (False, "2 coordinator agents run on this machine (limit 2)"))
        self.agents = []
        for at in (1, 2, 3):
            self.assertTrue(self.wake(now=10_000 + at)[0])
        self.assertIn("3 starts in the last hour", self.wake(now=10_004)[1])
        self.assertTrue(self.wake(now=10_000 + 3601)[0])  # an hour later

    def test_orca_unreadable_starts_nothing(self):
        with patch.object(wg, "live_agents", side_effect=wg.ReadError("orca agent list: not running")):
            self.assertEqual(self.wake(), (False, "Orca cannot be read (orca agent list: not running)"))


class AnswerTests(unittest.TestCase):
    """Human's answer from the page, found in Linear by the label `answered`."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.d = self.tmp.name
        wg.save_keymap(self.d, {"project": {"id": "proj"}, "milestones": {},
                                "nodes": {"a": {"id": "ia", "identifier": "CD-1"}, "b": {"id": "ib", "identifier": "CD-2"}}})

    def issue(self, id_, ident, state="Todo", labels=("answered",), comments=()):
        return {"id": id_, "identifier": ident, "state": {"name": state, "type": "unstarted"},
                "labels": {"nodes": [{"id": l, "name": l} for l in labels]},
                "comments": {"nodes": [{"body": b, "createdAt": t} for t, b in comments]}}

    def test_an_answered_needs_human_issue_is_a_do_line_with_the_newest_comment(self):
        found = [self.issue("ia", "CD-1", labels=("answered", "needs-human"),
                            comments=[("2026-11-21T10:00:00Z", "Which API?"), ("2026-11-21T11:00:00Z", "Use v2.\nKeep v1.")]),
                 self.issue("ib", "CD-2"),  # no longer waits on Human
                 self.issue("ix", "CD-9", labels=("answered", "needs-human"))]  # not in this effort
        with patch.object(wg, "gql", return_value={"issues": {"nodes": found}}):
            self.assertEqual(ANSWER_LINES(self.d), [("do", "answer a CD-1: Use v2. / Keep v1.")])

    def test_an_unreadable_linear_gives_a_note(self):
        with patch.object(wg, "gql", side_effect=wg.ReadError("Linear request failed")):
            self.assertEqual(ANSWER_LINES(self.d), [("note", "answer @effort -: answers not read (Linear request failed)")])


class ProgressTests(unittest.TestCase):
    def test_progress_has_the_job_state_and_evidence_of_each_node_with_a_job(self):
        with tempfile.TemporaryDirectory() as d:
            wg.save_keymap(d, {"project": {"id": "p"}, "milestones": {}, "nodes": {"a": {"id": "ia", "identifier": "CD-1"}, "b": {"id": "ib", "identifier": "CD-2"}},
                               "run": {"effort": {}, "nodes": {"a": {"job": "review", "state": "running", "started_at": "2026-11-20T10:00:00Z"}, "b": {"branch": "x"}}}})
            (Path(d) / "evidence").mkdir()
            (Path(d) / "evidence" / "a.json").write_text(json.dumps({"key": "a", "sha": "abcdef123", "exit": 1}))
            self.assertEqual(wg.progress_nodes(d), [{"key": "a", "issue": "CD-1", "job": "review", "state": "running", "ci": None,
                                                     "evidence": "fail (exit 1) on abcdef1", "at": "2026-11-20T10:00:00Z"}])


class CleanupTests(LaneTests):
    """At Merged or Done, `wg move` removes the node's Orca worktree, then the lane parent of a settled lane."""

    def tree(self, name, branch, parent=None, children=()):
        path = str(self.d / name)
        return {"id": f"repo::{path}", "path": path, "branch": f"refs/heads/{branch}", "isMainWorktree": False,
                "parentWorktreeId": parent, "childWorktreeIds": list(children)}

    def setUp(self):
        super().setUp()
        self.a = self.tree("ex-one-00-a", "wg/ex-one-00-a", parent="repo::lane")
        self.b = self.tree("ex-one-01-b", "wg/ex-one-01-b", parent="repo::lane")
        self.lane = self.tree("ex-one", "wg/ex-one", children=[self.a["id"], self.b["id"]])
        self.rows = {"a": {"worktree": self.a["id"], "path": self.a["path"], "pr": "7"},
                     "b": {"worktree": self.b["id"], "path": self.b["path"], "pr": "8"}}

    def run_move(self, key, status, live, rows=None, dirty="", rm_error=None, trees=None, keep=False):
        self.keymap(rows=copy.deepcopy(rows if rows is not None else self.rows))
        trees = trees if trees is not None else [self.lane, self.a, self.b]
        removed = []

        def orca_result(*args):
            if rm_error:
                raise wg.ReadError(rm_error)
            removed.append(args)
            return {}

        def command(*args, cwd=None):
            self.assertEqual(args[:3], ("git", "status", "--porcelain"))
            return subprocess.CompletedProcess(args, 0, dirty, "")

        with patch.object(wg, "fetch_nodes", return_value=self.issues(live)), \
             patch.object(wg, "gql", return_value=STATES), patch.object(wg, "issue_update"), \
             patch.object(wg, "comment"), patch.object(wg, "move_guard", return_value=([], [])), \
             patch.object(wg, "sync_ready"), \
             patch.object(wg, "orca_worktrees", return_value={t["id"]: copy.deepcopy(t) for t in trees}), \
             patch.object(wg, "orca_result", side_effect=orca_result), patch.object(wg, "command", side_effect=command):
            out, err = self.call(wg.move, self.d, self.p, key, status, None, None, keep)
        return out, err, removed, wg.run_rows(wg.load_keymap(self.d))["nodes"]

    def test_merged_removes_the_node_worktree_and_keeps_the_branch(self):
        out, err, removed, rows = self.run_move("a", "Merged", {"a": "Ready to Merge", "b": "In Review"})
        self.assertEqual(removed, [("worktree", "rm", "--worktree", f"id:{self.a['id']}")])
        self.assertIn(f"removed worktree {self.a['path']} (a)", out)
        self.assertTrue(rows["a"]["worktree_removed"])
        self.assertNotIn("worktree_removed", rows["b"])
        self.assertEqual(err, "")

    def test_the_lane_parent_goes_after_the_last_node_of_its_lane(self):
        lane = self.lane | {"childWorktreeIds": [self.b["id"]]}
        rows = self.rows | {"a": self.rows["a"] | {"worktree_removed": "2026-11-22T10:00:00Z"}}
        _, _, removed, _ = self.run_move("b", "Done", {"a": "Merged", "b": "Merged"}, rows=rows, trees=[lane, self.b])
        self.assertEqual([args[3] for args in removed], [f"id:{self.b['id']}", f"id:{self.lane['id']}"])

    def test_a_dirty_worktree_and_its_lane_parent_stay(self):
        lane = self.lane | {"childWorktreeIds": [self.b["id"]]}
        rows = self.rows | {"a": self.rows["a"] | {"worktree_removed": "2026-11-22T10:00:00Z"}}
        _, err, removed, rows = self.run_move("b", "Merged", {"a": "Merged", "b": "Ready to Merge"}, rows=rows,
                                              trees=[lane, self.b], dirty=" M x.py\n")
        self.assertEqual(removed, [])
        self.assertIn(f"b: worktree {self.b['path']} stays: it has uncommitted changes", err)
        self.assertNotIn("worktree_removed", rows["b"])

    def test_an_open_node_keeps_the_lane_parent(self):
        _, _, removed, _ = self.run_move("a", "Merged", {"a": "Ready to Merge", "b": "In Review"},
                                         trees=[self.lane | {"childWorktreeIds": [self.a["id"]]}, self.a])
        self.assertEqual([args[3] for args in removed], [f"id:{self.a['id']}"])

    def test_a_live_job_keeps_the_worktree(self):
        rows = self.rows | {"a": self.rows["a"] | {"state": "running", "job": "restack"}}
        _, err, removed, _ = self.run_move("a", "Merged", {"a": "Ready to Merge"}, rows=rows)
        self.assertEqual(removed, [])
        self.assertIn("a restack job is live", err)

    def test_keep_worktree_and_an_orca_failure_never_fail_the_move(self):
        _, _, removed, rows = self.run_move("a", "Merged", {"a": "Ready to Merge"}, keep=True)
        self.assertEqual(removed, [])
        self.assertNotIn("worktree_removed", rows["a"])
        out, err, _, rows = self.run_move("a", "Merged", {"a": "Ready to Merge"}, rm_error="busy")
        self.assertIn("CD-1: Ready to Merge -> Merged", out)
        self.assertIn(f"a: worktree {self.a['path']} stays: busy", err)
        self.assertNotIn("worktree_removed", rows["a"])

    def test_a_worktree_removed_by_hand_is_recorded(self):
        _, _, removed, rows = self.run_move("a", "Merged", {"a": "Ready to Merge"}, trees=[self.lane, self.b])
        self.assertEqual(removed, [])
        self.assertEqual(rows["a"]["worktree_removed"], "gone")

    def test_the_coordinator_is_never_removed(self):
        core = self.tree("ex-core", "wg/ex-core") | {"path": str(self.d)}
        rows = {"s": {"worktree": core["id"], "path": str(self.d)}}
        _, _, removed, _ = self.run_move("s", "Done", {"s": "In Progress"}, rows=rows, trees=[core])
        self.assertEqual(removed, [])

    def test_cleanup_dry_run_lists_and_removes_nothing(self):
        self.keymap(rows=copy.deepcopy(self.rows))
        trees = {t["id"]: t for t in (self.lane, self.a, self.b)}
        with patch.object(wg, "fetch_nodes", return_value=self.issues({"a": "Merged", "b": "Done"})), \
             patch.object(wg, "orca_worktrees", return_value=trees), patch.object(wg, "orca_result") as rm, \
             patch.object(wg, "command", return_value=subprocess.CompletedProcess([], 0, "", "")):
            out, _ = self.call(wg.cleanup_command, self.d, self.p, True)
        rm.assert_not_called()
        self.assertIn(f"would remove worktree {self.a['path']} (a)", out)
        self.assertIn(f"would remove worktree {self.b['path']} (b)", out)
        self.assertNotIn("worktree_removed", wg.run_rows(wg.load_keymap(self.d))["nodes"]["a"])

    def test_plan_lock_is_reentrant(self):
        with wg.plan_lock(self.d), wg.plan_lock(self.d):
            pass


class GqlRetryTests(unittest.TestCase):
    """`gql` against a fake transport. The sleep, the clock, and the jitter are fakes: no test waits."""

    QUERY = "query { viewer { id } }"
    MUTATION = "mutation { issueUpdate(id: \"i\", input: {}) { success } }"
    NOW = 1_700_000_000.0

    class Response:
        def __init__(self, body, headers=None):
            self.headers = headers or {}
            self.body = json.dumps(body).encode()

        def read(self, *args):
            return self.body

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    class UnreadableBody(io.BytesIO):
        def read(self, *args):
            raise TimeoutError("timed out while reading")

    @staticmethod
    def http_error(code, body="", headers=None, fp=None):
        """An HTTP error of the fake transport. It is made at the request, with the request's URL."""
        return lambda request: wg.urllib.error.HTTPError(request.full_url, code, "error", headers or {},
                                                         fp or io.BytesIO(body.encode()))

    def ok(self, headers=None):
        return self.Response({"data": {"viewer": {"id": "me"}}}, headers)

    def reset_at(self, seconds):
        return str(int((self.NOW + seconds) * 1000))

    def run_gql(self, answers, query=None):
        answers = iter(answers)

        def transport(request, **kwargs):
            answer = next(answers)
            if callable(answer) and not isinstance(answer, BaseException):
                answer = answer(request)
            if isinstance(answer, BaseException):
                raise answer
            return answer

        sleeps = []
        stderr = io.StringIO()
        with patch.object(wg, "linear_key", return_value="key"), \
                patch.object(wg.urllib.request, "urlopen", side_effect=transport) as request, \
                patch.object(wg, "gql_sleep", side_effect=sleeps.append), \
                patch.object(wg, "gql_clock", return_value=self.NOW), \
                patch.object(wg, "gql_jitter", return_value=0.5), \
                patch.dict(wg.LINEAR_RATE, clear=True), contextlib.redirect_stderr(stderr):
            error = None
            try:
                result = wg.gql(query or self.QUERY)
            except wg.ReadError as e:
                result, error = None, e
            rate = dict(wg.LINEAR_RATE)
        return result, error, sleeps, stderr.getvalue(), request.call_count, rate

    def assert_warnings(self, err, count):
        lines = err.splitlines()
        self.assertEqual(len(lines), count, err)
        self.assertTrue(all(line.startswith("warn linear: ") for line in lines), err)

    def test_a_query_is_tried_again_after_each_short_failure(self):
        failures = {
            "network": wg.urllib.error.URLError("connection refused"),
            "timeout": TimeoutError("timed out"),
            "closed": wg.http.client.RemoteDisconnected("closed"),
            "429": self.http_error(429, "too many"),
            "502": self.http_error(502, "bad gateway"),
            "503": self.http_error(503, "unavailable"),
            "502 body not read": self.http_error(502, fp=self.UnreadableBody()),
            "ratelimited 400": self.http_error(400, '{"errors":[{"extensions":{"code":"RATELIMITED"}}]}'),
            "ratelimited 200": self.Response({"errors": [{"message": "limit", "extensions": {"code": "RATELIMITED"}}]}),
        }
        for name, failure in failures.items():
            with self.subTest(name):
                result, error, sleeps, err, calls, _ = self.run_gql([failure, self.ok()])
                self.assertIsNone(error)
                self.assertEqual(result, {"viewer": {"id": "me"}})
                self.assertEqual(calls, 2)
                self.assertEqual(sleeps, [1.0])
                self.assert_warnings(err, 1)
                self.assertIn("try 2 of 4", err)

    def test_the_base_delay_doubles_and_the_last_failure_gives_the_count_of_tries(self):
        result, error, sleeps, err, calls, _ = self.run_gql([self.http_error(502, "bad gateway")] * 4)
        self.assertIsNone(result)
        self.assertEqual(calls, 4)
        self.assertEqual(sleeps, [1.0, 2.0, 4.0])
        self.assert_warnings(err, 3)
        self.assertIn("Linear HTTP 502", str(error))
        self.assertIn("after 4 tries", str(error))

    def test_jitter_changes_the_delay(self):
        with patch.object(wg, "linear_key", return_value="key"), \
                patch.object(wg.urllib.request, "urlopen", side_effect=[TimeoutError("t"), self.ok()]), \
                patch.object(wg, "gql_sleep") as sleep, patch.object(wg, "gql_jitter", return_value=0.0), \
                contextlib.redirect_stderr(io.StringIO()):
            wg.gql(self.QUERY)
        sleep.assert_called_once_with(0.5)

    def test_a_body_with_a_newline_gives_one_warning_line(self):
        _, error, _, err, calls, _ = self.run_gql([self.http_error(502, "bad\ngateway\r\n"), self.ok()])
        self.assertIsNone(error)
        self.assertEqual(calls, 2)
        self.assert_warnings(err, 1)
        self.assertIn("bad gateway", err)

    def test_a_mutation_is_not_tried_again_after_a_timeout_or_a_5xx(self):
        failures = {
            "timeout": TimeoutError("timed out"),
            "reset": wg.urllib.error.URLError("reset"),
            "502": self.http_error(502, "bad"),
            "502 that names RATELIMITED": self.http_error(502, "upstream said RATELIMITED, maybe"),
            "503 with a RATELIMITED body": self.http_error(503, '{"errors":[{"extensions":{"code":"RATELIMITED"}}]}'),
            "502 body not read": self.http_error(502, fp=self.UnreadableBody()),
        }
        for name, failure in failures.items():
            with self.subTest(name):
                result, error, sleeps, err, calls, _ = self.run_gql([failure, self.ok()], query=self.MUTATION)
                self.assertIsInstance(error, wg.ReadError)
                self.assertEqual((calls, sleeps, err), (1, [], ""))
                self.assertIn("after 1 try", str(error))

    def test_a_mutation_after_a_comment_is_a_mutation(self):
        for query in ("# set the status\n" + self.MUTATION, "\ufeff ,\n# one\r\n  # two\n" + self.MUTATION):
            with self.subTest(query):
                self.assertFalse(wg.is_query(query))
                _, error, sleeps, _, calls, _ = self.run_gql([TimeoutError("timed out"), self.ok()], query=query)
                self.assertIsInstance(error, wg.ReadError)
                self.assertEqual((calls, sleeps), (1, []))
        for query in (self.QUERY, "{ viewer { id } }", "# mutation\nquery { viewer { id } }", "mutationX { a }"):
            with self.subTest(query):
                self.assertTrue(wg.is_query(query))

    def test_a_mutation_is_tried_again_when_linear_refused_it(self):
        for failure in (self.http_error(429, "too many"),
                        self.http_error(400, '{"errors":[{"extensions":{"code":"RATELIMITED"}}]}'),
                        self.Response({"errors": [{"extensions": {"code": "RATELIMITED"}}]})):
            with self.subTest(str(failure)):
                answer = self.Response({"data": {"issueUpdate": {"success": True}}})
                result, error, sleeps, _, calls, _ = self.run_gql([failure, answer], query=self.MUTATION)
                self.assertIsNone(error)
                self.assertEqual(result, {"issueUpdate": {"success": True}})
                self.assertEqual((calls, sleeps), (2, [1.0]))

    def test_other_errors_are_not_tried_again(self):
        for failure in (self.http_error(400, "bad query"), self.http_error(400, "the word RATELIMITED in text"),
                        self.http_error(401, "no key"), self.http_error(400, fp=self.UnreadableBody()),
                        self.Response({"errors": [{"message": "Entity not found"}]})):
            with self.subTest(str(failure)):
                _, error, sleeps, err, calls, _ = self.run_gql([failure, self.ok()])
                self.assertIsInstance(error, wg.ReadError)
                self.assertEqual((calls, sleeps, err), (1, [], ""))
                self.assertIn("after 1 try", str(error))

    def test_a_rate_limit_waits_for_the_reset_time_when_it_is_near(self):
        headers = {"X-RateLimit-Requests-Remaining": "0", "X-RateLimit-Requests-Reset": self.reset_at(30)}
        _, error, sleeps, err, calls, _ = self.run_gql([self.http_error(429, "too many", headers), self.ok()])
        self.assertIsNone(error)
        self.assertEqual(sleeps, [30.5])
        self.assertIn("in 30.5 s", err)
        self.assertEqual(calls, 2)

    def test_a_rate_limit_with_a_far_reset_time_stops_at_once(self):
        headers = {"X-RateLimit-Requests-Remaining": "0", "X-RateLimit-Requests-Reset": self.reset_at(900)}
        _, error, sleeps, _, calls, _ = self.run_gql([self.http_error(429, "too many", headers), self.ok()])
        self.assertEqual((calls, sleeps), (1, []))
        self.assertIn("again in 900 s", str(error))
        self.assertIn("after 1 try", str(error))

    def test_the_reset_of_the_used_up_limit_counts(self):
        cases = {
            "complexity": {"X-RateLimit-Requests-Remaining": "100", "X-RateLimit-Requests-Reset": self.reset_at(900),
                           "X-RateLimit-Complexity-Remaining": "0", "X-RateLimit-Complexity-Reset": self.reset_at(10)},
            "endpoint": {"X-RateLimit-Requests-Remaining": "4000", "X-RateLimit-Requests-Reset": self.reset_at(900),
                         "X-RateLimit-Endpoint-Requests-Remaining": "0",
                         "X-RateLimit-Endpoint-Requests-Reset": self.reset_at(10)},
            "retry-after": {"Retry-After": "10", "X-RateLimit-Requests-Reset": self.reset_at(900)},
        }
        for name, headers in cases.items():
            with self.subTest(name):
                _, error, sleeps, _, _, _ = self.run_gql([self.http_error(429, "too many", headers), self.ok()])
                self.assertIsNone(error)
                self.assertEqual(sleeps, [10.5])

    def test_a_rate_limit_code_after_a_long_message_is_found(self):
        body = json.dumps({"errors": [{"message": "x" * 600, "extensions": {"code": "RATELIMITED"}}]})
        self.assertGreater(body.index("RATELIMITED"), 500)
        for query in (self.QUERY, self.MUTATION):
            with self.subTest(query):
                _, error, sleeps, err, calls, _ = self.run_gql([self.http_error(400, body), self.ok()], query=query)
                self.assertIsNone(error)
                self.assertEqual((calls, sleeps), (2, [1.0]))
                self.assert_warnings(err, 1)
                self.assertLess(len(err), 300)

    def test_the_request_reset_counts_when_no_limit_is_marked_used_up(self):
        for code in (429, 400):
            with self.subTest(code):
                body = '{"errors":[{"extensions":{"code":"RATELIMITED"}}]}'
                headers = {"X-RateLimit-Requests-Reset": self.reset_at(30)}
                _, error, sleeps, _, calls, _ = self.run_gql([self.http_error(code, body, headers), self.ok()])
                self.assertIsNone(error)
                self.assertEqual((calls, sleeps), (2, [30.5]))
        far = {"X-RateLimit-Requests-Reset": self.reset_at(900), "Retry-After": "10"}
        _, error, sleeps, _, _, _ = self.run_gql([self.http_error(429, "too many", far), self.ok()])
        self.assertIsNone(error)
        self.assertEqual(sleeps, [10.5])

    def test_a_rate_limit_during_execution_never_repeats_a_mutation(self):
        partial = {"data": {"issueUpdate": {"success": True}},
                   "errors": [{"message": "limit", "path": ["other"], "extensions": {"code": "RATELIMITED"}}]}
        path_only = {"data": None, "errors": [{"path": ["issueUpdate"], "extensions": {"code": "RATELIMITED"}}]}
        for name, body in (("partial data", partial), ("error path", path_only)):
            with self.subTest(name):
                answer = self.Response({"data": {"issueUpdate": {"success": True}}})
                _, error, sleeps, err, calls, _ = self.run_gql([self.Response(body), answer], query=self.MUTATION)
                self.assertIsInstance(error, wg.ReadError)
                self.assertEqual((calls, sleeps, err), (1, [], ""))
                self.assertIn("after 1 try", str(error))
                _, error, sleeps, _, calls, _ = self.run_gql([self.Response(body), self.ok()])
                self.assertIsNone(error)
                self.assertEqual((calls, sleeps), (2, [1.0]))
        with self.subTest("HTTP 400 with data"):
            _, error, _, _, calls, _ = self.run_gql([self.http_error(400, json.dumps(partial)), self.ok()],
                                                    query=self.MUTATION)
            self.assertIsInstance(error, wg.ReadError)
            self.assertEqual(calls, 1)

    def test_a_mutation_after_a_fragment_is_not_tried_again(self):
        documents = ("fragment F on Issue { id } mutation M { issueUpdate(id: \"i\", input: {}) { issue { ...F } } }",
                     "query Q { viewer { id } } mutation M { a }", "subscription { a }", "query { a",
                     "query { a(s: \"open)")
        for query in documents:
            with self.subTest(query):
                self.assertFalse(wg.is_query(query))
                _, error, sleeps, _, calls, _ = self.run_gql([TimeoutError("timed out"), self.ok()], query=query)
                self.assertIsInstance(error, wg.ReadError)
                self.assertEqual((calls, sleeps), (1, []))
        for query in ("fragment F on User { id } query { viewer { ...F } }", 'query { a(s: "mutation {") }',
                      'query { a(s: """x \\""" mutation""") }', "query($m: mutation) { a }"):
            with self.subTest(query):
                self.assertTrue(wg.is_query(query))

    def test_a_tls_read_failure_is_a_transport_failure(self):
        class TlsEof(self.Response):
            def read(self, *args):
                raise wg.ssl.SSLEOFError(8, "EOF occurred in violation of protocol")

        for error_type in (wg.ssl.SSLEOFError, wg.ssl.SSLZeroReturnError):
            with self.subTest(error_type.__name__):
                broken = TlsEof({})
                broken.read = Mock(side_effect=error_type(8, "TLS stream ended"))
                _, error, sleeps, err, calls, _ = self.run_gql([broken, self.ok()])
                self.assertIsNone(error)
                self.assertEqual((calls, sleeps), (2, [1.0]))
                self.assert_warnings(err, 1)
                _, error, sleeps, err, calls, _ = self.run_gql([TlsEof({}), self.ok()], query=self.MUTATION)
                self.assertIsInstance(error, wg.ReadError)
                self.assertEqual((calls, sleeps, err), (1, [], ""))
                self.assertIn("after 1 try", str(error))

    def test_a_complexity_limit_with_points_left_can_be_the_refused_limit(self):
        cases = {
            "one point left": {"X-RateLimit-Requests-Remaining": "4000",
                               "X-RateLimit-Requests-Reset": self.reset_at(900),
                               "X-RateLimit-Complexity-Remaining": "1",
                               "X-RateLimit-Complexity-Reset": self.reset_at(10)},
            "cost above the points": {"X-Complexity": "50", "X-RateLimit-Requests-Remaining": "4000",
                                      "X-RateLimit-Requests-Reset": self.reset_at(900),
                                      "X-RateLimit-Complexity-Remaining": "500000",
                                      "X-RateLimit-Complexity-Reset": self.reset_at(900),
                                      "X-RateLimit-Endpoint-Complexity-Remaining": "20",
                                      "X-RateLimit-Endpoint-Complexity-Reset": self.reset_at(10)},
        }
        for name, headers in cases.items():
            with self.subTest(name):
                body = '{"errors":[{"extensions":{"code":"RATELIMITED"}}]}'
                _, error, sleeps, _, calls, _ = self.run_gql([self.http_error(400, body, headers), self.ok()])
                self.assertIsNone(error)
                self.assertEqual((calls, sleeps), (2, [10.5]))

    def test_a_reset_exactly_60_s_away_is_awaited(self):
        for seconds, expected in ((60, [60.5]), (61, [])):
            with self.subTest(seconds):
                headers = {"X-RateLimit-Requests-Remaining": "0", "X-RateLimit-Requests-Reset": self.reset_at(seconds)}
                _, error, sleeps, _, _, _ = self.run_gql([self.http_error(429, "too many", headers), self.ok()])
                self.assertEqual(sleeps, expected)
                self.assertEqual(error is None, bool(expected))

    def test_the_error_body_read_is_bounded_and_closed(self):
        class Body(io.BytesIO):
            def __init__(self, data):
                super().__init__(data)
                self.sizes = []
                self.closed_by_gql = False

            def read(self, size=-1):
                self.sizes.append(size)
                return super().read(size)

            def close(self):
                self.closed_by_gql = True
                super().close()

        for code, size in ((429, wg.GQL_STATUS_BODY), (502, wg.GQL_STATUS_BODY), (400, wg.GQL_ERROR_BODY)):
            with self.subTest(code):
                body = Body(b"y" * (2 * wg.GQL_ERROR_BODY))
                self.run_gql([self.http_error(code, fp=body), self.ok()])
                self.assertEqual(body.sizes, [size])
                self.assertTrue(body.closed_by_gql)

    def test_a_refusal_uses_its_own_headers_not_the_headers_of_an_earlier_response(self):
        old = {"X-RateLimit-Requests-Remaining": "0", "X-RateLimit-Requests-Reset": self.reset_at(900)}
        _, error, sleeps, _, calls, rate = self.run_gql([self.http_error(502, "bad", old),
                                                         self.http_error(429, "too many"), self.ok()])
        self.assertIsNone(error)
        self.assertEqual((calls, sleeps), (3, [1.0, 2.0]))
        self.assertEqual(rate["requests-reset"], self.reset_at(900))

    def test_the_last_limit_headers_are_kept(self):
        headers = {"X-RateLimit-Requests-Limit": "5000", "X-RateLimit-Requests-Remaining": "4321",
                   "X-RateLimit-Requests-Reset": "1700000000000", "X-RateLimit-Endpoint-Requests-Remaining": "9"}
        _, error, _, _, _, rate = self.run_gql([self.ok(headers)])
        self.assertIsNone(error)
        self.assertEqual(rate, {"requests-limit": "5000", "requests-remaining": "4321",
                                "requests-reset": "1700000000000", "endpoint-requests-remaining": "9"})


class FreePlanTests(DirTests):
    """Linear's Free plan holds 250 issues: wg archives the completed and canceled ones."""

    def setUp(self):
        super().setUp()
        wg.FREE_PLAN.clear()
        self.addCleanup(wg.FREE_PLAN.clear)

    def test_free_plan_is_a_workspace_with_no_subscription(self):
        for org, free in (({"subscription": None}, True), ({"subscription": {"type": "business"}}, False), ({}, False)):
            wg.FREE_PLAN.clear()
            with patch.object(wg, "gql", return_value={"organization": org}) as request:
                self.assertEqual(wg.free_plan(), free)
                self.assertEqual(wg.free_plan(), free)
            self.assertEqual(request.call_count, 1)  # one read for each workspace

    def test_archive_reads_every_page_then_archives_each_issue(self):
        pages = [{"issues": {"nodes": [{"id": "i1", "identifier": "CD-1"}],
                             "pageInfo": {"hasNextPage": True, "endCursor": "c1"}}},
                 {"issues": {"nodes": [{"id": "i2", "identifier": "CD-2"}],
                             "pageInfo": {"hasNextPage": False, "endCursor": None}}}]
        with patch.object(wg, "gql", side_effect=pages + [{}, {}]) as request:
            self.assertEqual(wg.archive_settled(), ["CD-1", "CD-2"])
        queries = [c.args[0] for c in request.call_args_list]
        self.assertIn('"completed","canceled"', queries[0])
        self.assertEqual(request.call_args_list[1].args[1], {"after": "c1"})
        self.assertEqual([c.args[1] for c in request.call_args_list[2:]], [{"id": "i1"}, {"id": "i2"}])
        self.assertTrue(all("issueArchive" in q for q in queries[2:]))
        with patch.object(wg, "gql", side_effect=pages) as request:
            self.assertEqual(wg.archive_settled(apply=False), ["CD-1", "CD-2"])
        self.assertEqual(request.call_count, 2)  # a dry run archives nothing

    def test_archive_runs_only_on_the_free_plan_and_a_failure_only_warns(self):
        with patch.object(wg, "free_plan", return_value=False), patch.object(wg, "archive_settled") as sweep:
            self.assertEqual(wg.archive_free(), [])
        sweep.assert_not_called()
        with patch.object(wg, "free_plan", return_value=True), \
             patch.object(wg, "archive_settled", return_value=["CD-1"]):
            out, _ = self.call(lambda: len(wg.archive_free()), code=1)
        self.assertIn("archived 1 completed or canceled issues (Linear Free plan, 250 issues): CD-1", out)
        with patch.object(wg, "free_plan", side_effect=wg.ReadError("offline")):
            _, err = self.call(lambda: len(wg.archive_free()), code=0)
        self.assertIn("warn: archive of settled issues failed: offline", err)

    def test_move_to_done_or_canceled_archives_and_a_reopen_unarchives(self):
        self.write_plan()
        self.keymap()
        states = {"team": {"states": {"nodes": [{"name": n, "id": n} for n in ("Canceled", "In Progress")]}}}
        for status, archived, sweeps in (("Canceled", None, True), ("In Progress", "2026-01-01T00:00:00Z", False)):
            issue = live_issue("Done", archivedAt=archived)
            with patch.object(wg, "fetch_nodes", return_value={"a": issue}), \
                 patch.object(wg, "gql", return_value=states) as request, patch.object(wg, "sync_ready"), \
                 patch.object(wg, "issue_update"), patch.object(wg, "comment"), \
                 patch.object(wg, "archive_free") as sweep:
                self.call(wg.move, self.d, self.p, "a", status, None, "test")
            self.assertEqual(sweep.called, sweeps)
            unarchive = [c for c in request.call_args_list if "issueUnarchive" in c.args[0]]
            self.assertEqual([c.args[1] for c in unarchive], [] if sweeps else [{"id": "a"}])


class PrBatchTests(unittest.TestCase):
    REPO = json.dumps({"owner": {"login": "octo"}, "name": "repo", "url": "https://git.example.com/octo/repo"})
    DONE = {"hasNextPage": False}

    def pr(self, contexts=(), *, more=None, **fields):
        """One PR of the answer; `more` names the connection that has a second page."""
        def page(name, nodes):
            return {"nodes": list(nodes), "pageInfo": {"hasNextPage": more == name}}
        rollup = {"contexts": page("contexts", contexts)} if contexts or more == "contexts" else None
        return {"state": "OPEN", "headRefOid": SHA, "isDraft": True, "mergeCommit": None, "mergeable": "MERGEABLE",
                "baseRefName": "main", "reviews": page("reviews", [{"body": "ok"}]),
                "comments": page("comments", []),
                "commits": {"nodes": [{"commit": {"statusCheckRollup": rollup}}]}, **fields}

    def check_run(self, run_name, contexts):
        return {"__typename": "CheckRun", "name": run_name, **contexts}

    def run_batch(self, answers, numbers=("7",)):
        """PR_BATCH with `gh repo view` and then one `gh api graphql` answer (code, stdout, stderr) for each request."""
        results = [subprocess.CompletedProcess([], 0, self.REPO, "")]
        results += [subprocess.CompletedProcess([], code, out if isinstance(out, str) else json.dumps(out), err)
                    for code, out, err in answers]
        with patch.object(wg, "command", side_effect=results) as run:
            return PR_BATCH(list(numbers), cwd="/plan"), run

    def data(self, **prs):
        return {"data": {"repository": prs}}

    def test_one_request_maps_each_pr_to_the_shape_of_pr_view_and_pr_checks(self):
        contexts = [self.check_run("test", {"status": "COMPLETED", "conclusion": "FAILURE"}),
                    self.check_run("lint", {"status": "IN_PROGRESS", "conclusion": None}),
                    {"__typename": "StatusContext", "context": "deploy", "state": "SUCCESS"}]
        data = self.data(pr7=self.pr(contexts), pr12=self.pr(state="MERGED", mergeCommit={"oid": OTHER}))
        out, run = self.run_batch([(0, data, "")], numbers=("12", "7", "7", None, "x"))
        self.assertEqual(run.call_args_list[0].args, ("gh", "repo", "view", "--json", "owner,name,url"))
        args = run.call_args_list[1].args
        self.assertEqual(args[:5], ("gh", "api", "graphql", "--hostname", "git.example.com"))
        self.assertIn("owner=octo", args)
        self.assertIn("name=repo", args)
        self.assertIn("pr7: pullRequest(number: 7)", args[6])
        self.assertIn("pr12: pullRequest(number: 12)", args[6])
        self.assertEqual(run.call_args_list[1].kwargs["cwd"], "/plan")
        info, checks = out["7"]
        self.assertEqual(set(info), set(wg.PR_FIELDS.split(",")))
        self.assertEqual((info["state"], info["headRefOid"], info["isDraft"], info["mergeable"]),
                         ("OPEN", SHA, True, "MERGEABLE"))
        self.assertEqual((info["reviews"], info["comments"]), ([{"body": "ok"}], []))
        self.assertEqual(checks, (False, "test"))
        self.assertEqual(out["12"], (dict(info, state="MERGED", mergeCommit={"oid": OTHER}), (True, "no checks")))

    def test_pending_and_passed_checks_pass(self):
        contexts = [self.check_run("lint", {"status": "QUEUED", "conclusion": None}),
                    self.check_run("test", {"status": "COMPLETED", "conclusion": "SKIPPED"}),
                    {"__typename": "StatusContext", "context": "ci", "state": "PENDING"}]
        self.assertEqual(wg.rollup_checks(contexts), (True, "no failed checks (2 pending)"))
        failed = [{"__typename": "StatusContext", "context": "ci", "state": "ERROR"}]
        self.assertEqual(wg.rollup_checks(failed), (False, "ci"))

    def test_a_rerun_that_passed_replaces_the_failed_run(self):
        suite = {"checkSuite": {"workflowRun": {"event": "pull_request", "workflow": {"name": "CI"}}}}
        failed = self.check_run("test", {"status": "COMPLETED", "conclusion": "FAILURE",
                                   "startedAt": "2026-11-20T10:00:00Z", **suite})
        rerun = self.check_run("test", {"status": "COMPLETED", "conclusion": "SUCCESS",
                                  "startedAt": "2026-11-20T11:00:00Z", **suite})
        self.assertEqual(wg.rollup_checks([failed, rerun]), (True, "no failed checks"))
        self.assertEqual(wg.rollup_checks([rerun, dict(failed, startedAt="2026-11-20T12:00:00Z")]), (False, "test"))
        # Another workflow or event is another check, as in `gh pr checks`.
        push = dict(failed, checkSuite={"workflowRun": {"event": "push", "workflow": {"name": "CI"}}})
        self.assertEqual(wg.rollup_checks([push, rerun]), (False, "test"))

    def test_a_check_key_is_the_slash_key_of_gh_pr_checks(self):
        # Name "build/test" in workflow "CI" and name "build" in workflow "test/CI" both give "build/test/CI/push".
        def check(name, workflow, conclusion, started):
            return self.check_run(name, {"status": "COMPLETED", "conclusion": conclusion, "startedAt": started,
                                         "checkSuite": {"workflowRun": {"event": "push",
                                                                        "workflow": {"name": workflow}}}})
        older = check("build/test", "CI", "FAILURE", "2026-11-20T10:00:00Z")
        newer = check("build", "test/CI", "SUCCESS", "2026-11-20T11:00:00Z")
        self.assertEqual(wg.rollup_checks([older, newer]), (True, "no failed checks"))
        self.assertEqual(wg.latest_checks([older, newer]), [newer])
        # A check with no workflow run has the key "<name>//".
        self.assertEqual(len(wg.latest_checks([self.check_run("lint", {"status": "QUEUED"}),
                                               self.check_run("lint", {"status": "QUEUED"})])), 1)

    def test_a_list_with_a_second_page_is_read_alone(self):
        for more in ("reviews", "comments", "contexts"):
            with self.subTest(more=more):
                out, _ = self.run_batch([(0, self.data(pr7=self.pr(more=more), pr8=self.pr()), "")],
                                        numbers=("7", "8"))
                self.assertEqual(list(out), ["8"])
        self.assertIn("pageInfo { hasNextPage }", PR_BATCH.__globals__["PR_BATCH_FIELDS"])

    def test_an_error_on_a_field_of_a_pr_sends_that_pr_to_the_single_reads(self):
        broken = self.pr(commits={"nodes": [{"commit": {"statusCheckRollup": None}}]})
        data = dict(self.data(pr7=broken, pr8=self.pr()),
                    errors=[{"message": "timeout", "path": ["repository", "pr7", "commits", "nodes", 0, "commit",
                                                            "statusCheckRollup"]}])
        out, _ = self.run_batch([(1, data, "gh: timeout")], numbers=("7", "8"))
        self.assertEqual(list(out), ["8"])
        # A null list is a failed read, not an empty list.
        for field in ("reviews", "comments"):
            with self.subTest(field=field):
                out, _ = self.run_batch([(0, self.data(pr7=self.pr(**{field: None})), "")])
                self.assertEqual(out, {})
        # An error that names no PR can touch each PR of the request.
        data = dict(self.data(pr7=self.pr()), errors=[{"message": "something failed"}])
        with self.assertRaisesRegex(wg.ReadError, "gh: failed"):
            self.run_batch([(1, data, "gh: failed")])

    def test_a_pr_that_github_does_not_return_is_left_out(self):
        data = dict(self.data(pr7=self.pr(), pr8=None),
                    errors=[{"message": "Could not resolve to a PullRequest with the number of 8.",
                             "path": ["repository", "pr8"]}])
        out, _ = self.run_batch([(1, data, "gh: Could not resolve")], numbers=("7", "8"))
        self.assertEqual(list(out), ["7"])

    def test_fifty_prs_go_in_each_request_and_a_failed_request_keeps_the_others(self):
        numbers = [str(n) for n in range(1, 52)]
        first = self.data(**{f"pr{n}": self.pr() for n in range(1, 51)})
        second = self.data(pr51=self.pr())
        out, run = self.run_batch([(0, first, ""), (0, second, "")], numbers=numbers)
        self.assertEqual(len(run.call_args_list), 3)
        self.assertEqual(sorted(out, key=int), numbers)
        out, _ = self.run_batch([(0, first, ""), (1, "", "HTTP 502")], numbers=numbers)
        self.assertEqual(sorted(out, key=int), numbers[:50])
        out, _ = self.run_batch([(1, "", "HTTP 502"), (0, second, "")], numbers=numbers)
        self.assertEqual(list(out), ["51"])
        # A request that times out, or that gh cannot start, skips only its own PRs.
        for error in (subprocess.TimeoutExpired(["gh"], 60), OSError("no gh")):
            with self.subTest(error=type(error).__name__):
                answers = [subprocess.CompletedProcess([], 0, self.REPO, ""),
                           subprocess.CompletedProcess([], 0, json.dumps(first), ""), error]
                with patch.object(wg, "command", side_effect=answers):
                    out = PR_BATCH(numbers, cwd="/plan")
                self.assertEqual(sorted(out, key=int), numbers[:50])
        with patch.object(wg, "command", side_effect=[subprocess.CompletedProcess([], 0, self.REPO, ""),
                                                      subprocess.TimeoutExpired(["gh"], 60)]):
            with self.assertRaisesRegex(wg.ReadError, "timed out"):
                PR_BATCH(["7"])

    def test_a_failed_request_is_a_read_error(self):
        for answer in [(1, "", "HTTP 502"), (1, self.data(pr7=None), "HTTP 502"), (0, "not json", "")]:
            with self.subTest(answer=answer):
                with self.assertRaises(wg.ReadError):
                    self.run_batch([answer])
        with patch.object(wg, "command", return_value=subprocess.CompletedProcess([], 1, "", "no repo")):
            with self.assertRaisesRegex(wg.ReadError, "no repo"):
                PR_BATCH(["7"])
        with patch.object(wg, "command", return_value=subprocess.CompletedProcess(
                [], 0, json.dumps({"owner": {"login": "octo"}, "name": "repo"}), "")):
            with self.assertRaisesRegex(wg.ReadError, "host"):
                PR_BATCH(["7"])

    def test_no_pr_needs_no_request(self):
        with patch.object(wg, "command") as run:
            self.assertEqual(PR_BATCH([None, "", "0"]), {})
        self.assertFalse(run.called)


class TerminalTests(unittest.TestCase):
    """`wg next` on the terminal: the command of each action, one line for the waits of one verb, few notes."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.d = self.tmp.name
        self.here = str(Path(self.d).resolve())
        self.keys = ("a", "b", "c", "d", "e", "m1", "s", "s1", "t", "z")

    def test_each_do_line_that_one_command_does_ends_with_that_command(self):
        cases = {
            "verify a CD-1: #7 head abc is not code done": f"wg done {self.here} a",
            "dispatch a CD-1": f"wg dispatch {self.here} a --run",
            "merged a CD-1: #7 bbbbbbbbbb": f"wg move {self.here} a Merged",
            "close m1 CD-5": f"wg move {self.here} m1 Done",
            "verifying s1 CD-6": f"wg move {self.here} s1 Verifying",
            "ship s1 CD-6: the soak passed at 2026-01-01T00:00:00Z": f"wg move {self.here} s1 Done",
            "load z -: not in keymap.json": f"wg load {self.here} --apply",
        }
        for text, command in cases.items():
            with self.subTest(text=text):
                self.assertEqual(wg.terminal_lines(self.d, [("do", text)], keys=self.keys), [f"do {text} -> {command}"])
        # A verb that needs more than one command, or a choice, gets no command.
        for text in ("review a CD-1: #7 round 1", "wave: pick the next wave from a,b", "restack a CD-1: #7"):
            self.assertEqual(wg.terminal_lines(self.d, [("do", text)], keys=self.keys), [f"do {text}"])

    def test_a_plan_dir_with_a_space_is_quoted(self):
        spaced = Path(self.d) / "my plan"
        spaced.mkdir()
        line = wg.terminal_lines(str(spaced), [("do", "dispatch a CD-1")], keys=self.keys)[0]
        self.assertTrue(line.endswith(f"-> wg dispatch '{spaced.resolve()}' a --run"))

    def test_the_load_command_applies_the_load(self):
        line = wg.terminal_lines(self.d, [("do", "load z -: not in keymap.json")], keys=self.keys)[0]
        command = wg.shlex.split(line.split(" -> ", 1)[1])
        self.assertEqual(command[:3], ["wg", "load", self.here])
        self.assertIn("--apply", command)
        ns = wg.cli_parser().parse_args(command[1:])
        self.assertTrue(ns.apply)

    def test_a_key_with_a_space_is_named_in_full(self):
        keys = ("api", "api cleanup")
        lines = [("do", "dispatch api cleanup EX-1"), ("do", "verify api EX-2: #3 head abc is not code done"),
                 ("wait", "worker api cleanup EX-1: job=ci dispatch=x"), ("wait", "worker api EX-2: job=review dispatch=y")]
        self.assertEqual(wg.terminal_lines(self.d, lines, keys=keys), [
            f"do dispatch api cleanup EX-1 -> wg dispatch {self.here} 'api cleanup' --run",
            f"do verify api EX-2: #3 head abc is not code done -> wg done {self.here} api",
            "wait worker: api cleanup (ci), api (review)"])
        command = wg.shlex.split(wg.terminal_lines(self.d, lines[:1], keys=keys)[0].split(" -> ", 1)[1])
        self.assertEqual(wg.cli_parser().parse_args(command[1:]).key, "api cleanup")
        # A line that names no key of the plan gets no command: a wrong node is worse than none.
        self.assertEqual(wg.terminal_lines(self.d, [("do", "dispatch other EX-9")], keys=keys), ["do dispatch other EX-9"])

    def test_waits_of_one_verb_are_one_line_and_other_notes_are_counted(self):
        lines = [("do", "review a CD-1: #7 round 1"),
                 ("wait", "worker b CD-2: job=dispatch dispatch=ctx_1"),
                 ("wait", "human c CD-3: merge PR #9"),
                 ("wait", "worker d CD-4: job=review dispatch=ctx_2"),
                 ("wait", "below e CD-5: d has a push that is not code done"),
                 ("wait", "soak s CD-6: until 2026-01-02T00:00:00Z"),
                 ("wait", "soak t CD-7: until 2026-01-03T00:00:00Z"),
                 ("note", "autonomy @effort -: standard"),
                 ("note", "triage CD-9: Found"),
                 ("note", "replied b CD-2: yes"),
                 ("note", "resumed @effort -: on the page")]
        self.assertEqual(wg.terminal_lines(self.d, lines, keys=self.keys), [
            "do review a CD-1: #7 round 1",
            "wait worker: b (dispatch), d (review)",
            "wait human c CD-3: merge PR #9",
            "wait below e CD-5: d has a push that is not code done",
            "wait soak: s (until 2026-01-02T00:00:00Z), t (until 2026-01-03T00:00:00Z)",
            "note autonomy @effort -: standard",
            "note triage CD-9: Found",
            f"note other: 2 more note lines; wg next {self.here} --all prints them"])
        self.assertEqual(wg.terminal_lines(self.d, lines, everything=True, keys=self.keys), [f"{level} {text}" for level, text in lines])

    def run_next(self, lines, *args):
        published, sent = [], []
        km = {"project": {"id": "proj"}, "milestones": {}, "nodes": {"a": {"id": "ia", "identifier": "CD-1"}}}
        wg.save_keymap(self.d, km)
        p = {"effort": {"name": "Example"}, "phases": [{"key": "1", "target": "main"}],
             "nodes": [node(k, lane="x", title=k) for k in ("a", "b", "c")], "edges": []}
        link = Mock()
        link.take.return_value = []
        link.send.side_effect = lambda kind, payload: sent.append((kind, payload))
        with patch.object(wg.Link, "open", return_value=link), \
             patch.object(wg, "next_lines", return_value=("phase 1: 1 task", list(lines))), \
             patch.object(wg, "answer_lines", return_value=[]), \
             patch.object(wg, "autonomy_lines", return_value=[("note", "autonomy @effort -: standard")]), \
             patch.object(wg, "effort_paused", return_value=False), \
             patch.object(wg, "flush_writes"), patch.object(wg, "open_asks", return_value=[]), \
             patch.object(wg, "progress_nodes", return_value=[]), \
             patch.object(wg, "publish", side_effect=lambda d, plan, head, got, **kw: published.append(got)), \
             contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(wg.next_command(self.d, p, False, 1, True, *args), 0)
        return out.getvalue().splitlines(), published, [payload for kind, payload in sent if kind == "state"]

    def test_the_page_and_the_status_document_get_every_full_line(self):
        lines = [("do", "dispatch a CD-1"), ("wait", "worker b CD-2: job=ci dispatch=x"),
                 ("wait", "worker c CD-3: job=review dispatch=y"), ("note", "replied b CD-2: ok")]
        full = [("note", "autonomy @effort -: standard")] + lines
        out, published, states = self.run_next(lines)
        self.assertEqual(out[1:], ["note autonomy @effort -: standard", f"do dispatch a CD-1 -> wg dispatch {self.here} a --run",
                                   "wait worker: b (ci), c (review)",
                                   f"note other: 1 more note line; wg next {self.here} --all prints them",
                                   out[-1]])
        self.assertTrue(out[-1].startswith("note page "))
        self.assertEqual(published, [full])
        self.assertEqual(states[0]["lines"], [{"level": level, "text": text} for level, text in full])
        out, _, _ = self.run_next(lines, True)
        self.assertEqual(out[1:-1], ["note autonomy @effort -: standard",
                                     f"do dispatch a CD-1 -> wg dispatch {self.here} a --run",
                                     "wait worker b CD-2: job=ci dispatch=x", "wait worker c CD-3: job=review dispatch=y",
                                     "note replied b CD-2: ok"])

    def test_the_all_flag_reaches_next(self):
        self.assertTrue(wg.cli_parser().parse_args(["next", self.d, "--all"]).all)
        self.assertFalse(wg.cli_parser().parse_args(["next", self.d]).all)


def printed_verbs(*functions):
    """Each verb that the functions can print as the first word of a line: `add("do", "<verb>", …)`, and the
    first word of the text of a `(level, text)` tuple. A choice (`"a" if … else "b"`) gives both verbs."""
    import ast
    import inspect
    import textwrap

    def words(value):
        if isinstance(value, ast.Constant) and isinstance(value.value, str):
            return {value.value.split(" ", 1)[0].rstrip(":")}
        if isinstance(value, ast.BinOp):  # "wave: pick … " + ",".join(idle)
            return words(value.left)
        if isinstance(value, ast.IfExp):
            return words(value.body) | words(value.orelse)
        if isinstance(value, ast.FormattedValue):
            return words(value.value)
        if isinstance(value, ast.JoinedStr) and value.values:
            first = value.values[0]
            if isinstance(first, ast.Constant):
                return {first.value.split(" ", 1)[0].rstrip(":")} if " " in first.value else set()
            return words(first)
        return set()

    found = {}
    for function in functions:
        tree = ast.parse(textwrap.dedent(inspect.getsource(function)))
        for item in ast.walk(tree):
            level = None
            if isinstance(item, ast.Call) and getattr(item.func, "id", None) == "add" and len(item.args) >= 2:
                level, text = item.args[0], item.args[1]
            elif isinstance(item, ast.Tuple) and len(item.elts) == 2:
                level, text = item.elts
            if isinstance(level, ast.Constant) and level.value in ("do", "wait", "note"):
                for verb in words(text):
                    found.setdefault(verb, set()).add(function.__name__)
    return found


class ExplainTests(unittest.TestCase):
    """`wg explain <verb>`: the part of the skill text for one verb of `wg next`."""

    def test_every_verb_that_next_can_print_has_an_entry(self):
        verbs = printed_verbs(wg.next_lines, wg.link_lines, AUTONOMY_LINES, wg.paused_lines, ANSWER_LINES,
                              wg.relay_reply)
        # The scan must see the verbs of each function, or it proves nothing.
        for verb in ("dispatch", "undraft", "ask-ready", "worker", "wave", "load", "triage", "answer", "paused",
                     "resumed", "autonomy", "relay", "replied", "human", "soak"):
            self.assertIn(verb, verbs)
        missing = {verb: sorted(where) for verb, where in verbs.items() if verb not in wg.EXPLAIN}
        self.assertEqual(missing, {})

    def test_each_entry_has_marked_text_of_at_most_60_lines(self):
        sections = wg.explain_sections()
        self.assertEqual(sorted(set(sections) - set(wg.EXPLAIN)), [])
        for verb in wg.EXPLAIN:
            with self.subTest(verb=verb):
                text = wg.explain_text(verb)
                self.assertTrue(text.strip(), "no marked text")
                self.assertLessEqual(len(text.splitlines()), wg.EXPLAIN_MAX_LINES)
                self.assertNotIn("<!--", text)

    def test_the_text_is_the_marked_part_only(self):
        text = wg.explain_text("dispatch")
        self.assertTrue(text.startswith("(references/coordinator.md)\n## Dispatch\n"))
        self.assertIn("Done when: `wg run show <plan-dir> <key>` shows `state=running`", text)
        self.assertNotIn("## Adopt", text)
        both = wg.explain_text("review")
        self.assertIn("(references/review-and-merge.md)\n## Wave review", both)
        self.assertIn("\n\n## Follow-up jobs", both)
        self.assertEqual(both.count("(references/coordinator.md)"), 1)

    def test_the_command_lists_explains_and_refuses_an_unknown_verb(self):
        with contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(wg.main(["wg", "explain"]), 0)
        listed = out.getvalue().splitlines()
        self.assertEqual([line.split()[0] for line in listed], list(wg.EXPLAIN))
        with contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(wg.main(["wg", "explain", "merged"]), 0)
        self.assertIn("## Merge point", out.getvalue())
        with contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()) as err:
            self.assertEqual(wg.main(["wg", "explain", "nothing"]), 2)
        self.assertEqual(out.getvalue(), "")
        self.assertIn("unknown verb 'nothing'", err.getvalue())

    def test_a_verb_gets_only_its_own_step(self):
        merged, undraft = wg.explain_text("merged"), wg.explain_text("undraft")
        self.assertNotEqual(merged, undraft)
        self.assertIn("**After each merge**", merged)
        for other in ("st undraft", "@claude-thorough", "**Threads.**", "**Merge request**", "**Close**"):
            self.assertNotIn(other, merged)
        self.assertIn("st undraft", undraft)
        self.assertNotIn("**After each merge**", undraft)
        # The shared text of the section stays: its heading and the paragraph before the steps.
        for text in (merged, undraft):
            self.assertIn("## Merge point", text)
        verifying = wg.explain_text("verifying")
        self.assertIn("`verifying <ship key>`", verifying)
        for other in ("`full-suite <ship key>`", "`ask <decision key>`", "`ops <ops key>`"):
            self.assertNotIn(other, verifying)
        self.assertEqual(verifying.count("(references/review-and-merge.md)"), 1)

    def test_the_coordinator_text_names_wg_explain(self):
        text = (Path(wg.__file__).resolve().parent.parent / "references" / "coordinator.md").read_text()
        self.assertIn("wg explain <verb>", text)
