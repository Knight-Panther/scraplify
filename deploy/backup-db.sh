#!/usr/bin/env bash
# Nightly database backup on a Linux host (Phase 8E): the same custom-format
# dump, archive validation and retention as scripts/backup-db.ps1. Run by
# deploy/systemd/xtelo-backup.service. BACKUP_DATABASE_URL must be a role
# that can read every table (the owner or a dedicated backup role), never
# the public one.
set -euo pipefail

: "${BACKUP_DATABASE_URL:?BACKUP_DATABASE_URL is not set}"
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

find "$directory" -maxdepth 1 -name 'xtelo-*.dump' | sort -r | tail -n +"$((keep + 1))" | while read -r old; do
  rm -f -- "$old"
  echo "Removed old backup $(basename "$old") (keeping the newest $keep)."
done
