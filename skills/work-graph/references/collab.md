# Share a plan

As the owner, run `wg login` for the workspace page. Load the effort into
Linear with `wg load <plan-dir> --apply`. Then run `wg share <plan-dir>`.
This creates version 1 on the page. Create the invitation on the page.

The local `collab` entry in `keymap.json` tells `wg` which page, workspace,
project, and version to use. An owner sends the workspace ID. A collaborator
sends the `shared:<member id>` workspace from the page. Each side uses its
own page token and tracks the hash of its last synchronized plan.

Both sides use the same `plan.json`. The shared part of the keymap contains
the project, milestones, status document ID, issue and card IDs, branches,
and PR numbers. The run rows, card hashes, and status document hash and time
stay local. `PLAN.md` stays local too.

## Read and edit

When a command reads a shared plan, `wg` checks its version on the page.
It pulls a new version if the local plan has no edits. If the page does
not answer, read-only commands use the local copy and print a warning.

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
Your local plan and keymap stay as they were. Linear can already contain
changes from the load. Save your edits, pull the new version, and compare
the two plans. Check Linear for changes from your first load. Apply the
edits you want to keep and run `wg load <plan-dir> --apply` again.
