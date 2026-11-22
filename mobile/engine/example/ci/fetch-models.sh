#!/usr/bin/env bash
# Downloads the whisper models the self-test uses into DIR (the two the app
# offers), from where the desktop app downloads them (src/main/transcribe.ts),
# and checks each against the SHA-1 whisper.cpp's models/README.md gives.
# Models already there and right are kept.
#
#   ci/fetch-models.sh DIR
set -euo pipefail

DIR=$1
mkdir -p "$DIR"

sha1() {
  if command -v sha1sum >/dev/null; then sha1sum "$1" | cut -d' ' -f1; else shasum -a 1 "$1" | cut -d' ' -f1; fi
}

while read -r name sum; do
  file="$DIR/ggml-$name.bin"
  if [ ! -f "$file" ] || [ "$(sha1 "$file")" != "$sum" ]; then
    curl -fsSL --retry 3 -o "$file" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$name.bin"
  fi
  got=$(sha1 "$file")
  [ "$got" = "$sum" ] || { echo "::error::ggml-$name.bin is $got, not $sum"; exit 1; }
  echo "ggml-$name.bin: $(wc -c < "$file" | tr -d ' ') bytes, sha1 $got"
done <<'EOF'
base.en 137c40403d78fd54d454da0f9bd998f78703390c
small.en db8a495a91d927739e50b3fc1cc4c6b8f6c2d022
EOF
