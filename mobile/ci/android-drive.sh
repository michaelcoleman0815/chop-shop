#!/usr/bin/env bash
# Runs the app's own flow (src/host/drive.ts) on the Android device adb sees
# (the emulator in CI): installs the app, puts the whisper model where the
# app keeps it, the footage where the engine's importer copies picks, and the
# plan in its documents, launches it, and takes a screenshot at every step
# the app says it has reached. Then pulls the app's report and its exports.
#
#   ci/android-drive.sh APK MODELS_DIR FOOTAGE_DIR OUT_DIR
#
# MODELS_DIR holds ggml-base.en.bin; FOOTAGE_DIR is what ci/make-footage.py
# made (the files and drive.json). OUT_DIR gets drive-report.json, screens/,
# Exports/ and logcat.txt. DRIVE_TIMEOUT (seconds, default 2400) bounds it.
# The app must be a debuggable build made with CUTALONG_DRIVE=1.
set -euo pipefail

APK=$1
MODELS=$2
FOOTAGE=$3
OUT=$4
PKG=social.brewed.cutalong
TIMEOUT=${DRIVE_TIMEOUT:-2400}
mkdir -p "$OUT/screens"

app() { adb shell run-as "$PKG" "$@" | tr -d '\r'; }

# A file into the app's own files, through the shell (which may read
# /data/local/tmp where the app may not), checked by its size.
put() {
  local from=$1 to=$2 name
  name=$(basename "$from")
  adb push "$from" "/data/local/tmp/$name" >/dev/null
  adb shell "cat '/data/local/tmp/$name' | run-as $PKG sh -c 'cat > \"files/$to\"'"
  adb shell rm -f "/data/local/tmp/$name"
  local want got
  want=$(wc -c < "$from" | tr -d ' ')
  got=$(app stat -c %s "files/$to")
  [ "$got" = "$want" ] || { echo "::error::$to arrived as $got bytes of $want"; exit 1; }
  echo "$to: $got bytes"
}

adb install -r -t "$APK"
app mkdir -p files/Cutalong/models files/Imported
put "$MODELS/ggml-base.en.bin" Cutalong/models/ggml-base.en.bin
for f in $(python3 -c 'import json, sys; print("\n".join(json.load(open(sys.argv[1]))["files"]))' "$FOOTAGE/drive.json"); do
  put "$FOOTAGE/$f" "Imported/$f"
done
put "$FOOTAGE/drive.json" drive.json
app rm -f files/drive-progress.txt files/drive-ack.txt files/drive-report.json

adb logcat -c || true
adb shell am start -W -n "$PKG/.MainActivity"

start=$SECONDS
seen=""
status=1
why="no report in $TIMEOUT s"
while [ $((SECONDS - start)) -lt "$TIMEOUT" ]; do
  progress=$(app cat files/drive-progress.txt 2>/dev/null | head -n1 || true)
  if [ -n "$progress" ] && [ "$progress" != "$seen" ]; then
    seen=$progress
    n=${progress%% *}
    step=${progress#* }
    echo "$((SECONDS - start)) s: $n $step"
    if [ "$step" = done ]; then
      status=0
      break
    fi
    adb exec-out screencap -p > "$OUT/screens/$(printf %02d "$n")-$step.png"
    adb shell "run-as $PKG sh -c 'echo $n > files/drive-ack.txt'"
    continue
  fi
  if [ -z "$(adb shell pidof "$PKG" | tr -d '\r')" ]; then
    why="the app stopped (last step: ${seen:-none})"
    break
  fi
  sleep 1
done
[ $status = 0 ] || echo "::error::$why"

adb exec-out run-as "$PKG" cat files/drive-report.json > "$OUT/drive-report.json" 2>/dev/null || rm -f "$OUT/drive-report.json"
adb exec-out run-as "$PKG" tar -C files -cf - Exports | tar -xf - -C "$OUT" || echo "::warning::no exports to pull"
adb logcat -d > "$OUT/logcat.txt" || true
grep -E "\[drive\]|Capacitor/Console|AndroidRuntime|FATAL" "$OUT/logcat.txt" | tail -n 120 || true
[ -s "$OUT/drive-report.json" ] || { echo "::error::the app wrote no report"; exit 1; }
exit $status
