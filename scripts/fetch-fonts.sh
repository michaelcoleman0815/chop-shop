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
# The faces of the owner's six reference reels (docs/research/sermon-clips.md, "The owner's six reels,
# 22 November"): Instrument Serif in roman and italic, Instrument Sans Bold, and Archivo at its widest and
# heaviest. The last two are the Google Fonts API's static instances of variable families, since captions need
# one fixed face per file.
fetch "InstrumentSerif-Regular.ttf" "$BASE/ofl/instrumentserif/InstrumentSerif-Regular.ttf"
fetch "InstrumentSerif-Italic.ttf"  "$BASE/ofl/instrumentserif/InstrumentSerif-Italic.ttf"
fetch "InstrumentSerif-OFL.txt"     "$BASE/ofl/instrumentserif/OFL.txt"
fetch "InstrumentSans-Bold.ttf"     "https://fonts.gstatic.com/s/instrumentsans/v4/pximypc9vsFDm051Uf6KVwgkfoSxQ0GsQv8ToedPibnr-yp2JGEJOH9npSQi_gf1.ttf"
fetch "InstrumentSans-OFL.txt"      "$BASE/ofl/instrumentsans/OFL.txt"
fetch "ArchivoExpanded-Black.ttf"   "https://fonts.gstatic.com/s/archivo/v25/k3k6o8UDI-1M0wlSV9XAw6lQkqWY8Q8EsJaRE-NWIDdgffTTnTRp8A.ttf"
fetch "Archivo-OFL.txt"             "$BASE/ofl/archivo/OFL.txt"
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
