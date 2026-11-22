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
# A bold display serif, one word at a time: the sermon look (The Life Church's own Shorts).
fetch "DMSerifDisplay-Regular.ttf" "$BASE/ofl/dmserifdisplay/DMSerifDisplay-Regular.ttf"
fetch "DMSerifDisplay-OFL.txt"     "$BASE/ofl/dmserifdisplay/OFL.txt"
# Tall condensed capitals, one word at a time: the sermon look 2819 Church posts. SIL Open Font License 1.1.
fetch "BebasNeue-Regular.ttf" "$BASE/ofl/bebasneue/BebasNeue-Regular.ttf"
fetch "BebasNeue-OFL.txt"     "$BASE/ofl/bebasneue/OFL.txt"
# The sermon captions and hook titles: Inter's static SemiBold and ExtraBold, whose family names are their own,
# from the type's own release. SIL Open Font License 1.1, kept beside them.
if [ ! -s "$DEST/Inter-SemiBold.ttf" ] || [ ! -s "$DEST/Inter-ExtraBold.ttf" ]; then
  TMP="$(mktemp -d)"
  curl -fsSL --retry 3 -o "$TMP/inter.zip" "https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip"
  unzip -o -q -j "$TMP/inter.zip" extras/ttf/Inter-SemiBold.ttf extras/ttf/Inter-ExtraBold.ttf -d "$DEST"
  unzip -o -q -p "$TMP/inter.zip" LICENSE.txt > "$DEST/Inter-OFL.txt"
  rm -r "$TMP"
  echo "fetched Inter"
else
  echo "have Inter"
fi

# The caption faces short-form video is set in (watched 2026-11-21), one static weight a file, from Google Fonts'
# own static instances (its CSS API hands a plain client .ttf files): Montserrat and TikTok Sans, and Inter's Bold
# under its plain family name (the type's own release gives the SemiBold and ExtraBold above). Each is SIL Open
# Font License 1.1, kept beside it.
css() { curl -fsSL "https://fonts.googleapis.com/css?family=$1" | grep -oE 'https://fonts.gstatic.com/[^)]+' | head -1; }
fetch "Montserrat-ExtraBold.ttf"  "$(css Montserrat:800)"
fetch "Montserrat-Black.ttf"      "$(css Montserrat:900)"
fetch "Inter-Bold.ttf"            "$(css Inter:700)"
fetch "TikTokSans-ExtraBold.ttf"  "$(css TikTok+Sans:800)"
fetch "TikTokSans-Black.ttf"      "$(css TikTok+Sans:900)"
fetch "Montserrat-OFL.txt"        "$BASE/ofl/montserrat/OFL.txt"
fetch "TikTokSans-OFL.txt"        "$BASE/ofl/tiktoksans/OFL.txt"
