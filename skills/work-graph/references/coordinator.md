# Coordinator loop

The coordinator is this session. It reads `wg next`, runs the Orca commands that `wg` prints, and talks to the human. `wg` holds the claims, the checkpoints, and the checks. Load `orchestration` (and through it `orca-cli`) before you start a worker.

## Loop

0. At the start of a run only: ask for the autonomy level and record it with `wg autonomy <plan-dir> <level>` (SKILL.md "Autonomy level"). `wg autonomy <plan-dir>` prints the current level.
1. `wg next <plan-dir>`.
2. Do each `do` line (table below). Put the lines that ask the human for the same thing into one message.
3. When no `do` line is left: "Wait".
4. An Orca message wakes you. A question: answer it from the issue design, or ask the human. A `worker_done`: "Job end". An `escalation`: recovery.md "Failure". Then step 1.

| `do` line | Action |
|---|---|
| `load <key>` | `wg load <plan-dir>` (dry run), then `--apply` |
| `wave: pick the next wave from …` | SKILL.md step 3 |
| `dispatch <key>` | "Dispatch" |
| `adopt <key>` | "Adopt an existing branch or PR" |
| `integration <key>` | ordering.md "`effort/<slug>`: integration branch" |
| `verify <key>` | `wg done <plan-dir> <key>` ("Job end") |
| `review <key>` | review-and-merge.md "Wave review" |
| `ask-ready`, `undraft`, `merge-review`, `ask-merge`, `merged`, `close` | review-and-merge.md "Merge point" |
| `restack <key>` | review-and-merge.md "Restack job" |
| `ask <ops or decision>`, `ops <key>`, `verifying`, `ship` | review-and-merge.md "Ship point" |
| `triage <identifier>` (level `full`) | "Discovered work" |
| `closed <key>` | recovery.md "Failure", row "PR closed without a merge" |
| `reconcile <key>` | recovery.md "Resume" |

A `wait` line needs no action from you. `human`: The human must act, and your status line says what. At level `full`, a `wait human` line for a review hold after 2 rounds, a `decision`, or triage is yours: SKILL.md "Autonomy level". `worker` and `reviewer`: Orca wakes you. `review`: the thorough review runs. `coordinator`: an `ops` node with `"by": "coordinator"` that you started and still run (for example a check that needs a market session first); finish it, then `wg move … Done --note`. `below`, `blockers`, `soak`: the node waits for other nodes or for time. A `note triage` line: "Discovered work". The last line, `note page <url>`, is the link of the effort in the page (SKILL.md "See the graph"): put it in each message that asks the human for something. `wg move … "Needs <human>"` prints `page <url>`, the link of that one issue.

## Wait

1. Post the status line (SKILL.md "Report progress"). For each `wait human` line, say once what they must do.
2. Start `wg next <plan-dir> --wait` as a background command with the longest time limit that the harness allows, and end the turn. It exits when a `do` line appears: a merge, a status that the human changed, a new review, a soak that passed, or a message from the page (page.md "Link"). With the link, a change on the page wakes it in about 1 second, and a change in Linear in about 30 seconds. Without the link, it reads Linear at each `--interval`.
3. If the harness stops the command at its time limit, end the turn and do not start it again. In a session with no Stop hook and no goal, a wait of hours or days never holds the session open. The human's next message, or a new session, starts at `wg next`. After the command ends, changes on the page or in Linear do not wake you, including a change to the `reviewed` label. The page shows `last ran <age>` when the last report is stale.
4. Exception to step 3. If a Stop hook or a goal keeps the session open and every open line is a `wait` line, keep one `wg next <plan-dir> --wait` in the background while you wait. Say once what you wait for. Do not start work in the human's place.

An Orca message, the end of `wg next --wait`, or a message from the human wakes the coordinator.

### Never block on a prompt

The coordinator often runs where nobody sees a prompt: a background session, an autostart run, or a session that the human left. A question that waits for an answer stops the whole effort, while workers report and the page still shows the coordinator as working.

- Inside the loop, never use `AskUserQuestion` or any other tool that waits for an answer. The one exception is the autonomy question at the start of a run in a foreground session (SKILL.md "Autonomy level").
- Ask through Linear: `wg move <plan-dir> <key> "Needs <human>"` with a comment that gives the question, the options with their costs, your recommendation, and the page link. A question that is not a node goes to a `decision` node (recovery.md "Replan"). Then act on the other lines and Wait. Their answer arrives as `do answer` (page) or as a status change.
- When a permission check refuses a tool call, do not retry it and do not work around it. Write the step that needs their approval to `Needs <human>` and continue with the other lines.

### One coordinator per effort

Exactly one session coordinates an effort, and Orca wakes only the terminal that holds the Run.

- A background session has no Orca terminal: Orca cannot wake it. Run the coordinator in a terminal session, or rely on `wg autostart`, which starts a fresh coordinator in the core worktree.
- A fork of the coordinator session (a copy that shares its history) is not the coordinator. When Orca wakes a fork, the fork does not run `orca orchestration check`, because that takes the coordinator's mail. It reads `orca orchestration inbox --terminal run:<run_id>` (read-only) and tells the coordinator with `SendMessage`.
- Take-over, only on the human's word: (1) send the old coordinator a stop message and wait for its reply, or confirm that it exited; (2) in the new session, `orca orchestration run-use --id <run_id>`; (3) recovery.md "Resume" steps 3 to 6; (4) name the new coordinator session in the next status line and in a comment on the project.
- A coordinator that sees a `wait human` line for more than 30 minutes with nothing else to do says so once in its status line. It does not sit on a prompt.

### Lines from the page

The link (page.md "Link") gives these lines. The server keeps each message until `wg next` prints its line, so a message that comes while you work is in your next `wg next`.

| Line | Do this |
|---|---|
| `do answer <key> <issue>: <text>` | The human answered on the page. The full text is their comment on the issue, which has the label `answered`. Act on it as their answer: for a `decision` node, `wg move <plan-dir> <key> Done --note "<answer>"`; for a worker's question, send it to the worker and `wg move` the issue out of `Needs <human>`. The line comes back at each `wg next` until a `wg move` of the issue removes the label. |
| `do dispatch <key> <issue>: …` | The human asked for this dispatch. Run Dispatch below. |
| `do relay <key> <issue>: …` | `wg next` could not send the human's reply to the worker. Send it with `orca orchestration reply --id <ask>`. |
| `note replied <key> <issue>: …` | `wg next` sent the human's reply to the worker with `orca orchestration reply`. Do nothing. |
| `do autonomy @effort -: …` | The human changed the autonomy level on the page or in Linear. Act at the new level from now on (SKILL.md "Autonomy level"), and say the change in your status line. `note autonomy @effort -: <level>` is the level when it did not change. |
| `wait paused @effort -: …` | The human paused the effort on the page (the project label `paused`). Start no job and move no status until the line goes; `wg next` holds each `do` line until they resume. |
| `do resumed @effort -: …` | The human resumed the effort. Say so in your next status line, then act on the other lines. `wg next` prints it once, so `wg next --wait` wakes even when every other line is a wait. |

The human can reply to a worker's Orca question on the page. You still answer a question that they did not answer.

## Worktree cleanup

`wg move <plan-dir> <key> Merged` or `Done` removes the node's Orca worktree with `orca worktree rm`: a task at its merge, a spike at its `worker_done`. When every node of a lane is `Merged`, `Done`, or `Canceled` and Orca shows no child under the lane parent, `wg` removes the lane parent too. The branch stays: `wg` never passes `--force` or `--delete-branch`. The coordinator worktree and the repository checkout stay.

A worktree with uncommitted changes, or with a live job, stays, and `wg` prints a `warning:` line with the cause. The move itself still passes. The run row gets `worktree_removed=<time>` (or `gone` when the worktree was already removed by hand). To keep a worktree, pass `--keep-worktree` to `wg move`. To retry the warnings or to clean up an effort from before this rule, run `wg cleanup <plan-dir>` (`--dry-run` lists and removes nothing); it exits 1 while a worktree stays.

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

## Adopt an existing branch or PR

A node whose branch or PR exists gets no dispatch. `wg next` prints `adopt <key>` for a node with `branch` or `pr` in `plan.json`, and `reconcile <key>: … with no run row` for work that started before the graph.

1. Find the branch and the PR. `plan.json` names them, or the issue's comments and links, `st ls`, and `orca worktree list --json` show them; if you cannot tell which branch is the node's, ask the human. `gh pr view <pr> --json headRefName,headRefOid,baseRefName` gives the branch and base. A node with a branch only: `gh pr list --head <branch> --state open`. Find the worktree on that branch with `orca worktree list --json`. If the branch has no Orca worktree, stop and ask the human: `orca worktree create --branch <existing>` makes a new branch with a number suffix, and Orca has no checked command that checks out an existing branch.
2. `git -C <child-path> branch --show-current` must equal the branch. With a PR, `git -C <child-path> rev-parse HEAD` must equal `headRefOid`. With a PR, the branch must sit on its PR base: `git -C <child-path> rev-list --count origin/<baseRefName>..HEAD` must equal the PR's commit count (`gh pr view <pr> --json commits --jq '.commits|length'`) and the node's own commits. A larger count means the branch was cut from another base (for example `main` under a `<release>` PR): stop and ask the human which base is right, then rebase only the node's own commits onto it. Record `parent` and `lower` from that PR base, never from where the branch happened to be cut. Then `(cd <child-path> && st branch track --parent <parent>)`.
3. `wg run set <plan-dir> <key> branch=<branch> parent=<parent> lower=<lower> path=<child-path>`. `<lower>` is `origin/<target>` for the bottom of a lane, else the branch below; `<parent>` is that branch name, or `<target>`.
4. `wg done <plan-dir> <key>`: it finds the PR and checks code done. Then start the first worker job in that worktree, when one is needed ("Follow-up jobs"). With no PR: `wg claim <plan-dir> <key> dispatch`. With a PR and a `FAIL` line: `wg claim <plan-dir> <key> ci`.

## Job end

At each `worker_done`: `wg done <plan-dir> <key> --dispatch <dispatch id of that message>`. For a `verify` line: `wg done <plan-dir> <key>`. It removes the claim, finds the PR, moves the stax parent to the target after the PR below merged, checks code done in the node's worktree, and moves the issue to `In Review`. When it finds a PR, it attaches the URL to the issue if the URL is missing, even if a check fails. An attachment error is a warning. A PR in `Ready to Merge` whose patch changed goes back to `In Review`.

`wg done` refuses a `worker_done` whose dispatch is not the job in the run row. From an old dispatch: ignore the message. From a job whose receipt was lost: record it with `wg started` first.

| Output | Action |
|---|---|
| `code done: <key> #<pr> <sha>` | Start the wave review at once (review-and-merge.md "Wave review"), unless `wg next` prints another line for the node. |
| `FAIL <check>` | The node is not code done. Send the repair as a follow-up job. Start no node above it and request no merge of it until `wg done` passes. |
| `SHARED <file>` | Read `git -C <child-path> diff <lower>...HEAD -- <file>`. Accept additive edits only. |
| `FAIL tests`, only known failures (SKILL.md step 4) | Read the log in `<plan-dir>/evidence/`, then `wg run set <plan-dir> <key> "tests_accepted=<sha>:<reason>"`, and `wg done` again. |
| `cleared review, …: the patch changed` | The reviews of the old patch are gone. `wg next` prints the review that is due. |
| `kept the review: new head, same patch` | A restack with no conflict. Nothing to review again. |

A worker that reports `--outcome failed`: `wg done <plan-dir> <key> --dispatch <id> --failed "<its first error>"`, then recovery.md "Failure". A spike: `wg done` moves it to `Done`; its findings are a comment on the issue.

## Follow-up jobs

Review fixes, CI fixes, thread fixes, and restack jobs. Write the work of the job to a file first: the findings, the failed check with its first error, or the threads. Then use one command: `wg claim <plan-dir> <key> <review|ci|threads|restack> --send --work-file <file>`. It refuses a second job on the node, a fourth live worker, and a second restack job in the effort. Then it adds the claim, writes the job header and the work text to `<plan-dir>/specs/<key>-<job>.md`, runs `orca orchestration send` to the node's dispatch (or `worker-start` in the recorded worktree when the node has no dispatch), and records the receipt. A send to a finished worker gives a new dispatch and task; `wg` records those. It prints `claimed …`, the restack line of a restack job, and `started <key> dispatch=<id> job=<job>`.

After a `FAIL` line or a lost reply, run the same command again: it adds a label that failed, takes no second claim, and retries a lost reply only with the request id that Orca named. An unknown outcome with no request id stays at `step=send`, and the command refuses until you look in Orca. At `step=receipt` it writes only the claim comment. `--send` refuses outside an Orca terminal, as `--run` does.

**Printed form.** Without `--send`, `wg claim` adds the claim, writes the job header (and the text of `--work-file`, when given), and prints the commands:

1. Add the work of this job at the end of that file, if `--work-file` did not.
2. Run the printed `orca orchestration send` command. A working worker gets the message when its turn ends. A finished or closed worker gets it as a follow-up Task and sends a new `worker_done`.
3. Record the receipt with the printed `wg started <plan-dir> <key> dispatch=<id> task=<id>`.

`wg claim <plan-dir> <key> dispatch` continues a node that has a branch and no PR: an adopted node, or a first job that failed. For a node with no dispatch it prints `worker-start` and puts the full task contract in the spec.

## PRs outside a worker job

The coordinator never runs `gh pr create`. A PR that stax did not open is missing from the stax stack comments on every PR of the lane. Open each PR through a worker job (worker-spec.md "submit lane"). When the coordinator must open one itself, it runs the same command in the child worktree: `st branch submit --draft --no-restack --no-native-stack --no-prompt --yes`. If a PR was opened another way, run `st branch submit --no-restack --no-native-stack --no-prompt --yes` on its branch: stax records the PR and refreshes the stack links on the whole lane.

## Discovered work

A `note triage <identifier>` line is an issue in the effort's project that is not a node, for example one a worker made. For each one, ask the human. At level `full`, `wg next` prints it as `do triage <identifier>` and the page does not count it as the human's: decide yourself, and comment the reason on the issue. Then add it through recovery.md "Replan" (it names the anchor), or move it to `Backlog` or `Canceled` with the Linear MCP (`save_issue`): an issue that is not a node has no key. An adopted issue joins the next wave, never the current one.

## Who moves what

| Node | Moves to | When | Command |
|---|---|---|---|
| `task` | `In Progress` | Dispatch | `wg dispatch` |
| `task` | `In Review` | Code done | `wg done` |
| `task` | `Ready to Merge` | Merge review of the current patch; the PR below it merged | `wg move` |
| `task` | `Merged` | The PR is merged | `wg move` |
| `task` | `Done` | Its phase's ship point is `Done` | `wg move <ship point> Done` does it |
| `spike` | `Done` | Findings are in a comment | `wg done` |
| `decision` | `Needs <human>`, then `Done` | Ready; then the human answers | `wg move`, then `wg move … --note "<answer>"` |
| `ops` | `Needs <human>`, then `Done` | Ready; then their evidence meets the acceptance | `wg move`, then `wg move … --note "<evidence>"` |
| merge point | `Done` | Every pre-merge task is `Merged`; the target holds each merge commit | `wg move` |
| ship point | `Verifying`, then `Done` | Every blocker satisfied; then the soak passed | `wg move` |

A worker moves only its own issue, and only to `Needs <human>`.
