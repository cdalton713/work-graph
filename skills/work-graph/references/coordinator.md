# Coordinator loop

The coordinator is this session. It reads `wg next`, runs the Orca commands that `wg` prints, and talks to the human. `wg` holds the claims, the checkpoints, and the checks. Load `orchestration` (and through it `orca-cli`) before you start a worker.

## Loop

0. At the start of a run only: ask for the autonomy level and the review effort in one question, and record them with `wg autonomy <plan-dir> <level>` (autonomy.md) and `wg review-effort <plan-dir> <level>` (review-and-merge.md "Review effort"). Without a level, each command prints the current level.
1. `wg next <plan-dir>`.
2. Do each `do` line (table below). Put the lines that ask the human for the same thing into one message. A line that one `wg` command does ends with ` -> <command>`, with each argument filled in: run that command. For a verb that you have not handled in this session, run `wg explain <verb>` first: it prints only the part of the references that tells you what to do for that `do` or `wait` verb. `wg explain` lists the verbs.
3. When no `do` line is left: "Wait".
4. An Orca message wakes you. A question: answer it from the issue design, or ask the human. A `worker_done`: jobs.md "Job end"; from a reviewer, its step in review-and-merge.md ("Wave review" step 2, or "Merge point" step 2). An `escalation`: recovery.md "Failure". Then step 1.

| `do` line | Action |
|---|---|
| `load <key>` | `wg load <plan-dir>` (dry run), then `--apply` |
| `wave: pick the next wave from …` | SKILL.md step 3 |
| `dispatch <key>` | jobs.md "Dispatch" |
| `adopt <key>` | jobs.md "Adopt an existing branch or PR" |
| `integration <key>` | ordering.md "`effort/<slug>`: integration branch" |
| `verify <key>` | `wg done <plan-dir> <key>` (jobs.md "Job end") |
| `review <key>` | review-and-merge.md "Wave review" |
| `ask-ready`, `undraft`, `merge-review`, `ask-merge`, `merge`, `merged`, `close` | review-and-merge.md "Merge point" |
| `restack <key>`, a review, CI, or thread fix | review-and-merge.md "Restack job"; jobs.md "Follow-up jobs" |
| `ask <ops or decision>`, `ops <key>`, `verifying`, `ship` | review-and-merge.md "Ship point" |
| `triage <identifier>` (level `full`) | "Discovered work" |
| `closed <key>` | recovery.md "Failure", row "PR closed without a merge" |
| `reconcile <key>` | recovery.md "Resume". For a claim renewal, see collab.md "Claims". |
| `answer`, `dispatch`, `relay` from the page | page.md "Lines from the page" |

<!-- explain: below,blockers,soak,worker,reviewer,coordinator,human,review -->
A `wait` line needs no action. `human` means the human must act. At level `full`, handle review holds, decisions, and triage as described in autonomy.md. `worker` and `reviewer` mean Orca will wake you. `review` means a thorough review runs. If a coordinator ops node is still running, wait for its result, then use `wg move … Done --note`. `below`, `blockers`, and `soak` wait for a node or for time. Use `wg next <plan-dir> --all` to show each wait and note. The page and the status document get each line in full. Include the URL from `note page` when you ask the human for something.

## Wait

1. Post the status line ("Report progress"). For each `wait human` line, say once what they must do.
2. Start `wg next <plan-dir> --wait` as a background command with the longest time limit that the harness allows, and end the turn. It exits when a `do` line appears: a merge, a status that the human changed, a new review, a soak that passed, or a message from the page (page.md "Link"). With the link, a change on the page wakes it in about 1 second, and a change in Linear in about 30 seconds. Without the link, it reads Linear at each `--interval`.
3. If the harness stops the command at its time limit, end the turn and do not start it again. In a session with no Stop hook and no goal, a wait of hours or days never holds the session open. The human's next message, or a new session, starts at `wg next`. After the command ends, changes on the page or in Linear do not wake you, including a change to the `reviewed` label. The page shows `last ran <age>` when the last report is stale.
4. Exception to step 3. If a Stop hook or a goal keeps the session open and every open line is a `wait` line, keep one `wg next <plan-dir> --wait` in the background while you wait, and no heartbeat of your own. Say once what you wait for. Do not start work in the human's place.

An Orca message, the end of `wg next --wait`, or a message from the human wakes the coordinator. Run `orca orchestration check` only for an Orca message.
<!-- /explain -->

<!-- explain: claims,collaborator,owner,stale -->
| Other line | Action |
|---|---|
| `wait collaborator <person> <key>` | Leave the node to the holder. |
| `wait owner <key>` | Leave the node to the project owner. |
| `note human <key>: waits on <person>` | Leave the node to the named person. |
| `note stale <key>` | Ask the human before takeover. See collab.md "Claims". |
| `wait claims page` | Start no new job. Running jobs continue. |
<!-- /explain -->

<!-- explain: human -->
### Never block on a prompt

A prompt can stop an unattended run.

- Inside the loop, never use `AskUserQuestion` or any other tool that waits for an answer. The one exception is the question for the autonomy level and the review effort at the start of a run in a foreground session (autonomy.md).
- Ask through Linear: `wg move <plan-dir> <key> "Needs <human>"` with a comment that gives the question and the page link. A question that is not a node goes to a `decision` node (recovery.md "Replan"). Then act on the other lines and Wait. Their answer arrives as `do answer` (page) or as a status change.
- When a permission check refuses a tool call, do not retry it and do not work around it. Write the step that needs their approval to `Needs <human>` and continue with the other lines.
For a choice, end that comment with a blank line and an `Options:` block, also for a `decision` node. Give two to four options, one line each. Mark one recommendation with its reason.

```text
When?

Options:
- Now: Start today. (Recommended: Checks passed.)
- Later: Keep the schedule.
```
<!-- /explain -->

<!-- explain: context -->
## After a compaction

Run `wg next <plan-dir>`: its lines, not old messages, are the state. Run `wg explain <verb>` again.

`note context`: the session is over `context_limit`; with the setting in place, over 120%, because Claude Code compacts at the limit. `/compact` is the human's.
<!-- /explain -->

### One coordinator per effort

Use one coordinator per account per effort. Orca wakes the Run terminal.
See [Share a plan](collab.md).

- A background session has no Orca terminal: Orca cannot wake it. Run the coordinator in a terminal session, or rely on `wg autostart`, which starts a fresh coordinator in the core worktree.
- A fork of the coordinator session (a copy that shares its history) is not the coordinator. When Orca wakes a fork, the fork does not run `orca orchestration check`, because that takes the coordinator's mail. It reads `orca orchestration inbox --terminal run:<run_id>` (read-only) and tells the coordinator with `SendMessage`.
- Take-over, only on the human's word: (1) send the old coordinator a stop message and wait for its reply, or confirm that it exited; (2) in the new session, `orca orchestration run-use --id <run_id>`; (3) recovery.md "Resume" steps 3 to 6; (4) name the new coordinator session in the next status line and in a comment on the project.
- A coordinator that sees a `wait human` line for more than 30 minutes with nothing else to do says so once in its status line. It does not sit on a prompt.

## More coordinator steps

- Dispatch, adopt, job end, follow-up jobs, PRs outside a worker job, and worktree cleanup: [jobs.md](jobs.md).
- The lines that the page sends, and the human's replies to worker questions: [page.md](page.md) "Lines from the page".

<!-- explain: triage -->
## Discovered work

A `note triage <identifier>` line is an issue in the effort's project that is not a node, for example one a worker made. For each one, ask the human. At level `full`, `wg next` prints it as `do triage <identifier>` and the page does not count it as the human's: decide yourself, and comment the reason on the issue. Then add it through recovery.md "Replan" (it names the anchor), or move it to `Backlog` or `Canceled` with the Linear MCP (`save_issue`): an issue that is not a node has no key. An adopted issue joins the next wave, never the current one.
<!-- /explain -->

## Report progress

Name each PR by its GitHub number (`#7747`). The `NN` prefix of a worktree is the lane position from `00`. The human counts PRs from 1 at the bottom of the lane, as the stax stack comment lists them: their "PR 3" is the third PR from the bottom, the `02 …` worktree. When they name a PR by position, repeat its number back before you change it.

After each wave and each merge point, post the first line of `wg next <plan-dir>` and the next action that is the human's:

`phase 1: 9 tasks, 9 code done, 9 reviewed, 0 merged. Next: merge point 1 needs your merge of #1234, then #1235.`

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
