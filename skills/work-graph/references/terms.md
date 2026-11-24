# Terms

Each bold term of the skill has the one meaning below.

| Term | Meaning |
|---|---|
| **node** | One entry in `plan.json` and one Linear issue, with a `key`, a `kind` (table below), and a `phase`. `keymap.json` maps each key to its issue. |
| **phase** | The nodes from one ship point to the next, with one target branch. It ends at a merge point, then a ship point. It is a milestone of the effort's Linear project. A split phase uses keys `1a`, `1b`. |
| **wave** | A frozen list of node keys of one phase, picked in SKILL.md step 3 and recorded with `wg run set <plan-dir> @effort wave=<k1,k2>`. One dispatch round. It may hold higher lane nodes that wait only for a lower node of the same wave. |
| **wave review** | The agent review of a draft PR before the merge review, with up to two rounds (review-and-merge.md "Wave review"). |
| **review effort** | How much review each PR gets: `thorough` (the default), `standard`, or `light`, a project label. review-and-merge.md "Review effort" describes the three levels. |
| **lane** | A chain of `task` nodes in one phase (`"lane": "<name>"`): one stax stack. Each node stacks on the node before it as soon as that node is code done. Two nodes can stack on one node (a fork). |
| **pre-merge task** | A `task` that the merge point depends on. |
| **post-merge task** | A SYNC or integration `task` (`"role": "sync"` or `"integration"`). It depends on the merge point, runs as its own wave, and the ship point depends on it. |
| **code done** | `wg done <plan-dir> <key>` passed on the PR's current head: the PR is open on the right base, the worktree is clean at that head, its **evidence** passed on that head (or its failure is accepted for that head with `tests_accepted`), the diff stays in owns and shares, and no check failed. The issue moves to `In Review`. `gh pr checks` is not test evidence. |
| **evidence** | The proof that a commit passed its tests. With `effort.test`, `wg evidence <plan-dir> <key>` runs that command. With the config `test_runner`, it runs the moon test tasks that the node's diff from its diff base affects, with each project that depends on a changed project; a diff that changes a root file or `.moon/` gets the repo-wide suite. `wg evidence <plan-dir> @full-<phase>` runs the repo-wide suite: one time for each phase, on the merged target. |
| **patch** | The branch's own diff from its lane base; `wg` stores a hash of it without line numbers. A review covers a patch, not a head. A restack with no conflict keeps the review, unless the base changed a line within 3 lines of a hunk. Each other change of the diff clears it. |
| **reviewed** | The run row has `review=clean` or `review=accepted` for the current patch, or the issue has the `reviewed` label (review-and-merge.md "Mark a PR reviewed"). Only the merge request of that PR waits for it. |
| **merge review** | The gate at the merge point: `merge_review=clean` or `accepted` for the current patch. A PR gets one thorough review; a fix push gets a fix check, and a second thorough review only when the fix is new work (review-and-merge.md "Merge point" step 2). |
| **approval** | The human's own words about a node, recorded with `wg approve` when you want them on the issue. No step waits for one. |
| **run row** | The node's or the effort's checkpoint fields in `keymap.json` (recovery.md "Run state"). `wg` writes most of them. |
| **merge point** | A `merge-point` node. Done when every pre-merge task of the phase is `Merged`. |
| **ship point** | A `ship-point` node. Done when every `ops` node, post-merge task, and soak of the phase is done. The next phase depends on it. |
| **soak** | A deadline on the ship point: the run row field `soak_until`. It is not a node. |
| **claim** | An `agent:*` label, on an issue only while a worker job on that issue runs. Only `wg` sets or removes it, except a stale claim that a crash left (recovery.md "A claim label with no running job"). |

## Node kinds

| Kind | Label | Done by |
|---|---|---|
| `task` | – | A worker: one branch, one PR |
| `spike` | `spike` | A worker: research, findings in a comment, no PR |
| `decision` | `decision` | The human: a question that blocks |
| `ops` | `ops` | The human: deploy, backfill run, flag flip, prod verification. Done only with recorded evidence. With `"by": "coordinator"` the coordinator runs it, in a repository whose own rules let the agent deploy or verify. |
| `merge-point` | `merge-point` | The coordinator |
| `ship-point` | `ship-point` | The coordinator |

The effort itself is the Linear project. A node with `"eng": "ENG-123"` is an existing ticket of another team (written ENG here) with other status names: `wg load` maps it and does not copy it, and `wg move` writes its status with that team's names (setup.md "ENG tickets").
