---
name: work-graph
description: "Plan and run a large multi-PR effort (migration, rewrite, platform change, cross-team project) as a Linear dependency graph with Orca workers, merge points, and ship points. Use to plan, orchestrate, or track one."
---

# Work graph

A large effort is a **graph**. `plan.json` defines the graph. Linear (the plan's team) holds each node's state. Orca runs the workers. stax holds the branches and PRs. The graph decides order, never a worker.

Use this skill when the effort has two or more lanes that can run at the same time, or `ops` steps between its phases. One lane in one phase with no `ops` step is a plain stack: use `stax`, with one Linear issue for each PR. There `wg` does not run, so move each issue yourself in the same step as its work.

`scripts/wg.py` (written `wg`) holds the rules that must not slip: it checks the graph, syncs it to Linear, holds the claims, checks code done, guards each status change, and derives the next action. To run it, or when a shell says `command not found`: setup.md "Run wg".

**At the start of each run, ask the human for the autonomy level** ("Autonomy level") before any other step. **`wg next <plan-dir>` is the first command of each session and of each turn.** It prints one status line, then what to do (`do`), what you wait for (`wait`), and what you must know (`note`). It changes no status, no claim, and no run field (setup.md "Queries"). `wg explain <verb>` prints what to do for one verb of these lines.

Load `stax` and `orchestration` when a step names their commands. Read `<cmd> --help` for flags; the references hold only what help does not say.

**Config and local rules.** `~/.config/work-graph/config.json` (or `WG_CONFIG`) names the Linear workspaces, the human, the page, the branch prefix, the release branch, and the test runner (the repository README "Config"). **The human** is the person that config names: the one who answers, merges, and deploys. `Needs <human>` is the status `Needs <their name>`. `wg config` prints the config and the path of the local rules file (config `rules`, default `~/.config/work-graph/rules.md`). Read that file when it exists, before step 0: it holds the rules of the human's own workspaces and repositories, and it wins over a default here where they differ.

## Terms

[references/terms.md](references/terms.md) defines each term of this skill: node, phase, wave, wave review, lane, pre-merge and post-merge task, code done, evidence, patch, reviewed, merge review, approval, run row, merge point, ship point, soak, claim, the six node kinds, and ENG nodes. Read it before step 1, and each time a term is not clear.

## Rules

- The human merges PRs and deploys, except where level `full` lets the coordinator merge. Agents stop at open PRs that are code done. Agents never merge a PR, deploy, push to `main` or the release branch, or run `gh stack`. A local `git merge` or rebase that prepares a branch is allowed only in a coordinator-created worktree.
- `plan.json` is the source of truth for nodes and edges; Linear for status. Change the graph only in `plan.json`, then `wg check` and `wg load --apply`. Never add or remove a blocks relation by hand.
- `wg load --apply` sets the manual sort order of each issue in the plan's team to the run order. Never drag issues by hand in a work-graph project; the next load resets them.
- Every status change is a `wg` command (also for ENG nodes), in the same step as its work: `wg done` at each `worker_done`, `wg move` at each merge and each answer, before you start the next node. A status behind the work makes `wg next` and the page wrong. When `wg` refuses a false status (`Merged` with an open PR, a `Done` `ops` node with no evidence), fix the cause that it prints. Use `wg move … --force "<reason>"` only on the human's word. A move to `Merged` or `Done` also removes the node's Orca worktree (jobs.md "Worktree cleanup").
- `wg dispatch` and `wg claim` add a claim, and `wg done` removes it. Workers move only their own issue, and only to `Needs <human>`. The coordinator makes the moves to `In Review`, `Ready to Merge`, and `Merged` with `wg done` and `wg move`, because `wg` checks each one.
- Reviews never stop other work. A lane node stacks on the node below it as soon as that node is code done, while the wave review of the node below runs. A wave moves on at code done. The only review gate is the merge request of the reviewed PR.
- Never ask the human to approve a graph, a design, a wave, or a first PR, unless the level is `supervised`. Their request for the effort is the go: plan, refine, dispatch, review, and report your choices. Only merges, deploys, `ops` nodes (except `"by": "coordinator"`), and `decision` nodes are theirs; at level `full`, fewer are. When each open line is `wait human`, say once what you wait for, and do nothing in their place.
- Orca liveness decides if a worker is dead, never a claim label. Reuse a worktree only after Orca shows its last worker exited.
- Update the `PLAN.md` flowchart in the same step as each graph change. `PLAN.md` has no log: history goes to Linear comments.

## Autonomy level

The level (`full`, `standard`, or `supervised`; no label means `standard`) is a project label that `wg autonomy <plan-dir> [<level>]` prints or sets. Ask for it once at the start of each run, except when the request names it, autostart started the run, or the session runs in the background. It decides what the human does and what you do in their place. Before you ask, and at each `do autonomy` line, read [references/autonomy.md](references/autonomy.md) (also `wg explain autonomy`).

## Linear workspace, initiatives, and autostart

- The Linear workspace and key, the retries of a failed request, and the Free-plan archive: setup.md "Linear workspace". Read it before step 0 and after a failed Linear mutation.
- The initiative that groups related efforts: graph.md "Initiatives" (step 1).
- `wg autostart`, which starts a fresh coordinator when the effort has work: setup.md "Autostart". The human installs it.

## Steps

### 0. Set up

Follow [references/setup.md](references/setup.md).

Done when: the `<slug>-core` coordinator worktree exists, `wg` runs with the selected workspace's key, and its team has the kind labels and the `agent:*` claim labels.

### 1. Draw the graph

Set `effort.initiative` (graph.md "Initiatives"). Write `<plan-dir>/PLAN.md`: one Mermaid flowchart, a phase table (phase, target branch, ship environment, merge point, ship point, soak), and an empty `## Notes` section. Use [references/graph.md](references/graph.md) for the templates and [references/ordering.md](references/ordering.md) for targets, lanes, and ship chains.

- Draw an edge only for a real order constraint. Each extra edge removes parallelism.
- End each phase on a **shippable** state: after its ship point, prod works and the effort can stop. For live data, APIs, or schemas, shape phases as **expand → migrate → contract**.
- Put each deploy, backfill run, flag flip, and prod check in the graph as an `ops` node, and each soak length in the phase table. Give an `ops` node `"by": "coordinator"` when the repository's own rules make that step the agent's (for example, the agent checks its own deploy); otherwise it is the human's (`do ask`).

Show the human the flowchart and the phase table, and continue to step 2 without waiting (at level `supervised`, wait for their approval first). Change the graph when they comment.

Done when: every phase has a target, a merge point, and a ship point, every `task` has a lane, and no edge joins two lanes inside one phase.

<!-- explain: load -->
### 2. Load the graph

Convert the flowchart to `<plan-dir>/plan.json` ([references/graph.md](references/graph.md#planjson)). Then:

```bash
wg check <plan-dir>                 # exit 0: no cycle, no orphan, lane rules hold
wg preflight <plan-dir>             # exit 0: tools, Linear, stax trunk of each phase
wg load  <plan-dir>                 # dry run: show the human what will be created
wg load  <plan-dir> --apply         # writes keymap.json; sorts issues in run order
wg ready <plan-dir> --apply         # first nodes move to Ready
```

On a `FAIL base` or `FAIL trunk` line: stop, and follow setup.md "Stax trunk and targets" (also `wg explain load`).

Done when: `wg check` and `wg preflight <plan-dir>` exit 0, a second `wg load <plan-dir>` prints `no changes to nodes`, no `missing` or `not in plan.json` relation, and no `orphan` line (remove stale ones with `wg load <plan-dir> --apply --prune`), and the project link is in `PLAN.md`.
<!-- /explain -->

<!-- explain: wave -->
### 3. Pick and refine the next wave

`wg next` prints `wave: pick the next wave from <keys>` when each node of the last wave is code done; their reviews can still run. Pick the wave: the keys of the next nodes to run, all pre-merge or all post-merge. Record them with `wg run set <plan-dir> @effort wave=<k1,k2>`. Refine only these nodes.

1. Unknowns → a `spike`. Open questions → a `decision` that blocks the affected nodes; resolve it with the human through `grilling`.
2. A node too big for one PR → split it ([references/graph.md](references/graph.md#split-a-node)).
3. Write `acceptance`, `owns`, and `shares` in `plan.json` ([references/ordering.md](references/ordering.md#file-ownership)), and the design in the issue description. Run `wg load <plan-dir> --apply` again: it updates the issue's node card comment (acceptance, owns, shares). Then dispatch; do not ask the human to approve the design (at level `supervised`, wait for their approval of the wave first).

Done when: every `task` of the wave fits one PR and has acceptance and `owns`, `wg owns overlap <plan-dir> <wave keys>` exits 0, and `wg next` prints `dispatch` for each wave node that has no blocker inside the wave.
<!-- /explain -->

### 4. Run and review the wave

Run the coordinator loop in [references/coordinator.md](references/coordinator.md). Workers are Codex in Orca, one per node, each in its own Orca child worktree. `wg dispatch` sets no limit on live workers: dispatch every ready node of the wave.

1. A test that fails in a node's evidence is that node's failure, unless it is a known failure (jobs.md "Known failures").
2. At each node's code done, start the wave review of that PR and the dispatch of the node above it in the lane, both at once (review-and-merge.md "Wave review"). A review fix on the node below sends a restack job to the node above.

Done when: every `task` of the wave is code done, and every `spike` is `Done` with findings. A failed or blocked node stops only itself and the nodes above it in its lane: record it with `wg done <plan-dir> <key> --failed "<error>"` (or `wg run set <plan-dir> <key> state=blocked`), report it, and continue with the other nodes.

Repeat steps 3–4 for each wave until every pre-merge task of the phase is code done. Step 5 runs at the same time, one PR at a time as each wave review passes.

### 5. Pass the merge point

Follow [references/review-and-merge.md](references/review-and-merge.md#merge-point) "Merge point": ready, merge review, threads, then the merge requests, bottom to top in each lane. A push that changes the patch brings the merge review back for that PR.

Done when: every pre-merge task is `Merged`, and `wg move <plan-dir> <merge point> Done` passed. It proves that the target branch holds each merge commit.

### 6. Ship the phase

Start both parts when the merge point is `Done`; the ship point waits for both.

1. Post-merge tasks: a SYNC task runs steps 3–4 as one wave; the integration node is coordinator-owned (ordering.md "`effort/<slug>`: integration branch"). Then step 5 for their PRs (SYNC: merge commit).
2. Follow review-and-merge.md "Ship point". You run the phase's repo-wide test run (`full-suite`). The human does each `ops` node, and you do each one with `"by": "coordinator"`; you resolve each ready `decision` with them.

Done when: the repo-wide test run of the phase passed, every `ops` node of the phase is `Done` with evidence, the soak deadline has passed (when the phase has a soak), and the ship point is `Done`.

Repeat steps 3–6 for each phase.

### 7. Close the effort

After the last ship point, close or replan each open node with the human. Then `wg status <plan-dir>` must show every node `Done` or `Canceled`; set the Linear project status to Completed.

Done when: the project is Completed and no node is open.

## Mark a PR reviewed

The human marks a PR reviewed with the issue label **`reviewed`**; an agent never adds or removes it (review-and-merge.md "Mark a PR reviewed").

## See the graph

The page is the web app at the root of this repository: the hosted `page_url` of the config, or `wg ui`. Give the human the link that `wg next` prints. For page data, links, edits, local use, and contract updates: [references/page.md](references/page.md).

## When the plan breaks

Red CI, a failed worker, a PR closed without a merge, a regression, a graph change, a `reconcile` line, or a new coordinator session: follow [references/recovery.md](references/recovery.md).

## Report progress

Post the status line of coordinator.md "Report progress" after each wave and each merge point.
