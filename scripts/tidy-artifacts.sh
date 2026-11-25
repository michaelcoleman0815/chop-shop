#!/usr/bin/env bash
# Deletes this repository's workflow artifacts once nothing needs them, so the
# account's Actions storage holds only what someone may still download.
#
# Artifacts count against the account's storage by the hour: GitHub Free
# includes 0.5 GB, and beyond it each GB kept a month is billed (or, with no
# payment set up, uploads stop). On 2026-11-24 the repository held 974 of them,
# 43.5 GB, nearly all from runs long finished: every push kept its Mac and
# Windows test builds and every file the phone jobs hand one another for 14 days.
#
#   bash scripts/tidy-artifacts.sh older NAME...
#     every artifact called NAME, or NAME-<number>, that another run made:
#     run after uploading a build, so only the newest one of each stays.
#   bash scripts/tidy-artifacts.sh run NAME...
#     this run's artifacts called NAME: run once the jobs that read them are done.
#
# Needs GH_TOKEN (a token with actions: write), GITHUB_REPOSITORY and
# GITHUB_RUN_ID, as a runner sets them. Nothing here fails a build: an
# artifact left behind still expires on its own.
set -uo pipefail

mode=${1:-}
[ $# -ge 2 ] || { echo "usage: $0 older|run NAME..." >&2; exit 2; }
shift
repo=$GITHUB_REPOSITORY
run=$GITHUB_RUN_ID

names=$(printf '%s|' "$@")
pattern="^(${names%|})(-[0-9]+)?$"

case $mode in
  older) url="repos/$repo/actions/artifacts?per_page=100"; keep=".workflow_run.id != $run" ;;
  run) url="repos/$repo/actions/runs/$run/artifacts?per_page=100"; keep="true" ;;
  *) echo "usage: $0 older|run NAME..." >&2; exit 2 ;;
esac

listed=$(gh api --paginate "$url" --jq ".artifacts[] | select($keep) | [.id, .name, .size_in_bytes] | @tsv") || {
  echo "::warning::could not list the artifacts to tidy; they expire on their own"
  exit 0
}

count=0
bytes=0
while IFS=$'\t' read -r id name size; do
  [ -n "$id" ] || continue
  size=${size%$'\r'}
  [[ $name =~ $pattern ]] || continue
  if gh api -X DELETE "repos/$repo/actions/artifacts/$id" >/dev/null; then
    count=$((count + 1))
    bytes=$((bytes + size))
  else
    echo "::warning::could not delete $name ($id)"
  fi
done <<< "$listed"

echo "deleted $count artifacts, $((bytes / 1048576)) MB"
