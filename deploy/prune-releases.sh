#!/usr/bin/env bash
# Deletes old release builds from /opt/xtelo/releases, keeping the live one
# and the newest KEEP others (default 2) for a rollback. Each build is about
# 1.6 GB, and 17 of them had filled the host's disk to 90% (2026-10-26).
# Run as root, after a deploy's probe passes (RUNBOOK §3):
#   sudo /opt/xtelo/current/deploy/prune-releases.sh [KEEP]
# "Newest" is by the commit time of each release's checkout, which follows
# the order of main, not the folder's date.
set -euo pipefail

releases=/opt/xtelo/releases
keep="${1:-2}"
[[ "$keep" =~ ^[0-9]+$ ]] || { echo "KEEP must be a whole number, got: $keep" >&2; exit 1; }

current="$(readlink -f /opt/xtelo/current)"
[[ -d "$current" && "$(dirname "$current")" == "$releases" ]] || {
  echo "/opt/xtelo/current does not point at a release in $releases" >&2
  exit 1
}

committed_at() {
  git -c safe.directory="$1" -C "$1" log -1 --format=%ct 2>/dev/null || stat -c %Y "$1"
}

mapfile -t others < <(
  for dir in "$releases"/*/; do
    dir="${dir%/}"
    [[ "$dir" == "$current" ]] && continue
    printf '%s %s\n' "$(committed_at "$dir")" "$dir"
  done | sort -rn | cut -d' ' -f2-
)

echo "live: $(basename "$current")"
for ((i = 0; i < ${#others[@]}; i++)); do
  if ((i < keep)); then
    echo "kept: $(basename "${others[i]}")"
  else
    echo "removed: $(basename "${others[i]}")"
    rm -rf -- "${others[i]}"
  fi
done
df -h / | tail -1
