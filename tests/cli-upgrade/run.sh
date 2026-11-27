#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
target=${1:-$(rustc -vV | sed -n 's/^host: //p')}
cargo fetch --locked --manifest-path cli/Cargo.toml --target "$target"
unset ORCA_CLI_COMMAND
export WG_NATIVE_UPGRADE_TRIAL=1
exec python3 -I tests/cli-parity/update_trial.py "$(command -v cargo)" "$target"
