#!/usr/bin/env bash
# Prints the oldest macOS the app runs on: electron-builder.yml's
# mac.minimumSystemVersion. The helpers are built for this same version, so a
# Mac the app opens on can always run them.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
v="$(awk '/^mac:/ { m = 1; next } m && /^[^ #]/ { m = 0 } m && $1 == "minimumSystemVersion:" { gsub(/["'\'']/, "", $2); print $2; exit }' "$ROOT/electron-builder.yml")"
[ -n "$v" ] || { echo "electron-builder.yml sets no mac.minimumSystemVersion" >&2; exit 1; }
echo "$v"
