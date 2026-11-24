# Review, merge point, and ship point

Agents review, undraft, restack, and push feature branches. The human merges PRs and does every `ops` node, except an `ops` node with `"by": "coordinator"`. A review holds only the merge request of its own PR: the node above it in the lane started at code done, and every other node continues. Each job to a worker follows coordinator.md "Follow-up jobs".

A review covers a **patch** (SKILL.md "Terms"). `wg done` clears `review` and `merge_review` when the patch changes, and keeps them through a restack with no conflict.

<!-- explain: review -->
## Wave review

`wg next` prints `review <key> #<n> round <k>` when a draft PR is code done. The reviewer is a different agent from the writer (Claude reviews Codex). Only a **blocking** finding holds the PR, and it holds only that PR's merge request. A PR whose issue has the `reviewed` label gets no review (SKILL.md "Mark a PR reviewed").

1. Start the reviewer in your own worktree: `orca orchestration worker-start --spec-file <review-spec> --worktree current --agent claude --json`. Then `wg run set <plan-dir> <key> review_round=<k> review_dispatch=<dispatch_id>`. Give it the PR, not the worker's report. The spec:

   > Load `code-review`. PR #<n> at head `<code_done_head>`: fixed point = its base branch, spec = the Linear issue's description and its `work-graph node card` comment. Read-only. Report two lists. **Blocking:** the change does not meet the acceptance, breaks behavior that worked, loses or exposes data, or breaks a repository rule that `pnpm lint` does not check (name the rule). **Notes:** each other finding. Write the report to `<scratchpad>/review-<key>-<round>.md` and pass `--report-path`.

   Round 2 adds: "The round 1 report is `<path>`. Check only that each blocking finding is fixed and that the fix broke nothing. Raise no new note."
2. At the reviewer's `worker_done`, read its report. It counts only when its dispatch id equals `review_dispatch` in the run row: ignore a report from another dispatch. A `wait reviewer` line means: wait for that report; never start a second reviewer.
   - **No blocking finding:** `wg run set <plan-dir> <key> review=clean`. `wg` refuses it when the patch changed after the reviewer started, or when the PR head moved after the last `wg done`: run `wg done`, and start the round again if the patch changed. Put the notes in one comment on the issue (`Review notes, not blocking: …`); the merge review and the human read them.
   - **Blocking findings in round 1:** `wg claim <plan-dir> <key> review`, and add each valid finding to the job spec. The worker fixes them on its own branch and pushes. At its `worker_done`, `wg done` clears the old review and `wg next` prints round 2.
   - **Blocking findings in round 2:** start no round 3. Comment the findings on the issue, and tell the human once in your status message. Do not move the issue: `wg next` prints `wait human` for this PR only, and every other node continues. They accept the findings with the `reviewed` label, or they ask for one more fix: then `wg claim <plan-dir> <key> review`.
3. After a review fix, only the branch directly above it in the lane gets a restack job, and only if that branch exists. Higher branches wait for their turn at the merge point.

Done when: the node's run row has `review=clean` or `review=accepted`, or the issue has the `reviewed` label. Then this PR goes on to "Merge point".
<!-- /explain -->

<!-- explain: ask-ready,undraft,merge-review,ask-merge,merged,close -->
## Merge point

Each PR starts these steps as soon as its own wave review passes; it does not wait for the other PRs of the phase. `wg next` prints the lines below. A PR that left draft is at the merge point; from then on its gate is the merge review, and the wave review does not run again. Each time you wait for the human, follow coordinator.md "Wait".

1. **Ready** (`undraft <key> #<n>`). Run `st undraft <branch>` in the node's child worktree. Do not ask the human. Only when they take this step back for the effort (`wg run set <plan-dir> @effort merge_prep=human`) do the lines become `ask-ready`: ask them once for all of them to mark the PRs ready, then `wg run set <plan-dir> <key> draft=yes` for each PR.
2. **Merge review** (`merge-review <key> #<n>: request the thorough review`). First `wg run set <plan-dir> <key> merge_review=requested`: it counts the PR's reviews and comments, without the requests. Then post the request yourself: the comment `@claude-thorough` on the PR. `wg next` prints `merge-review … read the new review` when a new review or comment arrives. If the new item is not the review, run the same `wg run set` command again.

   Read the review (`gh pr view <n> --json reviews,comments`). It covers the head in `code_done_head` when it names that head, or when it names no head and the PR head did not move after the request (`wg` clears the merge review when the patch changes). A `reviewed` label on the issue replaces this step.
   - No blocking finding and no open thread: `wg run set <plan-dir> <key> merge_review=clean` (`accepted` when the human accepted the rest).
   - Open threads or a blocking finding: step 3.

   **One thorough review per PR.** A thorough review is slow and costs many tokens. `wg` records the head that it read in `thorough_head`. When a push after it changes the patch (a thread fix, or a restack that touched the code), `wg next` prints `merge-review <key> #<n>: check the fix since <sha>, no new thorough review`. Do not post `@claude-thorough` again. Check the fix yourself: read `git diff <thorough_head> <code_done_head>` (after a base move, `git range-diff <old base>..<thorough_head> <new base>..<code_done_head>`). It passes when each change answers a thread or a finding of the thorough review, and adds no other behavior. Then `wg run set <plan-dir> <key> merge_review=clean`.

   Request a second thorough review only when the check finds that the fix is new work: it adds a behavior, a contract, or a file that no finding asked for, or a conflict resolution rewrote reviewed code. Write the reason in an issue comment, then do the request steps above. `wg` refuses a third request: the fix check is the gate, or the human accepts the PR with the `reviewed` label.
3. **Threads.** `wg claim <plan-dir> <key> threads`, with the job "load `gh-close-review-loop`, prepare phase". Relay the push-ready report. After the human accepts, the worker pushes, reports the new head SHA, runs the finalize phase with `pr_threads.py resolve --expected-head-oid <new head SHA>`, and fetches the threads again. Each thread that stays open needs the human's disposition; write it as an issue comment. The push changes the patch, so step 2 comes back for this PR as a fix check, not as a new thorough review.
4. **Merge request** (`ask-merge <key> #<n>`: the bottom PR of a lane, with a merge review). `wg move <plan-dir> <key> "Ready to Merge"`; `wg` checks the PR, its base, its head, its checks, conflicts, the merge review, and the lane order. Ask: "PR #a: thorough review done, threads settled, code done on `<sha>`. Please merge #a with <method>." The method is squash, or a merge commit for a SYNC PR. One message can name a whole lane in order ("merge #a, then #b after I restack it"). At autonomy level `full` in a repository where agents may merge, merge it yourself instead of asking (SKILL.md "Autonomy level"). At level `supervised`, ask only after the issue has the `reviewed` label.
5. **After each merge** (`merged <key> #<n> <sha>`). `wg move <plan-dir> <key> Merged`: `wg` checks that the PR is merged and comments the merge commit. It also removes the node's Orca worktree, and the lane parent when every node of the lane is settled (coordinator.md "Worktree cleanup"). Then `git fetch origin`. After a SYNC merge, also check `git merge-base --is-ancestor <<release> head SHA in the SYNC PR> origin/main`. Then:
   - The merged branch has a child in its lane: `wg next` prints `restack <child> …: the PR below it merged`. Send that restack job. A branch higher in the lane is restacked when the branch below it merges.
   - It has no child: on a trunk target, run `st sync --force --no-stash --no-delete` from the coordinator worktree; on a frozen base, run `wg base <plan-dir>`.
   - The bottom PR of another lane gets a restack job only when `wg next` prints `restack <key> …: conflicts with <target>` or `…: its base is <branch>, not <target>`.
6. **Close** (`close <merge point>`). `wg move <plan-dir> <merge point> Done`. `wg` proves that every pre-merge task is `Merged` and that `origin/<target>` holds each merge commit, and comments it. A node that is `Canceled` is skipped. A closed unmerged PR is not `Merged`: follow recovery.md "Failure".

Native GitHub stacks are off for work-graph efforts: every submit passes `--no-native-stack`, and `wg done` fails `stack` when a PR is in one (`st stack unlink <n>`, then check each PR base). If `st submit` or `st branch submit` fails with 422 "part of a stack": stop. Give the human the stack number (`gh api repos/{owner}/{repo}/pulls/<n> --jq .stack.number`) and ask them to unstack it. After they confirm, run `st submit --native-stack --no-prompt --yes`. GitHub's retarget of a stacked PR is not verified: after each submit, `gh pr view <n> --json baseRefName` must show the expected base, or stop and tell the human.
<!-- /explain -->

<!-- explain: restack -->
## Restack job

The only way a branch is refreshed onto a moved base. The coordinator never starts a restack in a worker-owned worktree. One job at a time, across the whole effort, bottom of a lane first.

Coordinator: `wg claim <plan-dir> <key> restack`. It refuses a second restack job. It refreshes a frozen base first (a `FAIL base` error stops the job, and you ask the human) and prints the pinned line `target <target> at <sha>; base: <trunk|frozen|integration|hotfix|sync>; parent merged: <yes|no>`. The line is also in the job spec. Send the job (coordinator.md "Follow-up jobs"). If the owner exited, the job arrives as a follow-up Task.

A second restack job on a branch that is already restacked is safe: the worker reports the same head.

Owner worker, in its own worktree:

1. Branch and status check. `st ls`: if a branch below yours needs restack, stop and report it (`st restack --stop-here` also restacks ancestors). If `git status` shows a rebase in progress, continue that rebase with the continuation of the command that started it (resolve, `git add <files>`, then `st restack --continue` after `st restack`, or `git rebase --continue` after `git rebase`) and skip step 2.
2. `git fetch origin`; `git rev-parse origin/<target>` must equal `<sha>`, and for `base: frozen` also `git rev-parse <target>`; if not, stop and report it (the coordinator pins again). Back up the branch (`git update-ref refs/backup/<date>/<branch> <branch>`). Refresh with the command of the `base` in ordering.md "Targets". On a conflict: load `resolving-merge-conflicts`, resolve, `git add <files>`, continue. A resolution that changes behavior another lane owns needs an `ask` first.
3. The push checks, then the update push of the same "Targets" row.
4. One `worker_done` for this job with the new head SHA and the `wg evidence` result, or `--outcome failed`.

Coordinator: `wg done <plan-dir> <key> --dispatch <id>`. For "parent merged: yes" it sets the parent to the target when the PR's base on GitHub is the target. If the base is still the merged branch, `FAIL pr` says so and the node is not code done: the update push did not retarget the PR; send the worker back, or tell the human. If Orca shows that the worker exited without `worker_done`: `wg done <plan-dir> <key> --failed "worker lost"`, and recovery.md "Failure".

`st restack --dry-run` can predict "no conflicts" for a restack that then conflicts. Do not plan on it.

Done when: `wg done` passed, and the restacked branch does not show "needs restack" in `st ls` (branches above it may).
<!-- /explain -->

<!-- explain: full-suite,ops,ask,verifying,ship -->
## Ship point

The `ops` chain can start as soon as the merge point is `Done`; post-merge tasks (SYNC, integration) run at the same time. The ship point waits for both. The human does each `ops` node; you never run a deploy, a backfill, or a flag change, unless the node has `"by": "coordinator"`.

1. `full-suite <ship key>`: the phase needs its one repo-wide test run on the merged target. `wg next` prints the line and the command when the merge point is `Done`; the `ops` chain does not wait for it. Run the command in a clean worktree whose HEAD is `origin/<target>` after the last merge: a new Orca child worktree of the coordinator from `origin/<target>`, or the first worktree of the next phase when it starts at that commit. `wg` refuses `Verifying` and `Done` for the ship point until the run passed on a commit that holds each merge commit of the phase. On a failure, read the log: a test that the phase broke is a `Regression` (step 3, **Fail**); a known failure of the target is accepted with `wg run set <plan-dir> <ship key> "tests_accepted=<sha>:<reason>"`.
2. `ops <ops key>` (`"by": "coordinator"`): do the step yourself as the repository's rules say. When it must wait (for example for a market session), `wg move <plan-dir> <key> "In Progress"`: `wg next` then prints `wait coordinator`, and the page does not show the human as the one who must act. When the acceptance holds, `wg move <plan-dir> <key> Done --note "<evidence>"`.

   `ask <ops key>`: `wg move <plan-dir> <key> "Needs <human>"` and tell them: "Ready for you: <title> (<identifier>). Done when: <acceptance>. Please send what you deployed (commit or version, environment), the check you ran, and its result."
3. Test their reply against the node's acceptance.
   - **Pass:** if this node starts a soak (phase table), first compute the deadline from the confirmed start and run `wg run set <plan-dir> <ship key> soak_until=<YYYY-MM-DDTHH:MM:SSZ>`. Then `wg move <plan-dir> <key> Done --note "<what> to <env> at <time>; check: <check>; result: <result>"`. `wg` refuses a `Done` `ops` node with no note.
   - **Fail or incomplete** (or a problem during a soak): the node stays open. `wg move <plan-dir> <ship key> "Needs <human>"` with a comment `Regression: <evidence>`, and follow recovery.md "Failure", row "Regression".
4. `ask <decision key>`: `wg move` it to `Needs <human>` and resolve it with them through `grilling`. Then `wg move <plan-dir> <key> Done --note "<their answer>"`. **No:** the note is "no", and you Replan the nodes after it with them. **Defer:** leave it in `Needs <human>` and write "deferred: <reason>" in `PLAN.md` `## Notes`; the ship point stays blocked.
5. `verifying <ship key>`: `wg move <plan-dir> <ship key> Verifying`. `wg next` then prints `wait soak … until <time>`, and `ship <ship key>` when the soak passed or the phase has none (`wait blockers` when a blocker opened again). On `ship`: check the `ops` evidence again and that no regression is open, then `wg move <plan-dir> <ship key> Done`. `wg` checks the blockers and the soak, and moves each `Merged` task of the phase to `Done`. Start the next phase from the updated target (SKILL.md step 3). After the last phase: SKILL.md step 7.

Done when: the repo-wide test run of the phase passed, each `ops` node of the phase is `Done` with passing evidence, the soak deadline passed (when the phase has a soak), and the ship point is `Done`.
<!-- /explain -->
