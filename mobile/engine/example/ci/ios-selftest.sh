#!/usr/bin/env bash
# Runs the self-test on an iPhone simulator: installs the test app, lets it
# add to Photos, gives it the whisper model, launches it with --selftest,
# waits for its report, and copies the report and everything the self-test
# made out of the app's container.
#
#   ci/ios-selftest.sh APP MODEL OUT_DIR [DEVICE]
#
# DEVICE is a booted simulator's UDID (default: the booted one). OUT_DIR gets
# selftest.json, selftest-out/ (the exports), the app's stdout and stderr,
# and crash reports if there are any. SELFTEST_TIMEOUT (seconds, default
# 2700) bounds the wait.
set -euo pipefail

APP=$1
MODEL=$2
OUT=$3
DEV=${4:-booted}
BUNDLE=app.cutalong.engine.example
TIMEOUT=${SELFTEST_TIMEOUT:-2700}
mkdir -p "$OUT"

xcrun simctl install "$DEV" "$APP"
# Saving to Photos asks to add; the simulator is told the answer.
xcrun simctl privacy "$DEV" grant photos-add "$BUNDLE" || echo "::warning::could not let the app add to Photos"

if ! data=$(xcrun simctl get_app_container "$DEV" "$BUNDLE" data 2>/dev/null); then
  # The container is made on the first launch.
  xcrun simctl launch "$DEV" "$BUNDLE" >/dev/null
  sleep 5
  xcrun simctl terminate "$DEV" "$BUNDLE" || true
  data=$(xcrun simctl get_app_container "$DEV" "$BUNDLE" data)
fi
docs="$data/Documents"
mkdir -p "$docs/models"
cp "$MODEL" "$docs/models/ggml-base.en.bin"
rm -f "$docs/selftest.json" "$docs/selftest-progress.txt"
echo "app data: $data"

xcrun simctl launch --terminate-running-process --stdout="$OUT/app-stdout.txt" --stderr="$OUT/app-stderr.txt" \
  "$DEV" "$BUNDLE" --selftest

start=$SECONDS
last=""
status=1
why="no report in $TIMEOUT s"
while [ $((SECONDS - start)) -lt "$TIMEOUT" ]; do
  sleep 10
  if [ -s "$docs/selftest.json" ] && python3 -c 'import json, sys; json.load(open(sys.argv[1]))' "$docs/selftest.json" 2>/dev/null; then
    cp "$docs/selftest.json" "$OUT/selftest.json"
    echo "report after $((SECONDS - start)) s"
    status=0
    break
  fi
  progress=$(cat "$docs/selftest-progress.txt" 2>/dev/null || true)
  if [ -n "$progress" ] && [ "$progress" != "$last" ]; then
    echo "$((SECONDS - start)) s: $progress"
    last=$progress
  fi
  services=$(xcrun simctl spawn "$DEV" launchctl list 2>/dev/null || true)
  if ! grep -q "UIKitApplication:$BUNDLE" <<<"$services"; then
    why="the app stopped without a report"
    break
  fi
done
[ $status = 0 ] || echo "::error::$why (last check started: ${last:-none})"

cp -R "$docs/selftest-out" "$OUT/" 2>/dev/null || echo "::warning::no exports to copy"
find "$HOME/Library/Logs/DiagnosticReports" -name 'App*' -newer "$OUT/app-stdout.txt" -exec cp {} "$OUT/" \; 2>/dev/null || true
grep "selftest" "$OUT/app-stdout.txt" | tail -n 80 || true
exit $status
