# CLI releases

The release workflow accepts stable tags of the form `wg-vMAJOR.MINOR.PATCH`. A tag with the suffix `-rc.N` produces a prerelease. Each numeric part is a decimal integer with no leading zero. A stable installer or updater must exclude prereleases. Protect these tags against changes and restrict the `release` environment to approved release tags and maintainers.

## Assets and verification

For each Rust target triple, the asset prefix is `<tag>-<target>`. The four targets are `aarch64-apple-darwin`, `x86_64-apple-darwin`, `aarch64-unknown-linux-gnu`, and `x86_64-unknown-linux-gnu`.

- `.tar.gz` contains regular files at relative paths. The executable is `wg` with mode 0755. All tracked blobs under `skills/work-graph/` and `orca-plugin/` have their names, bytes and executable modes from the tagged commit.
- `.json` is the schema 1 manifest, encoded as UTF-8. The producer sorts keys and ends the document with one LF. The signature input is **every original byte**, including the final LF.
- `.sig` contains the 64 raw bytes of the detached Ed25519 signature.
- `.parity.json` records the target, tagged commit, archive SHA-256, parity process exit code, and SHA-256 of `.parity.log`. The log contains the frozen suite output for the extracted binary. The workflow checks these records before signing.

| JSON field | Required value |
| --- | --- |
| `schema` | Integer 1 |
| `version` | Tag text after `wg-v`, including any candidate suffix |
| `target` | Rust target triple |
| `commit` | 40 lowercase hexadecimal digits of the tagged Git commit |
| `sha256` | SHA-256 of the compressed archive, in lowercase hexadecimal |
| `files` | Object mapping each relative file path to its SHA-256 in lowercase hexadecimal |
| `public_key` | 32-byte Ed25519 public key embedded in the packaged executable, in lowercase hexadecimal |

The initial installer needs a public key obtained through a separately authenticated channel. For subsequent updates, use the key from the installed release. The Rust module `wg_preview::release` supplies `public_key` for the initial pin, `embedded_key` for an installed binary, and `verify_manifest` for both consumers. Pass the trusted key, original manifest bytes, raw signature, requested version and host target to the verifier. Enforce the channel and version policy before installation.

Call `verify_digest` on the compressed archive using the authenticated `sha256`. Extract only the regular files listed in `files`, once each, under a new private staging directory. Reject missing members, extra members, links, unsafe paths and special modes. Call `verify_digest` on each file using its authenticated digest. Install the CLI, skill, and plugin together after all checks pass.

## Signing and recovery

In the protected release environment, set `WG_CURRENT_PUBLIC_KEY` to the current raw public key in lowercase hexadecimal. Set the secret `WG_SIGNING_KEY` to its Ed25519 private key in unencrypted PKCS#8 PEM format. Keep private keys in protected secret storage. The workflow builds the release signer from its own Cargo lockfile before it reads the secret. The signing step passes the PEM to the signer on standard input. The signer checks its public key against the protected pin and writes the 64 signature bytes to standard output. The managed CLI ships separately.

The workflow builds with a fixed Rust version, pinned actions, and `Cargo.lock`. Each native runner extracts its own archive, checks the embedded key and version, and runs `sh tests/cli-parity/run.sh` with the absolute path to the extracted executable. Publication requires a successful matrix and a second check of the four archives, tagged resources and evidence. A failed parity run retains its exit code and log in the workflow artifacts.

For normal rotation, set `WG_NEXT_PUBLIC_KEY` to the successor's public key. Keep the current signing secret and current pin for the transition release. The old key signs the manifest that authenticates the executable with the new key. After that release, promote the successor to current pin and signing secret and clear the next-key variable. Clients with the old key must install the authenticated transition release before a release signed by the new key. Keep the transition assets available.

After suspected compromise, stop automated publication and updates, revoke the signing secret, and disable use of the compromised pin. Generate a new key outside the repository. Distribute the replacement pin and recovery installer digest through a separately authenticated channel independent of the release host and old key. Verify the installer and new pin through that channel. Manually reinstall the CLI, skill, and plugin together from a release verified with the new pin. Resume updates from the new installation.

Run `cargo test --locked --manifest-path cli/Cargo.toml --test release` to check verification, rotation, and the publication gate. The tests use a temporary tagged repository, disposable keys and simulated native parity processes. A release tag runs the actual frozen suite on all four native runners.
