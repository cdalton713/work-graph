# Work-graph page

## Data and links

The page reads Linear. It needs no plan directory. It groups the projects by configured workspace, each under its `name`. The overview groups the projects of each workspace by initiative (SKILL.md "Initiatives"), with a roll-up for each initiative; the projects with no initiative come last. The picker and the top bar name the initiative. It reads the kind, phase, lane, wave, next action, and reviews from each node card. It gets the PR link from the issue attachments. Work flows from top to bottom through the phase and lane boxes. The page hides an edge when a longer path gives the same order. Use **All edges** to show every edge.

- The top bar of a project has the **Autonomy** menu: `full`, `standard`, or `supervised` (SKILL.md "Autonomy level"). The overview shows the level of each project that has a label.
- `wg next` prints `note page <url>` for the effort. The URL uses `?project=<URL-encoded name>`. It includes `&workspace=<id>` for a plan of a workspace other than the first.
- `?initiative=<URL-encoded name>` opens the overview with only that initiative, in each workspace that has it.
- `wg move … "Needs <human>"` prints `page <url>` for one issue. The URL also has `&issue=<identifier>`.
- `wg ui [--workspace <id>] [--port N] [--project <name>] [--no-open] [--no-tailnet]` serves the page from the root of this repository (or `WG_UI_DIR`) at `http://127.0.0.1:4747` by default. It needs the key for the selected workspace. Start it in the background when the human asks or the hosted page is down. The first run installs and builds it in about 1 minute. If the port already serves the page, the command prints the address, opens it, and exits. Tailscale Serve gives it the address `https://<this machine>.<tailnet>.ts.net`. Use `--no-tailnet` to serve it only on this machine.

## Edits

The human can edit the description, status, priority, assignee, and labels, or add a comment. They can add or remove the `reviewed` label for the wave review and merge review. `plan.json` defines the graph and node titles. The graph, issue titles, claim labels, kind labels, and ENG nodes are read-only. The page requires a note to set an `ops` or `decision` node to `Done`.

### After an edit

Treat a status change on the page the same as a status change in Linear. The page writes directly to Linear. It does not run the checks of `wg move` or move any other node. Run `wg next <plan-dir>` to read the change, and `wg ready <plan-dir> --apply` after a status change to update `Todo` and `Ready`. If the human set an `ops` or `decision` node to `Done` in Linear without an `Evidence:` or `Answer:` comment, ask them for it and add it to the issue. For wake conditions, see [Wait](coordinator.md#wait).

## Contract

The `work-graph status` document gives the status, wave, and result lines. Its `at` is the UTC time of the last result change. The contract adds these fields.

- `ran` is the UTC time of the last `wg next` run that published, in `YYYY-MM-DDTHH:MM:SSZ` format.
- `wait_interval` is a number in seconds, present only with `wg next --wait`. The page shows `listening` while `now - ran < 2 * wait_interval`. Otherwise it shows `last ran <age>`.
- `contract` is the first 12 hex characters of the SHA-256 of the `contract.json` text from `contract_text()`.
- The node card has `started_at` only in `creating`, `starting`, or `running`. It is the UTC time that `wg started` records for the current job.

[contract.json](../contract.json) has `version: 2`. Its `project_labels.initiative_group` names the project label group of the initiatives. `project_labels.autonomy_group`, `autonomy_levels`, and `autonomy_default` give the autonomy label group, its child labels, and the level with no label. Its `card.fields` includes `started_at`. Its `status_doc.fields` includes `ran`, `wait_interval`, and `contract`. For each `satisfied` entry, `clear` lists the statuses that clear the edge when the blocker is code done. `clear_without_code_done` lists the statuses that clear it when the blocker has no `code_done_head`.

1. After a contract change in `wg.py`, run `wg contract --write`.
2. The page tests read the same file (`pnpm test` at the repository root). Change the page until they pass.
3. Deploy the page again where it is hosted (the repository README "Host the page"). Until then, the page says that its contract differs from `wg`.

## Link

`wg next` connects to the page server over a WebSocket (`/api/link`, protocol `wg-link/1`, `contract.json` `link`). The server is `WG_UI_URL`, or the hosted page.

- `wg next` sends its status and lines, the open Orca questions of the effort's workers, and the job and test evidence of each node. The page shows the coordinator as `coordinator listening`, `coordinator working · <age>`, or `coordinator not listening · <age>`.
- The server sends `wg next` each change that the page makes, and each change in Linear for a project with a connected coordinator (about every 30 seconds). It also sends the human's answers, their replies to worker questions, and their commands: **Run wg next now**, **Dispatch**, **Pause**, **Resume**, and an **Autonomy** change (`command` `autonomy`, with `level`). The server sets the project label first; `wg next` reads it and prints `do autonomy`. coordinator.md "Lines from the page" lists the lines.
- The server keeps the messages of each project until a `wg next` acknowledges them. Any number of coordinators of different projects can connect at the same time.
- Linear stays the record. An answer and a reply are comments on the issue. A dispatch is a comment on the issue. An answer also gets the issue label `answered`, so `wg next` finds it after a server restart. Pause is the project label `paused`. The server's queue is in memory and only wakes `wg next` sooner.
- Without the link (no server, no `websockets` package, or `WG_LINK=off`), `wg next` prints one `warn link:` line and polls Linear.

## Scheduled page refresh

`wg tick` refreshes the Linear page for each loaded effort every time it runs.
It skips an effort while its coordinator listens and after it publishes the
complete result. The tick makes only page updates in Linear. The `none`
channel stores the “Your move” list locally and sends no notices.

1. Run `wg tick --install`. Use a copy of the skill at a permanent path.
2. Put the Linear keys in the private files named in the output. Set each file's
   mode to 600.
3. Run the printed `launchctl bootstrap` command. The agent runs at load and
   at minutes 0, 15, 30, and 45. See `~/Library/Logs/wg-tick/` for the logs.

To remove the schedule, run `wg tick --uninstall` and run the printed
`launchctl bootout` command.
