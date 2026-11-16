#!/usr/bin/env bash
# Runs the self-test on the Android device adb sees (the emulator in CI, or a
# phone with USB debugging): installs the test app, gives it the whisper
# models, launches it with the self-test flag, waits for its report, and
# pulls the report and everything the self-test made.
#
#   ci/android-selftest.sh APK MODELS_DIR OUT_DIR
#
# MODELS_DIR holds ggml-base.en.bin and ggml-small.en.bin; they go where the
# app keeps them, Cutalong/models in its documents. OUT_DIR gets
# selftest.json, selftest-out/ (the exports) and logcat.txt.
# SELFTEST_TIMEOUT (seconds, default 2700) bounds the wait.
set -euo pipefail

APK=$1
MODELS=$2
OUT=$3
PKG=app.cutalong.engine.example
TIMEOUT=${SELFTEST_TIMEOUT:-2700}
mkdir -p "$OUT"

app() { adb shell run-as "$PKG" "$@" | tr -d '\r'; }

adb install -r -t "$APK"

# The models go into the app's own files; run-as works because the test
# app is debuggable. They are piped through the shell, which may read
# /data/local/tmp where the app may not.
app mkdir -p files/Cutalong/models
for model in "$MODELS"/ggml-*.bin; do
  name=$(basename "$model")
  adb push "$model" "/data/local/tmp/$name" >/dev/null
  adb shell "cat /data/local/tmp/$name | run-as $PKG sh -c 'cat > files/Cutalong/models/$name'"
  adb shell rm -f "/data/local/tmp/$name"
  want=$(wc -c < "$model" | tr -d ' ')
  got=$(app stat -c %s "files/Cutalong/models/$name")
  [ "$got" = "$want" ] || { echo "::error::$name arrived as $got bytes of $want"; exit 1; }
  echo "$name in place: $got bytes"
done

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
