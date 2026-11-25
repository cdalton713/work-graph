# work-graph

Plan and run a large multi-PR effort (a migration, a rewrite, a platform change) as a dependency graph in
Linear. Coding agents do the work in parallel lanes, and a coordinator agent follows the graph. This repository
holds two parts:

- `skills/work-graph/`: the agent skill. `SKILL.md` tells a coding agent (Claude Code, Codex) how to plan
  and coordinate an effort. `scripts/wg.py` (the `wg` command) holds the rules that must not slip: it checks
  the graph, syncs it to Linear, takes and releases claims, checks that a PR is code done, guards each status
  change, and prints the next action.
- The page (`src/`, `server/`): a web app that shows each effort as a graph of its nodes (phases, lanes, merge
  and ship points), with an issue panel to edit and comment, and a live link to the coordinator.

The skill expects these tools: [Linear](https://linear.app), the GitHub CLI (`gh`),
[stax](https://github.com/cesarferreira/stax) (`st`) for stacked branches, [Orca](https://github.com/stablyai/orca)
for worker agents and worktrees, and [uv](https://docs.astral.sh/uv/) to run `wg`. The page needs Node 24 and pnpm.

Each user who runs an effort needs access to Linear and these tools on their own machine,
including an agent CLI (Claude Code or Codex). A hosted deployment serves only the page and its API.

## Install the skill

```sh
git clone https://github.com/cdalton713/work-graph.git ~/Projects/work-graph
ln -s ~/Projects/work-graph/skills/work-graph ~/.claude/skills/work-graph   # or your agent's skills folder
ln -s ~/Projects/work-graph/skills/work-graph/scripts/wg.py ~/.local/bin/wg
wg config                                                                    # what wg will use
wg doctor                                                                    # one ok, warn, or FAIL line per check
```

`wg doctor` checks this machine and changes nothing: the Python version, the `websockets` package, that `wg` on
PATH and each skill link point at one checkout and that checkout is not behind its `origin/main`, each workspace
key (present, mode 600, accepted by Linear) with the request budget that is left, `gh auth`, `st`, the Orca CLI,
the page server (`/healthz`, and the contract of `/api/config`), the `tick`, `autostart`, and `health` schedules, and
the session settings of each loaded effort's core worktree (config `coordinator_settings` and `context_limit`).
`wg doctor --fix` writes those settings; it changes nothing else.
`wg doctor <plan-dir>` also checks that effort: `wg check`, `keymap.json` against Linear (an issue that is gone, a
claim label with no live job, a job start that is stuck for more than 30 minutes, a status that the run row
contradicts), each worktree path of the run rows, and the link (connect, `hello`, close). It exits 1 on a `FAIL`.

## Config

`wg` and the page server read `~/.config/work-graph/config.json` (or the file `WG_CONFIG`; the server also takes
the text in `WG_CONFIG_JSON`). Without a file, there is one Linear workspace with `LINEAR_API_KEY`, the human is
"Human", there is no hosted page, and each plan needs `effort.test`. Every field is optional:

```json
{
  "human": "Ada",
  "page_url": "https://wg.example.com",
  "branch_prefix": "wg/",
  "release_branch": "release",
  "rules": "~/.config/work-graph/rules.md",
  "github_user": "ada",
  "tick_label": "dev.work-graph.tick",
  "tick_roots": ["~/Projects"],
  "health_interval": 6,
  "health_agent": "codex",
  "context_limit": 250000,
  "notify": [
    {"type": "webhook", "url_env": "WG_NOTIFY_URL", "url_file": "~/.config/work-graph/notify-url"},
    {"type": "command", "argv": ["/usr/local/bin/my-notifier", "--title", "work-graph"]}
  ],
  "test_runner": {
    "run": ["./node_modules/.bin/test-runner", "run", "--"],
    "suite": [":test"],
    "options": ["--concurrency", "7"],
    "lint": ["moon", "run", ":lint", "--affected", "--base", "{lower}"],
    "commit_marker": "testing ([0-9a-f]{10})"
  },
  "worker_settings": {
    "claude": {"enabledPlugins": {"some-plugin@some-marketplace": false}, "permissions": {"deny": ["Agent"]}},
    "codex": {"features": {"apps": false}, "agents": {"enabled": false}}
  },
  "workspaces": [
    {"id": "work", "name": "Work", "team": "ENG", "key_env": ["LINEAR_API_KEY"], "share_url": "https://view.example.com"},
    {"id": "home", "name": "Home", "team": "HOME", "teams": ["HOME"], "key_env": [], "team_labels": false}
  ]
}
```

| Field | Meaning |
|---|---|
| `human` | The person who answers, merges, and deploys. Their wait status is `Needs <human>` (`Needs Ada`), and its label on another team's ticket is `needs-<slug>` (`needs-ada`). |
| `page_url` | The hosted page. `wg next` prints links to it. Default: `http://127.0.0.1:4747` (`wg ui`). |
| `branch_prefix` | The prefix of each branch that `wg` names (`wg/<slug>-core`). |
| `release_branch` | The target of a HOTFIX/SYNC phase (`skills/work-graph/references/ordering.md`). |
| `rules` | A Markdown file of your own rules: your workspaces, the repositories where agents may merge, freeze rules. The skill tells the agent to read it. |
| `github_user` | The `gh` login that `wg tick --install` requires for the scheduled job. |
| `agent_merge` | The GitHub owners (`ada`) or repositories (`ada/tool`) where agents may merge. At autonomy level `full` there, `wg next` prints `do merge` in place of `ask-merge`: the merge is the coordinator's step, not the human's move. Default: none. |
| `context_limit` | The context size in tokens at which Claude Code compacts a coordinator session. `wg load --apply` and `wg doctor --fix` write it as `autoCompactWindow` into `.claude/settings.local.json` of the core worktree. They write it as `worker_settings` does: the other keys of the file stay, the file stays out of git, and `wg` writes through no symlink. `wg doctor --fix` writes only into the plan directory of a loaded effort. Claude Code reads the file when a session starts, and takes no value below 100000. `wg next` prints a `note context` line when its session is over the limit. `0` turns this off. Default: 250000. |
| `coordinator_settings` | The session settings of the coordinator, per agent, in the shape of `worker_settings` and with its merge rules. `wg load --apply` and `wg doctor --fix` merge them into the core worktree's `.claude/settings.local.json` and `.codex/config.toml`, in the same step as `context_limit`, and `wg doctor` reports a core worktree whose files do not have the values. A `context_limit` that is not 0 wins over an `autoCompactWindow` in `coordinator_settings.claude`. A coordinator needs more than a worker (`skills/work-graph/references/setup.md` "Worker sessions"). Default: none, and `wg` writes no file for it. |
| `tick_label`, `tick_roots` | The launchd label of `wg tick --install`, and the folders where `wg tick` looks for `*-core/plan.json`. |
| `notify` | The channels that tell `human` that a move is theirs (see "Notices" below). Default: none. |
| `health_interval`, `health_agent` | The status check (`wg health`, `skills/work-graph/references/health.md`): the hours from one check to the next (1 to 168, default 6), and the Orca agent that does the check (default `codex`). |
| `test_runner` | The default test command of `wg evidence`. A node runs the moon test tasks that its diff affects; `@full-<phase>` runs `suite`. `commit_marker` is a regular expression for the line where the runner prints the commit it tests; without it, the exit code is the proof. `lint` is the lint command of the worker spec's push checks, as a list of arguments; each `{lower}` is the node's diff base. Without it, the spec has no lint step. A plan's `effort.lint` replaces it, and a plan with `effort.test` does not use it (`skills/work-graph/references/graph.md`). |
| `worker_settings` | The session settings of a worker, per agent. Before a worker starts in a worktree, `wg dispatch` and `wg claim` merge `claude` into the worktree's `.claude/settings.local.json` and `codex` into its `.codex/config.toml` (as TOML). The merge keeps the other keys of a file that exists. A value of the config replaces a value of a different type in the file (a `false` replaces a table), and a list gets the config's items that it does not have yet, each one time. `wg` adds the file to the repository's `.git/info/exclude`, so the tree stays clean. It does not change a file that git tracks, a symlink, or a file that a `.gitignore` rule keeps in `git status`; it prints one line and the dispatch continues. Codex reads `.codex/config.toml` only in a project that it trusts. Use it to turn off what a worker does not need (plugins, MCP servers, tools, skills), so that each worker starts with less context. Default: none, and `wg` writes no file (`skills/work-graph/references/setup.md` "Worker sessions"). |
| `workspaces` | The Linear workspaces. The first is the default. `team` is the default team of a plan; `teams` limits a workspace to those teams; `team_labels: false` makes project labels workspace labels (Linear's team project labels need the Business plan). `share_url` is the address of the read-only viewer of the workspace: with it, the page has a **Share** button on each project ("Host a read-only viewer"). |
| `workspaces[].page_url` | The page for plans in this workspace. It defaults to the top-level `page_url`. `WG_UI_URL` overrides both. |
| `auth` | Only in the config of a read-only viewer or a full page with owners: `{"domains": ["example.com"]}` names the Google Workspace domains whose accounts may sign in ("Host a read-only viewer"). `wg` does not read it. |
| `auth.owners` | The emails of owners on a hosted page with sign-in. See "Give owners and viewers access on one hosted page". |

A workspace's key comes from `LINEAR_<ID>_API_KEY`, then the `key_env` names, then the private file
`~/.config/work-graph/<id>-linear-api-key` (mode 600). Keys never go in the config.

### Notices

`wg next` (also with `--wait`) and `wg tick` send one notice when the human's moves have a new entry. An entry is
a `wait human` line, a `do ask` line (also `ask-ready` and `ask-merge`), an open worker question, or a worker escalation that no coordinator read. The notice has
one line for each new entry and the page link. `wg next` prints its result first and then sends. The run row field
`notified_<n>` of `@effort` holds the entries that channel `<n>` (0 is the first) got. An entry is not sent again to
a channel while it stays. An entry that goes away and comes back is sent again. A
paused effort sends nothing.

Each channel of `notify` is one of these:

- `{"type": "webhook", "url_env": "…", "url_file": "…"}`: one HTTP POST with the JSON body
  `{"title", "body", "url", "text"}`. `text` holds the full notice, for a Slack-compatible incoming webhook. For a
  plain ntfy topic URL, the headers `X-Template`, `X-Title`, and `X-Message` make ntfy show the title and the body.
  The URL comes from the environment variable `url_env`, else from the file `url_file` (mode 600). The URL never
  goes in the config, and `wg` never prints it: a failure shows only the HTTP status or the error type. The scheduled `wg tick` has no shell environment: use `url_file`.
- `{"type": "command", "argv": […]}`: `wg` runs the command with the notice text on stdin. A non-zero exit is a
  failure; `wg` shows its exit code, not its output.

All channels of one notice together have 5 seconds. The failures of one run print one `warn notify:` line. A
channel that failed tries again at a later run, at most once every 5 minutes (`notify_failed_<n>`); the other
channels are not sent the same entries again. With `notify`, the default channel of `wg tick` is `notify`; without
it, the default is `none`, which sends no notices. `wg tick --install --channel <name>` keeps that channel for the
scheduled tick; without `--channel`, each tick uses the default of the config.

### The agents on the page

`wg agents` reads Orca each 10 seconds (`orca agent list`) and sends the agents of each loaded effort to the page:
the agents in the plan directory (the coordinator) and in the worktree of each run row (the workers). For each
agent, the page gets its state, its title, and its last message as one line of at most 500 characters. The
Overview shows one line for each agent below its project. An agent that Orca reports as `blocked` or `waiting`
stopped at a prompt: it counts as a move of the human's, and it sends one notice through the `notify` channels
when it waits for two reads in sequence. The message text goes to the page server, so do not use `wg agents` with
a page that other people can read.

`wg agents --once` does one read and prints the rows. `wg agents --install` writes a launchd agent that keeps
`wg agents` running; run the printed `launchctl bootstrap` command to load it. Logs: `~/Library/Logs/wg-agents/`.
When no report came for 3 minutes, the page shows "agent view stopped". `wg agents --uninstall` removes the agent.

In a workspace on Linear's Free plan (250 issues; archived issues do not count), `wg` archives each completed and
canceled issue of the workspace at each `wg move` to Done or Canceled and at each `wg tick`. `wg archive <dir>`
shows the list; `--apply` archives it. `wg` and the page read archived issues and their relations.

Each Linear team of a plan needs the statuses Triage, Backlog, Todo, Ready, In Progress, `Needs <human>`,
In Review, Ready to Merge, Merged, Verifying, Done, Canceled, and Duplicate
(`skills/work-graph/references/setup.md`).

### Token use

`wg usage <plan-dir>` prints how many tokens the sessions of one effort used. It reads the session transcripts
of Claude Code (`~/.claude/projects`, or `CLAUDE_CONFIG_DIR`) and Codex (`~/.codex/sessions`, or `CODEX_HOME`) of
the plan directory and of each worktree that a run row or the journal records, also a worktree that was removed.
A session that starts with the worker preamble is a `worker`. A session in the plan directory that ran `wg next`
or loaded the work-graph skill is the `coordinator`. Each other session (a session of the human, or a short
utility session for a chat name, a branch name, or a commit message) is `other`. A session that records the cwd
of another folder does not count. Each line shows the role,
the node key, the agent, the model, the calls, the input tokens (fresh, cache write, cache read), the output
tokens, the largest context, the start size (the context of the first call), and the first and last time. Then
come the totals per role and one grand total. It prints the 15 largest sessions; `--all` prints each one.
`--json` gives exact integers, and `--since <2h|3d|UTC time>` counts only the calls after that time. It makes no
Linear, GitHub, or Orca call and writes nothing.

## Run the page on this machine

`wg ui` builds and starts it from this repository (or from `WG_UI_DIR`). By hand:

```sh
pnpm install
pnpm build
LINEAR_API_KEY=... node server/main.ts      # http://127.0.0.1:4747
pnpm test
```

`node server/main.ts --team <key>` gives a team to a workspace that has none in the config. The server also puts
the page on your tailnet with Tailscale Serve while it runs; `--no-tailnet` keeps it on this machine. Keys stay in
the server. Every graph, edit, comment, and cache is scoped to its workspace.

The server sends at most 6 Linear requests at the same time. It tries a query again, at most 3 tries, after a
network error, a timeout, HTTP 429, HTTP 5xx, or Linear's `RATELIMITED` error. It tries a mutation again only after
HTTP 429 or `RATELIMITED`, because Linear can have applied a mutation that timed out.

## Host the page

**What a host does not do.** The host serves only the page and its API. The coordinator and
workers run on the user's machine. Each user who runs an effort needs access to Linear and
local copies of `gh`, `st`, Orca, `uv`, and an agent CLI (Claude Code or Codex).

The `Dockerfile` builds the page and its server. Run the container behind a proxy that serves HTTPS, and set:

- `WG_HOSTED`: the name that the page answers under (`wg.example.com`). The API refuses requests for another
  host name, and a write needs the exact HTTPS origin and a JSON body.
- `WG_CONFIG_JSON`: the config text (at least `human` and `workspaces`).
- The Linear key of each workspace (`LINEAR_API_KEY`, or the names in `key_env`).
- `WG_LINK_TOKEN`: a shared secret of at least 32 characters. Set it on a hosted server that has a
  coordinator link. Give each coordinator the same value in `WG_LINK_TOKEN` or in
  `~/.config/work-graph/link-token` with mode 600. Use HTTPS for the hosted URL. Run `wg doctor` to check it.
  An empty value on the server leaves token checks off. `wg` sends the token only over HTTPS or to
  a loopback address (`127.0.0.1`, `localhost`, or `::1`).
  For a workspace with its own `page_url`, set the client token in `WG_<ID>_LINK_TOKEN` or in
  `~/.config/work-graph/<id>-link-token` with mode 600. Use uppercase and replace hyphens with
  underscores in the environment variable. The workspace uses only its own token, even when its
  address equals the top-level `page_url`. When you set `WG_UI_URL`, `wg` sends the selected token
  to the override address.
- `WG_STATE_DIR` (optional): a directory where the link keeps the queue of each project and the open worker
  questions over a restart. Without it, a restart loses them: a reply or a command that a coordinator did not get
  yet does not arrive. The server writes one file, `link-state.json` (mode 600), at most 1 s after a change, and
  reads it at start. Give the directory a volume, so that the file stays when the container changes. Put the
  directory outside the built page (`dist`): the server refuses a state directory there and keeps the state in
  memory only. If the server cannot write the file, it logs the error and exits with code 1 at a stop, and after
  the restart a coordinator can get a message again that it acknowledged.

- `WG_REDIS_URL` (optional): the secret URL of the Redis server (`redis://` or `rediss://`).
  Set the same URL on each instance when more than one instance serves the full page.
  Redis keeps the link state and queue for all instances. When you set the URL, the server ignores
  `WG_STATE_DIR`. Use a standalone Redis server with persistence if the queue must survive a Redis restart.
  The client uses scripts with more than one key. Redis Cluster is unsupported.
  If Redis goes down, the link closes its sockets and refuses new sockets until Redis is back.
  The server tries again automatically, and the coordinator polls Linear while the link is down.
  The page and read API stay available. During an outage, a signed-in cookie can still read
  unless this instance already knows the session ended. A logged-out cookie can therefore read
  until Redis is back, and cannot write. Writes and link connections return HTTP 503.
  A coordinator on a dead instance can still show as connected for up to 60 seconds after its
  last heartbeat. If it held the Linear check, no instance runs that check for its project until
  its lease expires.
  Check `linkStore` and `redisReady` in `/api/status`.
- `WG_REDIS_PREFIX` (optional): use a different prefix for each deployment that shares a Redis server.
  The default is `wg:link:`. Use the same prefix on all instances of a deployment.
- `WG_VERSION` (optional): the commit of the build. The `Dockerfile` takes it as a build argument
  (`--build-arg WG_VERSION=<commit>`). Without it, the server gives `dev`.

Checks of a running server:

- `GET /healthz` gives `{"ok":true}` while the process runs, under any host name.
- `GET /api/config` gives `version` and `contract`: the first 12 hex characters of the SHA-256 of
  `skills/work-graph/contract.json`, the same hash that `wg` computes. A deploy check compares both with the
  commit that it deployed and with `wg`.
- `GET /api/status` gives the uptime in seconds, for each workspace the remaining Linear requests and complexity
  with their reset times (from the last Linear response), the count of cached project graphs, and for each link
  room the count of connected coordinators, pages, queued messages, and open asks. It gives no key, no issue
  text, and no message body. The same host check as the other API routes applies.

The page shows the same state. The top bar shows the server `version`. The overview polls `/api/status` each
60 s and warns for each workspace with fewer than 500 remaining Linear requests. When Linear fails, the graph
answer is the last graph with `stale: true`, the error, and `loadedAt` (when that graph loaded, epoch ms), also for
a page that has that version. The project page keeps the graph and shows `Linear is unavailable: this graph is
from <age> ago` until a fresh graph comes.

Each API request that takes more than 5 s or ends with status 500 or more writes one log line with the method, the
path, the status, and the duration. The server compresses static files and JSON answers of any size with gzip when
the client accepts it. `index.html` has a weak `ETag` and `Vary: Accept-Encoding`, also on a 304.

The server listens on `127.0.0.1:4747`. Without sign-in, it does not check who the user is: keep it on a private network, such as a
tailnet, or put an authenticating proxy in front of it. To let other people read a project, use a viewer
("Host a read-only viewer"), not this page without sign-in. Then set `page_url` in the config of each machine that
runs `wg`.

The server pings each link socket every 20 s. It closes a socket that sent no pong for 45 s (messages do not count), so the
page shows a coordinator whose machine sleeps as not connected. On `SIGTERM` or `SIGINT`, the server closes each
link socket with code 1012 (restart), and stops after the sockets close or after 3 s. A proxy in front of the server
must keep a WebSocket open for longer than 20 s with no data.

### Give owners and viewers access on one hosted page

Set `auth.domains` to the Google Workspace domains that may sign in. Add the owner emails in
`auth.owners`, for example `["ada@example.com"]`. Set the sign-in environment values from the
next section and set `WG_LINK_TOKEN`. Leave `WG_READ_ONLY` unset. The server needs at least one
owner and a link token to start with sign-in on a full page.

An owner can read and edit all projects of the page. Other accounts can read only the projects
with the `shared` label. They get the same graph and comment limits as the read-only viewer below.
They get change notices and limited coordinator presence for those projects. The Share button
uses this page as the viewer address when the workspace has no `share_url`.

`GET /api/config` gives the signed-in `role` and the `link` path that the page opens.
Set `WG_READ_ONLY` to give each account viewer access and turn off the link.
On a full page with sign-in, the coordinator token alone allows GET requests to `/api/status` and
`/api/projects/<id>/presence`. The token also opens the coordinator socket. Page sockets need a session.
`/api/config` and `/healthz` are open.

## Host a read-only viewer

A viewer is a second deployment of the page for other people: they sign in and read the projects that you
shared, and they can change nothing. Your own page stays where it is, and each coordinator stays connected to it.

- **What a viewer shows.** The graph, the issues, their comments, and the `work-graph status` document, all from
  Linear. It has no link, so it does not show live job progress, worker questions, or the agent lines of
  `wg agents`. A change shows at the next poll (15 s for a graph, 60 s for the overview). It shows only the issues
  of the project: an issue of another project that blocks one of them (an outside node of your own page) is not in
  the graph of the viewer, and neither is the relation to it. From the status document it shows the status text,
  the times, and the wave, with only the nodes that the viewer shows. It does not show the lines of `wg next`:
  a line can name an issue that the plan maps from another project.
  The graph also has the status names, the member names, and the label names of the team.
- **Read-only.** `WG_READ_ONLY=1` (or `createApp({ readOnly: true })`): each API request with a method that
  changes data (`POST`, `PATCH`, `PUT`, `DELETE`) gives 405, `/api/link` gives 404, and the page shows no edit
  control and no command. Give the viewer a Linear key
  that can only read the team, so that a fault in the page cannot write.
- **Sign-in.** The config field `auth` names the Google Workspace domains, and the environment gives the secrets:
  `WG_AUTH_CLIENT_ID` and `WG_AUTH_CLIENT_SECRET` (a Google OAuth client of type "Web application" whose redirect
  URI is `https://<WG_HOSTED>/auth/callback`), and `WG_SESSION_SECRET` (32 random characters or more). The server
  accepts an account only when Google says that its email is verified, and both its Workspace domain (`hd`) and
  the domain of its address are in the list. A personal Google account has no Workspace domain. A session is a
  signed cookie that lasts 7 days. A new `WG_SESSION_SECRET` ends each session, and a domain that leaves the list
  ends the sessions of its accounts at their next request. Sign-in needs a hosted page and all sign-in
  secrets. On a full page, it also needs at least one owner and a link token.
- **Share a project.** The plain Linear project label `shared` is the record. A viewer lists a project, and
  gives its graph and comments, only for a project that has the label; each other project gives 404. Set the label
  with the **Share** button on the full page, or in Linear. The button uses the workspace's `share_url`
  if set. On a full page with sign-in, it otherwise uses that page's address. A full page without sign-in
  needs `share_url` to show the button. The viewer must name the workspace with the same `id`.
- **When a share ends.** The viewer decides from its newest project list from Linear. It reads the list for each
  overview poll of each open page, and again when its copy is 60 s old. So a project that loses the label leaves
  the viewer at the next list, in at most 60 s. Each server process has its own list: where a host runs more than
  one instance of the function, the 60 s hold for each instance. While Linear does not give the list, the viewer
  gives no project (503): it does not use an older list. When Linear does not give a graph, the viewer gives an
  error, not its last graph.
- **When an issue leaves a shared project.** Its comments stop at once: Linear says in the same answer as the
  comments which project the issue is in. Its title and text, as they were in the shared project, can stay in the
  graph of the viewer for at most 5 minutes (the full reload of a graph in memory). A page that a person has open
  keeps what it loaded before. To take a project away from the viewers sooner, stop its share.

On Vercel: `vercel.json` builds the page (`dist/`) as static files and sends `/api/*`, `/auth/*`, and `/healthz` to
the function `api/index.ts`, which is always read-only. Set these environment values in the Vercel project:
`WG_HOSTED` (the production name, for example `view.example.com`), `WG_CONFIG_JSON` (`human`, the shared
`workspaces`, and `auth`), the Linear key of each workspace, and the three sign-in values. A preview deployment
has another name, so its API answers 403 (`bad host`) unless `WG_HOSTED` of the preview environment names it.
The full page does not run on Vercel: the link needs one process that lives as long as its sockets.

With the `Dockerfile`: the same container with `WG_READ_ONLY=1`, `WG_HOSTED`, and the same values.

Checks of a viewer: `GET /healthz` gives `{"ok":true}`; `GET /api/config` gives `"readOnly":true,"auth":true`;
`GET /api/projects` without a session gives 401; a `POST` to any API path gives 405.

## The contract between `wg` and the page

`skills/work-graph/contract.json` holds the status names, the node card format, the link protocol, and the rule
that says when a blocker is done. `wg contract --write` makes it from `wg.py`, and it does not depend on the local
config. The tests of both parts read it: `python3 -m unittest` in `skills/work-graph/scripts`, and `pnpm test`
here. After a change of `wg.py`, write the file again and change the page until both pass.

## License

MIT. See [LICENSE](LICENSE).
