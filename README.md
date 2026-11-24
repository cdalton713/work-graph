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

## Install the skill

```sh
git clone https://github.com/cdalton713/work-graph.git ~/Projects/work-graph
ln -s ~/Projects/work-graph/skills/work-graph ~/.claude/skills/work-graph   # or your agent's skills folder
ln -s ~/Projects/work-graph/skills/work-graph/scripts/wg.py ~/.local/bin/wg
wg config                                                                    # what wg will use
```

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
  "test_runner": {
    "run": ["./node_modules/.bin/test-runner", "run", "--"],
    "suite": [":test"],
    "options": ["--concurrency", "7"],
    "commit_marker": "testing ([0-9a-f]{10})"
  },
  "workspaces": [
    {"id": "work", "name": "Work", "team": "ENG", "key_env": ["LINEAR_API_KEY"]},
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
| `tick_label`, `tick_roots` | The launchd label of `wg tick --install`, and the folders where `wg tick` looks for `*-core/plan.json`. |
| `test_runner` | The default test command of `wg evidence`. A node runs the moon test tasks that its diff affects; `@full-<phase>` runs `suite`. `commit_marker` is a regular expression for the line where the runner prints the commit it tests; without it, the exit code is the proof. |
| `workspaces` | The Linear workspaces. The first is the default. `team` is the default team of a plan; `teams` limits a workspace to those teams; `team_labels: false` makes project labels workspace labels (Linear's team project labels need the Business plan). |

A workspace's key comes from `LINEAR_<ID>_API_KEY`, then the `key_env` names, then the private file
`~/.config/work-graph/<id>-linear-api-key` (mode 600). Keys never go in the config.

In a workspace on Linear's Free plan (250 issues; archived issues do not count), `wg` archives each completed and
canceled issue of the workspace at each `wg move` to Done or Canceled and at each `wg tick`. `wg archive <dir>`
shows the list; `--apply` archives it. `wg` and the page read archived issues and their relations.

Each Linear team of a plan needs the statuses Triage, Backlog, Todo, Ready, In Progress, `Needs <human>`,
In Review, Ready to Merge, Merged, Verifying, Done, Canceled, and Duplicate
(`skills/work-graph/references/setup.md`).

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

The `Dockerfile` builds the page and its server. Run the container behind a proxy that serves HTTPS, and set:

- `WG_HOSTED`: the name that the page answers under (`wg.example.com`). The API refuses requests for another
  host name, and a write needs the exact HTTPS origin and a JSON body.
- `WG_CONFIG_JSON`: the config text (at least `human` and `workspaces`).
- The Linear key of each workspace (`LINEAR_API_KEY`, or the names in `key_env`).
- `WG_STATE_DIR` (optional): a directory where the link keeps the queue of each project and the open worker
  questions over a restart. Without it, a restart loses them: a reply or a command that a coordinator did not get
  yet does not arrive. The server writes one file, `link-state.json` (mode 600), at most 1 s after a change, and
  reads it at start. Give the directory a volume, so that the file stays when the container changes. Put the
  directory outside the built page (`dist`): the server refuses a state directory there and keeps the state in
  memory only. If the server cannot write the file, it logs the error and exits with code 1 at a stop, and after
  the restart a coordinator can get a message again that it acknowledged.

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

The server listens on `127.0.0.1:4747`. It does not check who the user is: keep it on a private network, such as a
tailnet, or put an authenticating proxy in front of it. Then set `page_url` in the config of each machine that
runs `wg`.

The server pings each link socket every 20 s. It closes a socket that sent no pong for 45 s (messages do not count), so the
page shows a coordinator whose machine sleeps as not connected. On `SIGTERM` or `SIGINT`, the server closes each
link socket with code 1012 (restart), and stops after the sockets close or after 3 s. A proxy in front of the server
must keep a WebSocket open for longer than 20 s with no data.

## The contract between `wg` and the page

`skills/work-graph/contract.json` holds the status names, the node card format, the link protocol, and the rule
that says when a blocker is done. `wg contract --write` makes it from `wg.py`, and it does not depend on the local
config. The tests of both parts read it: `python3 -m unittest` in `skills/work-graph/scripts`, and `pnpm test`
here. After a change of `wg.py`, write the file again and change the page until both pass.

## License

MIT. See [LICENSE](LICENSE).
