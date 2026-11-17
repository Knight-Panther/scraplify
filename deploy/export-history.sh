#!/usr/bin/env bash
# Monthly export of the permanent market history (Phase 17F,
# docs/PHASE_17_PLAN.md). Run by deploy/systemd/xtelo-history-export.service
# with /etc/xtelo/backup.env, as the nightly backup is.
#
# The nightly dumps expire 30 days after upload, so history older than that
# would otherwise live on this host only. This dumps the history tables, whole
# each time, to HISTORY_REMOTE: an rclone remote:path that the nightly copies'
# 30-day rule does not reach (RUNBOOK §6). Each export is a full copy, so the
# newest one alone holds all the history; older ones guard against a mistake
# noticed late. They are written once and never replaced (--immutable), and
# this script deletes none: the bucket's own rule for that folder expires them
# (395 days). Each year's first export also goes to HISTORY_YEARLY_REMOTE,
# which nothing expires.
#
# Next to each dump goes a .counts file, the rows of each table counted just
# before and just after the dump, which a restore drill checks against
# (scripts/restore-history-drill.sh, RUNBOOK §6).
#
# HISTORY_REMOTE=none is the visible opt-out, reported on every run.
set -euo pipefail

: "${BACKUP_DATABASE_URL:?BACKUP_DATABASE_URL is not set}"
: "${HISTORY_REMOTE:?HISTORY_REMOTE is not set (an rclone remote:path outside the nightly copies 30-day rule, or none)}"
if [ "$HISTORY_REMOTE" != none ] && [ "${HISTORY_REMOTE%/}" = "${BACKUP_REMOTE:-}" ]; then
  echo "HISTORY_REMOTE is the nightly copies' folder, whose copies expire after 30 days; give it a folder of its own" >&2
  exit 1
fi
if [ "${HISTORY_YEARLY_REMOTE:-none}" != none ] &&
  { [ "${HISTORY_YEARLY_REMOTE%/}" = "${HISTORY_REMOTE%/}" ] || [ "${HISTORY_YEARLY_REMOTE%/}" = "${BACKUP_REMOTE:-}" ]; }; then
  echo "HISTORY_YEARLY_REMOTE must be a folder of its own, which nothing expires" >&2
  exit 1
fi
directory="${BACKUP_DIR:-/var/backups/xtelo}/history"
keep="${HISTORY_RETENTION_COUNT:-3}"

# The history: the real-estate archive schema whole (Phases 13A and 17A), the
# private poster directory and photo references whole (17B and 17G), and the
# job boards' revisions and status events (17C) and NBG's rates (17D).
history_schemas=(realestate_archive realestate_contacts realestate_media)
public_tables=(source_listing_revisions source_listing_status_events fx_rates)

table_args=()
schema_list=""
for schema in "${history_schemas[@]}"; do
  table_args+=(--table="$schema.*")
  schema_list+="${schema_list:+,}'$schema'"
done
in_list=""
for table in "${public_tables[@]}"; do
  table_args+=(--table="public.$table")
  in_list+="${in_list:+,}'$table'"
done

# One line per base table, "schema.table<TAB>rows", sorted by name.
count_rows() {
  psql "$BACKUP_DATABASE_URL" -X -A -t -q -v ON_ERROR_STOP=1 -F $'\t' <<SQL
select format('select %L, count(*) from %I.%I', schemaname || '.' || tablename, schemaname, tablename)
  from pg_tables
 where schemaname in ($schema_list)
    or (schemaname = 'public' and tablename in ($in_list))
 order by schemaname, tablename
\gexec
SQL
}

mkdir -p "$directory"
stamp="$(date -u +%Y%m%d-%H%M%S)"
file="$directory/xtelo-history-$stamp.dump"
counts="$directory/xtelo-history-$stamp.counts"
trap 'rm -f "$file.partial" "$counts.partial"' EXIT

before="$(count_rows)"
# --strict-names: a table that is not there fails the export rather than
# leaving it out quietly. zstd at level 9, as the nightly dump.
pg_dump --dbname="$BACKUP_DATABASE_URL" --format=custom --compress=zstd:9 --strict-names \
  "${table_args[@]}" --file="$file.partial"
after="$(count_rows)"

# Every counted table must have its data in the archive, which pg_restore can list.
tables="$(printf '%s\n' "$before" | grep -c .)"
with_data="$(pg_restore --list "$file.partial" | grep -c ' TABLE DATA ')" || true
if [ "$tables" -eq 0 ] || [ "$with_data" -ne "$tables" ]; then
  echo "the export holds data for $with_data tables, expected $tables" >&2
  exit 1
fi

# "schema.table<TAB>rows before<TAB>rows after": the restored count lies between.
LC_ALL=C join -t $'\t' <(printf '%s\n' "$before" | LC_ALL=C sort) \
  <(printf '%s\n' "$after" | LC_ALL=C sort) > "$counts.partial"
[ "$(grep -c . "$counts.partial")" -eq "$tables" ] || { echo "the tables changed during the export" >&2; exit 1; }
mv "$file.partial" "$file"
mv "$counts.partial" "$counts"
echo "Exported the history to $file ($(du -h "$file" | cut -f1), $tables tables)."

if [ "$HISTORY_REMOTE" = none ]; then
  echo "WARNING: HISTORY_REMOTE=none, so this export exists on this host only." >&2
else
  # Written once: --immutable fails rather than replace an existing copy.
  rclone copyto --checksum --immutable "$file" "$HISTORY_REMOTE/$(basename "$file")"
  rclone copyto --checksum --immutable "$counts" "$HISTORY_REMOTE/$(basename "$counts")"
  echo "Copied off the host to $HISTORY_REMOTE."

  # The year's first export is also kept for good (owner, 2026-11-17) under
  # HISTORY_YEARLY_REMOTE, a folder the bucket never expires. Its lock is 365
  # days, not forever: the exports hold private data (listing_private, the
  # poster directory), and a copy must stay rewritable should one person's
  # data have to go.
  yearly="${HISTORY_YEARLY_REMOTE:-none}"
  if [ "$yearly" != none ]; then
    year="${stamp:0:4}"
    # A failed listing fails the run rather than skip or repeat the year's copy.
    listed="$(rclone lsf --files-only --include "xtelo-history-$year*.dump" "$yearly")"
    if [ -z "$listed" ]; then
      rclone copyto --checksum --immutable "$file" "$yearly/$(basename "$file")"
      rclone copyto --checksum --immutable "$counts" "$yearly/$(basename "$counts")"
      echo "Kept as $year's copy for good in $yearly."
    fi
  fi

  # R2's free 10 GB-month is shared by the nightly copies (at most 7 GB) and
  # Hermes's backups (about 1.5 GB). This only warns: nothing here deletes.
  warn_bytes="${HISTORY_REMOTE_WARN_BYTES:-1500000000}"
  bytes() { rclone size --json "$1" | sed -n 's/.*"bytes":\([0-9]*\).*/\1/p'; }
  used="$(bytes "$HISTORY_REMOTE")"
  if [ -n "$used" ] && [ "$yearly" != none ]; then
    kept="$(bytes "$yearly")"
    used=$((used + ${kept:-0}))
  fi
  echo "History exports off the host: ${used:-?} bytes (warning above $warn_bytes)."
  if [ -n "$used" ] && [ "$used" -gt "$warn_bytes" ]; then
    echo "WARNING: the history exports take more than HISTORY_REMOTE_WARN_BYTES; shorten the folder's expiry or raise the budget." >&2
  fi
fi

# Local retention: the newest $keep exports stay on this host.
find "$directory" -maxdepth 1 -name 'xtelo-history-*.dump' | sort -r | tail -n +"$((keep + 1))" | while read -r old; do
  rm -f -- "$old" "${old%.dump}.counts"
  echo "Removed old export $(basename "$old") (keeping the newest $keep)."
done
