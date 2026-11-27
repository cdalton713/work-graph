# work-graph

Plan and run a large multi-PR effort (a migration, a rewrite, a platform change) as a dependency graph in
Linear. Coding agents do the work in parallel lanes, and a coordinator agent follows the graph. This repository
holds two parts:

- `skills/work-graph/`: the agent skill. `SKILL.md` tells a coding agent (Claude Code, Codex) how to plan
  and coordinate an effort. The native CLI in `cli/` provides the `wg` command. It checks
  the graph, syncs it to Linear, takes and releases claims, checks that a PR is code done, guards each status
  change, and prints the next action.
- The page (`src/`, `server/`): a web app that shows each effort as a graph of its nodes (phases, lanes, merge
  and ship points), with an issue panel to edit and comment, and a live link to the coordinator.

## How Work Graph works

Work Graph turns a big change into a graph of Linear issues in the order they need to happen.
Ready issues can move together while blocked issues wait. You can see everything that needs your attention in one place.
You answer questions, merge the changes, and deploy.

```mermaid
flowchart LR
    plan["You describe the change"] --> graph["Linear issues in order"]
    graph --> first["Agent: branch and pull request"]
    graph --> second["Agent: branch and pull request"]
    first --> ship["You merge and ship"]
    second --> ship
```

The page server uses a tenant provider to find the human and Linear workspaces for a request.
The config supplies one tenant. The server keeps Linear data in separate caches for each tenant.

The skill expects these tools: [Linear](https://linear.app), the GitHub CLI (`gh`),
[stax](https://github.com/cesarferreira/stax) (`st`) for stacked branches, [Orca](https://github.com/stablyai/orca)
for worker agents and worktrees, and the native `wg` executable. The page needs Node 24 and pnpm.

Each user who runs an effort needs access to Linear and these tools on their own machine,
including an agent CLI (Claude Code or Codex). A hosted deployment serves only the page and its API.

Each tenant has its own link rooms, even when tenants use the same workspace and project IDs.
A page uses the tenant of its session. A coordinator uses the tenant of its token.
Only a config installation can use `WG_STATE_DIR`. Other tenants keep the queue and open questions in memory or in Redis.

## Install the skill

### Fresh managed installation

The signed 0.1.1 Linux release passed CLI parity checks on Ubuntu 24.04 on x86_64 and arm64. Both binaries require glibc 2.39 and OpenSSL 3.
Choose a stable release for your OS and CPU. Obtain its bootstrap digest and release public key through an
independent authenticated channel. Follow the [bootstrap commands](packaging/install/README.md#fresh-installation)
to verify and install the binary, skill and Orca plugin together. Put `~/.local/bin` first on PATH.
Register `~/.local/share/work-graph/current/skills/work-graph` in your agent's skills directory.
For example, for a new registration:

```sh
mkdir -p "$HOME/.claude/skills"
ln -s "$HOME/.local/share/work-graph/current/skills/work-graph" "$HOME/.claude/skills/work-graph"
wg config
wg agents --install
wg doctor
```

Review the plugin access request in Orca. The page has its own release cycle. Use `wg doctor` to compare
the CLI contract with the page's `/api/config` contract. If they differ, use a CLI and page with matching
contracts before starting an effort.

### Migrate a source installation

Keep the legacy checkout, its local edits, and its Python and uv environment for recovery. Record the targets of
your launcher and each agent's skill link with `readlink`. Preserve any local plugin edits before running
`wg agents --install`. With the verified bootstrap and assets from the fresh installation procedure, run:

```sh
./wg-install -assets ./assets -version "$VERSION" -key "$RELEASE_KEY" -migrate-source
```

This flag replaces the recognized link at `~/.local/bin/wg` to a checkout's `skills/work-graph/scripts/wg.py`.
For a different launcher, use its owner's instructions. Move each old skill registration to a private backup
outside the agent's skills directory, including any edited files. Register the managed skill at the original
location, then run `wg agents --install` and `wg doctor`. Keep the same config, credentials and plan directories.

To return to the source CLI after the first install, stop scheduled jobs and running agents. Set `CHECKOUT`
to the absolute path of the preserved checkout. In a shell, run:

```sh
(
  set -eu
  launcher="$HOME/.local/bin/wg"
  source_wg="$CHECKOUT/skills/work-graph/scripts/wg.py"
  test -x "$source_wg"
  test "$(readlink "$launcher")" = "$HOME/.local/share/work-graph/current/wg"
  unlink "$launcher"
  ln -s "$source_wg" "$launcher"
)
```

Restore the saved skill registrations in place of the managed links. Run `wg config`, `wg agents --install`
and `wg doctor` from the source installation before resuming jobs. Leave the managed versions on disk.

### Update and roll back

A normal managed command starts a background release check at most once every 24 hours, including after a
failed check. Run `wg update status` offline to see the active version, check result, rollback hold and plugin
review notice. A read-only install continues to run its active version. Set `WG_UPDATE=off` in the environment
of every launcher to freeze it. Set `WG_UPDATE_PIN` to an exact newer stable version to limit discovery to
that release. Clear the pin to resume normal discovery.

Run `wg update rollback` to verify and select the previous managed release. The hold prevents the next
command from updating it again. Set `root="$HOME/.local/share/work-graph"`. When ready, remove
`"$root/update-hold"`. To retry before the next daily check, remove `"$root/update-check"` and run `wg config`.
If verification reports local changes, save the edited files outside the managed root and restore the signed
files before retrying. Keep customizations outside signed version directories.

After a plugin change, `wg update status` requests review. Run `wg agents --install` to compare the registered
plugin with the bundled files and review any new access request in Orca. After review, remove
`"$root/update-plugin-review"`. Registrations, permissions and disabled-plugin settings remain under local
control. See the [shared updater controls](cli/src/update/README.md).

### Recover signing trust

**Missed transition.** Discovery checks up to eight newer stable candidates in the first 100 listed releases
for a transition signed by the installed key. If status reports no verified transition, obtain the stable
bridge version from the release maintainer. With updates enabled and any rollback hold intentionally cleared,
set `BRIDGE` to that numeric version. Run:

```sh
root="$HOME/.local/share/work-graph"
export WG_UPDATE_PIN="$BRIDGE"
rm -f "$root/update-check"
wg config
wg update status
```

Repeat status until the background check finishes and the bridge is active. Then run
`unset WG_UPDATE_PIN`, remove `"$root/update-check"`, run `wg config`, and check status again.
If the signed bridge is unavailable, use a separately authenticated fresh installation as described below.

**Suspected compromise.** Stop release publication. Revoke the signing secret and distribute a new key and
bootstrap digest through a channel independent of the release host and the old key.
On each affected machine, stop agents, schedules and updater processes. Disable the registered plugin in Orca
and export `WG_UPDATE=off`. Use a trusted shell and tools for recovery. Keep the config directory, any
`WG_CONFIG` file, credentials and effort worktrees in place. Preserve the entire old installation for recovery
of local edits. For the documented managed paths, run:

```sh
(
  set -eu
  root="$HOME/.local/share/work-graph"
  launcher="$HOME/.local/bin/wg"
  test "$(readlink "$launcher")" = "$root/current/wg"
  backup=$(mktemp -d "$HOME/.local/share/work-graph-recovery.XXXXXXXX")
  mv "$launcher" "$backup/launcher"
  mv "$root" "$backup/installation"
  echo "$backup"
)
```

In a new private directory, follow the fresh bootstrap commands with the **replacement** digest, key and
recovery release. Verify the new CLI version, point skill registrations at the new managed skill, and inspect
any saved edits as data before adapting them outside the signed tree. Compare and approve the verified plugin
with `wg agents --install`. Run `wg doctor`, then clear `WG_UPDATE` and resume jobs. If the compromised
software ran, review access to local credentials and replace exposed credentials before resuming.
See [release signing and recovery](packaging/releases/README.md#signing-and-recovery).

### Check the installation

`wg doctor` checks each workspace
key (present, mode 600, accepted by Linear) with the request budget that is left, `gh auth`, `st`, the Orca CLI,
the page server (`/healthz`, and the contract of `/api/config`), the Orca plugin of `wg agents` (installed, approved,
and as new as the checkout), the `tick`, `autostart`, and `health` schedules, and
the session settings of each loaded effort's core worktree (config `coordinator_settings` and `context_limit`).
`wg doctor --fix` writes those settings; it changes nothing else.
`wg doctor <plan-dir>` also checks that effort: `wg check`, `keymap.json` against Linear (an issue that is gone, a
claim label with no live job, a job start that is stuck for more than 30 minutes, a status that the run row
contradicts), each worktree path of the run rows, and the link (connect, `hello`, close). It exits 1 on a `FAIL`.

For a new Linear team, run `wg setup --team WG --name "Work Graph"` to see what the team needs.
Add `--apply` to create missing items. See [Linear setup](skills/work-graph/references/setup.md#linear)
for workspace keys, team privacy, and label scope.

## Config

Push notices are optional. For a config installation, set `WG_STATE_DIR` to a private directory outside the
page directory. The server keeps device subscriptions and account notice settings there. Without a state
directory or VAPID keys, push is off.

Use one P-256 VAPID key pair for the installation. Set `WG_VAPID_PUBLIC_KEY` and `WG_VAPID_PRIVATE_KEY`
to the base64url keys. Set `WG_VAPID_SUBJECT` to a contact email with the `mailto:` prefix or an HTTPS contact URL.
Push stays off if the subject is missing or invalid. To keep the keys and subject in one mode-600 JSON file,
set `WG_VAPID_FILE` to its path. Replace the example contact address below with your own. To create the file,
run this command in a private directory. It creates a new file with mode 600 and prints no keys.

```sh
node --input-type=module - <<'JS'
import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const { x, y, d } = privateKey.export({ format: "jwk" });
const publicKey = Buffer.concat([Buffer.from([4]), Buffer.from(x, "base64url"), Buffer.from(y, "base64url")]);
writeFileSync("vapid.json", JSON.stringify({ publicKey: publicKey.toString("base64url"), privateKey: d, subject: "mailto:push@example.com" }),
  { flag: "wx", mode: 0o600 });
JS
```

Each account starts with notices on for decisions and ops steps, merge requests, worker questions, and
other waits. The account can turn notices off or select the kinds to receive. Removing one device
keeps the account settings and the other devices.

A coordinator sends a move with `POST /api/push/notices`. Use the coordinator bearer token.
Send a JSON object with `workspace`, `project`, `issue` (the issue identifier), and `kind`
(`decision`, `merge`, `question`, or `wait`). In config mode, add `recipient` with the email
of one configured owner. You can omit it if there is one owner. In service mode, omit it.
The token identifies the account. The server reads the project name for the notice.

The signed-in page can send a test to one registered device with
`POST /api/push/devices/:id/test`. Both routes return 202 when they accept the request.
Each account can request 30 notices per minute. A disabled notice produces no delivery.

`wg` and the page server read `~/.config/work-graph/config.json` (or the file `WG_CONFIG`; the server also takes
the text in `WG_CONFIG_JSON`). Without a file, there is one Linear workspace with `LINEAR_API_KEY`, the human is
"Human", there is no hosted page, and each plan needs `effort.test`. Every field is optional:

```json
{
  "human": "Ada",
  "app_name": "Example Planner",
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
  "agent_replies": false,
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
| `app_name` | The name of the installed app. The default is `work-graph`. |
| `page_url` | The hosted page. `wg next` prints links to it. Default: `http://127.0.0.1:4747` (`wg ui`). |
| `branch_prefix` | The prefix of each branch that `wg` names (`wg/<slug>-core`). |
| `release_branch` | The target of a HOTFIX/SYNC phase (`skills/work-graph/references/ordering.md`). |
| `rules` | A Markdown file of your own rules: your workspaces, the repositories where agents may merge, freeze rules. The skill tells the agent to read it. |
| `github_user` | The `gh` login that `wg tick --install` requires for the scheduled job. |
| `agent_merge` | The GitHub owners (`ada`) or repositories (`ada/tool`) where agents may merge. At autonomy level `full` there, `wg next` prints `do merge` in place of `ask-merge`: the merge is the coordinator's step, not the human's move. Default: none. |
| `context_limit` | The context size in tokens at which Claude Code compacts a coordinator session. `wg load --apply` and `wg doctor --fix` write it as `autoCompactWindow` into `.claude/settings.local.json` of the core worktree. They write it as `worker_settings` does: the other keys of the file stay, the file stays out of git, and `wg` writes through no symlink. `wg doctor --fix` writes only into the plan directory of a loaded effort. Claude Code reads the file when a session starts, and takes no value below 100000. `wg next` prints a `note context` line when its session is over the limit. `0` turns this off. Default: 250000. |
| `coordinator_settings` | The session settings of the coordinator, per agent, in the shape of `worker_settings` and with its merge rules. `wg load --apply` and `wg doctor --fix` merge them into the core worktree's `.claude/settings.local.json` and `.codex/config.toml`, in the same step as `context_limit`, and `wg doctor` reports a core worktree whose files do not have the values. A `context_limit` that is not 0 wins over an `autoCompactWindow` in `coordinator_settings.claude`. A coordinator needs more than a worker (`skills/work-graph/references/setup.md` "Worker sessions"). Default: none, and `wg` writes no file for it. |
| `tick_label`, `tick_roots` | The launchd label of `wg tick --install`, and the folders where `wg tick` looks for `*-core/plan.json`. |
| `agent_replies` | Let project owners reply to idle agents when `wg agents` runs in your Orca terminal. Default is `false`. |
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

- `{"type": "page"}` sends each new move to the workspace page with the coordinator token from `wg login`.
  The notice shows the project name and opens the issue. The account's settings select which kinds to receive.
  For a page with several configured owners, set `"to": "ada@example.com"` in the channel. On a hosted
  account, the token selects the recipient. Run `wg doctor` to check push setup and the registered device count.
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
when it waits for two reads in sequence. The message text goes to the page server. On a config page, use
`wg agents` only if everyone with access may read the agent lines.

The Overview inbox puts moves with a waiting agent first, then moves that hold back the most open issues.
When these are equal, the oldest move comes first. Each move shows if an agent waits, how many open issues
it holds back, and how many can start when it closes. The Board uses the same order for these moves.

`wg agents --once` does one read and prints the rows. `wg agents --install` installs the Orca plugin in
`orca-plugin/` (its README), which keeps `wg agents` running in a background Orca terminal named `wg agents`.
Orca asks you to approve the plugin's access: the command prints that access and the `wg agents --install
--approve <fingerprint>` command to run. Run `wg agents --install` again after an update of the checkout; it
updates the plugin when its files changed. It also removes the launchd sender of older versions.

On a hosted page with accounts, only the account that sends the lines can see them. Viewers do not see them.
Keep `wg agents` running on the machine that runs Orca. Run `wg login` for the workspace page so the sender can
use the token for that page. `wg doctor <dir>` shows the sender service and the last successful send for that effort.

The sender checks for config and token changes each cycle. If the `wg` executable changes, the sender exits, and the
plugin's terminal starts the new code.

When no report came for 3 minutes, the page shows "agent view stopped". `wg agents --uninstall` removes the plugin.

To let a project owner reply to a chat or terminal agent whose turn ended, set `agent_replies` to `true`.
The default is `false`. Replies need the sender in an Orca terminal: the plugin of `wg agents --install`
runs it there. Without the plugin, run `wg agents` in your own Orca terminal and keep it open.
Use Orca directly for a prompt with choices. `wg agents --wait` waits while another sender runs, then starts.

On the Overview, open the line of a stopped coordinator or worker to read its last message and send a reply.
The line stays visible for 60 minutes after the agent stops. You can reply during that time.
A prompt that needs an answer stays in the inbox. Answer that agent in Orca.

The line shows `sent` when the server queues the reply and `delivered` when Orca confirms it.
If Orca refuses the reply, the line gives the reason. If the line shows `not confirmed`, check Orca
before you send the reply again. If no watcher takes the reply within two minutes, the line shows
`not delivered: wg agents does not run`. Reloading the tab keeps the latest reply status.

The watcher checks that the agent is still idle in this effort before it sends Orca mail. This
check is best effort because Orca can change the agent state before it accepts the mail.
Mail waits for a running turn to end. A delivered result means that Orca stored the mail.
It does not confirm that the agent read it. If delivery is unconfirmed, check Orca before you reply again. A reply to a worker is also a comment on its
issue. A reply to the coordinator has no issue comment.

The Overview shows one state and one reason for each project. It shows stalled projects first, then
projects that wait on you, then moving projects, then projects in the “Not running” state. Each switch
shows a count for one state. Select one or more states to filter the projects. The URL keeps the selection.

Select an inbox question to read it and reply in place. Use the arrow keys to move between focused inbox rows.
Press `r` to open a reply, `⌘↵` to send, or `Esc` to close it.
With an empty reply box, focus a choice and press `⌥1` through `⌥4` to send the choice in that position.

The Overview inbox also shows stalls, with the time since each one started.

- **Worker silent.** A job has a working agent that last reported 20 minutes ago or earlier.
- **Worker gone.** A job has had no running agent for 3 minutes.
- **No coordinator.** A job runs or an action is due, and for 15 minutes no coordinator listened or worked.
- **No agent view.** A job runs and the agent view has no report from the last 3 minutes. The page cannot detect
  worker stalls until reports resume. Run `wg agents --install` to set up reports.

Paused and completed efforts and read-only views have no stall entries. Each project row shows its next wait
or action, or the stall if there is one. The browser tab shows the inbox count.

In a workspace on Linear's Free plan (250 issues; archived issues do not count), `wg` archives each completed and
canceled issue of the workspace at each `wg move` to Done or Canceled and at each `wg tick`. `wg archive <dir>`
shows the list; `--apply` archives it. `wg` and the page read archived issues and their relations. The page
shows each archived issue of the project as a read-only node, marked archived; the server refuses each write to it.

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

### Agent settings

Set the optional `agents` object to choose who starts the coordinator and worker jobs.

```json
{
  "agents": {
    "coordinator": {"agent": "claude"},
    "worker": {"agent": "codex", "model": "example-model", "effort": "high"}
  }
}
```

Both roles accept `agent`, `model`, and `effort`. Use `claude` or `codex` for
`agent`. Use a model ID and effort level that Orca accepts. Effort needs a model.
For each field, a command flag wins over `effort.agents` in the plan, then the
installation config. Changing the agent drops the model and effort from the
lower-priority setting for the previous agent. The default worker is Codex. The default coordinator is
Orca's default agent. `wg config [<plan-dir>]` shows the resolved roles.

A follow-up job uses the settings in the node's run row before the plan and
config defaults. Command flags can override those settings. To apply changes
to an installed coordinator automation, run `wg autostart <plan-dir> --install`
again.

## Run the page on this machine

`wg ui` builds and starts it from this repository (or from `WG_UI_DIR`). By hand:

```sh
pnpm install
pnpm build
LINEAR_API_KEY=... node server/main.ts      # http://127.0.0.1:4747
pnpm test
```

Install Chromium once with `pnpm exec playwright install chromium`. Run `pnpm test:e2e` to build the page
and check its layout at six window sizes. The tests start local fixture servers and use no Linear key.
Run `pnpm shots` to build the page and save screenshots in `shots/<size>/`.
The service fixture stops if `DATABASE_URL`, `WG_HOSTED`, `WG_DATA_KEY`, or `WG_SESSION_SECRET` is set in the shell.

`node server/main.ts --team <key>` gives a team to a workspace that has none in the config. The server also puts
the page on your tailnet with Tailscale Serve while it runs; `--no-tailnet` keeps it on this machine. Keys stay in
the server. Every graph, edit, comment, and cache is scoped to its workspace.

The server sends at most 6 Linear requests at the same time. It tries a query again, at most 3 tries, after a
network error, a timeout, HTTP 429, HTTP 5xx, or Linear's `RATELIMITED` error. It tries a mutation again only after
HTTP 429 or `RATELIMITED`, because Linear can have applied a mutation that timed out.

## Host the page

For a service with separate Linear accounts, see [Run the hosted service](#run-the-hosted-service).

**What a host does not do.** The host serves only the page and its API. The coordinator and
workers run on the user's machine. Each user who runs an effort needs access to Linear and
local copies of `gh`, `st`, Orca, and an agent CLI (Claude Code or Codex).

The `Dockerfile` builds the page and its server. Run the container behind a proxy that serves HTTPS, and set:

- `WG_PRECOMPRESSED_ASSETS=1`: the page server sends the gzip files from `pnpm build` to clients
  that accept gzip. Leave the value unset to compress responses on request.
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
- `WG_LINK_MAX_AGE` (optional): maximum link socket age in seconds, measured from the socket join.
  Use 60 to 2147483 seconds. The server closes each socket slightly earlier with code 4001 so clients
  can reconnect. Set the host's limit at least 20 seconds above this setting to allow time for the join.

On the coordinator's machine, run `wg login https://wg.example.com` and enter the coordinator
token at the prompt. If the config already names the page, run `wg login --workspace <id>`.
The command checks the token with the page and stores it in a private file for that page.
It shows the workspaces the page serves and the config entries to add. Run `wg doctor`
to check the token and `wg logout [<page-url>]` to remove the saved copy.

For a workspace with its own page, the client checks `WG_<ID>_LINK_TOKEN` and then
`<id>-link-token`. For a workspace that uses the top-level page, it checks `WG_LINK_TOKEN`
and then `link-token`. If neither source exists, it checks the token saved for that page
by `wg login`.
  Leave the setting blank or set it to 0 to turn off the age limit. With a limit set, the page and the
  presence API show a coordinator as connected for up to 15 seconds after any close, including a
  deliberate exit. Autostart uses the queued work count and the Orca agent list to decide when to start.
- `WG_LINK_PONG_MS` (optional): time in milliseconds to wait for a pong before ending a socket.
  Use 25000 to 300000 milliseconds. A blank value uses the default of 45000.
  Set it to 0 to turn off the deadline if the host drops pong frames.
  Set a socket age limit when you turn off the pong deadline. A live function test with managed Redis
  verified the bearer-token WebSocket upgrade, ping and pong frames, and the planned socket close before
  the function time limit.
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
  A signed-in read can wait up to 500 ms when Redis does not answer. A new instance knows only
  the ended sessions that Redis gives it.
  A dead coordinator's lease expires within 60 seconds of its last heartbeat. An open page
  can show it as connected for up to about 80 seconds, until a live instance's next heartbeat.
  If the dead coordinator held the Linear check, no instance runs that check for its project
  until the lease expires.
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
next section and set `WG_LINK_TOKEN`. Leave `WG_READ_ONLY` unset for the container. On Vercel,
set `WG_READ_ONLY=0`. The server needs at least one
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

### Vercel

`vercel.json` serves `dist/` as static files. It routes `/api/*`, `/auth/*`, and `/healthz` to the
function in `api/index.ts`. Enable Fluid Compute for the full page so that the function can accept WebSockets.
Set `WG_HOSTED` to the preview host name in the preview environment. When the host name differs from
`WG_HOSTED`, the API returns 403 (`bad host`).

| Environment value | Read-only viewer | Full page |
| --- | --- | --- |
| `WG_READ_ONLY` | Unset or any value other than the exact text `0`. | `0`. |
| `WG_HOSTED` | The host name of the deployment. | Same as the viewer. |
| `WG_CONFIG_JSON` | The page config with its workspaces and optional `auth`. | The page config with its workspaces and `auth` with at least one owner. |
| `LINEAR_<ID>_API_KEY` | The Linear key for each workspace, or a key from its `key_env` list. | Same as the viewer. |
| `WG_AUTH_CLIENT_ID`, `WG_AUTH_CLIENT_SECRET`, `WG_SESSION_SECRET` | Required with `auth`. | Required. |
| `WG_LINK_TOKEN` | Optional. Permits the viewer's bearer-token reads. | Required. Use the same token for the coordinator. |
| `WG_REDIS_URL`, `WG_REDIS_PREFIX` | Optional. | The Redis URL is required. Use the same prefix on all instances of this page. |
| `WG_LINK_MAX_AGE` | No link socket. | Use 60 to 280 seconds. A blank or unset value uses 270 seconds. |
| `WG_LINK_PONG_MS` | No link socket. | Use 25000 to 300000 milliseconds, or `0` to turn off the pong deadline. A blank or unset value uses 45000. |

The 300-second function limit applies to both modes. The socket age starts at the join. While the socket
timer runs, the server closes the socket in time for the client to reconnect. On a plan with a higher
limit, raise `maxDuration` in `vercel.json` and `VERCEL_MAX_DURATION` in `server/vercel.ts` together.
Keep a custom `WG_LINK_MAX_AGE` at least 20 seconds below the function limit. The default keeps 30 seconds.

A live function test with managed Redis verified the WebSocket upgrade with a bearer token from the
Python link client, ping and pong frames, and the planned socket close before the function time limit.
If pong frames do not reach the app, set `WG_LINK_PONG_MS=0`. The function has no stop hook. If the host
ends the instance before the planned close, clients reconnect and Redis keeps the link state.
`wg next --wait` also polls Linear, so a missed timer check can delay an update.

The server waits up to three seconds for Redis to connect before returning 503 with `Retry-After: 1`.
After a pause, it checks a timed-out connection with a fresh ping before it reconnects.

`GET /healthz` checks that the configured server runs. Use the coordinator token on `GET /api/status`
to check the mode (`readOnly` and `link`) and Redis (`linkStore` and `redisReady`). Redis can be
unavailable while `/healthz` returns 200.

### Create a starter project

Set `WG_CREATE_PROJECTS=1` on the server to enable project creation for signed-in owners.
The workspace credential must belong to the selected team. Configure the workspace team filter
and the team's `Ready` and `Todo` states. The starter has one phase targeting `main`. Its
first task blocks the merge point, and the merge point blocks the ship point.

When `GET /api/config` returns `createProjects: true`, the page can get eligible teams
with `GET /api/project-creation/teams`. Send the selected workspace ID in `X-Workspace`
on this request and on `POST /api/projects`. The team response is `{teams: [{key, name}]}`.
Send the team key, project name, and first task as JSON fields `team`, `name`, and
`firstTask`. Trim the fields before submission. The team, project name, and first line
of the task each accept 1 to 120 characters. The first line becomes the issue title.
Subsequent lines become its description. The complete task accepts up to 10,000 characters.
Set `Idempotency-Key` to the lowercase hexadecimal SHA-256 of the UTF-8 bytes of
`JSON.stringify([workspaceId, team, name, firstTask])`. Retry the same request after an
interruption. A changed input with the previous key returns HTTP 409. Identical input
from the same owner selects the same starter. Success returns HTTP 200 with `workspace`,
`project` (Linear ID and URL), and `handoff` (plan, keymap, and command).

The owner saves the returned `handoff.plan` as `plan.json` and `handoff.keymap` as
`keymap.json` in a new coordinator checkout of the target repository. Configure the local
workspace ID and team to match the plan. For a configured owner, run `wg next .`.
For a hosted account, sign in with `wg login <page-url>`. In the new checkout, run
`wg pull . --force && wg next .` before editing the files. This loads the current
hosted revision and connects subsequent edits to the shared plan. The keymap
identifies the existing project, issues, cards, and milestone.

## Run the hosted service

The service hosts the page and its API. Accounts share a server and keep their workspaces private.
Each user runs `wg`, Orca, `gh`, `st`, and an agent CLI on their own machine.

To enable push for the hosted service, set the same VAPID keys on every instance (see [Config](#config)).
The service stores subscriptions in Postgres and encrypts them with `WG_DATA_KEY`. Device removal and
notice settings apply to the signed-in account. A read-only viewer cannot register a device.

### Parts of the service

- Run the container behind an HTTPS proxy that supports WebSocket upgrades. The server listens on the
  container's loopback address, so the proxy must share its network namespace. See [Host the page](#host-the-page).
  You can also use a function host that supports WebSockets.
- Use Postgres for accounts, workspace credentials, and coordinator token records.
- Use Redis on a function host or when you run more than one instance. Use the same standalone Redis server and prefix on all instances.
- Create a Linear OAuth application. Register `https://wg.example.com/auth/callback`, with your public host name in place of the example.
  The server requests the `read` and `write` scopes with `actor=user`. It reads projects and issues and writes comments, labels, and status changes as the user.

### Service environment

Set these values in the server environment. Keep secrets in the host's secret store.

| Environment value | Required | Purpose | Secret |
| --- | --- | --- | --- |
| `DATABASE_URL` | Yes | Postgres connection URL. Enables service mode. | Yes |
| `WG_HOSTED` | Yes | Public host name, for example `wg.example.com`. Use the host name alone. | No |
| `WG_LINEAR_CLIENT_ID` | Yes | Client ID of the Linear OAuth application. | No |
| `WG_LINEAR_CLIENT_SECRET` | Yes | Client secret of the Linear OAuth application. | Yes |
| `WG_SESSION_SECRET` | Yes | Signs session cookies. Use at least 32 characters. Also supplies the key material for hashing usage data IDs. | Yes |
| `WG_DATA_KEY` | Yes | Encrypts Linear credentials in Postgres. Use a base64-encoded 32-byte key. | Yes |
| `WG_DATA_KEY_OLD` | For key rotation | Earlier data keys, separated by commas or spaces. The server can still read credentials encrypted with these keys. | Yes |
| `WG_ALLOWED_ORGS` | No | Linear workspaces that can sign in. Separate entries with commas or spaces. | No |
| `WG_LINEAR_ATTACH_OAUTH` | No | `1` lets users attach more workspaces through the Linear OAuth application. Unset: they attach with a personal API key. | No |
| `WG_REDIS_URL` | On a function host or with multiple instances | Redis connection URL for link state, account changes, and personal key-check counters. | Yes |
| `WG_REDIS_PREFIX` | No | Isolates deployments on a Redis server. The default is `wg:link:`. | No |
| `WG_LINK_MAX_AGE` | No | Maximum socket age in seconds from the join. The server can close the socket up to 10% earlier. The container accepts 60 to 2147483 seconds. Unset or 0 disables the container age limit. See the function limits below. | No |
| `WG_LINK_PONG_MS` | No | Pong deadline in milliseconds. Use 25000 to 300000. The default is 45000. Use 0 to turn off the deadline if the host drops pong frames. Set a socket age limit in that case. | No |
| `WG_VERSION` | No | Build version in the API. The default is `dev` unless the function host provides a commit SHA. | No |
| `VERCEL_GIT_COMMIT_SHA` | No | Function host build commit. The server uses its first seven characters if `WG_VERSION` is unset. | No |
| `DD_API_KEY` | For usage data | Datadog intake key. See [Usage data](#usage-data). | Yes |
| `DD_SITE` | No | Datadog intake site. See [Usage data](#usage-data) for the default and accepted sites. | No |
| `WG_TELEMETRY_WORKSPACES` | For usage data | Workspaces to include. See [Usage data](#usage-data) for entry formats. | No |

The Postgres driver also reads `PG*` environment values, such as `PGSSLMODE` for TLS.

#### Sentry error monitoring

Set `WG_SENTRY_DSN` to enable server error reports. Set `WG_SENTRY_BROWSER_DSN` to publish the browser DSN in `/api/config`. You can enable either setting independently. Both use `WG_SENTRY_ENVIRONMENT` (default `production`) and the same release as the build.

Set `WG_SENTRY_DSN` in the Rust CLI process to report panics and fatal I/O errors. Set it separately in the server process to select the server’s Sentry project. Leave it unset in either process to keep reporting off there. CLI events contain the compiled release, the command verb and a fixed failure message. They omit arguments, paths, plan data and credentials.

To upload browser source maps, set all three build variables. Use `SENTRY_AUTH_TOKEN` for the upload token, `SENTRY_ORG` for the organization slug, and `SENTRY_PROJECT_BROWSER` for the browser project slug. Set `WG_VERSION` to the same release at build time and at runtime. If unset, the release uses the first seven characters of `VERCEL_GIT_COMMIT_SHA`, or `dev` if no commit is available. The build uploads hidden source maps and removes the map files from `dist`. If any upload variable is empty, or the release is `dev`, the build skips source maps and makes no upload request. For a Vercel CLI deploy, pass the commit both ways: `--build-env WG_VERSION=<commit> --env WG_VERSION=<commit>`.

For Vercel, set the variables in the project environment. For Docker, pass `--secret id=SENTRY_AUTH_TOKEN,env=SENTRY_AUTH_TOKEN` and the build arguments `--build-arg SENTRY_ORG --build-arg SENTRY_PROJECT_BROWSER --build-arg WG_VERSION` from the build environment.

Set `WG_SENTRY_TEST_EVENT=1` to send one info event, `work-graph sentry test`, when a server with error reporting enabled starts. Server reports omit request data, exception messages, and source text.

When browser reporting is enabled, the page also sends this test event once per page load if `WG_SENTRY_TEST_EVENT=1`. Browser error reports include error types and stack locations. They omit request data, breadcrumbs, and exception text.

### First start and data key changes

The container applies database migrations at start. On a function host, the first request waits for them.
If the database schema is newer than the server, run a server version that supports that schema.

To change the encryption key, put the new key in `WG_DATA_KEY` and move the previous key to `WG_DATA_KEY_OLD`.
Restart all instances with the same keys. The server uses the new key for credential writes. Earlier keys are
still necessary for credentials that have yet to be written again, and for backups that contain those credentials.
Startup migrations do not rewrite credentials.

### Sign up and connect

With `WG_ALLOWED_ORGS` unset, any Linear user can sign in. An empty or blank value refuses all sign-ins.
To allow specific workspaces, list their Linear organization IDs in UUID form. Workspace URL keys also
work, but can change or be reused. The service creates one account per Linear user in each sign-in workspace.

Choose **Sign in with Linear**. The setup guide walks you through your name, workspaces, teams, and the first
coordinator connection. You can attach another workspace with a personal Linear API key and select its team.
If Linear refuses that key later, replace it in Settings. Projects in an attached workspace stay private to you:
viewers do not see them, and you cannot share them.

With `WG_LINEAR_ATTACH_OAUTH=1`, Settings and the guide also offer **Connect a workspace with Linear**, which
attaches a workspace through the Linear OAuth application. The sign-up list of `WG_ALLOWED_ORGS` does not apply
to attached workspaces. Turn it on only if your Linear OAuth application accepts authorizations from other
workspaces; Linear refuses the others.

In the guide, create a coordinator token and copy it when it appears. Run `wg login https://wg.example.com` on
your machine and paste the token at the prompt. Run the `wg setup` command shown in the guide for each workspace,
then run `wg doctor`. Settings lets you reopen the guide or manage tokens. If you change your name, update
`human` in your local `wg` config too.

### Data and privacy

Postgres holds names, email addresses, user IDs, and organization IDs from Linear. It also holds account settings,
workspace records with team keys, and encrypted Linear OAuth tokens and personal API keys. Coordinator token
records hold the token hash, name, and creation, last use, and revocation times. The operator holds the key that
encrypts Linear credentials. The server processes issue text and worker output in memory. With Redis, link traffic and state
such as queued messages and open worker questions can also pass through Redis. Postgres holds no issue text.

See [Usage data](#usage-data) for setup and controls.

Adapt this privacy text to your installation. Fill in the retention periods before you publish it.

> We use the account and workspace data listed above to run your account. We keep that data,
> encrypted Linear credentials, and coordinator token records in Postgres while your account is open.
> Postgres backups expire after [backup retention period].
>
> We send queries and requested changes to Linear with your connected credentials. Linear keeps its own
> project and issue records under your workspace's policies. We process issue text and worker output
> in server memory and use Redis for link traffic, queued messages, and open worker questions.
> Cached data can stay in memory while the account is active. Queued messages and open questions
> can stay in Redis until handled. We remove leftover Redis data after [Redis retention period]
> and keep Redis backups for [Redis backup retention period, if applicable].
>
> Host logs can include request paths with project IDs or keys and the types of coordinator messages.
> We keep host logs for [host log retention period].
>
> When we enable usage data, each account sends data for the workspaces we include.
> We send activity counts and logs to Datadog. These cover sign-in, account and
> setup activity, coordinator connections, and page actions. Logs include hashed account and workspace
> IDs. We exclude names, email addresses, project and issue IDs, issue text, and credentials.
> We keep these records for [Datadog retention period]. Accounts have no usage data switch. We can turn off usage data for all accounts in the server environment.
>
> To delete your account, open **Settings**, choose **Delete account**, and enter `delete` to confirm.

### Delete an account

Account deletion removes the account, its workspace connections and stored credentials, and its coordinator
token records from Postgres. It ends the current session and attempts to revoke each OAuth grant at Linear.
If a revoke fails, remove the app under **Authorized applications** in Linear's settings. Manage any
personal API keys separately in Linear. Project and issue records stay in Linear. Previously sent usage logs follow your Datadog retention policy.

### Service limits

- Each account can have 10 workspace connections including the sign-in workspace, and 10 active coordinator tokens.
- Each account can make 10 personal key checks in 10 minutes. Attaching a workspace and replacing its key use the same limit.
- Each server process uses one Linear request limiter for all accounts, with up to six requests in flight.
- The function configuration allows 300 seconds per invocation. Sockets have a default age of 270 seconds.
  Use 60 to 280 seconds for a custom age with that configuration. Allow at least 20 seconds before the function limit.
  Clients reconnect after a close. If the host pauses the instance, the server checks the Redis connection
  with a fresh ping before reconnecting.

### Checks after a deploy

1. Request `GET /healthz`. Expect HTTP 200 and `{"ok":true}`.
2. Request `GET /api/config` at the public host name. Expect `auth: true`, `readOnly: false`, and `signIn: "linear"`.
   Check that `linkStore` is `"redis"` on a function host or on a deployment with multiple instances.
3. Sign in with an allowed Linear account. Check that the setup guide or the account's workspaces open.
4. Create a coordinator token, run `wg login https://wg.example.com` and the setup commands, then run `wg doctor`.
   Check that it accepts the token and that the page shows the coordinator connection.

For local testing, run `pnpm build` and `pnpm service:dev` to start a preview with a temporary database and stub Linear.
Use the loopback address from the terminal. To attach the second workspace, use the stub key
`lin_api_example00000000000000000000`. Stop the preview with Ctrl-C.

To open the shared project, go to `/auth/login?as=ada` on the loopback address. Open **Example project** and select **Share**.
To see the project as a collaborator, go to `/auth/login?as=grace` and open the shared **Example project**.
Use `/auth/login?as=pat` for the viewer. To see a Linear access refusal, start the preview with `pnpm service:dev --refuse-access`.

## Share a project

On a hosted service, the **Read-only link** lets a member read the shared project. The
**Collab link** also lets a member edit the project and run its nodes.
The owner keeps pause and resume, autonomy, review effort, closing the effort,
sharing, and member management. The owner handles merge points, ship points,
ops nodes, decisions, and deploys.

### Set up sharing as the owner

1. Open a project in your Linear sign-in workspace and select **Share**. Select
   **Make link** for each role you want to offer. Copy the link before you close
   the dialog. Keep each link secret. Anyone with the link can sign in with
   Linear and join with its role. Send it only to the intended person. The
   host's access logs and browser history can hold the join address. If a link
   goes to the wrong place, use **New link** to stop the old link and make a new one.
2. For CLI collaboration, set `effort.team` in the plan. Sign in with `wg login <page-url>`,
   set the workspace's `page_url` to the page address in the local config,
   load the plan with `wg load <plan-dir> --apply`, then run `wg share <plan-dir>`
   to publish the first plan version.
3. In **Members**, set a member's role or select **Remove** to end their access.
   **Turn off** stops new joins. Turning off or replacing a link keeps existing
   memberships. Removing a member or changing their role to viewer releases
   their claims.

### Join as a collaborator

1. Open the **Collab link** in a browser. Sign in with Linear and select
   **Join**. Open the project under **Shared projects**.
2. Create a coordinator token in **Settings**. Run `wg login https://wg.example.com`
   with your page address and paste the token at the prompt. Match the local
   `human` setting to your display name on the page.
3. Run `wg join https://wg.example.com` from your repository checkout. Use your
   own Linear key with access to the project's team. Give the CLI the page
   address. It refuses the **Collab link**. Follow the printed instructions
   if you need to add the key or create the coordinator worktree.
4. The page uses your own Linear connection for writes. If the page asks for
   a workspace key, attach your own in **Settings**. If you lack team access,
   select **Request access**. The owner selects **Add access** in **Members**
   to add an existing workspace member to the team or confirm an email
   invitation. An invitation can add a seat to the Linear plan.

See [Join as a collaborator](skills/work-graph/references/collab.md#join-as-a-collaborator)
for worktree setup and how to leave.

### Run work together

A coordinator claims a node before dispatch. The lease lasts 10 minutes by
default. `wg next` and `wg tick` renew claims for local run rows. Another
coordinator sees `wait collaborator <person> <key>: job=<job>` and leaves
that node to the holder. A `note stale` line means the lease expired.
Ask your human before you take it with `wg claim <plan-dir> <key> <job> --takeover`.
The owner can release another holder's claim on the page.
Each person uses their own `Needs <name>` status in the project's Linear team.

Use `wg pull <plan-dir>` to fetch the shared plan version. Use
`wg load <plan-dir> --apply` to update Linear and publish your changes.
The service stores the full plan, including the writer's test command, lint,
rules, agents, and team settings. Every project member can read the current
plan. Keep secrets out of `plan.json`. Each coordinator uses local settings
until they choose `wg pull <plan-dir> --accept-settings`.

If a newer version blocks the write, pull it, compare the changes, and
apply your edits to the new version before you publish again. See
[Resolve a version conflict](skills/work-graph/references/collab.md#resolve-a-version-conflict)
for local edits and HTTP 412.

The owner and collaborators can see shared worker questions and progress.
Each account sees only its own agent lines. See
[The agents on the page](#the-agents-on-the-page).

### Sharing limits

- A project can have 50 members in addition to the owner. Its link room can
  hold up to eight collaborator accounts that connect a coordinator or
  send a page command. The owner has a place in addition.
- A project can have 200 live node claims. A lease can last 30 to 3600 seconds.
- A plan write can contain up to 1 MiB of JSON, including the keymap. The
  maximum nesting depth is 64. The service keeps the latest 50 versions.

A config installation shares read access with the Linear project label
`shared`. See [Give owners and viewers access on one hosted page](#give-owners-and-viewers-access-on-one-hosted-page)
and [Host a read-only viewer](#host-a-read-only-viewer).

## Usage data

Usage data is off by default. To enable it, set these values in the server environment.

- `DD_API_KEY` is the Datadog intake key. Keep it secret.
- `WG_TELEMETRY_WORKSPACES` lists the Linear workspaces to include. Use a comma or space between entries. An entry can be a Linear organization ID or URL key. A config installation also accepts the workspace ID from the config. The list applies to every project in each listed workspace.
- `DD_SITE` selects the Datadog site. The default is `datadoghq.com` (US1). A value outside the [list of accepted sites](server/telemetry.ts) turns usage data off without a log message.
- `WG_SESSION_SECRET` must have at least 32 characters. The server derives a separate key from this secret to hash account and workspace IDs.

The server sends count metrics and logs for sign-ups, sign-ins, account changes, setup progress, coordinator connections, page views, node opens, and types of page writes. Account events use the Linear workspace for sign-in. Other events use the workspace where the action occurred. Logs contain hashed account and workspace IDs. The data contains no names, email addresses, project or issue IDs, issue text, or tokens. The page sends its events through the server. The `wg` CLI sends no usage data.

When the operator enables usage data, each account in a listed workspace sends it. Accounts have no usage data switch. To turn off usage data for all accounts, the operator can remove `DD_API_KEY` or clear `WG_TELEMETRY_WORKSPACES`.

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

For Vercel settings, see [Vercel](#vercel).

For the `Dockerfile`, set `WG_READ_ONLY=1`, `WG_HOSTED`, and the workspace and sign-in values in
the [Vercel settings table](#vercel).

Checks of a viewer: `GET /healthz` gives `{"ok":true}`; `GET /api/config` gives `"readOnly":true,"auth":true`;
`GET /api/projects` without a session gives 401; a `POST` to any API path gives 405.

## The contract between `wg` and the page

`skills/work-graph/contract.json` holds the status names, the node card format, the link protocol, and the rule
that says when a blocker is done. `wg contract --write` makes it from the native CLI, and it does not depend on the local
config. The tests of both parts read it: `python3 -m unittest` in `tests/cli-parity/reference`, and `pnpm test`
here. After a CLI contract change, write the file again and change the page until both pass.

## License

MIT. See [LICENSE](LICENSE).
