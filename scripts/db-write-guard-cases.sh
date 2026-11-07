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
# --- must ask: SQL it cannot read, or split across lines (security review 2026-11-07)
check ask "psql -d scraplify < cleanup.sql"
check ask "cat cleanup.sql | docker exec -i scraplify-postgres-1 psql -U scraplify -d scraplify"
check ask "pg_dump -d other | psql -d scraplify"
check ask "docker exec -i scraplify-postgres-1 psql -U scraplify -d scraplify <<'SQL'
DROP
TABLE realestate.places;
SQL"
# --- must ask: pushes that delete a remote branch
check ask "git push origin --delete main"
check ask "git push -d origin phase-14a-place-capture"
check ask "git push origin :main"
check ask "git push --prune origin"
# --- must ask: a qa name elsewhere in the command does not exempt a real target
check ask "docker exec scraplify-postgres-1 psql -d scraplify -c 'drop table x' # scraplify_qa"
check ask "psql postgresql://scraplify:pw@127.0.0.1:5432/scraplify -c 'delete from x' -v note=scraplify_qa_re"
check ask "ssh ubuntu@152.228.171.98 \"sudo -u postgres psql -d scraplify -c 'truncate realestate.places'\" # scraplify_qa"
# --- must ask: the exemption needs proof of a qa target (security review 2026-11-07, round 3)
check ask "psql \"\$DATABASE_URL\" -c 'drop table x' -v db=scraplify_qa_re"
check ask "psql \"\$DATABASE_URL\" -d scraplify_qa_re -c 'drop table x'"
check ask "psql -c 'drop table x' # -d scraplify_qa_re"
check ask "PGDATABASE=scraplify psql -d scraplify_qa_re -c 'truncate x'"
check ask "echo 'drop database scraplify' | docker exec -i scraplify-postgres-1 psql -d postgres"
# --- must ask: quoted refspecs and flags
check ask "git push origin ':main'"
check ask "git push origin \"+main\""
check ask "git push origin '+refs/heads/main:refs/heads/main'"
check ask "git push \"--force\" origin main"

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
# --- must ask: destructive work on the disposable databases too (no exemption since 2026-11-07)
check ask "docker exec xtelo-re-test dropdb -U scraplify scraplify_qa_places"
check ask "echo 'drop database if exists scraplify_qa_grants14a' | docker exec -i xtelo-re-test psql -U scraplify -d postgres"
# --- must pass: text about SQL that runs nothing
check pass "grep -rn 'delete from' src/realestate"
check pass "rg -n 'DROP TABLE' drizzle/migrations"
check pass "git log --oneline -5"
check pass "git push -u origin phase-14b-official-map"
check pass "git push -q origin main"
check pass "gh pr merge 81 --merge --delete-branch"
check pass "truncate -s 0 /tmp/x.log"
check pass "docker compose down"
check pass "git push origin HEAD:refs/heads/phase-14b"
check pass "git push origin 'HEAD:refs/heads/phase-14b'"
check ask "DATABASE_URL=postgresql://scraplify:throwaway@127.0.0.1:5544/scraplify_qa_re node -e \"client.query('DELETE FROM realestate.places')\""
check pass "DATABASE_URL=postgresql://scraplify:throwaway@127.0.0.1:5544/scraplify_qa_re npx vitest run"
check ask "printf 'TRUNCATE realestate.places' | docker exec -i xtelo-re-test psql -U scraplify -d scraplify_qa_re"
check ask "docker exec -i xtelo-re-test psql -U scraplify -d scraplify_qa_re <<'SQL'
DELETE FROM realestate.places;
SQL"
check ask "docker exec xtelo-re-test sh -c \"pg_dump -U scraplify --data-only scraplify_qa_places | psql -U scraplify -d scraplify_qa_grants14a\""

# Without jq the guard falls back to the raw payload: it must still ask, and
# still pass harmless commands. A jq that always fails stands first on PATH
# (portable: Git Bash's own tools cannot be copied out of their folder).
nojq_dir=$(mktemp -d)
printf '#!/bin/sh\nexit 127\n' > "$nojq_dir/jq"
chmod +x "$nojq_dir/jq"
nojq() { # $1 = ask|pass, $2 = a JSON payload written by hand
  total=$((total + 1))
  out=$(printf '%s' "$2" | PATH="$nojq_dir:$PATH" sh "$guard")
  case "$out" in *'"ask"'*) got=ask ;; *) got=pass ;; esac
  if [ "$got" != "$1" ]; then
    failed=$((failed + 1))
    printf 'WRONG without jq (want %s, got %s): %s\n' "$1" "$got" "$2"
  fi
}
nojq ask '{"tool_name":"Bash","tool_input":{"command":"psql -d scraplify -c \"DROP TABLE realestate.places\""}}'
nojq ask '{"tool_name":"Bash","tool_input":{"command":"docker exec scraplify-postgres-1 dropdb -U scraplify scraplify"}}'
nojq pass '{"tool_name":"Bash","tool_input":{"command":"git status --short"}}'
rm -rf "$nojq_dir"

printf '%s of %s cases right\n' $((total - failed)) "$total"
[ "$failed" -eq 0 ]
