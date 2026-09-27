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

# Local retention only: off-host copies are kept by the bucket's own
# lifecycle rule (RUNBOOK §6), never deleted from here.
find "$directory" -maxdepth 1 -name 'xtelo-*.dump' | sort -r | tail -n +"$((keep + 1))" | while read -r old; do
  rm -f -- "$old"
  echo "Removed old backup $(basename "$old") (keeping the newest $keep)."
done
