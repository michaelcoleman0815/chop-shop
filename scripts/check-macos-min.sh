#!/usr/bin/env bash
# Fails when a bundled binary needs a newer macOS than the app says it runs on.
# macOS opens the app on any version its Info.plist allows, but a helper built
# for a newer one refuses to launch there, and transcription (whisper-cli) or
# face tracking (chopshop-vision) would fail with no clear reason.
#
#   check-macos-min.sh            the helpers in resources/bin
#   check-macos-min.sh App.app    a built app: its Info.plist, its helpers, and
#                                 a warning for any other binary inside it
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIN="$("$ROOT/scripts/macos-min.sh")"

# The oldest macOS a Mach-O file loads on, as its load commands record it
# (the arm64 slice of a universal binary).
minos() {
  # awk reads to the end rather than exiting early, so otool never meets a
  # closed pipe (which pipefail would turn into a failure).
  { otool -arch arm64 -l "$1" 2>/dev/null || otool -l "$1"; } | awk '
    /cmd LC_BUILD_VERSION/ { b = 1; next }
    /cmd LC_VERSION_MIN_MACOSX/ { v = 1; next }
    !found && b && $1 == "minos" { r = $2; found = 1 }
    !found && v && $1 == "version" { r = $2; found = 1 }
    END { if (found) print r }'
}

# Whether version $1 is newer than version $2.
newer() {
  awk -v a="$1" -v b="$2" 'BEGIN {
    n = split(a, x, "."); m = split(b, y, "."); k = n > m ? n : m
    for (i = 1; i <= k; i++) { if (x[i] + 0 > y[i] + 0) exit 0; if (x[i] + 0 < y[i] + 0) exit 1 }
    exit 1 }'
}

is_macho() { file -b "$1" | grep -q 'Mach-O'; }

fail=0
# $1 file, $2 "error" or "warning"
check() {
  local need
  need="$(minos "$1")"
  if [ -z "$need" ]; then
    echo "::$2::$1 records no minimum macOS"
    [ "$2" = error ] && fail=1
    return 0
  fi
  if newer "$need" "$MIN"; then
    echo "::$2::$1 needs macOS $need, newer than the $MIN the app says it runs on"
    [ "$2" = error ] && fail=1
  else
    echo "ok   macOS $need  $1"
  fi
}

if [ $# -eq 0 ]; then
  for f in "$ROOT"/resources/bin/*; do
    [ -f "$f" ] && is_macho "$f" && check "$f" error
  done
else
  APP="$1"
  declared="$(plutil -extract LSMinimumSystemVersion raw "$APP/Contents/Info.plist")"
  if [ "$declared" != "$MIN" ]; then
    echo "::error::$APP declares macOS $declared in its Info.plist, but electron-builder.yml says $MIN"
    fail=1
  else
    echo "ok   $APP declares macOS $declared"
  fi
  # Ours, which must run wherever the app opens.
  for f in "$APP/Contents/MacOS/"* "$APP"/Contents/Resources/bin/*; do
    [ -f "$f" ] && is_macho "$f" && check "$f" error
  done
  # Everything else (Electron, ffmpeg, native modules): a warning, since a
  # prebuilt binary's minimum is its maker's choice, but worth knowing.
  while IFS= read -r -d '' f; do
    case "$f" in "$APP/Contents/MacOS/"*|"$APP/Contents/Resources/bin/"*) continue ;; esac
    is_macho "$f" && check "$f" warning
  done < <(find "$APP/Contents" -type f \( -perm -u+x -o -name '*.node' -o -name '*.dylib' \) -print0)
fi
exit $fail
