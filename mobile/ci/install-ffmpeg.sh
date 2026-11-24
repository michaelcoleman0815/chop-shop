#!/usr/bin/env bash
# Installs ffmpeg and ffprobe from Ubuntu's own packages on a CI runner,
# without letting a slow or stalled mirror take the run with it.
#
# A plain apt-get install usually took 20 to 45 seconds, but now and then sat
# silent for 5 to 10 minutes and was stopped, and the jobs after it never
# tested the app; retrying from another mirror did not help, since the
# download itself crawled. So the packages are downloaded once and kept:
# with FFMPEG_DEBS set (.github/actions/ffmpeg keeps that folder in the
# Actions cache, one per runner image), they are installed from there with
# nothing to download, and a fresh download leaves them there for the next
# run. A download says how much it is before it starts; each part is timed
# and said as it starts; each try is capped and a stalled one tried again
# from Ubuntu's main archive; and a try that runs out of time shows what apt
# last said and what apt and dpkg were doing, so the log says where it stuck.
# Only Ubuntu's own sources are read (the runner's other ones, Microsoft's and
# the rest, are not needed and can stall too); the man-page index, which apt
# rebuilds after every install, is not rebuilt; and the check for services to
# restart is skipped.
#
#   FFMPEG_DEBS=/path/to/kept/debs mobile/ci/install-ffmpeg.sh
#
# FFMPEG_TRIES (default 3), FFMPEG_LISTS_SECONDS (default 90) and
# FFMPEG_INSTALL_SECONDS (default 180) bound each try: three stalled tries
# end inside the step's 15 minutes, and a good one takes under a minute.
set -euo pipefail

tries=${FFMPEG_TRIES:-3}
lists_for=${FFMPEG_LISTS_SECONDS:-90}
install_for=${FFMPEG_INSTALL_SECONDS:-180}
debs=${FFMPEG_DEBS:-}

say() { echo "$(date -u +%H:%M:%S) $*"; }

done_now() {
  say "installed"
  ffmpeg -hide_banner -version | head -1
  ffprobe -hide_banner -version | head -1
}

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
  -o APT::Keep-Downloaded-Packages=true
)
if [ -n "$debs" ]; then
  mkdir -p "$debs"
  apt_opts+=(-o "Dir::Cache::Archives=$debs")
fi

# Man pages are never read on a runner, and rebuilding their index after an install with this many
# libraries is minutes on its own.
echo 'man-db man-db/auto-update boolean false' | "${sudo[@]}" debconf-set-selections 2>/dev/null || true
"${sudo[@]}" rm -f /var/lib/man-db/auto-update

log=$(mktemp)

# What a try that ran out of time was doing: apt's last lines, and the apt and dpkg processes still there.
stuck() {
  say "$1. What apt said last:"
  tail -n 12 "$log" | sed 's/^/    /'
  echo "    apt and dpkg running now:"
  ps -eo pid,etime,args | grep -E '[a]pt|[d]pkg|[u]nattended' | sed 's/^/    /' || echo "    none"
}

# Kept from an earlier run on this runner image: installed with nothing to download.
if [ -n "$debs" ] && compgen -G "$debs/*.deb" >/dev/null; then
  say "installing ffmpeg from the $(compgen -G "$debs/*.deb" | wc -l | tr -d ' ') packages kept from an earlier run"
  if as_root timeout --kill-after=10 "$install_for" apt-get "${apt_opts[@]}" install -y --no-install-recommends "$debs"/*.deb >"$log" 2>&1; then
    done_now
    exit 0
  fi
  stuck "the kept packages did not install"
  as_root dpkg --configure -a || true
  say "downloading them again"
fi

for n in $(seq 1 "$tries"); do
  if [ "$n" -gt 1 ]; then
    # The next try asks Ubuntu's main archive rather than the runner's nearby mirror.
    sed -i -E 's#https?://[a-z0-9.-]*\.archive\.ubuntu\.com/ubuntu/?#http://archive.ubuntu.com/ubuntu/#g' "$sources"/*
    # A try stopped partway can leave packages half set up.
    as_root dpkg --configure -a || true
  fi
  say "reading the package lists (try $n of $tries, at most ${lists_for} s)"
  if ! as_root timeout --kill-after=10 "$lists_for" apt-get "${apt_opts[@]}" update >"$log" 2>&1; then
    stuck "the package lists did not come in time"
    continue
  fi
  # What is about to come down: packages not already here, and their size.
  read -r count bytes < <(as_root apt-get "${apt_opts[@]}" install -y -qq --no-install-recommends --print-uris ffmpeg 2>/dev/null |
    awk '/^'"'"'/ { n++; s += $3 } END { print n + 0, s + 0 }') || { count='?'; bytes=0; }
  say "downloading and installing ffmpeg: $count packages, $((bytes / 1048576)) MB (at most ${install_for} s)"
  if ! as_root timeout --kill-after=10 "$install_for" apt-get "${apt_opts[@]}" install -y --no-install-recommends ffmpeg >"$log" 2>&1; then
    stuck "the install did not finish in time"
    continue
  fi
  done_now
  # Kept for the next run: only the packages themselves, readable by the cache step.
  if [ -n "$debs" ]; then
    as_root rm -rf "$debs/partial" "$debs/lock"
    as_root chown -R "$(id -u):$(id -g)" "$debs"
    say "kept $(compgen -G "$debs/*.deb" | wc -l | tr -d ' ') packages for the next run"
  fi
  exit 0
done

echo "::error::ffmpeg could not be installed in $tries tries; the log above shows where each one stopped"
exit 1
