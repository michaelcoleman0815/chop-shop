#!/usr/bin/env bash
# Runs the self-test on the Android device adb sees (the emulator in CI, or a
# phone with USB debugging): installs the test app, gives it the whisper
# model, launches it with the self-test flag, waits for its report, and pulls
# the report and everything the self-test made.
#
#   ci/android-selftest.sh APK MODEL OUT_DIR
#
# OUT_DIR gets selftest.json, selftest-out/ (the exports) and logcat.txt.
# SELFTEST_TIMEOUT (seconds, default 2700) bounds the wait.
set -euo pipefail

APK=$1
MODEL=$2
OUT=$3
PKG=app.cutalong.engine.example
TIMEOUT=${SELFTEST_TIMEOUT:-2700}
mkdir -p "$OUT"

app() { adb shell run-as "$PKG" "$@" | tr -d '\r'; }

adb install -r -t "$APK"

# The model goes into the app's own files; run-as works because the test
# app is debuggable. It is piped through the shell, which may read
# /data/local/tmp where the app may not.
adb push "$MODEL" /data/local/tmp/ggml-base.en.bin >/dev/null
adb shell "run-as $PKG mkdir -p files/models && cat /data/local/tmp/ggml-base.en.bin | run-as $PKG sh -c 'cat > files/models/ggml-base.en.bin'"
adb shell rm -f /data/local/tmp/ggml-base.en.bin
want=$(wc -c < "$MODEL" | tr -d ' ')
got=$(app stat -c %s files/models/ggml-base.en.bin)
[ "$got" = "$want" ] || { echo "::error::the model arrived as $got bytes of $want"; exit 1; }
echo "model in place: $got bytes"

app rm -f files/selftest.json files/selftest-progress.txt
adb logcat -c || true
adb shell am start -W -n "$PKG/.MainActivity" --ez selftest true

start=$SECONDS
last=""
status=1
why="no report in $TIMEOUT s"
while [ $((SECONDS - start)) -lt "$TIMEOUT" ]; do
  sleep 10
  if adb exec-out run-as "$PKG" cat files/selftest.json > "$OUT/selftest.json" 2>/dev/null &&
    python3 -c 'import json, sys; json.load(open(sys.argv[1]))' "$OUT/selftest.json" 2>/dev/null; then
    echo "report after $((SECONDS - start)) s"
    status=0
    break
  fi
  progress=$(app cat files/selftest-progress.txt 2>/dev/null || true)
  if [ -n "$progress" ] && [ "$progress" != "$last" ]; then
    echo "$((SECONDS - start)) s: $progress"
    last=$progress
  fi
  if [ -z "$(adb shell pidof "$PKG" | tr -d '\r')" ]; then
    why="the app stopped without a report"
    break
  fi
done
[ $status = 0 ] || echo "::error::$why (last check started: ${last:-none})"

adb exec-out run-as "$PKG" tar -C files -cf - selftest-out | tar -xf - -C "$OUT" || echo "::warning::could not pull the exports"
adb logcat -d > "$OUT/logcat.txt" || true
grep -E "selftest|AndroidRuntime|FATAL|libc|DEBUG" "$OUT/logcat.txt" | tail -n 80 || true
exit $status
