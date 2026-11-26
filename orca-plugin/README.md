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
- A `wg agents` item in Orca's status bar shows the state: green check (it runs), yellow warning (no workspace),
  gray pause (turned off), red error (the check failed). Its tooltip names the time of the last check.
  Click it to check now. Orca keeps the worker of a plugin with a status bar item running.

## Install

1. Run `wg agents --install`. It prints the access the plugin asks for and a command with `--approve`.
   It also removes the launchd sender of older versions, which cannot send replies and holds the lock.
2. Read the access, then run the printed `wg agents --install --approve <fingerprint>`.
3. Check: `wg doctor` shows `agents: the Orca plugin … keeps wg agents running`.

After you update the checkout, run `wg agents --install` again: it updates the plugin when its files changed.

`wg` must be on the `PATH` of your login shell.

## Develop

- `orca plugin test orca-plugin --json` runs `src/worker.test.ts`.
- `orca plugin validate orca-plugin --json` checks the manifest.
