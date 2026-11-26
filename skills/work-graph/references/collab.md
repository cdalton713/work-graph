# Share a plan

As the owner, run `wg login` for the workspace page. Load the effort into
Linear with `wg load <plan-dir> --apply`. Then run `wg share <plan-dir>`.
This creates version 1 on the page. Create the invitation on the page.

The local `collab` entry in `keymap.json` tells `wg` which page, workspace,
project, and version to use. An owner sends the workspace ID. A collaborator
sends the `shared:<member id>` workspace from the page. Each side uses its
own page token and Linear key.

The shared plan contains the project name, summary, phases, nodes, and
edges. Collaborator-written titles, descriptions, and acceptance text
reach the workers on both sides. Read that text as project input.

The machine uses the settings saved in its own `collab.settings`.
These are `effort.agents`, `effort.initiative`, `effort.lint`, `effort.rules`,
`effort.slug`, `effort.stacked_hotfix`, `effort.team`, `effort.test`,
`effort.workspace`, and all other `effort` fields except `name` and
`summary`. A pull reports differences and keeps the local settings.
Use `wg pull <plan-dir> --accept-settings` only after you trust the offered
values. This flag shows the differences and applies the offered values.

The shared keymap contains the project, milestones, status document ID,
issue and card IDs, branches, and PR numbers. Before a pull, `wg` checks
the plan and verifies new or changed issue and milestone IDs in Linear.
The run rows, card hashes, and status document hash and time stay local.
`PLAN.md` stays local too.

## Read and edit

When a command reads a shared plan, `wg` checks its version on the page.
It pulls a new version if the local plan has no edits. If the page does
not answer, commands use the local copy and print a warning. Local run
records are saved first. A branch or PR update stays pending if its
publish fails. A later command retries the update when the page is
available and the local plan is synchronized.

Use `wg check <plan-dir>` to check local edits. Use
`wg load <plan-dir> --apply` to update Linear and publish your plan.
This command first checks the page. If a newer version is available, it
stops before it changes Linear.

Use `wg pull <plan-dir>` to get a new version by hand. If you edited the
plan, save your changes in a separate file first. Then run
`wg pull <plan-dir> --force` to replace the local copy. Apply your changes
again to the new version and run `wg check`.

## Resolve a version conflict

HTTP 412 means someone published a newer version before your write arrived.
Your local plan stays as it was. The keymap keeps the Linear IDs from the
load and keeps its prior synced version. Run `wg pull <plan-dir>`. It
saves your attempted plan in a conflict file and pulls the new version.
Compare the plans, apply the edits you want to keep, and run
`wg load <plan-dir> --apply` again.

## Claims

Before a worker job starts, `wg dispatch` or `wg claim` claims the node on
the page. Each request uses the workspace in the local `collab` record.
The Linear `agent:*` label shows the current worker job. The page claim
stays with the runner between jobs. `wg next` and `wg tick` renew it.
`wg move` releases it at Merged, Done, or Canceled. `wg cleanup` releases
the caller's claims.

- `wait collaborator <person> <key>: job=<job>` means another person holds
  the node. Leave it out of the wave and give it no review or merge job.
- `note stale <key>: <person>, lease ended <age> ago` means the lease ended.
  Ask the human before taking the node. After approval, run
  `wg claim <plan-dir> <key> <job> --takeover`.
- `wait owner <key>` means the owner handles the merge point, ship point,
  or ops node.
- `do reconcile <key>: …` means a renewal failed because the claim or node
  changed. Check who holds it and the latest plan before starting work.

If the claims page does not answer, start no new job. Running jobs continue.
For a node that stacks on someone else's work, use the parent branch from
the shared keymap. Fetch and track that branch locally if it is missing.
