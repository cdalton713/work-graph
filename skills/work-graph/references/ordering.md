# Ordering, lanes, ownership, and targets

## Constraint → encoding

| Constraint | Encoding in plan.json |
|---|---|
| B starts after A, same lane | Edge `B → A`. B stacks on A's unmerged branch; B is ready when A is code done. A's review runs at the same time. |
| B starts after A, other lane | One of the three rewrites in "Lanes". |
| B and C run at the same time | No edge; different lanes; disjoint `owns`. |
| A phase must finish before the next | Merge point → `ops` chain → ship point. Each first node of the next phase depends on the ship point. |
| Test the phase as one unit before it reaches its base | A merge-point branch ("Merge-point branch"): merge point → QA `ops` node → integration task → deploy `ops` chain → ship point. |
| Wait for a PR merge | Nothing extra: the merge point depends on each pre-merge task and is satisfied when the task is `Merged`. A post-merge task blocks the ship point the same way. |
| A human step (deploy, backfill run, flag flip, prod check) | An `ops` node. The next node depends on it. |
| Soak time after a deploy or flag flip | A deadline on the ship point: the run row field `soak_until`, written when the human confirms the start (review-and-merge.md "Ship point"). Never at plan time. |
| Wait for the human's yes | A `decision` node, or `Needs <human>` on the waiting issue with a comment that says what is needed. Record their answer as a comment. |
| One branch resolves conflicts at a time | `wg claim … restack` allows one restack job at a time (review-and-merge.md "Restack job"). |

Edges among tasks, milestones, and `ops` nodes follow this list only (A → B: A depends on B). A `decision` or `spike` sits in front of the nodes it blocks.

- pre-merge task → pre-merge task below it in the lane; first lane node → previous ship point
- merge point → every pre-merge task; first `ops` node → merge point; next `ops` or `decision` node → the one before it
- post-merge task → merge point
- ship point → last `ops` node (or the merge point when the phase has no `ops` node) and → every post-merge task
- merge-point branch phase: QA `ops` node → merge point; integration task → QA `ops` node; first deploy `ops` node → integration task; SYNC task (release base) → integration task

## Lanes

- A lane is a chain of `task` nodes in one phase. Each `task` has at most one `task` dependency in its phase (the node below it in the lane). It can have more than one `task` dependent: two nodes can stack on one branch (a fork). Each lane is one stax stack.
- A lane's `00` node starts from `origin/<target>`. Each later node stacks on the branch of the node below it, merged or not.
- A cross-lane edge inside a phase is not allowed (`wg check` rejects it). If B needs A from another lane, use one rewrite:
  1. B has no other `task` dependency in the phase: move B into A's lane, so B stacks on A (a fork when A has another dependent). Prefer this rewrite: it costs no merge round.
  2. Put B in the next phase. It starts from the updated target after the ship point.
  3. Split the phase in two at A: phase `<N>a` ends with a merge point and a ship point that depends only on it (no `ops` node). B goes in phase `<N>b`. The cost is one human merge round, not a deploy.

## Branches and worktrees

The effort coordinator is `<slug>-core`, with branch `<prefix><slug>-core` (config `branch_prefix`, default `wg/`); its root holds the plan files (setup.md). Reuse it as the core lane parent. Orca shows it with the name of the Linear project (`wg load --apply` sets that display name); the path and the branch do not change.

One Orca child worktree per branch, SYNC and integration branches included. One parent workspace per lane and phase, nested under the `<slug>-core` coordinator, so the effort is one tree in Orca: `<slug>-core` › `<stack>` › `NN <key>`. Spikes are children of `<slug>-core` itself. The coordinator creates both with the commands that `wg dispatch` prints (jobs.md "Dispatch"); workers never create worktrees. `wg dispatch` computes these names:

| Item | Form | Example |
|---|---|---|
| Stack name | `<slug>-<lane>` in the first phase, else `<slug>-p<P>-<lane>`, where `<P>` is the phase key (`2`, `1b`) | `xy-write`, `xy-p1b-data` |
| Parent workspace | `<stack>` | `xy-write` |
| Child display name | `NN <key>` (two digits from `00`: the node's place in its lane) | `01 dualwrite` |
| Child workspace name | `<stack>-NN-<key>` | `xy-write-01-dualwrite` |
| Branch | `<prefix><stack>-NN-<key>` | `wg/xy-write-01-dualwrite` |
| Base (`--base-branch`) | `origin/<target>` for `00` or when the node below merged, else the branch below | `wg/xy-write-00-schema` |
| HOTFIX branch | `hotfix/<slug>-<key>` from `origin/<release>` (in a merge-point phase: from `origin/mp/<slug>-p<P>`); not tracked by stax | `hotfix/z-fix` |
| Merge-point branch | `mp/<slug>-p<P>` from `origin/<base>`, stack `<slug>-p<P>-mp`, child `00 merge point`; owned by the coordinator | `mp/xy-p1` |
| SYNC branch | `sync/<slug>-p<P>` from `origin/main`, stack `<slug>-p<P>-sync`, child `00 sync`; not tracked by stax | `sync/z-p1` |
| Spike branch | `<prefix><slug>-spike-<key>` from `origin/<target>`, under the `<slug>-core` coordinator; no PR | `wg/xy-spike-load` |

An adopted branch keeps its own name (jobs.md "Adopt an existing branch or PR").

A new phase starts its stacks again at `00` from the updated target.

## File ownership

Each `task` in `plan.json` has two arrays of path globs:

- `owns`: files only this node changes in its wave. No glob in one node's `owns` overlaps another wave node's `owns` or `shares`.
- `shares`: shared files this node may change with additive edits only, for example `pnpm-lock.yaml`, `packages/types/**`, `src/clients/index.ts`. Nodes of one wave may share a file.

```bash
wg owns overlap <plan-dir> <every task key of the wave>     # plan time: exit 0
(cd <worktree> && wg owns diff <plan-dir> <key> <base>)     # wg done runs it: no OUT line
```

- `wg load --apply` creates or updates the issue's `work-graph node card` comment when its text changes, so the worker sees `acceptance`, `owns`, and `shares` in Linear. Every node has a card: it ends with a JSON block (`key`, `kind`, `phase`, `lane`, `role`, the run fields `branch`, `pr`, `review`, `merge_review`, `state`, `job`, `soak_until`, `code_done`, and `wave` and `next` from the last `wg next`; `next` has one line for each thing that `wg next` said about the node) that the page reads. `wg run set` updates the block when one of the run fields changes, and `wg next` updates `wave` and `next`. The design stays in the issue description, written by the coordinator.
- `diff` prints `SHARED <file>` for each changed `shares` file. The coordinator reads that diff and accepts additive edits only.
- `overlap` compares the glob text up to the first wildcard, so it can report a pair that never matches one real file. Narrow the glob to clear it (`web/ai/**` → `web/ai/src/foo/**`).
- A non-additive change to a shared file (rename, removed field, changed schema) is its own node. Put it in the lane of the nodes that need it, or in an earlier phase.
- Parallelism = the number of lanes with disjoint `owns`, not the number of ready nodes.

## Target branch per phase

`PLAN.md` and `plan.json` give each phase one target branch and one ship environment. All lanes of the phase start from the target. The **base** is the branch the phase's work finally reaches: the target itself, or for a merge-point branch the phase field `base`.

| Target | Use for | Merge point is Done when | Ship environment |
|---|---|---|---|
| `mp/<slug>-p<P>`, `"base": "main"` | Default for a phase with 2 or more pre-merge PRs | Every pre-merge PR is merged to `mp/<slug>-p<P>` | The environment that `main` deploys to, after the integration PR merges |
| `mp/<slug>-p<P>`, `"base": "<release>"` | Default for a release phase with 2 or more HOTFIX PRs | Every HOTFIX PR is merged to `mp/<slug>-p<P>` | Prod, after the integration PR merges to `<release>` |
| `main` | A phase with 1 pre-merge PR. Additive, backward-compatible work. | The PR is merged to `main` | The environment that `main` deploys to |
| `<release>` | A release phase with 1 HOTFIX PR | The HOTFIX PR is merged to `<release>` | Prod |
| `effort/<slug>` | Older form of a merge-point branch: one long-lived branch for the whole effort, base `main` | Every pre-merge PR is merged to `effort/<slug>` | As `main`, after the integration PR merges |

`wg check` prints `warn phase <P>: <n> pre-merge tasks merge straight to <target>` for a `main` or `<release>` phase with 2 or more pre-merge tasks. Use a merge-point branch unless the human says otherwise.

### `<release>`: HOTFIX and SYNC

`<release>` is the config `release_branch` (default `release`): a branch that prod deploys from while `main` moves ahead, for example during a code freeze. A **release phase** has target `<release>`, or a merge-point branch with `"base": "<release>"`. The rules below apply to both.

Every pre-merge task is a HOTFIX. Lanes have length 1: no stacks. graph.md has the plan.json example.

Exception, only on the human's word: `"stacked_hotfix": true` in `effort` lets one lane of HOTFIX tasks stack. Then `wg check` accepts a HOTFIX that depends on the HOTFIX below it, and `wg dispatch` names and stacks those branches like any lane (`<prefix><stack>-NN-<key>`, stax parent = the branch below, bottom parent `<release>`). Each PR still has the `HOTFIX:` title and body, and the phase still has one SYNC task.

- **HOTFIX** (pre-merge `task`, `"role": "hotfix"`): branch `hotfix/<slug>-<node>` from `origin/<target>`, draft PR to the target (`<release>`, or the merge-point branch), title `HOTFIX: <summary>` (worker-spec.md "submit hotfix").
- **SYNC** (post-merge `task`, `"role": "sync"`): one per phase, on `sync/<slug>-p<P>` from `origin/main`. The worker merges `origin/<release>` into it and opens a draft PR to `main`. The human merges it with a merge commit. In a merge-point phase, the SYNC task depends on the integration task: `<release>` has the phase's work only after that PR merges.
- If two hotfixes depend on each other, put them in two phases.

<!-- explain: integration -->
### Merge-point branch

A phase with 2 or more pre-merge PRs collects them on a merge-point branch `mp/<slug>-p<P>`, not on its base. The human merges each approved PR into it. Then the phase is tested as one unit on that branch, and one integration PR merges it into the base. Phase fields: `"target": "mp/<slug>-p<P>"` and `"base": "main"` or `"<release>"` (default `main`).

The phase's graph, in order (graph.md "Merge-point branch plan.json"):

1. Pre-merge tasks: PRs to `mp/<slug>-p<P>`, squash-merged by the human (review-and-merge.md "Merge point").
2. Merge point: every pre-merge PR is merged to `mp/<slug>-p<P>`.
3. The repo-wide test run (`full-suite`, review-and-merge.md "Ship point" step 1) on `origin/mp/<slug>-p<P>`, by the coordinator, and a **QA `ops` node** ("QA on `mp/<slug>-p<P>`"), by the human, at the same time. The integration task depends on the QA node.
4. Integration task (post-merge `task`, `"role": "integration"`, no lane): one PR from `mp/<slug>-p<P>` to the base, merged by the human with a **merge commit**. In a release phase its title starts with `HOTFIX:`.
5. Deploy `ops` nodes depend on the integration task. A release phase's SYNC task depends on it too.

`wg check` rejects an integration phase with no `ops` node between the merge point and the integration task, an `ops` node that is neither before nor after the integration task, and a SYNC task that does not come after it. `wg move <key> "Ready to Merge"` for the integration task, and its `ask-merge` line, wait until the repo-wide test run of the phase passed on a commit that holds each merge commit of the phase (`wait coordinator … merges after the repo-wide test run passes`).

The coordinator creates the branch and its worktree once, at phase start, as the child `00 merge point` of the parent `<slug>-p<P>-mp`, which nests under `<slug>-core`, and owns it:

```bash
orca worktree create --name <slug>-p<P>-mp --parent-worktree id:<core-id> --base-branch origin/<base> --setup skip --json
orca worktree create --name <slug>-p<P>-mp-00-merge-point --branch mp/<slug>-p<P> \
  --base-branch origin/<base> --parent-worktree id:<parent-id> --setup skip --json
orca worktree set --worktree id:<child-id> --display-name "00 merge point" --json
cd <child-path> && git push -u origin mp/<slug>-p<P>
```

Then track it in stax without a checkout: `st get mp/<slug>-p<P> --parent <base> --no-checkout --no-restack --downstack`, and `st freeze mp/<slug>-p<P>`. For base `<release>`, which stax does not track, skip `st freeze` when `st get` refuses the parent, and say so in a `PLAN.md` note.

- Lanes use `--base-branch origin/mp/<slug>-p<P>` and `st branch track --parent mp/<slug>-p<P>`. Child PRs target it. Base `main`: refresh it once per wave (table below). Base `<release>`: refresh it only when a hotfix lands on `<release>` outside the effort.
- The **integration** node is coordinator-owned; no worker runs it. `wg next` prints `integration <key>` when the QA node is `Done`. Then: `wg move <plan-dir> <key> "In Progress"`; refresh the branch; `wg run set <plan-dir> <key> lower=origin/<base>`; run the push checks in its worktree (`wg evidence <plan-dir> <key>`); `gh pr create --draft --base <base> --head mp/<slug>-p<P> --title "<effort>: phase <P>" --body-file <body>` (release: `--title "HOTFIX: <effort>: phase <P>"`); `wg run set <plan-dir> <key> branch=mp/<slug>-p<P> parent=<base> lower=origin/<base> path=<child-path> pr=<n>`; then `wg done <plan-dir> <key>` (it attaches the PR and skips the owns check for role `integration`), and review-and-merge.md "Merge point" steps 1–5.
- After the integration PR merges, delete `mp/<slug>-p<P>` on GitHub if GitHub did not, and remove its worktree. The next phase cuts a new branch from the updated base.
- Never run `st trunk`: it checks out the trunk.
- The older `effort/<slug>` target follows the same rules with base `main`: one branch for the whole effort, refreshed from `main` between phases.
<!-- /explain -->

### Move a lane to another base

Only on the human's word (a target change is a graph change: update each phase's `target` in `plan.json` first). Bottom to top, one branch at a time, in each child worktree:

1. Back up the head: `git update-ref refs/backup/<date>-<slug>/<key> HEAD`.
2. Clean tree. A file that a setup script copies into the worktree can block a rebase whose two bases differ in that path: stash only the tracked changed paths (`git stash push -- $(git diff --name-only)`), never `git checkout --` them.
3. `git rebase --onto <new parent> <old parent SHA>`. Never `st restack` or `st branch reparent --restack` here: stax restacks onto the parent in its metadata, which still names the old base.
4. `st branch reparent --parent <new parent>` (metadata only), then run the repository's worktree setup again if it has one (local rules file).
5. Lint the touched projects on the new base: rules differ between `main` and `<release>` (for example another major version of a dependency).
6. `git push --force-with-lease=<branch>:<old remote SHA>`, then retarget the bottom PR (`gh api -X PATCH …/pulls/<n> -f base=<target>`) and update the run rows (`wg run set <plan-dir> <key> parent=<target> lower=origin/<target>`).
7. Check scope on every PR: `gh pr view <n> --json commits --jq '.commits|length'` equals `git rev-list --count <parent>..HEAD`.

### Targets

How each branch kind is refreshed onto a moved base (review-and-merge.md "Restack job" step 2) and how a PR update is pushed. The `base:` word of a restack job names the row: `trunk`, `frozen`, `integration`, `hotfix`, `sync`.

| Branch | Refresh | Update push | stax |
|---|---|---|---|
| Lane on the stax trunk | If the parent merged: the refresh of the restack line, `git rebase --onto origin/<target> <old parent tip>`, then `st branch reparent --parent <target>`. If the parent is `<target>`: `git rebase origin/<target>`. Else `st restack --stop-here --yes`. Never `st sync`: it moves the local trunk branch, which another worktree can have checked out. | `st branch submit --no-restack --no-native-stack --no-prompt --yes` | yes |
| Lane on a frozen base | `wg claim … restack` refreshes the base first. If the parent merged: the refresh of the restack line, `git rebase --onto origin/<target> <old parent tip>`, then `st branch reparent --parent <target>`. Else `st restack --stop-here --yes`. Never `st sync`. | `wg base <plan-dir>`, then `st branch submit --no-restack --no-native-stack --no-prompt --yes` | yes |
| Lane on `mp/<slug>-p<P>` or `effort/<slug>` | Base `main` must pass `wg preflight` (trunk or frozen base). The coordinator refreshes the merge-point branch first. If the parent merged: the refresh of the restack line, `git rebase --onto origin/<target> <old parent tip>`, then `st branch reparent --parent <target>`. Else `st restack --stop-here --yes`. | `st branch submit --no-restack --no-native-stack --no-prompt --yes` | yes |
| HOTFIX | `git rebase origin/<target>` (`<release>`, or the merge-point branch; stacked hotfix: the lane rows above) | `git push --force-with-lease origin <branch>` | no (stacked hotfix: yes) |
| SYNC | `git merge origin/<release>` | `git push origin <branch>` | no |
| `mp/<slug>-p<P>` or `effort/<slug>` (coordinator) | `git merge --ff-only origin/<target> && git merge --no-ff origin/<base> -m "Merge <base> into <target>"` | `git push origin <target>`; never force | frozen: never restacked |

## Repository rules

The local rules file (SKILL.md "Config and local rules") and the repository's own agent instructions can add rules for a target: what `main` must stay compatible with, which environments share a database, and which deploys count as prod changes. Follow them when you choose a phase's target and when you write `ops` nodes.
