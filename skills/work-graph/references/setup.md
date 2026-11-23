# Setup: plan location, Linear, and labels

| Item | Location |
|---|---|
| `<plan-dir>` | The effort's `<slug>-core` coordinator worktree; branch `<prefix><slug>-core` (config `branch_prefix`) |
| `PLAN.md` | Flowchart, phase table, project link, `## Notes` (recovery.md "Run state") |
| `plan.json` | The graph: effort, phases, nodes, edges ([graph.md](graph.md#planjson)) |
| `keymap.json` | Written by `wg` only: project, phase milestones, key → issue id, identifier, node card, and what `wg next` last published for the page; the id of the `work-graph status` document; the run rows |
| `evidence/` | Written by `wg evidence`: the last test run of each node, and the repo-wide run of each phase |
| `specs/` | Written by `wg dispatch` and `wg claim`: the worker spec of each job |
| Linear | The plan's team. One project per effort; one project milestone per phase. |

## Plan location

Select or create the `<slug>-core` coordinator worktree through Orca before writing the plan: `orca worktree list --json`, else `orca worktree create --name <slug>-core --branch <prefix><slug>-core --no-parent --base-branch origin/<target> --setup skip --json`. It is the only top-level workspace of the effort; every lane parent, spike, and integration workspace nests under it. Reuse it for the core lane parent when the names match. Keep `PLAN.md`, `plan.json`, `keymap.json`, `evidence/`, and `specs/` together at its root. Do not commit them unless the human asks. If `keymap.json` is lost, follow recovery.md "Failure" before any `wg load --apply`.

When moving an existing setup, copy all of them, check that `wg status <new-dir>` prints the same issues, then delete the old copies.

## Linear

1. Configure the plan's Linear workspace and key as described in SKILL.md "Linear workspace". `wg preflight <plan-dir> [--phase P]` checks the tools (`git`, `gh auth`, `st`), the selected key, the statuses and claim labels below, and the target of each phase ("Stax trunk and targets").
2. The plan's team needs these statuses. For a team that owns its statuses (`inheritWorkflowStatuses: false`), configure them on the team: Triage, Backlog, Todo, Ready, In Progress, Needs <human>, In Review, Ready to Merge, Merged, Verifying, Done, Canceled, Duplicate. `Needs <human>` is `Needs` and the config's `human` (for example `Needs Ada`). `wg` uses these names; do not rename them. The meanings are in the table below.
3. Kind labels for the plan's team: `merge-point`, `ship-point`, `ops`, `decision`. `wg load` creates `spike` on first use, and the `reviewed` label (SKILL.md "Mark a PR reviewed").
4. Claim labels: the workspace label group `agent` (single-select) with `agent:codex`, `agent:claude`, and `agent:coordinator`. Single-select means an issue holds at most one claim. The claim comment names the Orca dispatch.
5. Initiatives: the project label group `initiative` (single-select): a team group where the workspace has `team_labels: true`, else a workspace group. `wg load --apply` creates it and its labels on first use. If Linear says that a label it just created is a duplicate, `wg` reads the labels again and uses that label.
6. Agents use the human's API key, so Linear shows them as the author of each agent comment and status change. A comment is no proof of who wrote it. Their words about a node can be recorded with `wg approve --quote`; their `ops` evidence and their answers go in `wg move --note`.

| Status | Meaning |
|---|---|
| Triage | New, unsorted. Agent-found follow-ups land here. |
| Backlog | Deferred. No agent picks it up. |
| Todo | Planned, but it has open blockers or an incomplete spec. |
| Ready | No open blockers, and the spec is complete. It can be dispatched. |
| In Progress | Dispatched to a worker, or taken by the coordinator. While a worker job runs, the issue has an `agent:*` claim label. |
| Needs <human> | Waits on the human: a decision, a login, a deploy, or an answer. The latest comment says what is needed. |
| In Review | PR open. CI and an independent review run. |
| Ready to Merge | CI green, review threads resolved. The human merges, or the coordinator at level `full` where agents may merge. |
| Merged | Merged. Waits for the deploy. |
| Verifying | Deployed. Post-deploy checks or a soak run. |
| Done | Acceptance criteria verified. |
| Canceled, Duplicate | Closed without the work. |

## Stax trunk and targets

stax has one trunk for the repository (`git cat-file -p refs/stax/trunk`); it stays as it is. A lane runs in one of two modes:

- **Target is the trunk:** `st sync` refreshes it.
- **Target is an imported, frozen base:** its metadata (`git cat-file -p refs/branch-metadata/<target>`) has a non-empty `sourceRemote` and `"frozen": true`. stax never pushes, restacks, or syncs it. The coordinator refreshes it with `wg base <plan-dir>` (fast-forward only); on a `FAIL base` line it stops and asks the human.

Setup of a base, one time for each branch, in the checkout that holds it: `st get <target> --parent <trunk> --no-checkout --downstack --no-restack && st freeze <target>`. Only the human runs or approves it: on `FAIL trunk` the coordinator stops and asks them. In a routine refresh, the coordinator and the workers never run `st sync`, `st get`, `st unfreeze`, or `st branch untrack` on a frozen base. If the human later makes a base the trunk, they first run `st branch untrack <branch>`.

## ENG tickets

A node with `"eng": "ENG-123"` is an existing ENG ticket. `wg load` maps it, adds relations, and keeps a node card comment on it; it never changes the title or the description. `wg move <plan-dir> <key> "<status>"` writes the ENG twin:

| Status | ENG write |
|---|---|
| Todo, Ready | `Ready for Eng` |
| In Progress | `In Dev` |
| In Review | `In Review` |
| Ready to Merge | `In Review`, and the workspace label `ready-to-merge` |
| Merged | `Ready for Deploy` |
| Done / Canceled | `Done` / `Canceled` |
| Needs <human> | no status change; adds the workspace label `needs-<human>` |
| Triage, Backlog, Verifying | exit 2: `no ENG status for <status>: ask the human` |

Every other ENG move removes `needs-<human>` and `ready-to-merge`. `wg` creates each workspace label on first use. `wg ready --apply` moves only plan-team nodes (Todo ↔ Ready); every other move is `wg move`; `wg ready` prints `skipped <key>: status <name>` for a task in an ENG status with no twin (for example `Scoping`).

Reading (`next`, `ready`, `status`): the `needs-<human>` label reads as `Needs <human>`, and `In Review` with the `ready-to-merge` label reads as `Ready to Merge`. Else a completed state reads as `Done`, canceled or duplicate as `Canceled`, `Ready for Eng` as `Todo`, `In Dev` as `In Progress`, `External QA` as `In Review`, `Ready for Deploy` as `Merged`. Other names read as they are.

## Queries

- `wg next <plan-dir>`: one status line for the open phase, then each `do`, `wait`, and `note` line (coordinator.md "Loop").
- `wg verify <plan-dir> <key>`: the code done checks of `wg done`, on the PR's current head, with the node's worktree as the current directory. It prints each `ok` and `FAIL` line and sets or removes `code_done_head`. It changes no claim, no status, and no review. Use it to see why a node is not code done; a `verify <key>` line of `wg next` still means `wg done`.
- `wg status <plan-dir> [--phase P]`: every node in run order, with its status, claim, and run row (`state`, `pr`, `code_done_head`, `review`, `dispatch`).
- Run order (also the Linear manual sort order, set by `wg load --apply`): phases in `plan.json` order; inside a phase, a topological order of the edges, with lane nodes kept together. Linear shows a lower `sortOrder` higher, so the first node to run is at the top. ENG nodes keep their own sort order. In Linear, set the project view's ordering to **Manual** to see it.
- `wg ready <plan-dir>`: the `Todo` or `Ready` nodes whose blockers are satisfied. Readiness rules: a lane task is satisfied by the task below it at `Merged` or `Done`, or at `In Review` or `Ready to Merge` with a `code_done_head` in its run row: the task below is code done, and its wave review can still run. A merge point is satisfied by a pre-merge task at `Merged` or `Done`. A ship point is satisfied by a post-merge task at `Merged` or `Done`. Every other edge needs `Done`. `Canceled` satisfies every edge.
- `wg` keeps `Todo` and `Ready` in step with the blockers after each of its writes that can satisfy an edge. For edits in Linear or on the page, follow [page.md](page.md#after-an-edit).
- In Linear, what waits on the human: status `Needs <human>` or `Ready to Merge` (plan-team issues), and label `needs-<human>` or `ready-to-merge` (ENG tickets). Filter by label group `agent` to see the issues that workers are writing to now.
