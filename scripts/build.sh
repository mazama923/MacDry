#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "MacDry must be built on an Apple Silicon Mac." >&2
  exit 1
fi

command -v gleam >/dev/null || { echo "Gleam is required to build MacDry." >&2; exit 1; }
command -v deno >/dev/null || { echo "Deno is required to build MacDry." >&2; exit 1; }

gleam build --target javascript
mkdir -p dist
deno compile \
  --no-prompt --no-remote --no-npm \
  --allow-read=public \
  --allow-net=127.0.0.1 \
  --allow-run=/usr/bin/sw_vers,/usr/sbin/sysctl,/bin/df,/usr/sbin/system_profiler,/usr/bin/pmset,/usr/bin/open,/usr/bin/osascript,/usr/bin/networkQuality,/usr/bin/log \
  --include public \
  --output dist/macdry \
  server.mjs

printf '\nBuilt dist/macdry. Run it from Terminal: ./dist/macdry\n'
