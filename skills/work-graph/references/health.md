# Status check (`wg health`)

A scheduled agent checks the status and the health of one effort, and reports. It changes nothing in the effort: the coordinator, or the human, acts on the report.

## Install

`wg health <plan-dir> --install` makes two things, one time:

- The Orca worktree `<slug>-health` on the branch `<prefix><slug>-health`, under the coordinator worktree. The agent runs there, so `wg wake` (autostart) does not see it as a coordinator.
- An Orca automation that runs each hour. Its precheck is `wg health <plan-dir> --due`. When the precheck says `start`, Orca starts the agent of config `health_agent` (default `codex`) in a fresh session.

`wg health <plan-dir>` prints the state and the last check. `--uninstall` removes the automation and keeps the worktree. The human installs it; a coordinator does not install it on its own. `wg doctor` checks the automation of each effort that has one.

## When a check starts

`wg health <plan-dir> --due` says `start` only when all of these are true:

1. The plan is loaded, and no agent runs in the `<slug>-health` worktree.
2. The last check (or the last start of a check that gave no report) is `health_interval` hours ago or more (config, default 6).
3. The effort is not paused, and not complete (each ship point `Done` or `Canceled`).
4. One of these: no check yet; the last check is 24 hours ago or more; or the effort changed after the last check (a journal entry, or a project issue in Linear, other than a `health` issue).

Otherwise it prints `skip: <reason>`, which Orca keeps in the run history of the automation.

<!-- explain: health-check -->
## The checks of the agent

You are read only. Edit no file in the plan directory or in a repository. Move no issue, and add no comment or label. Send no message to an agent. Run only these `wg` commands, each with `WG_LINK=off`: `wg next <plan-dir> --no-publish`, `wg status`, `wg doctor <plan-dir>`, `wg run show`, `wg log`, `wg explain`, and at the end, one `wg health <plan-dir> --report <file>`. Read Linear (issues, comments, relations), GitHub (`gh pr view`, `gh pr checks`), and Orca (`orca agent list`, `orca terminal read`).

1. Run `wg doctor <plan-dir>` and `wg next <plan-dir> --no-publish`. Do not report their lines again: `--report` runs `wg doctor` itself. Use them to know the state.
2. Do the checks that need judgment. Each fault is one finding:

| kind | The fault |
|---|---|
| `status` | An issue status does not agree with the work: a PR merged or closed and the issue does not show it, an issue `In Progress` with no branch, PR, or live job, a `Done` node whose acceptance is not met. |
| `connection` | Linear, GitHub, Orca, or the page does not answer, or an Orca worktree of a run row is gone. |
| `stale-human` | An issue is `Needs <human>` for 24 hours or more, or its last comment does not say clearly what the human must do. Give `hours`. |
| `stale-review` | An issue is `In Review` or `Ready to Merge` for 48 hours or more with no activity on its PR. Give `hours`. |
| `comment` | The latest comment of an issue does not match its work (a wrong PR number, an old result). |
| `plan-drift` | The `PLAN.md` flowchart does not match the nodes and edges of `plan.json`. |
| `relation` | An ENG ticket of a node is gone or moved to another project, or its relation to the node is gone. |
| `worker` | An Orca agent of the effort stopped at a prompt, or a terminal shows a loop or an error that no run row records. |
| `other` | Another fault that puts the effort at risk. |
| `doctor-gap` | A fault above that a script could find. It files a request to add that check to `wg doctor`; it does not change the health value. |

3. Write the findings to a new file in `<health worktree>/.wg-health/` as JSON:

```json
{"summary": "One or two sentences on the state of the effort.",
 "findings": [{"kind": "status", "subject": "api-auth", "text": "PR #41 merged, the issue is In Review.",
               "fix": "wg move <plan-dir> api-auth Merged"}]}
```

`subject` is the node key, or a short name when no node applies (A-Z, a-z, 0-9, `_ . @ -`, at most 60 characters). One fault has one `kind` and `subject`: they make its fault ID `<kind>:<subject>`. Keep the same subject for the same fault in each run. With no fault, `findings` is `[]`.

4. Run `wg health <plan-dir> --report <file>` once, print its last line, and end.
<!-- /explain -->

## The report

`--report` reads the file, runs `wg doctor <plan-dir>`, and sets the health value from the rules, not from the agent:

- `offTrack`: a `status` or `connection` finding, or a `wg doctor` FAIL line.
- `atRisk`: any other finding, except `doctor-gap`; or no journal entry for 3 days while the effort is not complete. A `stale-human` finding under 24 hours and a `stale-review` finding under 48 hours are dropped.
- `onTrack`: none of these. `wg doctor` warn lines go in the notes of the update; they do not change the value.

Then it:

1. Files one issue for each fault that the last check did not have: status `Triage`, label `health`, the line `wg-health-fault: <fault ID>` in the description, in the effort's project (a `doctor-gap` issue has no project). When an open issue has that fault ID, it adds a comment to that issue in place of a new one. A fault that the last check also had gets nothing.
2. Posts a Linear project update with the health value, the faults, and their issues.
3. Writes `health`, `health_at`, `health_update`, and `health_faults` to the `@effort` run row.
4. Sends one notice through the `notify` channels when the value is worse than the last value, unless the effort is paused.

<!-- explain: health -->
## Act on a `note health` line

`note health @effort -: <value> at <time>, <n> fault(s); <update link>`: the last status check was `atRisk` or `offTrack`. Read the project update at the link. Each fault has a `Triage` issue with the label `health` in the project; `wg next` prints a `triage` line for each one.

1. For a fault that is yours (a status behind the work, a stale run row, a worker at a prompt), fix the cause with the `wg` command that the fault's `Fix:` names, or as recovery.md says. Then close its issue with a comment.
2. For a fault that only the human can fix (a login, a key, a decision), ask the human once, in the same step as your other questions.
3. A fault that is not real: close its issue as `Canceled` with a comment that says why. The next check files it again if it comes back.

The line goes away at the next check with no faults.
<!-- /explain -->
