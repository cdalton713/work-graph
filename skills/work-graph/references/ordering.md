# Ordering, lanes, ownership, and targets

## Constraint → encoding

| Constraint | Encoding in plan.json |
|---|---|
| B starts after A, same lane | Edge `B → A`. B stacks on A's unmerged branch; B is ready when A is code done. A's review runs at the same time. |
| B starts after A, other lane | One of the three rewrites in "Lanes". |
| B and C run at the same time | No edge; different lanes; disjoint `owns`. |
| A phase must finish before the next | Merge point → `ops` chain → ship point. Each first node of the next phase depends on the ship point. |
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

## Lanes

- A lane is a chain of `task` nodes in one phase. Each `task` has at most one `task` dependency in its phase (the node below it in the lane). It can have more than one `task` dependent: two nodes can stack on one branch (a fork). Each lane is one stax stack.
- A lane's `00` node starts from `origin/<target>`. Each later node stacks on the branch of the node below it, merged or not.
- A cross-lane edge inside a phase is not allowed (`wg check` rejects it). If B needs A from another lane, use one rewrite:
  1. B has no other `task` dependency in the phase: move B into A's lane, so B stacks on A (a fork when A has another dependent). Prefer this rewrite: it costs no merge round.
  2. Put B in the next phase. It starts from the updated target after the ship point.
  3. Split the phase in two at A: phase `<N>a` ends with a merge point and a ship point that depends only on it (no `ops` node). B goes in phase `<N>b`. The cost is one human merge round, not a deploy.

## Branches and worktrees

The effort coordinator is `<slug>-core`, with branch `<prefix><slug>-core` (config `branch_prefix`, default `wg/`); its root holds the plan files (setup.md). Reuse it as the core lane parent.

One Orca child worktree per branch, SYNC and integration branches included. One parent workspace per lane and phase, nested under the `<slug>-core` coordinator, so the effort is one tree in Orca: `<slug>-core` › `<stack>` › `NN <key>`. Spikes are children of `<slug>-core` itself. The coordinator creates both with the commands that `wg dispatch` prints (coordinator.md "Dispatch"); workers never create worktrees. `wg dispatch` computes these names:

| Item | Form | Example |
|---|---|---|
| Stack name | `<slug>-<lane>` in the first phase, else `<slug>-p<P>-<lane>`, where `<P>` is the phase key (`2`, `1b`) | `xy-write`, `xy-p1b-data` |
| Parent workspace | `<stack>` | `xy-write` |
| Child display name | `NN <key>` (two digits from `00`: the node's place in its lane) | `01 dualwrite` |
| Child workspace name | `<stack>-NN-<key>` | `xy-write-01-dualwrite` |
| Branch | `<prefix><stack>-NN-<key>` | `wg/xy-write-01-dualwrite` |
| Base (`--base-branch`) | `origin/<target>` for `00` or when the node below merged, else the branch below | `wg/xy-write-00-schema` |
| HOTFIX branch | `hotfix/<slug>-<key>` from `origin/<release>`; not tracked by stax | `hotfix/z-fix` |
| SYNC branch | `sync/<slug>-p<P>` from `origin/main`, stack `<slug>-p<P>-sync`, child `00 sync`; not tracked by stax | `sync/z-p1` |
| Spike branch | `<prefix><slug>-spike-<key>` from `origin/<target>`, under the `<slug>-core` coordinator; no PR | `wg/xy-spike-load` |

An adopted branch keeps its own name (coordinator.md "Adopt an existing branch or PR").

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

`PLAN.md` and `plan.json` give each phase one target branch and one ship environment. All lanes of the phase start from the target.

| Target | Use for | Merge point is Done when | Ship environment |
|---|---|---|---|
| `main` | Default. Additive, backward-compatible work. | Every pre-merge PR is merged to `main` | The environment that `main` deploys to |
| `<release>` | Work that must reach prod from the release branch while `main` cannot ship there | Every HOTFIX PR is merged to `<release>` | Prod |
| `effort/<slug>` | A phase that is only safe as one unit (a cut-over across many files) | Every pre-merge PR is merged to `effort/<slug>` | As `main`, after the integration PR merges |

### `<release>`: HOTFIX and SYNC

`<release>` is the config `release_branch` (default `release`): a branch that prod deploys from while `main` moves ahead, for example during a code freeze.

Every pre-merge task is a HOTFIX. Lanes have length 1: no stacks. graph.md has the plan.json example.

Exception, only on the human's word: `"stacked_hotfix": true` in `effort` lets one lane of HOTFIX tasks stack. Then `wg check` accepts a HOTFIX that depends on the HOTFIX below it, and `wg dispatch` names and stacks those branches like any lane (`<prefix><stack>-NN-<key>`, stax parent = the branch below, bottom parent `<release>`). Each PR still has the `HOTFIX:` title and body, and the phase still has one SYNC task.

- **HOTFIX** (pre-merge `task`, `"role": "hotfix"`): branch `hotfix/<slug>-<node>` from `origin/<release>`, draft PR to `<release>`, title `HOTFIX: <summary>` (worker-spec.md "submit hotfix").
- **SYNC** (post-merge `task`, `"role": "sync"`): one per phase, on `sync/<slug>-p<P>` from `origin/main`. The worker merges `origin/<release>` into it and opens a draft PR to `main`. The human merges it with a merge commit.
- If two hotfixes depend on each other, put them in two phases.

### `effort/<slug>`: integration branch

The coordinator creates its worktree once, as the child `00 integration` of the parent `<slug>-integration`, which nests under `<slug>-core`, and owns it:

```bash
orca worktree create --name <slug>-integration --parent-worktree id:<core-id> --base-branch origin/main --setup skip --json
orca worktree create --name <slug>-integration-00-integration --branch effort/<slug> \
  --base-branch origin/main --parent-worktree id:<parent-id> --setup skip --json
orca worktree set --worktree id:<child-id> --display-name "00 integration" --json
cd <child-path> && git push -u origin effort/<slug> && st branch track --parent main && st freeze
```

- Lanes use `--base-branch effort/<slug>` and `st branch track --parent effort/<slug>`. Child PRs target it. Refresh it once per wave (table below).
- The **integration** node (post-merge `task`, `"role": "integration"`) is coordinator-owned; no worker runs it, and `wg next` prints `integration <key>` when the merge point is `Done`. Then: `wg move <plan-dir> <key> "In Progress"`; refresh `effort/<slug>`; `wg run set <plan-dir> <key> lower=origin/main`; run the push checks in its worktree (`wg evidence <plan-dir> <key>`); `gh pr create --draft --base main --head effort/<slug> --title "<effort>: phase <P>" --body-file <body>`; `wg run set <plan-dir> <key> branch=effort/<slug> parent=main lower=origin/main path=<child-path> pr=<n>`; then `wg done <plan-dir> <key>` (it attaches the PR and skips the owns check for role `integration`), and review-and-merge.md "Merge point" steps 1–5.
- Never run `st trunk`: it checks out the trunk. Never use this target for `<release>` work, or for a phase longer than about one week.

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
| Lane on the stax trunk | If the parent merged: `st sync --force --no-stash --no-delete`. Then `st restack --stop-here --yes`. | `st branch submit --no-restack --no-native-stack --no-prompt --yes` | yes |
| Lane on a frozen base | `wg claim … restack` refreshes the base first. If the parent merged: `st branch reparent --parent <target>`. Then `st restack --stop-here --yes`. Never `st sync`. | `st branch submit --no-restack --no-native-stack --no-prompt --yes` | yes |
| Lane on `effort/<slug>` | `main` must pass `wg preflight` (trunk or frozen base). The coordinator refreshes `effort/<slug>` first. If the parent merged: `st branch reparent --parent effort/<slug>`. Then `st restack --stop-here --yes`. | `st branch submit --no-restack --no-native-stack --no-prompt --yes` | yes |
| HOTFIX | `git rebase origin/<release>` (stacked hotfix: the lane rows above) | `git push --force-with-lease origin <branch>` | no (stacked hotfix: yes) |
| SYNC | `git merge origin/<release>` | `git push origin <branch>` | no |
| `effort/<slug>` (coordinator) | `git merge --ff-only origin/effort/<slug> && git merge --no-ff origin/main -m "Merge main into effort/<slug>"` | `git push origin effort/<slug>`; never force | frozen: never restacked |

## Repository rules

The local rules file (SKILL.md "Config and local rules") and the repository's own agent instructions can add rules for a target: what `main` must stay compatible with, which environments share a database, and which deploys count as prod changes. Follow them when you choose a phase's target and when you write `ops` nodes.
