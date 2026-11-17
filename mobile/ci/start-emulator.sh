#!/usr/bin/env bash
# Starts an Android emulator on a GitHub runner, as the engine's self-test
# does (.github/workflows/mobile-engine.yml), and waits for it to boot:
# KVM opened to the emulator, the system image and an AVD made, animations
# off and the screen kept on. Up to ten minutes; no open-ended wait.
#
#   ci/start-emulator.sh IMAGE LOG
#
# IMAGE is an sdkmanager package, e.g. "system-images;android-34;google_apis;x86_64".
set -euo pipefail

IMAGE=$1
LOG=$2

echo 'KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS+="static_node=kvm"' | sudo tee /etc/udev/rules.d/99-kvm4all.rules >/dev/null
sudo udevadm control --reload-rules
sudo udevadm trigger --name-match=kvm
sdk="$ANDROID_HOME/cmdline-tools/latest/bin"
yes | "$sdk/sdkmanager" --install emulator platform-tools "$IMAGE" >/dev/null
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
# avdmanager writes under XDG_CONFIG_HOME on the runner, where the emulator
# does not look: one place for both.
export ANDROID_AVD_HOME="$HOME/.android/avd"
mkdir -p "$ANDROID_AVD_HOME"
echo no | "$sdk/avdmanager" create avd --force -n drive -k "$IMAGE" -d pixel_6
nohup "$ANDROID_HOME/emulator/emulator" -avd drive -no-window -noaudio -no-boot-anim -no-snapshot \
  -gpu swiftshader_indirect -camera-back none -camera-front none -memory 4096 -cores 4 -partition-size 8192 \
  > "$LOG" 2>&1 &
emulator=$!
for _ in $(seq 1 120); do
  if ! kill -0 "$emulator" 2>/dev/null; then
    tail -n 80 "$LOG"
    echo "::error::the emulator stopped"
    exit 1
  fi
  if [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ]; then
    adb shell settings put global window_animation_scale 0
    adb shell settings put global transition_animation_scale 0
    adb shell settings put global animator_duration_scale 0
    adb shell settings put system screen_off_timeout 2147483647
    adb shell svc power stayon true
    adb shell input keyevent 82
    echo "booted: $(adb shell getprop ro.build.fingerprint)"
    echo "WebView: $(adb shell dumpsys webviewupdate | grep -m1 'Current WebView package')"
    exit 0
  fi
  sleep 5
done
tail -n 80 "$LOG"
echo "::error::the emulator did not boot in 10 minutes"
exit 1
