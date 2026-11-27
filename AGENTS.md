# work-graph: agent notes

This repository is public. Its code and docs name no person, company, team, domain, or host. Each installation's
names live in that installation's work-graph config (README "Config"): the human's name, workspaces, page URL,
branch prefix, release branch, and test runner.

## Hosting

A host serves only the page and its API. The coordinator and workers run on the user's machine.
Each user who runs an effort needs access to Linear and a local installation of `gh`, `st`, Orca,
the native `wg`, and an agent CLI (Claude Code or Codex).

The `Dockerfile` and Vercel support both modes. A live function test with managed Redis verified the
bearer-token WebSocket upgrade, ping and pong frames, and the planned socket close before the function
time limit. Keep each new hosting feature off by default. Read deployment names from the installation
config and environment. Keep deployment-specific settings out of the repository.

Each new service feature stays off until you set its environment value. Keep installation names
and secrets out of the repository.

## Before each push

1. `pnpm test` and `pnpm build` (the page).
2. `python3 -m unittest test_wg` in `tests/cli-parity/reference` (the development oracle; Python 3.11 or later). `pnpm test`
   does not run it.
3. Run `cargo test --locked --manifest-path cli/Cargo.toml` for the native CLI.
4. After a CLI change that touches names, the node card, the link, or the edge rule: `wg contract --write`,
   then change the page until both suites pass (README "The contract between `wg` and the page").

## Deploy

A push does not deploy the hosted page. The local rules file holds the deploy and check steps of this machine's
hosted page: run `wg config`, read the file at `rules`, and follow its "The page" section after each push to `main` that changes more than Markdown files.
Without a rules file, no hosted page is set up here, and there is nothing to deploy.
