#!/usr/bin/env bash
# Sign only assets checked against the tagged files and native parity results.
set -euo pipefail
tag=$1
artifacts=$2
output=$3
umask 077
private_key=$WG_SIGNING_KEY
unset WG_SIGNING_KEY
mkdir "$output"
for target in aarch64-apple-darwin x86_64-apple-darwin aarch64-unknown-linux-gnu x86_64-unknown-linux-gnu; do
  directory="$artifacts/release-$target"
  python3 -I packaging/releases/package.py check "$tag" "$target" "$directory"
  name="$tag-$target"
  for ext in tar.gz json parity.json parity.log; do
    cp "$directory/$name.$ext" "$output/"
  done
  printf '%s\n' "$private_key" | "$WG_RELEASE_SIGNER" "$output/$name.json" > "$output/$name.sig"
done
