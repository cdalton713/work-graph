# Install a managed CLI

Choose a stable release and the matching CPU and OS from the [release format](../releases/README.md). Obtain the bootstrap SHA-256 and the raw 32-byte Ed25519 release public key in lowercase hexadecimal through an authenticated channel independent of the download location. The bootstrap uses only the Go standard library. Run it as the account that will use the CLI.

## Fresh installation

Use a private empty working directory. Set REPO to the release repository in owner/repository form, VERSION to the numeric release version, TARGET to the Rust target triple, BOOTSTRAP_SHA256 to the independently obtained digest of install.go, and RELEASE_KEY to the separately obtained public key. With the GitHub CLI, Go 1.20 or later, and shasum available, run:

```sh
set -eu
tag="wg-v$VERSION"
gh api -H 'Accept: application/vnd.github.raw+json' \
  "repos/$REPO/contents/packaging/install/install.go?ref=$tag" > install.go
printf '%s  install.go\n' "$BOOTSTRAP_SHA256" | shasum -a 256 -c -
prefix="$tag-$TARGET"
gh release download "$tag" --repo "$REPO" --dir assets \
  --pattern "$prefix.json" --pattern "$prefix.sig" --pattern "$prefix.tar.gz"
GO111MODULE=off GOTOOLCHAIN=local go build -o wg-install install.go
./wg-install -assets ./assets -version "$VERSION" -key "$RELEASE_KEY"
"$HOME/.local/bin/wg" --version
```

Use a tag that includes the bootstrap source. An administrator can also build the verified source for the target OS and CPU on a separate machine and distribute the bootstrap executable with its own separately authenticated digest. On an offline machine, verify that executable against its digest and run the same `./wg-install` command with the three local assets. The executable has no Go toolchain, Git checkout, Python, or uv dependency.

The installer authenticates the manifest, matches the stable version and host target, checks the archive hash and verifies every member in private staging. It checks the authenticated binary's version and embedded key before activation.

## Ownership and migration

- A release occupies `~/.local/share/work-graph/versions/<version>-<target>/`. This directory contains `wg`, `skills/work-graph/`, `orca-plugin/`, the original `manifest.json`, its raw `manifest.sig`, and `signer` (the verifying public key in lowercase hex with no newline).
- Under `~/.local/share/work-graph/`, `current` points to the relative version directory. The absolute target of `~/.local/bin/wg` is `~/.local/share/work-graph/current/wg`, with the home directory expanded. The installer takes an exclusive flock on the open managed root directory. A version switch replaces the link with rename. `previous` retains the preceding verified directory. Old versions stay on disk.
- An existing managed installation accepts the same release or a newer stable version signed with the active binary's authenticated manifest key. The installer checks installed manifest file hashes and preserves edited resources. If it reports a local change, retain a copy of the edited version before reconciling it.
- To migrate the documented symlink to a checkout's `skills/work-graph/scripts/wg.py`, repeat the install command with `-migrate-source`. This changes only the launcher. Source files, external skill and plugin registrations, configuration, and credentials stay with their owner. A different launcher or package-manager installation requires action by its owner.
- Use the skill and plugin from the same version as the binary. Installing the bundle grants no Orca permissions. Use the normal plugin installation and fingerprint approval flow when enabling it.

Run the synthetic bootstrap checks from this directory with `GO111MODULE=off go test`.

Add `export PATH="$HOME/.local/bin:$PATH"` to your shell configuration to use the managed launcher. If the installer reports another `wg` on PATH, use `command -v wg` to identify its owner. Keep the existing installation if you still need it. To switch, use its owner's removal or unlink procedure before running the bootstrap again.

Point your skill registration at `~/.local/share/work-graph/current/skills/work-graph`. The matching plugin is in `~/.local/share/work-graph/current/orca-plugin`. Keep any local edits in the old registration and use Orca's normal permission approval when registering the managed plugin.

After an interrupted bootstrap, rerun the same command with the same assets, key, and migration flag. It verifies a previously published version directory before completing the launcher switch. Forward installation preserves edits in an inactive version directory. It sets `previous` to the verified version that was active just before the switch. A rollback consumer must verify the destination before activation, since a user can edit its files after the link is set.
