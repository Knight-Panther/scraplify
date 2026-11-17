#!/usr/bin/env bash
# Restore drill for the monthly history export (Phase 17F; RUNBOOK §6). Run
# from the repository root in Git Bash on the PC, with the throwaway Postgres
# container up:
#
#   bash scripts/restore-history-drill.sh xtelo-history-<utc>.dump
#
# It makes a database of its own in that container, migrates it to this
# checkout's schema, restores the export's rows into it, and checks each
# table's count against the .counts file beside the dump (between the rows
# before and after the export). Then it drops that database. Exit 0 only when
# every table is there and its count fits.
#
# The restore is data only, into migrated tables, with triggers off: the
# history refers to listings and runs that live in the nightly dump, not in
# this export, and a real recovery restores it the same way, into a migrated
# database. pg_restore names the columns of each table it copies, so an export
# taken under an older schema still loads into a newer one.
#
# It never touches another database: the name is its own and fresh each run.
set -euo pipefail
# Git Bash would turn the container's /tmp paths into Windows ones.
export MSYS_NO_PATHCONV=1

dump="${1:?usage: restore-history-drill.sh <xtelo-history-*.dump> [<.counts>]}"
counts="${2:-${dump%.dump}.counts}"
[ -s "$dump" ] || { echo "no export at $dump" >&2; exit 1; }
[ -s "$counts" ] || { echo "no counts file at $counts" >&2; exit 1; }

container="${DRILL_CONTAINER:-xtelo-re-test}"
port="${DRILL_PORT:-5544}"
user="${DRILL_USER:-scraplify}"
password="${DRILL_PASSWORD:-throwaway}"
database="xtelo_history_drill_$(date -u +%Y%m%d%H%M%S)"
inside="/tmp/$database.dump"

cleanup() {
  docker exec "$container" rm -f "$inside" > /dev/null 2>&1 || true
  docker exec "$container" dropdb -U "$user" --if-exists "$database" > /dev/null 2>&1 || true
}
trap cleanup EXIT

docker exec "$container" createdb -U "$user" "$database"
echo "Migrating $database to this checkout's schema..."
DATABASE_URL="postgresql://$user:$password@127.0.0.1:$port/$database" \
  node node_modules/drizzle-kit/bin.cjs migrate > /dev/null

docker cp "$dump" "$container:$inside" > /dev/null
echo "Restoring $(basename "$dump")..."
docker exec "$container" pg_restore -U "$user" -d "$database" --data-only --disable-triggers \
  --no-owner --no-privileges --exit-on-error "$inside"

failed=0
while IFS=$'\t' read -r table low high; do
  [ -n "$table" ] || continue
  restored="$(docker exec "$container" psql -U "$user" -d "$database" -X -A -t \
    -c "select count(*) from $table" 2> /dev/null)" || restored=missing
  if [ "$restored" = missing ]; then
    verdict="MISSING"
    failed=1
  elif [ "$restored" -ge "$low" ] && [ "$restored" -le "$high" ]; then
    verdict="ok"
  else
    verdict="WRONG (expected $low..$high)"
    failed=1
  fi
  printf '%-48s %10s  %s\n' "$table" "$restored" "$verdict"
done < "$counts"

if [ "$failed" -eq 0 ]; then
  echo "Drill passed: every table restored with its rows."
else
  echo "Drill FAILED." >&2
fi
exit "$failed"
