# work-graph: agent notes

This repository is public. Its code and docs name no person, company, team, domain, or host. Each installation's
names live in that installation's work-graph config (README "Config"): the human's name, workspaces, page URL,
branch prefix, release branch, and test runner.

## Hosting

A host serves only the page and its API. The coordinator and workers run on the user's machine.
Each user who runs an effort needs access to Linear and a local installation of `gh`, `st`, Orca,
`uv`, and an agent CLI (Claude Code or Codex).

The `Dockerfile` and Vercel support the full page and the read-only viewer. Keep each new
hosting feature off by default. Read deployment names from the installation config and
environment. Keep deployment-specific settings out of the repository.

## Before each push

1. `pnpm test` and `pnpm build` (the page).
2. `python3 -m unittest test_wg` in `skills/work-graph/scripts` (the skill; Python 3.11 or later). `pnpm test`
   does not run it.
3. After a change of `wg.py` that touches names, the node card, the link, or the edge rule: `wg contract --write`,
   then change the page until both suites pass (README "The contract between `wg` and the page").

## Deploy

A push does not deploy the hosted page. The local rules file holds the deploy and check steps of this machine's
hosted page: run `wg config`, read the file at `rules`, and follow its "The page" section after each push to `main` that changes more than Markdown files.
Without a rules file, no hosted page is set up here, and there is nothing to deploy.
