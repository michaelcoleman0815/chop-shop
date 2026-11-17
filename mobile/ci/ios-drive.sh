#!/usr/bin/env bash
# Runs the app's own flow (src/host/drive.ts) on an iPhone simulator:
# installs the app, lets it add to Photos, puts the whisper model where the
# app keeps it, the footage where the engine's importer copies picks, and the
# plan in its documents, launches it, and takes a screenshot at every step
# the app says it has reached. Then turns the simulator dark, asks for
# reduced motion, and launches the app again for the dark tour of the same
# project. Then copies out the app's reports and exports.
#
#   ci/ios-drive.sh APP MODELS_DIR FOOTAGE_DIR OUT_DIR [DEVICE]
#
# MODELS_DIR holds ggml-base.en.bin; FOOTAGE_DIR is what ci/make-footage.py
# made (the files and drive.json). DEVICE is a booted simulator's UDID
# (default: the booted one). OUT_DIR gets drive-report.json,
# tour-report.json, screens/, Exports/, and the app's stdout and stderr for
# each pass. DRIVE_TIMEOUT (seconds, default 2400) bounds each pass. The app
# must be built with CUTALONG_DRIVE=1.
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
rm -f "$docs/drive-progress.txt" "$docs/drive-ack.txt" "$docs/drive-report.json" "$docs/tour-report.json"
echo "app data: $data"

# Launches the app afresh, its output to OUT_DIR under the pass's label.
launch() {
  xcrun simctl launch --terminate-running-process --stdout="$OUT/app-stdout-$1.txt" --stderr="$OUT/app-stderr-$1.txt" \
    "$DEV" "$BUNDLE"
}

# Follows one pass of the flow from launch to its last step, with a
# screenshot at each step. Sets status and why.
follow() {
  local label=$1 start=$SECONDS seen="" gone=0 last=0 again="" sampled=0 progress services n step pid app_kb web_kb
  status=1
  why="$label: no report in $TIMEOUT s"
  while [ $((SECONDS - start)) -lt "$TIMEOUT" ]; do
    progress=$(head -n1 "$docs/drive-progress.txt" 2>/dev/null || true)
    # The flow says its first step within a minute or two of the app starting; nothing by then is a stop.
    if [ -z "$seen" ] && [ -z "$progress" ] && [ $((SECONDS - start)) -gt 240 ]; then
      why="$label: the app showed no step of its flow in 240 s: it did not find drive.json, or could not start"
      return
    fi
    if [ -n "$progress" ] && [ "$progress" != "$seen" ]; then
      seen=$progress
      n=${progress%% *}
      step=${progress#* }
      echo "$label $((SECONDS - start)) s: $n $step"
      # A lower step than the last: the page started its flow again, as it does when its web view is restarted.
      if [ "$n" -lt "$last" ] 2>/dev/null; then
        again="the app's page started again after step $last: its web view was restarted"
        echo "::warning::$label: $again"
      fi
      last=$n
      if [ "$step" = done ]; then
        if [ -z "$again" ]; then status=0; else why="$label: $again"; fi
        return
      fi
      xcrun simctl io "$DEV" screenshot "$OUT/screens/$label-$(printf %02d "$n")-$step.png" >/dev/null 2>&1 ||
        echo "::warning::no screenshot at $step"
      echo "$n" > "$docs/drive-ack.txt"
      continue
    fi
    # Read whole before it is searched: grep -q leaving early would break launchctl's pipe, which
    # pipefail counts as the app gone. Gone only when the listing leaves it out five times in a
    # row; no listing at all is no news either way.
    services=$(xcrun simctl spawn "$DEV" launchctl list 2>/dev/null || true)
    # The app's memory every 15 s, and its web views', for when the page is restarted. Each runs as a
    # process of this Mac; nothing here stops reading early, which pipefail would count as a failure.
    if [ $((SECONDS - sampled)) -ge 15 ]; then
      sampled=$SECONDS
      pid=$(awk -v app="UIKitApplication:$BUNDLE" 'index($3, app) == 1 { print $1; exit }' <<<"$services")
      app_kb=""
      if [ -n "$pid" ] && [ "$pid" != "-" ]; then app_kb=$(ps -o rss= -p "$pid" 2>/dev/null | tr -d ' ' || true); fi
      web_kb=$(ps -axo rss=,command= 2>/dev/null | awk '/WebKit\.WebContent/ && /CoreSimulator/ { s += $1 } END { print s + 0 }' || true)
      echo "$label $((SECONDS - start)) s ${seen:-starting}: app ${app_kb:-?} kB, web views ${web_kb:-?} kB" >> "$OUT/memory.txt"
    fi
    if grep -q "UIKitApplication:$BUNDLE" <<<"$services"; then
      gone=0
    elif [ -n "$services" ]; then
      gone=$((gone + 1))
    fi
    if [ "$gone" -ge 5 ]; then
      why="$label: the app stopped (last step: ${seen:-none})"
      return
    fi
    sleep 1
  done
}

# The first pass in light, moving as it moves for a person.
xcrun simctl ui "$DEV" appearance light || echo "::warning::could not turn the simulator light"
launch light
follow light
flow_status=$status
flow_why=$why
cp "$docs/drive-report.json" "$OUT/" 2>/dev/null || true

# The tour runs after a flow that stopped too, to show the project as far as it got.
if [ -s "$OUT/drive-report.json" ]; then
  # The dark tour: the simulator dark, reduced motion asked for, and the app launched again on the same project.
  xcrun simctl ui "$DEV" appearance dark
  # As Settings does: the preference, then the news of it. The tour's report says whether the web view heard.
  xcrun simctl spawn "$DEV" defaults write com.apple.Accessibility ReduceMotionEnabled -bool true ||
    echo "::warning::could not ask for reduced motion"
  xcrun simctl spawn "$DEV" notifyutil -p com.apple.accessibility.reduce.motion.status || true
  python3 -c 'import json, sys; p = json.load(open(sys.argv[1])); p["tour"] = "dark"; json.dump(p, open(sys.argv[2], "w"))' \
    "$FOOTAGE/drive.json" "$docs/drive.json"
  rm -f "$docs/drive-progress.txt" "$docs/drive-ack.txt"
  launch dark
  follow dark
  tour_status=$status
  tour_why=$why
  cp "$docs/tour-report.json" "$OUT/" 2>/dev/null || true
  xcrun simctl ui "$DEV" appearance light || true
  xcrun simctl spawn "$DEV" defaults write com.apple.Accessibility ReduceMotionEnabled -bool false || true
else
  tour_status=1
  tour_why="dark: not started, as the app wrote no report"
fi
[ "$flow_status" = 0 ] || echo "::error::$flow_why"
[ "$tour_status" = 0 ] || echo "::error::$tour_why"

cp -R "$docs/Exports" "$OUT/" 2>/dev/null || echo "::warning::no exports to copy"
for label in light dark; do
  [ -f "$OUT/app-stdout-$label.txt" ] || continue
  echo "--- the app's lines, $label (without the plugins' turned-down reads)"
  grep -E "\[drive\]|ERROR|Error|WebView|terminat|crash" "$OUT/app-stdout-$label.txt" | grep -v "does not exist\|given key" |
    tail -n 120 || true
done
# What WebKit says of the page's process: why it ended, when it did (its memory limit, or a crash).
xcrun simctl spawn "$DEV" log show --style compact --last 90m \
  --predicate 'eventMessage CONTAINS[c] "WebProcessProxy" OR eventMessage CONTAINS[c] "WebContent" OR eventMessage CONTAINS[c] "memory limit"' \
  > "$OUT/webkit-log.txt" 2>/dev/null || true
echo "--- the app's memory"
cat "$OUT/memory.txt" 2>/dev/null || true
echo "--- WebKit on the page's process"
grep -iE "terminat|crash|exceed|memory|jetsam" "$OUT/webkit-log.txt" | tail -n 40 || true
if [ "$flow_status" != 0 ] || [ "$tour_status" != 0 ]; then
  for label in light dark; do
    [ -f "$OUT/app-stderr-$label.txt" ] || continue
    echo "--- the app's stderr, $label, last lines"
    tail -n 60 "$OUT/app-stderr-$label.txt" || true
  done
fi
# Crash reports from the run, the app's and its web views', and where each crashed.
sleep 5
find "$HOME/Library/Logs/DiagnosticReports" \( -name 'App*' -o -name '*WebContent*' -o -name '*WebKit*' \) \
  -newer "$OUT/app-stdout-light.txt" -exec cp {} "$OUT/" \; 2>/dev/null || true
for report in "$OUT"/*.ips; do
  [ -f "$report" ] || continue
  echo "--- $(basename "$report"): the thread that crashed"
  python3 "$(dirname "$0")/crashed-thread.py" "$report" || true
done
[ -s "$OUT/drive-report.json" ] || { echo "::error::the app wrote no report"; exit 1; }
[ "$flow_status" = 0 ] && [ "$tour_status" = 0 ]
