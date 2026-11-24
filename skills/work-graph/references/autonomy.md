# Autonomy level

<!-- explain: autonomy -->
The level is a label of the Linear project: one child of the single-select project label group `autonomy` (`full`, `standard`, or `supervised`). No label means `standard`. `wg autonomy <plan-dir>` prints the level; `wg autonomy <plan-dir> <level>` sets it.

A run is one coordinator session of the effort: the first `/work-graph` request, or a new session that resumes it. At the start of each run, before step 0 or the first `wg next`, ask the human which level this run uses. Use `AskUserQuestion` with the three levels below, and put the current level (`wg autonomy <plan-dir>`) first, marked "(current)". In the same call, ask for the review effort (review-and-merge.md "Review effort"). Do not ask when their request for this run already names a level, when `wg autostart` started the run (setup.md "Autostart"), or when the session runs in the background: there, use the current level. After this one question, the loop never waits on a prompt (coordinator.md "Never block on a prompt"). Then record it: `wg autonomy <plan-dir> <level>` (before step 2, `<plan-dir>` has no `keymap.json` yet: keep the level and record it right after `wg load --apply`). Say the level in the first status line of the run.

The human can change the level at any time on the page (the **Autonomy** menu of the project) or in Linear. `wg next` reads the label each time. Its first line is `note autonomy @effort -: <level>`. When the level changed since your last `wg next`, that line is `do autonomy @effort -: The human set the autonomy level to <new> (was <old>)…` instead, and a `wg next --wait` wakes for it. The new level takes effect at once: from that step on, ask for, or do yourself, what the table gives the new level. Say the change in your next status line. A level change that the human gives in this session: record it with `wg autonomy <plan-dir> <level>`.

| Level | The human does | The coordinator also does |
|---|---|---|
| `full` | `ops` nodes. Merges and deploys in repositories where agents may not merge. | Answers each `decision` node, each `do triage` line, and each review hold after 2 rounds itself, and records each choice on the issue. Merges each PR in a repository where agents may merge. Never waits for the human's review. |
| `standard` | Merges, deploys, `ops` nodes, `decision` nodes, triage, review holds after 2 rounds. | The rest, as these steps say. This is the default when no level is recorded. |
| `supervised` | All of `standard`, plus: approves the graph before `wg load --apply`, each wave before its first dispatch, and each PR with the `reviewed` label before its merge request. | Asks once for each gate, and waits for their answer. Other nodes continue. |

Level `full`:

- **Where agents may merge.** Only a repository whose rules let agents merge: the local rules file or the repository's own agent instructions say so. Everywhere else the human always merges and deploys; at `ask-merge`, ask them as at `standard`. No level lets an agent deploy, run an `ops` node without `"by": "coordinator"`, push to `main` or the release branch directly, or bypass a `wg` check.
- **Merge.** At `ask-merge <key> #<n>`: `wg move <plan-dir> <key> "Ready to Merge"`, then `gh pr merge <n> --squash` (`--merge` for a SYNC PR), then the `merged` line as usual. Merge bottom to top in each lane, one PR at a time.
- **Decisions.** At `ask <decision key>`: decide from the plan, the issue, and the code. Then `wg move <plan-dir> <key> Done --note "autonomy=full, coordinator's choice: <answer>; reason: <reason>"`. A decision that is hard to reverse (a public or persistent contract, data loss, a cost) still goes to the human.
- **Review holds.** After 2 blocking rounds: send one more fix (`wg claim <plan-dir> <key> review`), or accept with `wg run set <plan-dir> <key> review=accepted` and an issue comment that names each accepted finding and why. Never add the `reviewed` label; it stays the human's.
- **Triage.** Adopt the issue through recovery.md "Replan", or move it to `Backlog`, and comment the reason.
- Report each choice in the status line, so the human can undo it.

Level `supervised`: show the gate's content (the flowchart and phase table, the wave keys with each node's acceptance, or the PR) and wait (coordinator.md "Wait"). Record their approval with `wg approve` when they give words to keep.
<!-- /explain -->
