# work-graph agents (Orca plugin)

Replies from the work-graph page reach an agent only through a `wg agents` process in an Orca terminal.
This plugin keeps that process running, so you do not have to keep a terminal open.

## What it does

- When Orca starts, and when a terminal or an agent changes, it checks the terminal that it started.
  It also checks each minute while its worker runs.
- When that terminal is gone, it opens a new background terminal named `wg agents` that runs
  `while :; do wg agents --wait; sleep 10; done`.
- `--wait` lets the new sender wait while another sender holds the lock. The loop starts the sender again
  when it exits, for example after `wg.py` changed.
- It opens the terminal in the Orca workspace that the setting "Workspace path" names. When that is empty,
  it uses the first local checkout named `work-graph`.
- The palette command "work-graph: start wg agents" runs the check now and shows the result.

## Install

1. Stop the launchd sender if it runs: `wg agents --uninstall`, then run the `launchctl` command it prints.
   It cannot send replies, and it holds the lock.
2. Install the plugin from your checkout: `orca plugin install <checkout>/orca-plugin --json`.
   Orca prints the access the plugin asks for and the command with `--approve`. Read it, then run that command.
3. Check: `orca plugin logs <plugin key>` shows `started wg agents`, and `wg doctor <plan-dir>` shows the sender.

`wg` must be on the `PATH` of your login shell.

## Develop

- `orca plugin test orca-plugin --json` runs `src/worker.test.ts`.
- `orca plugin validate orca-plugin --json` checks the manifest.
