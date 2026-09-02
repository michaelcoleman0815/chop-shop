#!/usr/bin/env bash
# Fetches the yt-dlp binary used to pull a recording from a URL.
# resources/bin is gitignored, so anything not fetched here is simply absent
# from the shipped app and the feature fails quietly.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/resources/bin/yt-dlp"
mkdir -p "$ROOT/resources/bin"

VERSION="${YTDLP_VERSION:-2026.08.19}"
URL="https://github.com/yt-dlp/yt-dlp/releases/download/${VERSION}/yt-dlp_macos"

if [ -x "$DEST" ] && "$DEST" --version >/dev/null 2>&1; then
  echo "yt-dlp already present ($("$DEST" --version))"
  exit 0
fi

curl -fsSL --retry 3 -o "$DEST" "$URL"
chmod +x "$DEST"
echo "fetched yt-dlp $("$DEST" --version)"
