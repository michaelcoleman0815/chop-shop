#!/usr/bin/env bash
# Runs the app's own flow (src/host/drive.ts) on an iPhone simulator:
# installs the app, lets it add to Photos, puts the whisper model where the
# app keeps it, the footage where the engine's importer copies picks, and the
# plan in its documents, launches it, and takes a screenshot at every step
# the app says it has reached. Then copies out the app's report and exports.
#
#   ci/ios-drive.sh APP MODELS_DIR FOOTAGE_DIR OUT_DIR [DEVICE]
#
# MODELS_DIR holds ggml-base.en.bin; FOOTAGE_DIR is what ci/make-footage.py
# made (the files and drive.json). DEVICE is a booted simulator's UDID
# (default: the booted one). OUT_DIR gets drive-report.json, screens/,
# Exports/, and the app's stdout and stderr. DRIVE_TIMEOUT (seconds,
# default 2400) bounds it. The app must be built with CUTALONG_DRIVE=1.
set -euo pipefail

APP=$1
MODELS=$2
FOOTAGE=$3
OUT=$4
DEV=${5:-booted}
BUNDLE=social.brewed.cutalong
TIMEOUT=${DRIVE_TIMEOUT:-2400}
mkdir -p "$OUT/screens"

xcrun simctl install "$DEV" "$APP"
# An export goes to Photos, which asks first; the simulator is told the answer.
xcrun simctl privacy "$DEV" grant photos-add "$BUNDLE" || echo "::warning::could not let the app add to Photos"

if ! data=$(xcrun simctl get_app_container "$DEV" "$BUNDLE" data 2>/dev/null); then
  # The container is made on the first launch.
  xcrun simctl launch "$DEV" "$BUNDLE" >/dev/null
  sleep 5
  xcrun simctl terminate "$DEV" "$BUNDLE" || true
  data=$(xcrun simctl get_app_container "$DEV" "$BUNDLE" data)
fi
docs="$data/Documents"
mkdir -p "$docs/Cutalong/models" "$docs/Imported"
cp "$MODELS/ggml-base.en.bin" "$docs/Cutalong/models/"
for f in $(python3 -c 'import json, sys; print("\n".join(json.load(open(sys.argv[1]))["files"]))' "$FOOTAGE/drive.json"); do
  cp "$FOOTAGE/$f" "$docs/Imported/"
done
cp "$FOOTAGE/drive.json" "$docs/"
rm -f "$docs/drive-progress.txt" "$docs/drive-ack.txt" "$docs/drive-report.json"
echo "app data: $data"

xcrun simctl launch --terminate-running-process --stdout="$OUT/app-stdout.txt" --stderr="$OUT/app-stderr.txt" \
  "$DEV" "$BUNDLE"

start=$SECONDS
seen=""
gone=0
status=1
why="no report in $TIMEOUT s"
while [ $((SECONDS - start)) -lt "$TIMEOUT" ]; do
  progress=$(head -n1 "$docs/drive-progress.txt" 2>/dev/null || true)
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
    xcrun simctl io "$DEV" screenshot "$OUT/screens/$(printf %02d "$n")-$step.png" >/dev/null 2>&1 ||
      echo "::warning::no screenshot at $step"
    echo "$n" > "$docs/drive-ack.txt"
    continue
  fi
  # Read whole before it is searched: grep -q leaving early would break launchctl's pipe, which
  # pipefail counts as the app gone. Gone only when three looks in a row do not find it.
  services=$(xcrun simctl spawn "$DEV" launchctl list 2>/dev/null || true)
  if grep -q "UIKitApplication:$BUNDLE" <<<"$services"; then gone=0; else gone=$((gone + 1)); fi
  if [ "$gone" -ge 3 ]; then
    why="the app stopped (last step: ${seen:-none})"
    break
  fi
  sleep 1
done
[ $status = 0 ] || echo "::error::$why"

cp "$docs/drive-report.json" "$OUT/" 2>/dev/null || true
cp -R "$docs/Exports" "$OUT/" 2>/dev/null || echo "::warning::no exports to copy"
grep -E "\[drive\]|ERROR|Error" "$OUT/app-stdout.txt" | tail -n 120 || true
if [ $status != 0 ]; then
  echo "--- the app's stderr, last lines"
  tail -n 60 "$OUT/app-stderr.txt" || true
  find "$HOME/Library/Logs/DiagnosticReports" -name 'App*' -newer "$OUT/app-stdout.txt" -exec cp {} "$OUT/" \; 2>/dev/null || true
fi
[ -s "$OUT/drive-report.json" ] || { echo "::error::the app wrote no report"; exit 1; }
exit $status
