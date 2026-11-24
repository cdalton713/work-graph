---
name: work-graph
description: "Plan and run a large multi-PR effort (migration, rewrite, platform change, cross-team project) as a Linear dependency graph with Orca workers, merge points, and ship points. Use to plan, orchestrate, or track one."
---

# Work graph

A large effort is a **graph**. `plan.json` defines the graph. Linear (the plan's team) holds each node's state. Orca runs the workers. stax holds the branches and PRs. The graph decides order, never a worker.

Use this skill when the effort has two or more lanes that can run at the same time, or `ops` steps between its phases. One lane in one phase with no `ops` step is a plain stack: use `stax`, with one Linear issue for each PR. There `wg` does not run, so no command moves a status for you: move each issue yourself in the same step as its work.

`scripts/wg.py` (written `wg` below) holds the rules that must not slip. Run it as `wg`: the command uses `uv run --script`, which supplies the `websockets` package for the link to the page (see [references/page.md](references/page.md) "Link"). `python3 -I <skill-dir>/scripts/wg.py` also works; without `websockets` in that Python, `wg next` polls Linear. It validates the graph, syncs it to Linear, takes and releases claims, checks code done, guards each status change, and derives the next action. `wg` is also a command on PATH: `~/.local/bin/wg` is a link to the script. If a shell says `command not found`, make the link again: `ln -s <skill-dir>/scripts/wg.py ~/.local/bin/wg`.

**At the start of each run, ask the human for the autonomy level** ("Autonomy level" below) before any other step. **`wg next <plan-dir>` is the first command of each session and of each turn.** It prints one status line, then what to do (`do`), what you wait for (`wait`), and what you must know (`note`). It reads Linear, GitHub, and the run rows. It changes no status, no claim, and no run field. It copies its result to Linear for the page ("See the graph"): the wave and the next action on each node card, and every line in the project document `work-graph status`; `--no-publish` skips the copy.

Load `stax` and `orchestration` when a step names their commands. Read `<cmd> --help` for flags. The references hold only what help does not say.

**Config and local rules.** `~/.config/work-graph/config.json` (or `WG_CONFIG`) names the Linear workspaces, the human, the page, the branch prefix, the release branch, and the test runner (the repository README "Config"). In this skill, **the human** is the person that config names: the one who answers, merges, and deploys. `Needs <human>` is the status `Needs <their name>`. `wg config` prints the config and the path of the local rules file (config `rules`, default `~/.config/work-graph/rules.md`). Read that file when it exists, before step 0: it holds the rules of the human's own workspaces and repositories, and it wins over a default here where they differ.

## Terms

| Term | Meaning |
|---|---|
| **node** | One entry in `plan.json` and one Linear issue. It has a `key`, a `kind` (table below), and a `phase`. `keymap.json` maps each key to its issue. |
| **phase** | The nodes from one ship point to the next. One target branch. It ends at a merge point, then a ship point. It is a milestone of the effort's Linear project. A split phase uses keys `1a`, `1b`. |
| **wave** | A frozen list of node keys of one phase, picked in step 3 and recorded with `wg run set <plan-dir> @effort wave=<k1,k2>`. One dispatch round. It may hold higher lane nodes that wait only for a lower node of the same wave. |
| **wave review** | The agent review of a draft PR before the merge review. It has up to two rounds. See [Wave review](references/review-and-merge.md#wave-review). |
| **lane** | A chain of `task` nodes in one phase (`"lane": "<name>"`). One lane = one stax stack. Each node stacks on the node before it, as soon as that node is code done. Two nodes can stack on one node (a fork). |
| **pre-merge task** | A `task` that the merge point depends on. |
| **post-merge task** | A SYNC or integration `task` (`"role": "sync"` or `"integration"`). It depends on the merge point, runs as its own wave, and the ship point depends on it. |
| **code done** | `wg done <plan-dir> <key>` passed on the PR's current head: the PR is open on the right base, the worktree is clean at that head, its **evidence** passed on that head (or its failure is accepted for that head with `tests_accepted`), the diff stays in owns and shares, and no check failed. The issue moves to `In Review`. `gh pr checks` is not test evidence. |
| **evidence** | The proof that a commit passed its tests. With `effort.test`, `wg evidence <plan-dir> <key>` runs that command. With the config `test_runner`, it runs the moon test tasks that the node's diff from its diff base affects, with each project that depends on a changed project; a diff that changes a root file or `.moon/` gets the repo-wide suite. `wg evidence <plan-dir> @full-<phase>` runs the repo-wide suite: one time for each phase, on the merged target. |
| **patch** | The branch's own diff from its lane base; `wg` stores a hash of it without line numbers. A review covers a patch, not a head. A restack with no conflict keeps the review, unless the base changed a line within 3 lines of a hunk. Each other change of the diff clears it. |
| **reviewed** | The run row has `review=clean` or `review=accepted` for the current patch (review-and-merge.md "Wave review"), or the issue has the `reviewed` label ("Mark a PR reviewed"). Only the merge request of that PR waits for it. |
| **merge review** | The gate at the merge point: `merge_review=clean` or `accepted` for the current patch. A PR gets one thorough review (`@claude-thorough`). After a fix push, the coordinator checks the fix diff against that review; a second thorough review runs only when the fix is new work (review-and-merge.md "Merge point" step 2). |
| **approval** | The human's own words about a node, recorded with `wg approve` when you want them on the issue. No step waits for one. |
| **run row** | The node's or the effort's checkpoint fields in `keymap.json` (recovery.md "Run state"). `wg` writes most of them. |
| **merge point** | A `merge-point` node. Done when every pre-merge task of the phase is `Merged`. |
| **ship point** | A `ship-point` node. Done when every `ops` node, post-merge task, and soak of the phase is done. The next phase depends on it. |
| **soak** | A deadline on the ship point: the run row field `soak_until`. It is not a node. |
| **claim** | An `agent:*` label. It is on an issue only while a worker job on that issue runs. Only `wg` sets or removes it; the one exception is a stale claim that a crash left (recovery.md "A claim label with no running job"). |

| Kind | Label | Done by |
|---|---|---|
| `task` | – | A worker: one branch, one PR |
| `spike` | `spike` | A worker: research, findings in a comment, no PR |
| `decision` | `decision` | The human: a question that blocks |
| `ops` | `ops` | The human: deploy, backfill run, flag flip, prod verification. Done only with recorded evidence. With `"by": "coordinator"` the coordinator runs it, in a repository whose own rules let the agent deploy or verify. |
| `merge-point` | `merge-point` | The coordinator |
| `ship-point` | `ship-point` | The coordinator |

The effort itself is the Linear project. A node with `"eng": "ENG-123"` is an existing ticket of another team (written ENG here) whose workflow has other status names: `wg load` maps it and does not copy it. `wg move` writes its status with that team's names (setup.md "ENG tickets").

## Rules

- The human merges PRs and deploys, except where the autonomy level `full` lets the coordinator merge ("Autonomy level"). Agents stop at open PRs that are code done. Agents never merge a PR, never deploy, never push to `main` or the release branch, and never run `gh stack`. A local `git merge` or rebase that prepares a branch is allowed, only in a coordinator-created worktree.
- `plan.json` is the source of truth for nodes and edges. Linear is the source of truth for status. Change the graph only in `plan.json`, then `wg check` and `wg load --apply`. Never add or remove a blocks relation by hand.
- Issues show in run order. `wg load --apply` sets the manual sort order of each issue in the plan's team from `plan.json`. Never drag issues by hand in a work-graph project; the next load resets them.
- Every status change is a `wg` command, for the plan's team and ENG nodes. Run it in the same step as the work that it records: `wg done` at each `worker_done`, `wg move` at each merge and each answer, before you start the next node. A status that is behind the work makes `wg next` and the page wrong for the human. `wg` refuses a move that would write a false status, such as `Merged` with an open PR or a `Done` `ops` node with no evidence, and it prints the cause. Fix the cause. Use `wg move … --force "<reason>"` only on the human's word. A move to `Merged` or `Done` also removes the node's Orca worktree (coordinator.md "Worktree cleanup").
- `wg dispatch` and `wg claim` add a claim, and `wg done` removes it. Workers move only their own issue, and only to `Needs <human>`. The coordinator makes the moves to `In Review`, `Ready to Merge`, and `Merged` with `wg done` and `wg move`, because `wg` checks each one.
- Reviews never stop other work. A lane node stacks on the node below it as soon as that node is code done, and the wave review of the node below runs at the same time. A wave moves on at code done. The only review gate is the merge request of the reviewed PR.
- Never ask the human to approve a graph, a design, a wave, or a first PR, unless the autonomy level is `supervised`. Their request for the effort is the go: plan, refine, dispatch, and review, and report what you decided. Only merges, deploys, `ops` nodes (except those with `"by": "coordinator"`), and `decision` nodes are theirs; at level `full`, fewer are ("Autonomy level"). When each open line is `wait human`, say once what you wait for, and do nothing in their place.
- Orca liveness decides if a worker is dead. A claim label never does. Reuse a worktree only after Orca shows its last worker exited.
- Update the `PLAN.md` flowchart in the same step as each graph change. `PLAN.md` has no log: history goes to Linear comments.

## Linear workspace

The config lists the Linear workspaces. Set `effort.workspace` to the id of the workspace that owns the work; a plan without it uses the first one. `effort.team` defaults to the workspace's `team`. A workspace with `teams` accepts only those teams, and a team that another workspace names stops `wg`. Choose from the work's owner, not the current shell key. Do not copy issues from one workspace into another.

`wg` selects the key for every command from the plan: `LINEAR_<ID>_API_KEY`, then the workspace's `key_env` names, then the private file `~/.config/work-graph/<id>-linear-api-key` (mode 600). A missing key stops the command; it never uses the key of another workspace. Keep keys out of plans, comments, and command arguments.

`wg` tries a Linear request again when it failed for a short time, at most 4 tries, with a longer delay each time. It tries a query again after a network error, a timeout, HTTP 429, HTTP 5xx, or a `RATELIMITED` error. It tries a mutation again only when Linear refused it before it ran (HTTP 429 or `RATELIMITED`), because after a timeout or a 5xx Linear can have applied it. At a rate limit, `wg` waits for Linear's reset time when it is at most 60 s away, and stops at once when it is farther. Each new try prints one `warn linear:` line to stderr. After a failed mutation, read the issue before you run the command again.

Linear's Free plan holds 250 issues in a workspace; archived issues do not count. In a workspace with no paid plan, `wg` archives every completed and canceled issue of the workspace, not only the nodes of the plan: at each `wg move` to `Done` or `Canceled`, and at each `wg tick`. `wg archive <plan-dir>` shows what it would archive; `--apply` archives it. An archived node stays in the graph, on the page, and in `wg next`. A `wg move` of an archived node to an open status restores it first. Do not archive or restore issues by hand.

## Initiatives

An initiative groups related projects, for example each effort on one tool. It is a child label of the project label group `initiative`, not a Linear initiative: those are company-wide. In a workspace with `team_labels: true` the group belongs to the plan's team, so only that team sees it. Else it is a workspace group, because Linear's team project labels need the Business plan. The group is single-select, so a project has at most one initiative.

- In step 1, set `effort.initiative` in `plan.json`. Use the name of an existing initiative when the effort continues its work: When the name is new, `wg load` prints `create initiative <name> (existing: <names>)`. Make a new name only for a new area of work. Do not ask the human to approve the name.
- `wg load --apply` creates the group and the initiative label when they are missing, and sets the label on the project. It replaces another initiative label on the project. Without `effort.initiative`, `wg load` leaves the project's labels as they are.
- The page groups the overview by initiative ("See the graph"). `?initiative=<URL-encoded name>` opens the overview with only that initiative.

## Autonomy level

The level is a label of the Linear project: one child of the single-select project label group `autonomy` (`full`, `standard`, or `supervised`). No label means `standard`. `wg autonomy <plan-dir>` prints the level; `wg autonomy <plan-dir> <level>` sets it.

A run is one coordinator session of the effort: the first `/work-graph` request, or a new session that resumes it. At the start of each run, before step 0 or the first `wg next`, ask the human which level this run uses. Use `AskUserQuestion` with the three levels below, and put the current level (`wg autonomy <plan-dir>`) first, marked "(current)". Do not ask when their request for this run already names a level, when `wg autostart` started the run ("Autostart"), or when the session runs in the background: there, use the current level. After this one question, the loop never waits on a prompt (coordinator.md "Never block on a prompt"). Then record it: `wg autonomy <plan-dir> <level>` (before step 2, `<plan-dir>` has no `keymap.json` yet: keep the level and record it right after `wg load --apply`). Say the level in the first status line of the run.

The human can change the level at any time on the page (the **Autonomy** menu of the project) or in Linear. `wg next` reads the label each time. Its first line is `note autonomy @effort -: <level>`. When the level changed since your last `wg next`, that line is `do autonomy @effort -: The human set the autonomy level to <new> (was <old>)…` instead, and a `wg next --wait` wakes for it. The new level takes effect at once: from that step on, ask for, or do yourself, what the table gives the new level. Say the change in your next status line. A level change that the human gives in this session: record it with `wg autonomy <plan-dir> <level>`.

| Level | The human does | The coordinator also does |
|---|---|---|
| `full` | `ops` nodes. Merges and deploys in repositories where agents may not merge. | Answers each `decision` node, each `do triage` line, and each review hold after 2 rounds itself, and records each choice on the issue. Merges each PR in a repository where agents may merge. Never waits for the human's review. |
| `standard` | Merges, deploys, `ops` nodes, `decision` nodes, triage, review holds after 2 rounds. | The rest, as these steps say. This is the default when no level is recorded. |
| `supervised` | All of `standard`, plus: approves the graph before `wg load --apply`, each wave before its first dispatch, and each PR with the `reviewed` label before its merge request. | Asks once for each gate, and waits for their answer. Other nodes continue. |

Level `full`:

- **Where agents may merge.** Only a repository whose rules let agents merge: the local rules file or the repository's own agent instructions say so. Everywhere else the human always merges and deploys; at `ask-merge`, ask them as at `standard`. No level lets an agent deploy, run an `ops` node without `"by": "coordinator"`, push to `main` or the release branch directly, or bypass a `wg` check.
- **Merge.** At `ask-merge <key> #<n>`: `wg move <plan-dir> <key> "Ready to Merge"`, then `gh pr merge <n> --squash` (`--merge` for a SYNC PR), then the `merged` line as usual. Merge bottom to top in each lane, one PR at a time.
- **Decisions.** At `ask <decision key>`: decide from the plan, the issue, and the code. Then `wg move <plan-dir> <key> Done --note "autonomy=full, coordinator's choice: <answer>; reason: <reason>"`. A decision that is hard to reverse (a public or persistent contract, data loss, a cost) still goes to the human.
- **Review holds.** After 2 blocking rounds: send one more fix (`wg claim <plan-dir> <key> review`), or accept with `wg run set <plan-dir> <key> review=accepted` and an issue comment that names each accepted finding and why. Never add the `reviewed` label; it stays the human's.
- **Triage.** Adopt the issue through recovery.md "Replan", or move it to `Backlog`, and comment the reason.
- Report each choice in the status line, so the human can undo it.

Level `supervised`: show the gate's content (the flowchart and phase table, the wave keys with each node's acceptance, or the PR) and wait (coordinator.md "Wait"). Record their approval with `wg approve` when they give words to keep.

## Autostart

`wg autostart <plan-dir> --install` makes an Orca automation for the effort's `<effort>-core` worktree. Every 5 minutes it runs `wg wake <plan-dir>` as its precheck, and starts a coordinator agent (the human's default agent, in a fresh session) only when `wg wake` says `start`. `wg wake` says `start` when all of these hold: no agent that Orca reports as not done runs in that worktree; fewer than 2 coordinator agents run on the machine; fewer than 3 starts for this effort in the last hour; the autonomy level is not `supervised`; the effort is not paused; and the effort has work (a page message waits for a coordinator, an answer from the page, an autonomy change, or a `do` line from `wg next`). Otherwise it prints `skip: <reason>`, which Orca keeps in the automation's run history. `wg autostart <plan-dir>` prints the state; `--uninstall` removes the automation. The human installs it; a coordinator does not install it on its own.

A run that autostart started uses the project's current autonomy level and does not ask for one. It runs the coordinator loop (references/coordinator.md) as any other run.

## Steps

### 0. Set up

Follow [references/setup.md](references/setup.md).

Done when: the `<slug>-core` coordinator worktree exists, `wg` runs with the selected workspace's key, and its team has the kind labels and the `agent:*` claim labels.

### 1. Draw the graph

Set the effort's initiative ("Initiatives"). Write `<plan-dir>/PLAN.md`: one Mermaid flowchart, a phase table (phase, target branch, ship environment, merge point, ship point, soak), and an empty `## Notes` section. Use [references/graph.md](references/graph.md) for the templates and [references/ordering.md](references/ordering.md) for targets, lanes, and ship chains.

- Draw an edge only for a real order constraint. Each extra edge removes parallelism.
- End each phase on a **shippable** state: after its ship point, prod works and the effort can stop. For live data, APIs, or schemas, shape phases as **expand → migrate → contract**.
- Put each deploy, backfill run, flag flip, and prod check in the graph as an `ops` node. Write each soak length in the phase table. Give an `ops` node `"by": "coordinator"` when the repository's own rules make that step the agent's (for example, the agent checks its own deploy); otherwise `wg next` prints it as `do ask` and the page shows the human as the one who must act.

Show the human the flowchart and the phase table, and continue to step 2 without waiting (at level `supervised`, wait for their approval first). Change the graph when they comment.

Done when: every phase has a target, a merge point, and a ship point, every `task` has a lane, and no edge joins two lanes inside one phase.

### 2. Load the graph

Convert the flowchart to `<plan-dir>/plan.json` ([references/graph.md](references/graph.md#planjson)). Then:

```bash
wg check <plan-dir>                 # exit 0: no cycle, no orphan, lane rules hold
wg preflight <plan-dir>             # exit 0: tools, Linear, stax trunk of each phase
wg load  <plan-dir>                 # dry run: show the human what will be created
wg load  <plan-dir> --apply         # writes keymap.json; sorts issues in run order
wg ready <plan-dir> --apply         # first nodes move to Ready
```

On `FAIL base`: the frozen base's PR targets another branch than its stax parent, carries foreign commits, or sits in a native stack. Stop and ask the human which base is right; never pick one. On `FAIL trunk`: stop and ask the human to do what the `FAIL trunk` lines say: set up the base (setup.md "Stax trunk and targets"), set the trunk with `st init`, or freeze the integration branch. Never run `st trunk`: it checks out the trunk.

Done when: `wg check` and `wg preflight <plan-dir>` exit 0, a second `wg load <plan-dir>` prints `no changes to nodes`, no `missing` or `not in plan.json` relation, and no `orphan` line (remove stale ones with `wg load <plan-dir> --apply --prune`), and the project link is in `PLAN.md`.

### 3. Pick and refine the next wave

`wg next` prints `wave: pick the next wave from <keys>` when each node of the last wave is code done; their reviews can still run. Pick the wave: the keys of the next nodes to run, all pre-merge or all post-merge. Record them with `wg run set <plan-dir> @effort wave=<k1,k2>`. Refine only these nodes.

1. Unknowns → a `spike`. Open questions → a `decision` that blocks the affected nodes; resolve it with the human through `grilling`.
2. A node too big for one PR → split it ([references/graph.md](references/graph.md#split-a-node)).
3. Write `acceptance`, `owns`, and `shares` in `plan.json` ([references/ordering.md](references/ordering.md#file-ownership)), and the design in the issue description. Run `wg load <plan-dir> --apply` again: it updates the issue's node card comment (acceptance, owns, shares). Then dispatch; do not ask the human to approve the design (at level `supervised`, wait for their approval of the wave first).

Done when: every `task` of the wave fits one PR and has acceptance and `owns`, `wg owns overlap <plan-dir> <wave keys>` exits 0, and `wg next` prints `dispatch` for each wave node that has no blocker inside the wave.

### 4. Run and review the wave

Run the coordinator loop in [references/coordinator.md](references/coordinator.md). Workers are Codex in Orca, one per node, each in its own Orca child worktree. `wg dispatch` sets no limit on live workers: dispatch every ready node of the wave.

1. Known failures: a test that fails in a node's evidence is that node's failure, unless the same test also fails in the evidence log of a node in another lane, or in the last `@full-<phase>` log. Record such a test with `wg run set <plan-dir> @effort "baseline=<target sha10>: <tasks>"`; the workers read this field. Exit 3 or a test-server error is an error, not a known failure.
2. At each node's code done, start the wave review of that PR and the dispatch of the node above it in the lane, both at once ([references/review-and-merge.md](references/review-and-merge.md#wave-review)). A review fix on the node below sends a restack job to the node above.

Done when: every `task` of the wave is code done, and every `spike` is `Done` with findings. A failed or blocked node stops only itself and the nodes above it in its lane: record it with `wg done <plan-dir> <key> --failed "<error>"` (or `wg run set <plan-dir> <key> state=blocked`), report it, and continue with the other nodes.

Repeat steps 3–4 for each wave until every pre-merge task of the phase is code done. Step 5 runs at the same time, one PR at a time as each wave review passes.

### 5. Pass the merge point

Follow "Merge point" in [references/review-and-merge.md](references/review-and-merge.md#merge-point): ready, merge review, threads, then the merge requests, bottom to top in each lane. A PR starts these steps when its own wave review passes; it does not wait for the other PRs of the phase. A push that changes the patch brings the merge review back for that PR.

Done when: every pre-merge task is `Merged`, and `wg move <plan-dir> <merge point> Done` passed. It proves that the target branch holds each merge commit.

### 6. Ship the phase

Start both parts when the merge point is `Done`; the ship point waits for both.

1. Post-merge tasks: a SYNC task runs steps 3–4 as one wave; the integration node is coordinator-owned ([references/ordering.md](references/ordering.md#effortslug-integration-branch)). Then step 5 for their PRs (SYNC: merge commit).
2. Follow "Ship point" in [references/review-and-merge.md](references/review-and-merge.md#ship-point). You run the phase's repo-wide test run (`full-suite`). The human does each `ops` node, and you do each one with `"by": "coordinator"`; you resolve each ready `decision` with them.

Done when: the repo-wide test run of the phase passed, every `ops` node of the phase is `Done` with evidence, the soak deadline has passed (when the phase has a soak), and the ship point is `Done`.

Repeat steps 3–6 for each phase.

### 7. Close the effort

After the last ship point, close or replan each open node with the human. Then `wg status <plan-dir>` must show every node `Done` or `Canceled`; set the Linear project status to Completed.

Done when: the project is Completed and no node is open.

## Mark a PR reviewed

The human marks a PR reviewed with the Linear label **`reviewed`** on its issue, in Linear or in `wg ui`. The label counts as the wave review and the merge review of that PR. It also accepts blocking findings that held the PR after 2 review rounds. Remove the label to undo it. An agent never adds or removes this label. A merge of the PR is also their review.

They have nothing else to mark: agent reviews run by themselves, and the coordinator undrafts each PR and requests its thorough review. A GitHub "Approve" cannot work, because agents open the PRs with their account, and GitHub refuses an approval from the author of a PR.

## See the graph

The page is the web app at the root of this repository: the hosted page of the config `page_url`, or `wg ui` on this machine.
Give the human the link that `wg next` prints.
For page data, links, edits, local use, and contract updates, read [references/page.md](references/page.md).

## When the plan breaks

Red CI, a failed worker, a PR closed without a merge, a regression, a graph change, a `reconcile` line, or a new coordinator session: follow [references/recovery.md](references/recovery.md).

## Report progress

Name each PR by its GitHub number (`#7747`). The `NN` prefix of a worktree is the lane position from `00`. The human counts PRs from 1 at the bottom of the lane, as the stax stack comment lists them: their "PR 3" is the third PR from the bottom, the `02 …` worktree. When they name a PR by position, repeat its number back before you change it.

After each wave and each merge point, post the first line of `wg next <plan-dir>` and the next action that is the human's:

`phase 1: 9 tasks, 9 code done, 9 reviewed, 0 merged. Next: merge point 1 needs your merge of #1234, then #1235.`
