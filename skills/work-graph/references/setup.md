# Setup: plan location, Linear, and labels

| Item | Location |
|---|---|
| `<plan-dir>` | The effort's `<slug>-core` coordinator worktree; branch `<prefix><slug>-core` (config `branch_prefix`) |
| `PLAN.md` | Flowchart, phase table, project link, `## Notes` (recovery.md "Run state") |
| `plan.json` | The graph: effort, phases, nodes, edges ([graph.md](graph.md#planjson)) |
| `keymap.json` | Written by `wg` only: project, phase milestones, key → issue id, identifier, node card, and what `wg next` last published for the page; the id of the `work-graph status` document; the run rows |
| `journal.jsonl` | Written by `wg` only, mode 600: a baseline line with the run rows, then one JSON line for each change of a status, a claim, or a run row; `journal.1.jsonl` holds the older lines after 5 MB (recovery.md "Run state") |
| `evidence/` | Written by `wg evidence`: the last test run of each node, and the repo-wide run of each phase |
| `specs/` | Written by `wg dispatch` and `wg claim`: the worker spec of each job |
| Linear | The plan's team. One project per effort; one project milestone per phase. |

## Run wg

Run `scripts/wg.py` as `wg`: the command uses `uv run --script`, which supplies the `websockets` package for the link to the page (page.md "Link"). `python3 -I <skill-dir>/scripts/wg.py` also works; without `websockets` in that Python, `wg next` polls Linear. `~/.local/bin/wg` is a link to the script. If a shell says `command not found`, make the link again: `ln -s <skill-dir>/scripts/wg.py ~/.local/bin/wg`.

## Plan location

Select or create the `<slug>-core` coordinator worktree through Orca before writing the plan: `orca worktree list --json`, else `orca worktree create --name <slug>-core --branch <prefix><slug>-core --no-parent --base-branch origin/<target> --setup skip --json`. It is the only top-level workspace of the effort; every lane parent, spike, and integration workspace nests under it. `wg load --apply` gives it the name of the Linear project as its display name in Orca; its path and its branch stay `<slug>-core`, so find it by its path. Reuse it for the core lane parent when the names match. Keep `PLAN.md`, `plan.json`, `keymap.json`, `journal.jsonl`, `journal.1.jsonl`, `evidence/`, and `specs/` together at its root. Do not commit them unless the human asks; never commit the journal files. If `keymap.json` is lost, follow recovery.md "Failure" before any `wg load --apply`.

When moving an existing setup, copy all of them, check that `wg status <new-dir>` prints the same issues, then delete the old copies.

## Linear

1. Configure the plan's Linear workspace and key as "Linear workspace" below says. `wg preflight <plan-dir> [--phase P]` checks the tools (`git`, `gh auth`, `st`), the selected key, the statuses and claim labels below, and the target of each phase ("Stax trunk and targets").
2. The plan's team needs these statuses. For a team that owns its statuses (`inheritWorkflowStatuses: false`), configure them on the team: Triage, Backlog, Todo, Ready, In Progress, Needs <human>, In Review, Ready to Merge, Merged, Verifying, Done, Canceled, Duplicate. `Needs <human>` is `Needs` and the config's `human` (for example `Needs Ada`). `wg` uses these names; do not rename them. The meanings are in the table below.
3. Kind labels for the plan's team: `merge-point`, `ship-point`, `ops`, `decision`. `wg load` creates `spike` on first use, and the `reviewed` label (review-and-merge.md "Mark a PR reviewed").
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

## Linear workspace

The config lists the Linear workspaces. Set `effort.workspace` to the id of the workspace that owns the work; a plan without it uses the first one. `effort.team` defaults to the workspace's `team`. A workspace with `teams` accepts only those teams, and a team that another workspace names stops `wg`. Choose from the work's owner, not the current shell key. Do not copy issues from one workspace into another.

Set `page_url` on a workspace to use a separate page for its plans. Other workspaces use the
top-level `page_url`. Set `WG_UI_URL` to override either setting for a command. See "Link" in
[page.md](page.md) for token setup.

`wg` selects the key for every command from the plan: `LINEAR_<ID>_API_KEY`, then the workspace's `key_env` names, then the private file `~/.config/work-graph/<id>-linear-api-key` (mode 600). A missing key stops the command; it never uses the key of another workspace. Keep keys out of plans, comments, and command arguments.

`wg` tries a Linear request again when it failed for a short time, at most 4 tries. The base delay is 1 s and doubles for each new try; a random factor from 0.5 to 1.5 changes each delay, so one delay can be shorter than the one before. It tries a query again after a network error, a timeout, HTTP 429, HTTP 5xx, or a `RATELIMITED` error. It tries a mutation again only when Linear refused it before it ran (HTTP 429, or a `RATELIMITED` error code below HTTP 500 with no data and no error path), because after a timeout, a 5xx, or a partial execution Linear can have applied it. A document that `wg` cannot prove to be a query counts as a mutation. At a rate limit, `wg` uses the times of that refusal (`Retry-After`, and the reset time of each used-up limit, also the limit of one endpoint; a complexity limit with fewer points than the request costs is used up). When that time is at most 60 s away, `wg` waits for it in place of the base delay; when it is farther, `wg` stops at once. Each new try prints one `warn linear:` line to stderr. After a failed mutation, read the issue before you run the command again.

Linear's Free plan holds 250 issues in a workspace; archived issues do not count. In a workspace with no paid plan, `wg` archives every completed and canceled issue of the workspace, not only the nodes of the plan: at each `wg move` to `Done` or `Canceled`, and at each `wg tick`. `wg archive <plan-dir>` shows what it would archive; `--apply` archives it. An archived node stays in the graph, on the page, and in `wg next`. A `wg move` of an archived node to an open status restores it first. Do not archive or restore issues by hand.

## Worker sessions

A worker session loads the full setup of the machine: all plugins, MCP servers, skills, and tools. Most of it is not necessary for a worker. A worker needs Bash, the file tools, git, `gh`, `wg`, the Orca CLI and the Orca status hooks, and the Linear MCP server (the worker spec reads and writes Linear through it). Put the settings that turn off the rest in the config `worker_settings` (README "Config"). `wg dispatch` writes them into each new worker worktree before the worker starts. Do not turn off hooks as a group: the Orca status hooks are hooks. A Codex project file has an effect only when Codex trusts the repository.

A coordinator session needs more than a worker: also the Linear MCP server, `AskUserQuestion`, `SendMessage`, `ListAgents`, auto memory, and the skills that the loop names (`work-graph`, `orchestration`, `orca-cli`, `stax`, `code-review`, `resolving-merge-conflicts`, `diagnosing-bugs`). Put the settings that turn off the rest in the config `coordinator_settings`; `wg load --apply` and `wg doctor --fix` write them into the core worktree, and a new coordinator session uses them.

To see the effect of a change, compare `wg usage <plan-dir>` of an effort before the change with one after it. It prints the tokens of each session (coordinator, worker, other) and the start size: the context of its first call. It reads the transcripts of Claude Code and Codex only, and writes nothing.

## Autostart

`wg autostart <plan-dir> --install` makes an Orca automation for the effort's `<effort>-core` worktree. Every 5 minutes it runs `wg wake <plan-dir>` as its precheck, and starts a coordinator agent (the human's default agent, in a fresh session) only when `wg wake` says `start`. `wg wake` says `start` when all of these hold: no agent that Orca reports as not done runs in that worktree; fewer than 2 coordinator agents run on the machine; fewer than 3 starts for this effort in the last hour; the autonomy level is not `supervised`; the effort is not paused; and the effort has work (a page message waits for a coordinator, an answer from the page, an autonomy change, or a `do` line from `wg next`). Otherwise it prints `skip: <reason>`, which Orca keeps in the automation's run history. `wg autostart <plan-dir>` prints the state; `--uninstall` removes the automation. The human installs it; a coordinator does not install it on its own.

A run that autostart started uses the project's current autonomy level and review effort, and does not ask for them. It runs the coordinator loop (coordinator.md) as any other run.

## Stax trunk and targets

stax has one trunk for the repository (`git cat-file -p refs/stax/trunk`); it stays as it is. A lane runs in one of two modes:

- **Target is the trunk:** `st sync` refreshes it.
- **Target is an imported, frozen base:** its metadata (`git cat-file -p refs/branch-metadata/<target>`) has a non-empty `sourceRemote` and `"frozen": true`. stax never pushes, restacks, or syncs it. `wg base <plan-dir>` refreshes it (fast-forward only, one refresh at a time in the repository). The coordinator runs it, and each lane worker runs it immediately before each `st branch submit` (worker-spec.md "submit lane"), because the base moves while a worker runs and stax refuses a submit whose parent is behind `origin`. On a `FAIL base` line the coordinator stops and asks the human; a worker escalates.

Setup of a base, one time for each branch, in the checkout that holds it: `st get <target> --parent <trunk> --no-checkout --downstack --no-restack && st freeze <target>`. Only the human runs or approves it: on `FAIL trunk` the coordinator stops and asks them. In a routine refresh, the coordinator and the workers never run `st sync`, `st get`, `st unfreeze`, or `st branch untrack` on a frozen base. If the human later makes a base the trunk, they first run `st branch untrack <branch>`.

<!-- explain: load -->
On `FAIL base` in `wg preflight` or `wg load`: the frozen base's PR targets another branch than its stax parent, carries foreign commits, or sits in a native stack. Stop and ask the human which base is right; never pick one. On `FAIL trunk`: stop and ask the human to do what the `FAIL trunk` lines say: set up the base (this section), set the trunk with `st init`, or freeze the integration branch. Never run `st trunk`: it checks out the trunk.
<!-- /explain -->

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

- `wg next <plan-dir>`: one status line for the open phase, then each `do`, `wait`, and `note` line (coordinator.md "Loop"). It reads Linear, GitHub, and the run rows: one GitHub request for each 50 PRs of the run rows, and one `gh pr view` only for a PR that the request does not return. It changes no status, no claim, and no run field. It copies its result to Linear for the page: the wave and the next action on each node card, and every line in the project document `work-graph status`; `--no-publish` skips the copy.
- `wg verify <plan-dir> <key>`: the code done checks of `wg done`, on the PR's current head, with the node's worktree as the current directory. It prints each `ok` and `FAIL` line and sets or removes `code_done_head`. It changes no claim, no status, and no review. Use it to see why a node is not code done; a `verify <key>` line of `wg next` still means `wg done`.
- `wg status <plan-dir> [--phase P]`: every node in run order, with its status, claim, and run row (`state`, `pr`, `code_done_head`, `review`, `dispatch`).
- Run order (also the Linear manual sort order, set by `wg load --apply`): phases in `plan.json` order; inside a phase, a topological order of the edges, with lane nodes kept together. Linear shows a lower `sortOrder` higher, so the first node to run is at the top. ENG nodes keep their own sort order. In Linear, set the project view's ordering to **Manual** to see it.
- `wg ready <plan-dir>`: the `Todo` or `Ready` nodes whose blockers are satisfied. Readiness rules: a lane task is satisfied by the task below it at `Merged` or `Done`, or at `In Review` or `Ready to Merge` with a `code_done_head` in its run row: the task below is code done, and its wave review can still run. A merge point is satisfied by a pre-merge task at `Merged` or `Done`. A ship point is satisfied by a post-merge task at `Merged` or `Done`. Every other edge needs `Done`. `Canceled` satisfies every edge.
- `wg` keeps `Todo` and `Ready` in step with the blockers after each of its writes that can satisfy an edge. For edits in Linear or on the page, follow [page.md](page.md#after-an-edit).
- In Linear, what waits on the human: status `Needs <human>` or `Ready to Merge` (plan-team issues), and label `needs-<human>` or `ready-to-merge` (ENG tickets). Filter by label group `agent` to see the issues that workers are writing to now.
