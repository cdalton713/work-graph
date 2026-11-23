# Recovery: failure, replan, and resume

## Failure

**CI red on a worker PR.** `gh pr checks <n> --json name,bucket,link`. If the failed check's `link` is an Actions run URL (`…/actions/runs/<run-id>…`), run `gh run view <run-id> --log-failed`. Otherwise open the link and record it with the first error, or record that no log is available. Send that as a CI job: `wg claim <plan-dir> <key> ci`. The worker fixes the cause and pushes. A red target branch fails every worker: check the baseline first (SKILL.md step 4).

**Worker fails before a PR exists** (`--outcome failed`, no PR). `wg done <plan-dir> <key> --failed "<first error>"`. Read its failing command and first error. Then send the fix direction to the same dispatch with `wg claim <plan-dir> <key> dispatch`, or ask the human. If the cause is in the design, Replan first.

**Diff leaves owns and shares** (`OUT` lines from `wg done`). Send the worker the paths. It reverts its own hunks, or asks you to extend `owns` in `plan.json`. Never edit a branch while its worker is live.

**PR closed without a merge** (`closed <key>`). `gh pr view <n> --json state,closedAt`, then ask the human why. On their word: **reopen** (they reopen the PR; `wg done` checks it again), **redesign**, or **drop**. Redesign and drop go through Replan. `wg` refuses `Merged` for a closed unmerged PR: list the PR under "Dropped" in `PLAN.md` `## Notes` with their reason.

**Worker escalates.** Read the `escalation` (`orca orchestration worker-show --dispatch <id>`) and steer it with `send`, or ask the human. If it needs the human, the issue is in `Needs <human>`; `wg move <plan-dir> <key> "In Progress"` after their answer.

**Worker lost or exited without `worker_done`.** `orca orchestration worker-list --run <run_id> --include-remote`, then `worker-show --dispatch <id>`. Silence or unknown liveness is never a reason to stop or retry. Retry only when Orca shows that the worker exited:

1. `wg done <plan-dir> <key> --failed "worker lost"`, then `wg claim <plan-dir> <key> <the same job>`.
2. `worker-start --task <task_id> --retry-of <dispatch_id> --worktree id:<same child> --agent codex --json`, in place of the printed send command.
3. `wg started <plan-dir> <key> dispatch=<new id>`.

To replace a worker that may be live, the human must ask; then `worker-stop --dispatch <id>`. On `stop_unknown`, or after a `worker-abandon` (it fences, it does not stop): stop, tell the human, and leave the claim and that worktree as they are until Orca shows the worker exited. After three failed starts, report to the human.

**Node must start again from nothing.** Only after Orca shows its worker exited, and with the human's word to drop the branch: `wg done <plan-dir> <key> --failed "<why>"`, then `wg run reset <plan-dir> <key>`, and `wg move <plan-dir> <key> Todo`. The reset removes the whole row: the branch, the reviews, and the approval.

**A claim label with no running job** (`reconcile <key>: agent:… with no job in the run row`). A crash left it, or a session that does not use the run rows holds it. Check Orca: if a live or unknown dispatch for that issue exists, leave the label. If none exists, remove the label with the Linear MCP (`save_issue`, `removeLabels`) and comment `stale claim removed: <reason>`.

**Regression** (a failed `ops` check, or a problem during a soak). The ship point is in `Needs <human>` with a `Regression:` comment (review-and-merge.md "Ship point"). Give the human the commit and the evidence. They choose a revert or a forward fix: new nodes through Replan with anchor = the open ship point (fix `task`, new deploy and verify `ops`). On `<release>` the fix is a HOTFIX node, and the human rolls back the deploy and tells the team (local rules file). List the regression in `PLAN.md` `## Notes` until it is resolved. A new build restarts the soak: `wg run set <plan-dir> <ship key> soak_until=<UTC time>`. When the new verify passes: `wg move` the failed `ops` node to `Canceled` with a comment `superseded by <new identifier>`, comment `Regression resolved: <fix PR> merged; <evidence>` on the ship point, and `wg move` it back to `Todo`.

**`keymap.json` lost or empty.** With no mapped project, `wg load` exits 2 when a project with the effort name exists. Run `wg load <plan-dir> --adopt`: it maps a plan-team node by its marker, else by exact title when exactly one unmapped plan node and exactly one unmapped project issue have that title (`adopted <key> -> <identifier> (by title)`), an `issue` node by its field, and an ENG node by `eng`. Then `wg load <plan-dir>` (dry run) and `--apply`. On any `conflict <key>: …` line: set `"issue": "<identifier>"` for that node in `plan.json`; two nodes cannot name the same issue, so ask the human which is which. `--apply` exits 2 before any create while a conflict exists. The run rows are lost with the file: `wg next` then prints a `reconcile` line for each node that has work, and "Resume" rebuilds the rows.

## Replan

Change the graph only at a settled checkpoint: no live worker on an affected node, and no restack job running. Change it only in `plan.json`, and change the `PLAN.md` flowchart in the same step. A change that adds, removes, or moves a node, or an edge to a merge point or ship point, needs the human's yes first.

Every added node names its **anchor**: the open merge point (a pre-merge task, while it is open), the open ship point (a post-merge task, a fix, or an `ops` node, after the merge point is Done), or the next phase's merge point. Never anchor to a Done milestone. Nodes anchored to the ship point run as their own recovery wave.

1. Edit `plan.json`:
   - **Add** a node: add it with its `phase`, `lane`, `kind`, and `role`, and an edge from its anchor to it. A lane node also gets an edge to the node below it. To map an existing issue of the plan's team (an adopted `Triage` issue), give the node `"issue": "<identifier>"`: `wg load` maps it and creates no copy.
   - **Remove an edge:** delete it from `edges`.
   - **Drop** a node: first `wg move` its issue to `Canceled` with a comment `dropped: <why>`, then delete the node and its edges. The `--prune` load in step 2 removes its key (dry run: `orphan <key> -> <identifier>`). If it has a PR, list the PR under "Dropped" in `PLAN.md` `## Notes`. If a lane branch stacks on it: send that branch a restack job with its new Git parent (the branch below, or `<target>`), and give it the matching edge in `plan.json`.
   - **Split** a node with no branch: graph.md "Split a node". A node with a PR: drop it first.
   - **Move** a node with no branch: change its `phase` and `lane`, fix its edges and anchor. Run `wg load --apply`: it updates the milestone of a plan-team node.
   - **Move or split a node that has a branch:** stop. Comment on the issue the branch, PR, and the wanted phase and lane, and ask the human.
2. Check: `wg check <plan-dir>` (exit 0), `wg load <plan-dir>` (dry run: review it), `wg load <plan-dir> --apply --prune`, `wg owns overlap <plan-dir> <every task key of the affected wave>` (exit 0), and `st ls`: each lane branch's parent matches its lane edge.
3. `wg ready <plan-dir> --apply`. Update the `PLAN.md` flowchart and, if the wave changed, `wg run set <plan-dir> @effort wave=<keys>`.

Done when: every check in step 2 passes and a new `wg load <plan-dir>` reports no change.

## Run state

The run rows in `keymap.json` hold what Linear and GitHub cannot tell: the Orca and Git ids of each node, and the results that only the coordinator knows. `wg next` derives each next action from Linear, GitHub, and these rows, so no step and no stage is stored. Read the rows with `wg run show <plan-dir> [<key>|@effort]`. One `wg` command writes `keymap.json` at a time.

| Field | Written by |
|---|---|
| `branch`, `parent`, `lower`, `agent`, `job`, `state` (`creating`, `starting`, `running`, `failed`) | `wg dispatch`, `wg claim`, `wg started`, `wg done` |
| `path`, `worktree`, `task`, `dispatch`; `@effort` `run_id` | `wg dispatch --worktree` (`path`), `wg started` |
| `pr`, `code_done_head`, `patch` | `wg done` |
| `approved` | `wg approve` only. A record of the human's words; no step reads it. |
| `review_patch`, `merge_review_patch`, `merge_review_seen`, `thorough_count`, `thorough_head` | `wg run set`, with the field that starts a review |
| `review_round`, `review_dispatch`, `review`, `draft`, `merge_review`, `tests_accepted`, `soak_until`, `state` (`blocked`, `unknown`) | The coordinator, with `wg run set`, where a step names the field |
| `@effort` `wave`, `baseline` | The coordinator, with `wg run set` |
| `@effort` `autonomy_seen` | `wg autonomy` and `wg next`: the last autonomy level that the coordinator saw. The level itself is the project label (SKILL.md "Autonomy level"). An old `@effort` `autonomy` field moves to the label at the next `wg next`. |
| `@effort` `merge_prep` | Absent: the coordinator undrafts each PR. `human`: only on their word, they mark PRs ready themselves. |

`wg run set <plan-dir> <key|@effort> <field>=<value>...` sets fields; `<field>=` deletes one. `wg run reset <plan-dir> <key>` removes a node's row. For an adopted node, the coordinator also sets `branch`, `parent`, `lower`, and `path` (coordinator.md "Adopt"). `wg` copies `branch`, `pr`, `review`, `merge_review`, `state`, `job`, `soak_until`, and the current job's `started_at` to the node card comment for the page; if Linear is unreachable it prints `node card not updated` and still saves the row.

`PLAN.md` `## Notes` holds only "Dropped" PRs with the reason, deferred decisions, and open regressions. History goes to Linear comments. Never append a checkpoint log to `PLAN.md`.

## Resume

A new session starts here. So does each `reconcile` line.

1. `wg next <plan-dir>` and `wg run show <plan-dir>`. Read `PLAN.md` `## Notes`.
2. `orca orchestration run-list`, confirm the `run_id`, then `orca orchestration run-use --id <run_id>`.
3. `orca orchestration task-list --run <run_id> --brief`, `orca orchestration worker-list --run <run_id> --include-remote`, and `orca orchestration inbox --terminal run:<run_id> --limit 50`. Handle unanswered questions and each unread `worker_done` (coordinator.md "Job end").
4. Each `reconcile` line and each `wait worker` line:
   - `state=creating` or `state=starting`: no receipt of the job is recorded, so the job can be live. Look for it in Orca first; with no `run_id` in `@effort`, `run-list` shows the runs. A matching dispatch: `wg started` with its ids. A matching worktree and no task: continue with `wg dispatch … --worktree`. Nothing: run `wg dispatch <plan-dir> <key>` again; it prints the commands again and takes no second claim. A follow-up job with no dispatch in Orca: send it, then `wg started`.
   - `wait worker`: the dispatch is live or unknown in Orca: wait for its message. Unknown is never "no live dispatch". It exited without `worker_done`: Failure, "Worker lost".
   - `agent:… with no job in the run row`: Failure, "A claim label with no running job".
   - `In Progress with no run row`, `In Review with no run row`, or `In Progress with no job in the run row`: the rows do not know this work. coordinator.md "Adopt an existing branch or PR"; for a spike, find its dispatch in Orca and record it with `wg run set <plan-dir> <key> state=running dispatch=<id>`.
   - `ENG status <name> has no twin`: ask the human which status it is, then `wg move`.
   - `reconcile <key> <id>: status Merged, but PR #<n> is <state>`: Check the PR state. If it is open, use `wg move` to set `In Review`, or `Ready to Merge` when the merge review passed and any PR below it has merged. If it is closed without a merge, follow "Failure", "PR closed without a merge".
   - `wait human <key>: state=unknown`: stop and ask the human.
5. `orca worktree list --json`. Check that each `path` in the run rows exists and is on its branch (`git -C <path> branch --show-current`).
6. Continue with the coordinator loop.

Done when: `wg next` prints no `reconcile` line, and each `wait worker` line maps to a live dispatch.
