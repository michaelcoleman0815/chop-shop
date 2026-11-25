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
# A soft display serif, Ali Abdaal's: Fraunces at its softest (SOFT 100, WONK 0), weight 420 at opsz 80, 600 and 760 at 144.
# Upstream ships only the variable family, so the two static instances are cut from it with fontTools, and kept in
# the repository; this rebuilds them only when they are missing and fontTools is there. SIL Open Font License 1.1.
fetch "Fraunces-OFL.txt" "$BASE/ofl/fraunces/OFL.txt"
if [ ! -s "$DEST/Fraunces-Soft.ttf" ] || [ ! -s "$DEST/Fraunces-SoftSemiBold.ttf" ] || [ ! -s "$DEST/Fraunces-SoftBold.ttf" ]; then
  if python3 -c "import fontTools" 2>/dev/null; then
    TMPF="$(mktemp -d)"
    curl -fsSL --retry 3 -o "$TMPF/fraunces.ttf" "$BASE/ofl/fraunces/Fraunces%5BSOFT,WONK,opsz,wght%5D.ttf"
    # The regular at optical size 80, where its proportions match Ali Abdaal's words; the heavier two at 144.
    for pair in "Fraunces-Soft.ttf:420:Fraunces:80" "Fraunces-SoftSemiBold.ttf:600:Fraunces SemiBold:144" "Fraunces-SoftBold.ttf:760:Fraunces Bold:144"; do
      IFS=: read -r file weight family opsz <<< "$pair"
      python3 - "$TMPF/fraunces.ttf" "$DEST/$file" "$weight" "$family" "$opsz" <<'PY'
import sys
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
src, out, weight, family, opsz = sys.argv[1], sys.argv[2], float(sys.argv[3]), sys.argv[4], float(sys.argv[5])
font = instantiateVariableFont(TTFont(src), {'opsz': opsz, 'SOFT': 100, 'WONK': 0, 'wght': weight}, updateFontNames=False)
for rec in font['name'].names:
    if rec.nameID in (1, 4, 16): rec.string = family
    if rec.nameID == 6: rec.string = family.replace(' ', '-')
    if rec.nameID in (2, 17): rec.string = 'Regular'
font.save(out)
PY
      echo "made $file"
    done
    rm -r "$TMPF"
  else
    echo "Fraunces instances missing and fontTools is not installed: pip3 install fonttools" >&2
  fi
else
  echo "have Fraunces"
fi
# A condensed grotesque in heavy capitals, the title Lecrae's Shorts hold over the chest. SIL Open Font License 1.1.
fetch "BarlowCondensed-ExtraBold.ttf" "$BASE/ofl/barlowcondensed/BarlowCondensed-ExtraBold.ttf"
fetch "BarlowCondensed-OFL.txt"       "$BASE/ofl/barlowcondensed/OFL.txt"
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
# The type of an app drawn on screen (a chat box, a document), as Ali Abdaal draws them: Figtree's regular,
# semibold, bold and italic, cut with fontTools from the variable family the interface already bundles
# (@fontsource-variable/figtree), and kept in the repository. SIL Open Font License 1.1, kept beside them.
FIG="$ROOT/node_modules/@fontsource-variable/figtree"
if [ ! -s "$DEST/Figtree-Regular.ttf" ] || [ ! -s "$DEST/Figtree-Italic.ttf" ]; then
  if [ -d "$FIG" ] && python3 -c "import fontTools, brotli" 2>/dev/null; then
    cp "$FIG/LICENSE" "$DEST/Figtree-OFL.txt"
    for spec in "normal:Figtree-Regular.ttf:400:Figtree" "normal:Figtree-SemiBold.ttf:600:Figtree SemiBold" \
                "normal:Figtree-Bold.ttf:700:Figtree Bold" "italic:Figtree-Italic.ttf:400:Figtree Italic"; do
      IFS=: read -r style file weight family <<< "$spec"
      python3 - "$FIG/files/figtree-latin-wght-$style.woff2" "$DEST/$file" "$weight" "$family" <<'PY'
import sys
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
src, out, weight, family = sys.argv[1], sys.argv[2], float(sys.argv[3]), sys.argv[4]
font = instantiateVariableFont(TTFont(src), {'wght': weight}, updateFontNames=False)
for rec in font['name'].names:
    if rec.nameID in (1, 4, 16): rec.string = family
    if rec.nameID == 6: rec.string = family.replace(' ', '-')
    if rec.nameID in (2, 17): rec.string = 'Regular'
font.flavor = None
font.save(out)
PY
      echo "made $file"
    done
  else
    echo "Figtree instances missing: npm install, then pip3 install fonttools brotli" >&2
  fi
else
  echo "have Figtree"
fi
