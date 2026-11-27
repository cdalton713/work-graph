# Worker spec templates

`wg dispatch` and `wg claim` fill these sections and write the result to `<plan-dir>/specs/`. The coordinator does not paste or fill them by hand. Each `{name}` is a value that `wg` supplies; `wg` stops if a name has no value.

A dispatch spec (`wg dispatch`) starts with one line that gives the time when `wg` wrote it. After the `task` or `spike` section, it has these sections, so that the worker makes no Linear call to start:

- `## Design`: a copy of the issue description, without the Agent notes of `wg load`. The issue stays the record.
- `## Node card`: the `acceptance`, `owns`, and `shares` of the node in plan.json.
- `## Repository rules`: the text of `effort.rules` in plan.json, if it has one (graph.md).

`{lint}` is the lint part of step 4: from `effort.lint` in plan.json, else from the config `test_runner.lint` when the plan has no `effort.test` (graph.md). With no lint command, step 4 has no lint. A job spec (`wg claim`) is one `job` header and the work; a new worker also gets the `task` section first.

## task

**Task:** Linear issue `{identifier}` ({url}), node `{key}`. Worktree `{path}`, branch `{branch}`, stax parent and PR base `{parent}`, diff base `{lower}`. `wg` = `{wg}`, plan dir `{plan_dir}`. The coordinator holds the claim and moves the issue. You change no `agent:*` label, no assignee, and no status, except in step 8.

1. Immediately before each edit, commit, and rebase, run `git branch --show-current` and `git status --short` (and `st ls` once at the start). The branch and parent must match the values above, and the tree must hold only your changes; if not, send an `escalation` and stop.
2. Your dispatch spec {dispatch_spec} holds the design (`## Design`), the acceptance, owns, and shares (`## Node card`), and the rules of the repository (`## Repository rules`, if any). Do not read the issue to start. Read Linear only for comments newer than the time in the first line of that spec (Linear MCP `list_comments`). Edit only owns files, and shares files additively. For any other file, `orca orchestration ask` first.
3. Commit per unit of work, with conventional messages and `--no-verify`. Stage only your own hunks. No ticket IDs in code comments.
4. **Push checks**, before every push that opens or updates a PR, in this order: {lint}with a clean tree, `{wg} evidence {plan_dir} {key}`. It runs the test tasks that your diff affects on the test server, on the committed head. While you work, your test runs are focused vitest files. Exit 3 means the evidence is invalid. If the test server fails, report the exact error; `wg evidence` is the only run of a `:test` task. The known failures on the base are the `baseline` field of `{wg} run show {plan_dir} @effort`; no field means none.
5. {submit}
6. Attach the PR to the issue (`save_issue` with `links`), and comment the PR URL, the head SHA, and the `wg evidence` result. If the Linear MCP cannot read the issue (another workspace), do neither: `wg done` attaches the PR, and the body of your `worker_done` is the record.
7. Your work ends at the open draft PR. The human merges, undrafts, and deploys. The coordinator creates worktrees and agents and sends follow-up jobs. Run `st restack` only inside a restack job. Never `st sync`: it moves the local trunk branch, which another worktree can have checked out. Never `st merge`, `st restack --all`, `gh stack`, or a push to `main` or `<release>`.
8. If you need the human (a decision, a login, a secret), comment what you need, run `{wg} move {plan_dir} {key} "Needs <human>"`, and send an `escalation`.
9. New work you find: create an issue in the plan's team in status `Triage`, in project `{project}`, related to `{identifier}`. Do not do it now.
10. Send one `worker_done` for each job: this dispatch and each follow-up job. `--outcome succeeded` only if the PR is open, `wg evidence` exited 0 on the pushed head (or failed only on the known failures on the base), and `{wg} owns diff {plan_dir} {key} {lower}` exits 0. Body: PR URL and head SHA; the check commands and results; what is left. Add `--files-modified` with the PR diff files. Otherwise `--outcome failed` with the failing command and its first error, also when no PR exists.

Use this form for an Orca ask, or for a waiting comment that asks the human to choose.

For a choice, put the question and any context first. Leave a blank line, then end the message with an `Options:` block. Give two to four options. Use one line per option in the form `- Label: Effect`. Add ` (Recommended: Reason)` to exactly one line. Use distinct labels without colons.

```text
When?

Options:
- Now: Start today. (Recommended: Checks passed.)
- Later: Keep the schedule.
```


## submit lane

Immediately before each `st branch submit`, run `{wg} base {plan_dir}`. It fast-forwards the frozen target branch to `origin` (never a reset or a merge), so stax does not refuse the submit with `Parent branch … is not in sync`. A `FAIL base` line: send an `escalation` with that line and stop; never fast-forward, reset, or sync the base yourself.

First PR: `st branch submit --draft --no-restack --no-native-stack --no-prompt --yes` (current branch only; `--no-restack` keeps the tested head). Title in conventional commit form. Check that the PR head equals the SHA that `wg evidence` tested, and with `st ll` that the base is `{parent}`. Each later update: `st branch submit --no-restack --no-native-stack --no-prompt --yes`. Never run `st submit` or `st ss`, and never omit `--no-native-stack`: a native GitHub stack retargets the bottom PR to the stax trunk. Then check scope: `gh pr view <n> --json commits --jq '.commits|length'` must equal `git rev-list --count {lower}..HEAD`; after a restack, GitHub can keep an old base: run `gh pr edit <n> --base <base>` (the target of the restack line when the parent merged, else `{parent}`) and count again. A number that stays larger means the branch is not based on its PR base, so stop and report it. If stax refuses the submit because the parent branch has commits that are not on `origin` (the work of another job), send an `escalation`, and wait for a restack job; never push, restack, or change the parent branch yourself.

## submit hotfix

First PR: follow the repository's hotfix rules for the PR body, if it has them (the local rules file names them); never ask for approval. `git push -u origin {branch}`, then `gh pr create --draft --base {parent} --title "HOTFIX: <summary>" --body-file <body>`. Check that the PR head equals the SHA that `wg evidence` tested. Each later update: `git push --force-with-lease origin {branch}`.

## submit sync

Your work is one merge, and it comes before the push checks of step 4: `git fetch origin && git merge origin/<release>` (conflicts: `resolving-merge-conflicts`). Run the push checks on the merge commit. First PR: `git push -u origin {branch}`, then `gh pr create --draft --base main --title "SYNC: <release> → main (#a, #b)"`. Check that the PR head equals the SHA that `wg evidence` tested. Each later update: merge again, run the push checks again, then `git push origin {branch}`.

## spike

**Spike:** Linear issue `{identifier}` ({url}), node `{key}`. Worktree `{path}`, branch `{branch}`. The question is in the sections `## Design` and `## Node card` below; read Linear only for comments newer than the time in the first line of this spec. Research only: no commit, no push, no PR. Write the findings as one comment on the issue; if the Linear MCP cannot read the issue, put them in the `worker_done` body. Send one `worker_done` with a summary.

## job

**Job `{job}`:** Linear issue `{identifier}`, node `{key}`. Worktree `{path}`, branch `{branch}`, PR #{pr}, stax parent and PR base `{parent}`, diff base `{lower}`. `wg` = `{wg}`, plan dir `{plan_dir}`. {restack}

Do the work below on this branch only. A restack job follows the owner steps in `{skill}/references/review-and-merge.md` "Restack job". For `parent merged: yes`, the restack line names the refresh: the `git rebase --onto` command with the old tip of the parent, then `st branch reparent`. Never `st sync`. Then run the push checks and the update push of step 4 and step 5 of your task contract. Send one `worker_done` for this job with the new head SHA and the `wg evidence` result, or `--outcome failed` with the failing command and its first error.

**Work:**
