#!/usr/bin/env bash
# Nightly database backup on a Linux host (Phase 8E): the same custom-format
# dump, archive validation and retention as scripts/backup-db.ps1. Run by
# deploy/systemd/xtelo-backup.service. BACKUP_DATABASE_URL must be a role
# that can read every table (the owner or a dedicated backup role), never
# the public one.
#
# Each dump is then copied off the host with rclone to BACKUP_REMOTE (an
# rclone remote configured through RCLONE_CONFIG_<NAME>_* variables in
# backup.env; see deploy/env/backup.env.template). A backup kept only on the
# host it protects is lost with that host's disk, so a failed upload fails
# the run. BACKUP_REMOTE=none is the explicit, visible opt-out, for before
# off-host storage exists; it is reported on every run.
set -euo pipefail

: "${BACKUP_DATABASE_URL:?BACKUP_DATABASE_URL is not set}"
: "${BACKUP_REMOTE:?BACKUP_REMOTE is not set (an rclone remote:path, or none)}"
directory="${BACKUP_DIR:-/var/backups/xtelo}"
keep="${BACKUP_RETENTION_COUNT:-14}"

mkdir -p "$directory"
file="$directory/xtelo-$(date -u +%Y%m%d-%H%M%S).dump"
partial="$file.partial"
trap 'rm -f "$partial"' EXIT

pg_dump --dbname="$BACKUP_DATABASE_URL" --format=custom --file="$partial"
# An archive pg_restore cannot list is not a backup.
pg_restore --list "$partial" > /dev/null
[ -s "$partial" ] || { echo "backup is empty" >&2; exit 1; }
mv "$partial" "$file"
echo "Backed up to $file ($(du -h "$file" | cut -f1))."

if [ "$BACKUP_REMOTE" = none ]; then
  echo "WARNING: BACKUP_REMOTE=none, so this backup exists on this host only." >&2
else
  # --checksum compares content, not size and time; the upload is verified by
  # the remote's own checksum before rclone reports success.
  rclone copyto --checksum "$file" "$BACKUP_REMOTE/$(basename "$file")"
  echo "Copied off the host to $BACKUP_REMOTE."
fi

# Local retention: the newest $keep dumps stay on this host.
find "$directory" -maxdepth 1 -name 'xtelo-*.dump' | sort -r | tail -n +"$((keep + 1))" | while read -r old; do
  rm -f -- "$old"
  echo "Removed old backup $(basename "$old") (keeping the newest $keep)."
done

# Off-host size guard. The bucket's lifecycle rule expires copies by age
# (RUNBOOK §6); this also keeps their total under BACKUP_REMOTE_MAX_BYTES
# (default 8 GB, below R2's 10 GB-month free tier) should dumps ever grow that
# large. It deletes the oldest first and never the newest, so the copy this
# run made always survives. Dump names sort by time (xtelo-<utc>.dump), and
# only those names are counted or deleted.
if [ "$BACKUP_REMOTE" != none ]; then
  max_bytes="${BACKUP_REMOTE_MAX_BYTES:-8000000000}"
  [[ "$max_bytes" =~ ^[1-9][0-9]*$ ]] || { echo "BACKUP_REMOTE_MAX_BYTES must be a positive whole number of bytes" >&2; exit 1; }
  # A failed listing fails the run (pipefail), rather than skipping the guard.
  listing="$(rclone lsf --files-only --format sp --separator ';' "$BACKUP_REMOTE" \
    | awk -F';' '$2 ~ /^xtelo-[0-9]+-[0-9]+\.dump$/' | sort -t';' -k2,2)"
  copies=()
  [ -z "$listing" ] || mapfile -t copies <<< "$listing"
  total=0
  for copy in "${copies[@]}"; do total=$((total + ${copy%%;*})); done
  removed=0
  while [ "$total" -gt "$max_bytes" ] && [ $((${#copies[@]} - removed)) -gt 1 ]; do
    size="${copies[removed]%%;*}"
    name="${copies[removed]#*;}"
    rclone deletefile "$BACKUP_REMOTE/$name"
    total=$((total - size))
    removed=$((removed + 1))
    echo "Removed off-host copy $name ($size bytes) to stay under $max_bytes bytes."
  done
  echo "Off-host copies: $((${#copies[@]} - removed)), $total bytes (limit $max_bytes)."
  if [ "$total" -gt "$max_bytes" ]; then
    echo "WARNING: the newest dump alone is over BACKUP_REMOTE_MAX_BYTES." >&2
  fi
fi
