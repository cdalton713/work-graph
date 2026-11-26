# Share a plan

See [Share a project](../../../README.md#share-a-project) for roles, links,
Linear access, and limits.

## Publish the first version

As the owner, run `wg login <page-url>` and set the workspace's `page_url`
in the local config. Set `effort.team` in the plan. Run
`wg load <plan-dir> --apply`, then `wg share <plan-dir>` to publish version 1.

## Join as a collaborator

1. Open the **Collab link** in a browser, sign in, and press **Join**.
2. Make a coordinator token in **Settings**. Run `wg login <page-url>` and paste
   your token at the prompt. Use the page address in CLI commands. For a
   **Collab link**, `wg join` says to open it in a browser.
3. Set the local config's `human` to your display name on the page. Run
   `wg join <page-url>` in your checkout. Use `--repo <path>` to select a
   checkout and `--project <name-or-id>` to select one of several shared projects.
   Use the printed `shared:<id>` when two projects have the same name.
   A viewer needs a **Collab link** to run `wg join`.
4. If `wg join` asks for a Linear key, follow the printed config and key
   instructions. Use your own key. If the key cannot read the team, use
   **Request access** at the page address that the command prints. Run
   `wg join` again after you get access.
5. In Orca, `wg join` creates the coordinator worktree or uses an existing
   clean worktree without plan files. Outside Orca, follow the printed
   instructions if you need to create it. The command pulls the plan and
   keymap, writes a local heading, and prints the first `wg next` result
   when preflight passes. Set up test commands and other machine settings
   for your checkout.

Run `wg leave <plan-dir>` to remove the local collaboration record. The
command tries to release your claims and warns if it cannot. Any claims
it leaves expire at the end of their leases. Ask the owner to remove your membership in **Share**.

## Shared and local data

The local `collab` entry in `keymap.json` tells `wg` which page, workspace,
project, and version to use. An owner sends the workspace ID. A collaborator
sends the `shared:<member id>` workspace from the page. Each side uses its
own page token and Linear key.

A publish sends the full plan, including the writer's other `effort`
fields such as the test command, lint, rules, agents, and team. The
service stores them. Every member, including a viewer, can read the
current plan. Keep secrets out of `plan.json`.

Collaborator-written titles, descriptions, and acceptance text reach the
workers on both sides. Read that text as project input.

Of the `effort` fields, a pull takes the project name and summary. Each
machine keeps its other fields in `collab.settings`, including the test
command, lint, rules, agents, and workspace. A pull reports differences.
Use `wg pull <plan-dir> --accept-settings` only if you trust the offered
values. The flag shows the differences and applies the offered values.

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

`wg dispatch` checks the local prerequisites before it claims the node on
the page. It claims the node before it starts the worker. If dispatch
fails after the claim request, it attempts to release the claim. A follow-up `wg claim` checks that the account still holds the
node. Each request uses the workspace in the local `collab` record.
The Linear `agent:*` label shows the current worker job. The page claim
stays with the runner between jobs. `wg next` and `wg tick` renew it when
this machine has a run row. `wg started`, `wg done`, and moves to Ready
to Merge or Merged check ownership before they act. For example,
`wg done` refuses if another person holds the node.
`wg move` releases it at Merged, Done, or Canceled. `wg cleanup` releases
the caller's claims.

- `wait collaborator <person> <key>: job=<job>` means another person holds
  the node. Leave it out of the wave and give it no review or merge job.
- `note stale <key>: <person>, lease ended <age> ago` means the lease ended.
  Ask the human before taking the node. After approval, run
  `wg claim <plan-dir> <key> <job> --takeover`.
- `wait owner <key>` means the owner handles the merge point, ship point,
  ops node, or decision node.
- `do reconcile <key>: …` means this machine lost the claim, the node
  changed, or the account holds a claim with no local job. Check the holder,
  the local run row, and the latest plan before starting work.

If the claims page does not answer, start no new job. Running jobs continue.
For a node that stacks on someone else's work, use the parent branch from
the shared keymap. Fetch and track that branch locally if it is missing.

## Who answers

The runner is the person whose account holds the node claim. Their
account receives answers for the node, and they handle its merge request.
The owner handles project triage.

Run `wg doctor <plan-dir>` to check the name in your claims or in the
page status. A different name makes this check fail. If the page does
not answer or does not have a name to check, doctor prints a warning.
Each runner needs their own
`Needs <name>` status in the project's Linear team. Run
`wg setup --workspace <id> --apply` for that workspace if preflight
reports that the status is missing.

`wg next` prints `wait human` for work that waits on your side.
`note human <key>: waits on <person>` means another person must act.
Leave that node to its runner. If the page sends your coordinator that
node's answer or reply, it acknowledges the message and skips it.
The owner handles answers and replies for unclaimed nodes and issues
outside the plan. A collaborator acknowledges and skips those messages.
