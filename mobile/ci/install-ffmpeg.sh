#!/usr/bin/env bash
# Installs ffmpeg and ffprobe from Ubuntu's own packages on a CI runner,
# without letting a stalled mirror take the run with it.
#
# The step this replaces usually took 20 to 45 seconds, but now and then sat
# silent for 5 to 10 minutes and was stopped, and the jobs after it never
# tested the app. So each part is timed and said as it starts, each try is
# capped, and a try that stalls is stopped and tried again from Ubuntu's main
# archive instead of the runner's nearby mirror. Only Ubuntu's own sources are
# read (the runner's other ones, Microsoft's and the rest, are not needed and
# can stall too); the man-page index, which apt rebuilds after every install,
# is not rebuilt; and the check for services to restart is skipped.
#
#   mobile/ci/install-ffmpeg.sh
#
# FFMPEG_TRIES (default 3), FFMPEG_LISTS_SECONDS (default 90) and
# FFMPEG_INSTALL_SECONDS (default 180) bound each try: three stalled tries
# end inside the step's 15 minutes, and a good one takes under a minute.
set -euo pipefail

tries=${FFMPEG_TRIES:-3}
lists_for=${FFMPEG_LISTS_SECONDS:-90}
install_for=${FFMPEG_INSTALL_SECONDS:-180}

say() { echo "$(date -u +%H:%M:%S) $*"; }

if command -v ffmpeg >/dev/null 2>&1 && command -v ffprobe >/dev/null 2>&1; then
  say "ffmpeg is here already"
  ffmpeg -hide_banner -version | head -1
  exit 0
fi

# Root in a container has no sudo; a runner's user has it without a password.
sudo=()
[ "$(id -u)" = 0 ] || sudo=(sudo)
as_root() { "${sudo[@]}" env DEBIAN_FRONTEND=noninteractive NEEDRESTART_SUSPEND=1 "$@"; }

# Ubuntu's own sources, copied where apt is pointed at them alone.
sources=$(mktemp -d)
if [ -f /etc/apt/sources.list.d/ubuntu.sources ]; then
  cp /etc/apt/sources.list.d/ubuntu.sources "$sources/"
elif [ -f /etc/apt/sources.list ]; then
  cp /etc/apt/sources.list "$sources/ubuntu.list"
else
  echo "::error::this runner has no Ubuntu package sources to install ffmpeg from"
  exit 1
fi

apt_opts=(
  -o Dir::Etc::SourceList=/dev/null
  -o "Dir::Etc::SourceParts=$sources"
  -o Acquire::Retries=2
  -o Acquire::http::Timeout=20
  -o Acquire::https::Timeout=20
  -o DPkg::Lock::Timeout=120
  -o Dpkg::Use-Pty=0
)

# Man pages are never read on a runner, and rebuilding their index after an install with this many
# libraries is minutes on its own.
echo 'man-db man-db/auto-update boolean false' | "${sudo[@]}" debconf-set-selections 2>/dev/null || true
"${sudo[@]}" rm -f /var/lib/man-db/auto-update

for n in $(seq 1 "$tries"); do
  if [ "$n" -gt 1 ]; then
    # The nearby mirror is the usual one to stall: the next try asks Ubuntu's main archive.
    sed -i -E 's#https?://[a-z0-9.-]*\.archive\.ubuntu\.com/ubuntu/?#http://archive.ubuntu.com/ubuntu/#g' "$sources"/*
    # A try stopped partway can leave packages half set up.
    as_root dpkg --configure -a || true
  fi
  say "reading the package lists (try $n of $tries, at most ${lists_for} s)"
  if ! as_root timeout --kill-after=10 "$lists_for" apt-get "${apt_opts[@]}" update -qq; then
    say "the package lists did not come in time"
    continue
  fi
  say "installing ffmpeg (at most ${install_for} s)"
  if ! as_root timeout --kill-after=10 "$install_for" apt-get "${apt_opts[@]}" install -y -qq --no-install-recommends ffmpeg >/dev/null; then
    say "the install did not finish in time"
    continue
  fi
  say "installed"
  ffmpeg -hide_banner -version | head -1
  ffprobe -hide_banner -version | head -1
  exit 0
done

echo "::error::ffmpeg could not be installed in $tries tries; Ubuntu's mirrors did not answer in time"
exit 1
