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

# Room for the whole flow: the debug build logs every line the engine prints.
adb logcat -G 16M || true
adb logcat -c || true
adb shell am start -W -n "$PKG/.MainActivity"

start=$SECONDS
seen=""
gone=0
sampled=0
status=1
why="no report in $TIMEOUT s"
while [ $((SECONDS - start)) -lt "$TIMEOUT" ]; do
  progress=$(app cat files/drive-progress.txt 2>/dev/null | head -n1 || true)
  # The flow says its first step within a minute or two of the app starting; nothing by then is a stop.
  if [ -z "$seen" ] && [ -z "$progress" ] && [ $((SECONDS - start)) -gt 240 ]; then
    why="the app showed no step of its flow in 240 s: it did not find drive.json, or could not start"
    break
  fi
  if [ -n "$progress" ] && [ "$progress" != "$seen" ]; then
    seen=$progress
    n=${progress%% *}
    step=${progress#* }
    echo "$((SECONDS - start)) s: $n $step"
    if [ "$step" = done ]; then
      status=0
      break
    fi
    adb exec-out screencap -p > "$OUT/screens/$(printf %02d "$n")-$step.png" || echo "::warning::no screenshot at $step"
    adb shell "run-as $PKG sh -c 'echo $n > files/drive-ack.txt'" || true
    continue
  fi
  # Gone only when the device itself says so five times in a row: an emulator busy exporting can
  # leave adb without an answer, which is no news either way.
  alive=$(adb shell "pidof $PKG >/dev/null && echo yes || echo no" 2>/dev/null | tr -d '\r' || true)
  # The app's memory every 15 s, and the device's, for when it is stopped.
  if [ "$alive" = yes ] && [ $((SECONDS - sampled)) -ge 15 ]; then
    sampled=$SECONDS
    pss=$(adb shell dumpsys meminfo "$PKG" 2>/dev/null | tr -d '\r' | awk '/TOTAL PSS:/ { print $3; exit } /^ *TOTAL / { print $2; exit }')
    free=$(adb shell cat /proc/meminfo 2>/dev/null | tr -d '\r' | awk '/MemAvailable/ { print $2 }')
    echo "$((SECONDS - start)) s ${seen:-starting}: app ${pss:-?} kB, device available ${free:-?} kB" >> "$OUT/memory.txt"
  fi
  case "$alive" in
    yes) gone=0 ;;
    no) gone=$((gone + 1)) ;;
  esac
  if [ "$gone" -ge 5 ]; then
    why="the app stopped (last step: ${seen:-none})"
    break
  fi
  sleep 1
done
[ $status = 0 ] || echo "::error::$why"

adb exec-out run-as "$PKG" cat files/drive-report.json > "$OUT/drive-report.json" 2>/dev/null || rm -f "$OUT/drive-report.json"
adb exec-out run-as "$PKG" tar -C files -cf - Exports | tar -xf - -C "$OUT" || echo "::warning::no exports to pull"
adb logcat -d > "$OUT/logcat.txt" || true
# The app's own lines, without the engine's progress, which its debug build logs as it arrives.
grep -E "\[drive\]|Capacitor/Console" "$OUT/logcat.txt" | grep -v '"stream":"stdout"' | tail -n 60 || true
echo "--- the app's memory"
tail -n 12 "$OUT/memory.txt" 2>/dev/null || true
if [ $status != 0 ]; then
  # Why it stopped: a crash, or the system ending it for memory.
  echo "--- crashes and kills"
  grep -E "AndroidRuntime|Fatal signal|DEBUG +:|lowmemorykiller|lmkd|am_kill|has died|Killing [0-9]+:$PKG|SIGKILL|OutOfMemory" "$OUT/logcat.txt" | tail -n 80 || true
fi
[ -s "$OUT/drive-report.json" ] || { echo "::error::the app wrote no report"; exit 1; }
exit $status
