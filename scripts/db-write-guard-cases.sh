#!/usr/bin/env sh
#
# Runs scripts/db-write-guard.sh on commands that must ask and commands that
# must pass, and fails on any mismatch. Run it after changing the guard:
#   sh scripts/db-write-guard-cases.sh
# Needs jq, like the guard itself.
set -u
here=$(cd "$(dirname "$0")" && pwd)
guard="$here/db-write-guard.sh"
failed=0
total=0

check() { # $1 = ask|pass, $2 = the command
  total=$((total + 1))
  out=$(jq -n --arg c "$2" '{tool_name: "Bash", tool_input: {command: $c}}' | sh "$guard")
  case "$out" in *'"ask"'*) got=ask ;; *) got=pass ;; esac
  if [ "$got" != "$1" ]; then
    failed=$((failed + 1))
    printf 'WRONG (want %s, got %s): %s\n' "$1" "$got" "$2"
  fi
}

# --- must ask: destructive SQL through a client
check ask "docker exec scraplify-postgres-1 psql -U scraplify -d scraplify -c 'DELETE FROM realestate.listings'"
check ask "docker exec scraplify-postgres-1 psql -U scraplify -d scraplify -c 'truncate realestate.places'"
check ask "psql \"\$DATABASE_URL\" -c 'drop table realestate.places'"
check ask "psql -d scraplify -c 'ALTER TABLE realestate.listings DROP COLUMN street_ref'"
check ask "psql -d scraplify -c 'DROP SCHEMA realestate_archive CASCADE'"
check ask "ssh -i ~/.ssh/xtelo_ovh_ed25519 ubuntu@152.228.171.98 \"sudo -u postgres psql -d scraplify -c 'delete from realestate_archive.listings'\""
check ask "node -e \"require('pg'); client.query('DELETE FROM realestate.listings')\""
check ask "psql -d scraplify -f cleanup.sql"
# --- must ask: whole-database tools
check ask "docker exec scraplify-postgres-1 dropdb -U scraplify scraplify"
check ask "ssh ubuntu@152.228.171.98 'sudo -u postgres dropdb scraplify'"
check ask "dropuser scraplify_public"
check ask "pg_restore --data-only --dbname=\"\$DATABASE_URL\" realestate-seed.dump"
check ask "pg_restore --clean -d scraplify backup.dump"
# --- must ask: retention, storage, the service, backups, force push
check ask "npm run retention -- --apply"
check ask "node dist/cli/run-retention.js --apply"
check ask "docker volume rm scraplify_pgdata"
check ask "docker volume prune -f"
check ask "docker system prune -a --volumes"
check ask "docker compose down -v"
check ask "docker rm -f scraplify-postgres-1"
check ask "ssh ubuntu@152.228.171.98 'sudo systemctl stop postgresql'"
check ask "ssh ubuntu@152.228.171.98 'sudo apt-get purge postgresql-17'"
check ask "rclone delete r2:xtelo-backups/old"
check ask "aws s3 rm s3://xtelo-backups/2026-10-01.dump"
check ask "git push --force origin main"
check ask "git push -f"
check ask "git push origin +main"
check ask "git push --force-with-lease origin phase-14b"

# --- must pass: reads, ordinary writes, migrations and the corpus CLIs
check pass "docker exec scraplify-postgres-1 psql -U scraplify -d scraplify -c 'select count(*) from realestate.listings'"
check pass "psql -d scraplify -c \"update realestate.listings set house_number = 1 where id = 'x'\""
check pass "npm run db:migrate"
check pass "npm run crawl:ss-ge -- --mode=nightly"
check pass "npm run dedupe -- --auto-link"
check pass "node dist/cli/places-ss-ge.js --backfill"
check pass "npm run retention"
check pass "ssh -i ~/.ssh/xtelo_ovh_ed25519 ubuntu@152.228.171.98 'bash /home/ubuntu/deploy-14a.sh 5006a19ff74ad4a2760b56858face2ec0d19ea99'"
check pass "ssh ubuntu@152.228.171.98 \"sudo -n -u postgres psql -X -qAt -d scraplify -c 'set role scraplify_backup' -c 'select count(*) from realestate.places'\""
check pass "ssh ubuntu@152.228.171.98 'sudo systemctl restart xtelo-web@public'"
# --- must pass: the disposable databases
check pass "docker exec xtelo-re-test dropdb -U scraplify scraplify_qa_places"
check pass "echo 'drop database if exists scraplify_qa_grants14a' | docker exec -i xtelo-re-test psql -U scraplify -d postgres"
# --- must pass: text about SQL that runs nothing
check pass "grep -rn 'delete from' src/realestate"
check pass "rg -n 'DROP TABLE' drizzle/migrations"
check pass "git log --oneline -5"
check pass "git push -u origin phase-14b-official-map"
check pass "git push -q origin main"
check pass "gh pr merge 81 --merge --delete-branch"
check pass "truncate -s 0 /tmp/x.log"
check pass "docker compose down"

printf '%s of %s cases right\n' $((total - failed)) "$total"
[ "$failed" -eq 0 ]
