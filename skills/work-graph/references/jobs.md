# Worker jobs

The coordinator starts each worker job with one `wg` command, and ends it with `wg done`. A section with a `wg next` verb is also the `wg explain` text of that verb.

<!-- explain: dispatch -->
## Dispatch

Use one command: `wg dispatch <plan-dir> <key> --run [--agent codex|claude] [--model <id>]`. It checks the node: ready (the node below it in the lane is code done), and in the wave. Then it does each step that the printed form below lists: the claim and the move to `In Progress`, the lane parent when `orca worktree list` does not show it, the child worktree and its display name, `st branch track` for a stax branch, the worktree checks, the worker spec, `worker-start --environment local`, and the record of `wg started`. `--agent` and `--model` apply from this first call. It prints at most 3 lines:

- `claimed <identifier> agent:<agent>`
- `started <key> dispatch=<id> worktree=<path>`
- a warning or a `FAIL <step>: <error>` line

The run row records each step (`step=claim|status|parent|child|track|spec|start|receipt`) before the step starts. The claim goes into the run row before the label and the move, so no worker starts on an issue that is not claimed and `In Progress`. After a `FAIL` line, fix the cause and run the same command again: it continues at the failed step, adds only the label or the move that Linear does not show, finds a worktree that it made before, and takes no second claim. Before a call that can start a worker, a resume checks that Linear shows the claim and `In Progress`, and writes what is missing (another agent's claim stops it). Each check of a step that passed is read-only: `st branch track` runs only while the row is at `track` or before. It uses only worktrees of the coordinator's repository, and it stops before it changes a lane parent that is not under the coordinator, a child that is not under its lane parent, or a worktree on another branch (Orca adds a number to a taken name). Stax tracks the branch when the branch plan says so (also a stacked HOTFIX). When Orca loses the reply of `worker-start`, `wg` records the request id that Orca names (`retry_request`) and keeps it until Orca gives a result; an error of the replay keeps it too, because it does not prove that the first request did nothing. The next `--run` sends the call again only with `--retry-request <id>`, with the spec that it sent first. A refusal of a first call (no request id) starts nothing, so the next `--run` starts again. While a start has no known result, the printed form refuses too (`wg dispatch` and `wg dispatch … --worktree`): use `--run`, or look in Orca and record the worker with `wg started`. If the outcome is not known (no JSON answer, a timeout) and there is no request id, `step=start` stays and `--run` refuses: look for the worker in Orca, then record it with `wg started`, or start again with `wg run set <plan-dir> <key> step=spec`. `step=receipt`: the worker runs, but the claim comment failed; the next `--run`, or `wg started` with the same dispatch id, writes only the comment. If `wg` cannot save the ids after Orca started the worker, the warning line gives the `wg started` command with those ids: run it.

`--run` refuses outside an Orca terminal (no `ORCA_AGENT_SESSION_ID` and no `ORCA_TERMINAL_HANDLE`), before the claim: there Orca cannot find the caller, and cannot wake the coordinator at `worker_done`. Then use the printed form.

**Printed form.** Without `--run`, `wg dispatch <plan-dir> <key>` adds the claim, moves the issue to `In Progress`, records `state=creating` with the branch names, and prints the Orca commands with every name filled in (ordering.md "Branches and worktrees"). Run them in order:

1. The printed `orca worktree create`, `orca worktree set`, and `st branch track` commands. Create the lane parent only when `orca worktree list --json` does not show it, as a child of the `<slug>-core` coordinator (`<core-id>` is its `id`); the core lane uses the coordinator itself. A lane parent with `parentWorktreeId: null` is wrong: move it with `orca worktree set --worktree id:<lane-parent-id> --parent-worktree id:<core-id> --json`.
2. `wg dispatch <plan-dir> <key> --worktree <child-path>`. It checks the new worktree: the branch name, the base, a clean tree, and the stax parent. Then it writes the worker spec to `<plan-dir>/specs/<key>.md` from [worker-spec.md](worker-spec.md) and prints the `worker-start` command. Fix each `FAIL` line and run it again. A worker starts only from this spec.
3. The printed `orca orchestration worker-start`, then the printed `wg started <plan-dir> <key> dispatch=<id> task=<id> worktree=<id> run_id=<id>`. It records the ids, sets `state=running`, and comments the claim on the issue.

- If an Orca reply is lost, re-issue the same command with the id from the error (`--retry-request <id>` for `worker-start`); never a fresh start. `worktree create` has no retry id: find the worktree with `orca worktree list --json` before you create it again. With no such id: stop, `wg run set <plan-dir> <key> state=unknown`, and ask the human.
- Reuse a child worktree for a retry only after Orca shows its last worker exited (recovery.md).
- Never use `worker-start --worktree new-child`: it cannot set the branch or the parent. Never use `st create`, `st wt create`, or `st lane`.
- `wg dispatch` prints no `st branch track` for a SYNC branch, a spike branch, or a HOTFIX branch that does not stack (lab result, stax 0.120.0: an untracked non-trunk parent moved onto `main` at the next restack). A HOTFIX of an effort with `stacked_hotfix` stacks like a lane node: both forms track it.

Done when: `wg run show <plan-dir> <key>` shows `state=running` and the dispatch id.
<!-- /explain -->

<!-- explain: adopt -->
## Adopt an existing branch or PR

A node whose branch or PR exists gets no dispatch. `wg next` prints `adopt <key>` for a node with `branch` or `pr` in `plan.json`, and `reconcile <key>: … with no run row` for work that started before the graph.

1. Find the branch and the PR. `plan.json` names them, or the issue's comments and links, `st ls`, and `orca worktree list --json` show them; if you cannot tell which branch is the node's, ask the human. `gh pr view <pr> --json headRefName,headRefOid,baseRefName` gives the branch and base. A node with a branch only: `gh pr list --head <branch> --state open`. Find the worktree on that branch with `orca worktree list --json`. If the branch has no Orca worktree, stop and ask the human: `orca worktree create --branch <existing>` makes a new branch with a number suffix, and Orca has no checked command that checks out an existing branch.
2. `git -C <child-path> branch --show-current` must equal the branch. With a PR, `git -C <child-path> rev-parse HEAD` must equal `headRefOid`. With a PR, the branch must sit on its PR base: `git -C <child-path> rev-list --count origin/<baseRefName>..HEAD` must equal the PR's commit count (`gh pr view <pr> --json commits --jq '.commits|length'`) and the node's own commits. A larger count means the branch was cut from another base (for example `main` under a `<release>` PR): stop and ask the human which base is right, then rebase only the node's own commits onto it. Record `parent` and `lower` from that PR base, never from where the branch happened to be cut. Then `(cd <child-path> && st branch track --parent <parent>)`.
3. `wg run set <plan-dir> <key> branch=<branch> parent=<parent> lower=<lower> path=<child-path>`. `<lower>` is `origin/<target>` for the bottom of a lane, else the branch below; `<parent>` is that branch name, or `<target>`.
4. `wg done <plan-dir> <key>`: it finds the PR and checks code done. Then start the first worker job in that worktree, when one is needed ("Follow-up jobs"). With no PR: `wg claim <plan-dir> <key> dispatch`. With a PR and a `FAIL` line: `wg claim <plan-dir> <key> ci`.
<!-- /explain -->

<!-- explain: verify -->
## Job end

At each `worker_done`: `wg done <plan-dir> <key> --dispatch <dispatch id of that message>`. For a `verify` line: `wg done <plan-dir> <key>`. It removes the claim, finds the PR, moves the stax parent to the target after the PR below merged, checks code done in the node's worktree, and moves the issue to `In Review`. When it finds a PR, it attaches the URL to the issue if the URL is missing, even if a check fails. An attachment error is a warning. A PR in `Ready to Merge` whose patch changed goes back to `In Review`.

`wg done` refuses a `worker_done` whose dispatch is not the job in the run row. From an old dispatch: ignore the message. From a job whose receipt was lost: record it with `wg started` first.

| Output | Action |
|---|---|
| `code done: <key> #<pr> <sha>` | Start the wave review at once (review-and-merge.md "Wave review"), unless `wg next` prints another line for the node. |
| `FAIL <check>` | The node is not code done. Send the repair as a follow-up job. Start no node above it and request no merge of it until `wg done` passes. |
| `SHARED <file>` | Read `git -C <child-path> diff <lower>...HEAD -- <file>`. Accept additive edits only. |
| `FAIL tests`, only known failures ("Known failures") | Read the log in `<plan-dir>/evidence/`, then `wg run set <plan-dir> <key> "tests_accepted=<sha>:<reason>"`, and `wg done` again. |
| `cleared review, …: the patch changed` | The reviews of the old patch are gone. `wg next` prints the review that is due. |
| `kept the review: new head, same patch` | A restack with no conflict. Nothing to review again. |

A worker that reports `--outcome failed`: `wg done <plan-dir> <key> --dispatch <id> --failed "<its first error>"`, then recovery.md "Failure". A spike: `wg done` moves it to `Done`; its findings are a comment on the issue.
<!-- /explain -->

<!-- explain: review,restack -->
## Follow-up jobs

Review fixes, CI fixes, thread fixes, and restack jobs. Write the work of the job to a file first: the findings, the failed check with its first error, or the threads. Then use one command: `wg claim <plan-dir> <key> <review|ci|threads|restack> --send --work-file <file>`. It refuses a second job on the node, a fourth live worker, and a second restack job in the effort. Then it adds the claim, writes the job header and the work text to `<plan-dir>/specs/<key>-<job>.md`, runs `orca orchestration send` to the node's dispatch (or `worker-start` in the recorded worktree when the node has no dispatch), and records the receipt. A send to a finished worker gives a new dispatch and task; `wg` records those. It prints `claimed …`, the restack line of a restack job, and `started <key> dispatch=<id> job=<job>`.

After a `FAIL` line or a lost reply, run the same command again: it adds a label that failed, takes no second claim, and retries a lost reply only with the request id that Orca named. An unknown outcome with no request id stays at `step=send`, and the command refuses until you look in Orca. At `step=receipt` it writes only the claim comment. `--send` refuses outside an Orca terminal, as `--run` does.

**Printed form.** Without `--send`, `wg claim` adds the claim, writes the job header (and the text of `--work-file`, when given), and prints the commands:

1. Add the work of this job at the end of that file, if `--work-file` did not.
2. Run the printed `orca orchestration send` command. A working worker gets the message when its turn ends. A finished or closed worker gets it as a follow-up Task and sends a new `worker_done`.
3. Record the receipt with the printed `wg started <plan-dir> <key> dispatch=<id> task=<id>`.

`wg claim <plan-dir> <key> dispatch` continues a node that has a branch and no PR: an adopted node, or a first job that failed. For a node with no dispatch it prints `worker-start` and puts the full task contract in the spec.
<!-- /explain -->

## PRs outside a worker job

The coordinator never runs `gh pr create`. A PR that stax did not open is missing from the stax stack comments on every PR of the lane. Open each PR through a worker job (worker-spec.md "submit lane"). When the coordinator must open one itself, it runs the same command in the child worktree: `st branch submit --draft --no-restack --no-native-stack --no-prompt --yes`. If a PR was opened another way, run `st branch submit --no-restack --no-native-stack --no-prompt --yes` on its branch: stax records the PR and refreshes the stack links on the whole lane.

## Worktree cleanup

`wg move <plan-dir> <key> Merged` or `Done` removes the node's Orca worktree with `orca worktree rm`: a task at its merge, a spike at its `worker_done`. When every node of a lane is `Merged`, `Done`, or `Canceled` and Orca shows no child under the lane parent, `wg` removes the lane parent too. The branch stays: `wg` never passes `--force` or `--delete-branch`. The coordinator worktree and the repository checkout stay.

A worktree with uncommitted changes, or with a live job, stays, and `wg` prints a `warning:` line with the cause. The move itself still passes. The run row gets `worktree_removed=<time>` (or `gone` when the worktree was already removed by hand). To keep a worktree, pass `--keep-worktree` to `wg move`. To retry the warnings or to clean up an effort from before this rule, run `wg cleanup <plan-dir>` (`--dry-run` lists and removes nothing); it exits 1 while a worktree stays.

<!-- explain: verify -->
## Known failures

A test that fails in a node's evidence is that node's failure, unless the same test also fails in the evidence log of a node in another lane, or in the last `@full-<phase>` log. Record such a test with `wg run set <plan-dir> @effort "baseline=<target sha10>: <tasks>"`; the workers read this field. Exit 3 or a test-server error is an error, not a known failure.
<!-- /explain -->
