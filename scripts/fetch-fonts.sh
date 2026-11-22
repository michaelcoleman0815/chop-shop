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
# Engraved documentary titles. SIL Open Font License 1.1, kept beside it.
fetch "Cinzel.ttf"        "$BASE/ofl/cinzel/Cinzel%5Bwght%5D.ttf"
fetch "Cinzel-OFL.txt"    "$BASE/ofl/cinzel/OFL.txt"

# The caption faces short-form video is set in, one static weight a file, from Google Fonts' own static instances
# (its CSS API hands a plain client .ttf files). Each is SIL Open Font License 1.1, kept beside it.
css() { curl -fsSL "https://fonts.googleapis.com/css?family=$1" | grep -oE 'https://fonts.gstatic.com/[^)]+' | head -1; }
fetch "Montserrat-ExtraBold.ttf"  "$(css Montserrat:800)"
fetch "Montserrat-Black.ttf"      "$(css Montserrat:900)"
fetch "Inter-Bold.ttf"            "$(css Inter:700)"
fetch "Inter-ExtraBold.ttf"       "$(css Inter:800)"
fetch "BebasNeue-Regular.ttf"     "$(css Bebas+Neue)"
fetch "TikTokSans-ExtraBold.ttf"  "$(css TikTok+Sans:800)"
fetch "TikTokSans-Black.ttf"      "$(css TikTok+Sans:900)"
for face in montserrat inter bebasneue tiktoksans; do fetch "$face-OFL.txt" "$BASE/ofl/$face/OFL.txt"; done
