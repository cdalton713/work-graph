#!/usr/bin/env bash
# Sign only assets checked against the tagged files and native parity results.
set -euo pipefail
tag=$1
artifacts=$2
output=$3
umask 077
key_dir=$(mktemp -d)
trap 'rm -rf "$key_dir"' EXIT
printf '%s\n' "$WG_SIGNING_KEY" > "$key_dir/private.pem"
unset WG_SIGNING_KEY
openssl pkey -in "$key_dir/private.pem" -pubout -outform DER -out "$key_dir/public.der"
# RFC 8410 SubjectPublicKeyInfo for Ed25519, followed by the 32 raw key bytes.
test "$(xxd -p -c 100 "$key_dir/public.der")" = "302a300506032b6570032100$WG_CURRENT_PUBLIC_KEY"
mkdir "$output"
for target in aarch64-apple-darwin x86_64-apple-darwin aarch64-unknown-linux-gnu x86_64-unknown-linux-gnu; do
  directory="$artifacts/release-$target"
  python3 -I packaging/releases/package.py check "$tag" "$target" "$directory"
  name="$tag-$target"
  for ext in tar.gz json parity.json parity.log; do
    cp "$directory/$name.$ext" "$output/"
  done
  openssl pkeyutl -sign -rawin -inkey "$key_dir/private.pem" \
    -in "$output/$name.json" -out "$output/$name.sig"
  openssl pkeyutl -verify -rawin -pubin -keyform DER -inkey "$key_dir/public.der" \
    -in "$output/$name.json" -sigfile "$output/$name.sig"
done
