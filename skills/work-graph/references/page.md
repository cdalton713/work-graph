# Work-graph page

## Data and links

The page reads Linear. It needs no plan directory. It groups the projects by configured workspace, each under its `name`. The overview groups the projects of each workspace by initiative (graph.md "Initiatives"), with a roll-up for each initiative; the projects with no initiative come last. The picker and the top bar name the initiative. It reads the kind, phase, lane, wave, next action, and reviews from each node card. It gets the PR link from the issue attachments. Work flows from top to bottom through the phase and lane boxes. The page hides an edge when a longer path gives the same order. Use **All edges** to show every edge.

- The top bar of a project has the **Autonomy** menu: `full`, `standard`, or `supervised` (autonomy.md). The overview shows the level of each project that has a label.
- Next to it is the **Review** menu for the review effort: `thorough`, `standard`, or `light` (review-and-merge.md "Review effort").
- `wg next` prints `note page <url>` for the effort. The URL uses `?project=<URL-encoded name>`. It includes `&workspace=<id>` for a plan of a workspace other than the first.
- `?initiative=<URL-encoded name>` opens the overview with only that initiative, in each workspace that has it.
- `wg move … "Needs <human>"` prints `page <url>` for one issue. The URL also has `&issue=<identifier>`.
- `wg ui [--workspace <id>] [--port N] [--project <name>] [--no-open] [--no-tailnet]` serves the page from the root of this repository (or `WG_UI_DIR`) at `http://127.0.0.1:4747` by default. It needs the key for the selected workspace. Start it in the background when the human asks or the hosted page is down. The first run installs and builds it in about 1 minute. If the port already serves the page, the command prints the address, opens it, and exits. Tailscale Serve gives it the address `https://<this machine>.<tailnet>.ts.net`. Use `--no-tailnet` to serve it only on this machine.

- **Share**: where the config of the workspace has `share_url`, the top bar of a project has a **Share** button. It sets the project label `shared`, and the read-only viewer at that address then shows the project to each account that may sign in there (the repository README "Host a read-only viewer"). The viewer changes nothing in Linear and sends the coordinator nothing. Do not paste secrets into issue text of a shared project.

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

[contract.json](../contract.json) has `version: 2`. Its `project_labels.initiative_group` names the project label group of the initiatives. `project_labels.autonomy_group`, `autonomy_levels`, and `autonomy_default` give the autonomy label group, its child labels, and the level with no label. `project_labels.review_group`, `review_prefix`, `review_levels`, and `review_default` give the same for the review effort: each child label is the prefix plus the level. Its `card.fields` includes `started_at`. Its `status_doc.fields` includes `ran`, `wait_interval`, and `contract`. For each `satisfied` entry, `clear` lists the statuses that clear the edge when the blocker is code done. `clear_without_code_done` lists the statuses that clear it when the blocker has no `code_done_head`.

1. After a contract change in the native CLI, run `wg contract --write`.
2. The page tests read the same file (`pnpm test` at the repository root). Change the page until they pass.
3. Deploy the page again where it is hosted (the repository README "Host the page"). Until then, the page says that its contract differs from `wg`.

## Link

`wg next` connects to the page server over a WebSocket (`/api/link`, protocol `wg-link/1`, `contract.json` `link`). The server is `WG_UI_URL`, the plan workspace's `page_url`, or the top-level `page_url`, in that order.

Set `WG_LINK_TOKEN` on the hosted server to require a bearer token on coordinator sockets. Use a secret
with at least 32 characters. On the coordinator's machine, run `wg login <page-url>` and enter the token.
See [Coordinator token](setup.md#coordinator-token) for the commands.

A workspace with its own page uses only its own token. For that workspace, `wg` checks
`WG_<ID>_LINK_TOKEN` and then the mode-600 file `<id>-link-token` in `~/.config/work-graph`.
Use uppercase and replace hyphens with underscores in the variable name. For a workspace
that uses the top-level page, `wg` checks `WG_LINK_TOKEN` and then the mode-600 file
`link-token` in the same directory. An empty environment variable disables the token.
If neither source exists, `wg` checks the token that `wg login` saved for the configured page.
An override from `WG_UI_URL` uses that saved token only if the origin matches the configured page.

`wg` sends tokens over HTTPS, to a loopback address, or to a tailnet address configured
as the page URL.
`wg` sends the token on the link, on the short connections for writes and agent state, and on HTTP requests
to the page. On a page with sign-in, the token permits API reads. The viewer's write limit still applies.
`wg doctor <plan-dir>` checks the plan's page and reports if it accepts the token.
`wg doctor` checks the top-level page. A 401 on the link gives one
`warn link:` line, and `wg next` polls Linear.

- `wg next` sends its status and lines, the open Orca questions of the effort's workers, and the job and test evidence of each node. The page shows the coordinator as `coordinator listening`, `coordinator working · <age>`, or `coordinator not listening · <age>`.
- The server sends `wg next` each change that the page makes, and each change in Linear for a project with a connected coordinator (about every 30 seconds). It also sends the human's answers, their replies to worker questions, and their commands: **Run wg next now**, **Dispatch**, **Pause**, **Resume**, and an **Autonomy** change (`command` `autonomy`, with `level`). The server sets the project label first; `wg next` reads it and prints `do autonomy`. A **Review** change sets the review label, then sends the command `next`: `wg next` reads the label and prints `do review`. "Lines from the page" below lists the lines.
- The server keeps the messages of each project until a `wg next` acknowledges them. Any number of coordinators of different projects can connect at the same time.
- Close code 4001 asks clients to reconnect. Close code 1012 signals a server restart. The page and
  `wg next --wait` make the first reconnect attempt at once. Repeated closes on sockets that lasted
  less than 10 seconds cause longer waits between attempts, up to 30 seconds. If the page server is
  still starting, `wg next --wait` makes short retries for up to 15 seconds before it warns.
  The page keeps its display while it reconnects and checks the project graph when it rejoins.
  The coordinator sends hello and its last state, asks, and progress again. The server sends the
  unacknowledged queue again.
- With `WG_LINK_MAX_AGE` set, the server allows 15 seconds for the same coordinator session to
  reconnect. The page and the presence API still show the coordinator as connected during that time.
  The same rule applies across instances that share Redis. If the session does not return, its
  last-seen time is the time the socket closed.
- Linear stays the record. An answer and a reply are comments on the issue. A dispatch is a comment on the issue. An answer also gets the issue label `answered`, so `wg next` finds it after a server restart. Pause is the project label `paused`. The server's queue is in memory and only wakes `wg next` sooner.
- Without the link (no server, no `websockets` package, or `WG_LINK=off`), `wg next` prints one `warn link:` line and polls Linear.

<!-- explain: answer,relay,replied,autonomy,paused,resumed -->
### Lines from the page

The link gives these lines. The server keeps each message until `wg next` prints its line, so a message that comes while you work is in your next `wg next`.

| Line | Do this |
|---|---|
| `do answer <key> <issue>: <text>` | The human answered on the page. The full text is their comment on the issue, which has the label `answered`. Act on it as their answer: for a `decision` node, `wg move <plan-dir> <key> Done --note "<answer>"`; for a worker's question, send it to the worker and `wg move` the issue out of `Needs <human>`. The line comes back at each `wg next` until a `wg move` of the issue removes the label. |
| `do dispatch <key> <issue>: …` | The human asked for this dispatch. Run jobs.md "Dispatch". |
| `do relay <key> <issue>: …` | `wg next` could not send the human's reply to the worker. Send it with `orca orchestration reply --id <ask>`. |
| `note replied <key> <issue>: …` | `wg next` sent the human's reply to the worker with `orca orchestration reply`. Do nothing. |
| `do autonomy @effort -: …` | The human changed the autonomy level on the page or in Linear. Act at the new level from now on (autonomy.md), and say the change in your status line. `note autonomy @effort -: <level>` is the level when it did not change. |
| `wait paused @effort -: …` | The human paused the effort on the page (the project label `paused`). Start no job and move no status until the line goes; `wg next` holds each `do` line until they resume. |
| `do resumed @effort -: …` | The human resumed the effort. Say so in your next status line, then act on the other lines. `wg next` prints it once, so `wg next --wait` wakes even when every other line is a wait. |
<!-- /explain -->

The human can reply to a worker's Orca question on the page. You still answer a question that they did not answer.

A `wg next --wait` that runs in the background stays connected and takes the queued page commands. To check the queue yourself (for example after a deploy of the page), stop that process first.

## Scheduled page refresh

`wg tick` refreshes the Linear page for each loaded effort every time it runs.
It skips an effort while its coordinator listens and after it publishes the
complete result. The tick makes only page updates in Linear. The `none`
channel stores the “Your move” list locally and sends no notices. The
`notify` channel is the default when the config has the field `notify`
(README "Notices"). It sends one notice through each configured channel
when the human's moves have a new entry. `wg next` sends the same notice.
For the scheduled tick, put a webhook URL in a mode-600 file (`url_file`):
launchd does not give the tick your shell environment.

1. Run `wg tick --install`. Use a copy of the skill at a permanent path.
2. Put the Linear keys in the private files named in the output. Set each file's
   mode to 600.
3. Run the printed `launchctl bootstrap` command. The agent runs at load and
   at minutes 0, 15, 30, and 45. See `~/Library/Logs/wg-tick/` for the logs.

To remove the schedule, run `wg tick --uninstall` and run the printed
`launchctl bootout` command.

## The agents on the page

`wg agents` runs on the human's machine, not in a coordinator. It reads Orca each 10 seconds and sends the link
message `agents` for each loaded effort: the state and the last message of the coordinator agent and of each
worker agent (README "The agents on the page"). The page shows them on the Overview and counts an agent that
stopped at a prompt (`blocked` or `waiting` in Orca) as a move of the human's. A coordinator does not run
`wg agents` and does not read its rows. `wg doctor` reports when the Orca plugin of `wg agents` (`wg agents --install`) is missing or old.

Set `agent_replies: true` in the `wg` config to let a project owner send replies to an idle
chat or terminal agent (Orca state `done`). The default is off. Replies need the sender in an Orca terminal:
the Orca plugin of `wg agents --install` runs it there. `wg doctor` reports the switch and warns when
neither the plugin nor the current session can take replies.

The page sends at most 4,000 characters to `POST /api/projects/:id/agents/:agent/reply`.
The server queues the reply for the watcher that published the rows. A queued reply expires
after two minutes if the watcher did not take it. Use Orca directly to answer an agent at a prompt (Orca states
`waiting` or `blocked`).

Before it sends, the watcher checks the agent and its state in Orca again. This check is
best effort. Orca can change the state between the check and the send. Mail waits for a
running turn to end. A delivered result gives the Orca mail id and confirms that Orca
stored the mail. It does not confirm that the agent read it. If delivery is unconfirmed, check Orca before you reply again. The watcher adds
`Reply to the agent: …` to a worker's issue when Orca accepts the mail. A coordinator
reply has no issue comment.
