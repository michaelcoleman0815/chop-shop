#!/usr/bin/env bash
# Fetches the caption faces. A preset naming a font that is not here does not
# fail: libass quietly substitutes something else, so the style renders wrong
# with no error anywhere.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/resources/fonts"
mkdir -p "$DEST"

fetch() {
  local name="$1" url="$2"
  if [ -s "$DEST/$name" ]; then echo "have $name"; return; fi
  curl -fsSL --retry 3 -o "$DEST/$name" "$url"
  echo "fetched $name"
}

BASE="https://raw.githubusercontent.com/google/fonts/main"
# Variable files where that is all upstream ships; libass takes the default
# instance, which is the weight these presets ask for.
fetch "Sora.ttf"          "$BASE/ofl/sora/Sora%5Bwght%5D.ttf"
fetch "Anton-Regular.ttf" "$BASE/ofl/anton/Anton-Regular.ttf"
