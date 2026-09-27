#!/usr/bin/env bash
# Database roles and grants on the host (Phase 8E), in the only order that
# works on a fresh database, and stopping at the first error. Run as root on
# the database host (it connects as the `postgres` superuser over peer auth).
#
#   sudo deploy/apply-db-roles.sh bootstrap   # before the first db:migrate
#   sudo deploy/apply-db-roles.sh grants      # after EVERY db:migrate
#
# bootstrap creates the database if it is missing and the migration role
# with just enough to run db:migrate, which then creates (and owns) every
# table and view. grants runs both scripts/sql/phase-8b-*.sql files in full:
# they create the public, worker and admin roles if missing and grant them
# exactly their objects. Both are idempotent. Re-running grants after every
# migration matters: a migration that recreates a view drops its grants (the
# public role script's own warning), and a new table has none.
#
# The scripts' placeholders are filled from the role passwords in each
# process's /etc/xtelo/<name>.env DATABASE_URL, so there is one place a
# password lives. Generate them with `openssl rand -hex 32`: only letters and
# digits are accepted, so nothing needs URL- or SQL-escaping. The passwords
# are only piped to psql, never printed.
set -euo pipefail

mode="${1:-}"
case "$mode" in
  bootstrap | grants) ;;
  *)
    echo "usage: $0 bootstrap|grants" >&2
    exit 2
    ;;
esac

[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo)" >&2; exit 1; }
repository="$(cd "$(dirname "$0")/.." && pwd)"

# role_url <env name> <expected role> [variable]: validates that env file's
# DATABASE_URL (or the named variable) and prints `<password> <database>`.
role_url() {
  local file="/etc/xtelo/$1.env" variable="${3:-DATABASE_URL}" url rest user password database
  url="$(sed -n "s/^$variable=//p" "$file" | tail -n 1)"
  [ -n "$url" ] || { echo "$file has no $variable" >&2; return 1; }
  rest="${url#postgres://}"
  rest="${rest#postgresql://}"
  user="${rest%%:*}"
  password="${rest#*:}"
  password="${password%%@*}"
  database="${rest##*/}"
  database="${database%%\?*}"
  [ "$user" = "$2" ] || { echo "$file: DATABASE_URL must use role $2" >&2; return 1; }
  [[ "$password" =~ ^[A-Za-z0-9]{24,}$ ]] || {
    echo "$file: the $2 password must be 24+ letters and digits (openssl rand -hex 32)" >&2
    return 1
  }
  [[ "$database" =~ ^[a-z_][a-z0-9_]*$ ]] || { echo "$file: unexpected database name" >&2; return 1; }
  printf '%s %s\n' "$password" "$database"
}

read -r migration_password database < <(role_url migration scraplify_migration)

psql_db() {
  runuser -u postgres -- psql -X --quiet -v ON_ERROR_STOP=1 --dbname="$database" --file=-
}

if [ "$mode" = bootstrap ]; then
  if ! runuser -u postgres -- psql -X -tAc "select 1 from pg_database where datname = '$database'" | grep -q 1; then
    runuser -u postgres -- createdb "$database"
    echo "Created database $database."
  fi
  # The migration role's part of scripts/sql/phase-8b-worker-admin-migration-roles.sql
  # (section 3), without its grants on tables that do not exist yet.
  psql_db <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'scraplify_migration') THEN
    EXECUTE \$create\$CREATE ROLE scraplify_migration LOGIN PASSWORD '$migration_password' NOCREATEDB NOCREATEROLE\$create\$;
  END IF;
END \$\$;
GRANT CONNECT ON DATABASE $database TO scraplify_migration;
GRANT CREATE, USAGE ON SCHEMA public TO scraplify_migration;
GRANT CREATE ON DATABASE $database TO scraplify_migration;
SQL
  echo "Migration role ready. Next: with-env.sh migration npm run db:migrate, then $0 grants."
  exit 0
fi

read -r public_password public_database < <(role_url public scraplify_public)
read -r worker_password worker_database < <(role_url worker scraplify_worker)
read -r admin_password admin_database < <(role_url admin scraplify_admin)
read -r backup_password backup_database < <(role_url backup scraplify_backup BACKUP_DATABASE_URL)
for other in "$public_database" "$worker_database" "$admin_database" "$backup_database"; do
  [ "$other" = "$database" ] || { echo "the env files name different databases" >&2; exit 1; }
done

# The ownership loop hands scraplify_migration anything the superuser owns in
# public/drizzle (after a restore run as postgres, for example); on a database
# only ever migrated as scraplify_migration it changes nothing.
fill() {
  sed -e "s/<STRONG_PASSWORD_HERE_WORKER>/$worker_password/g" \
    -e "s/<STRONG_PASSWORD_HERE_ADMIN>/$admin_password/g" \
    -e "s/<STRONG_PASSWORD_HERE_MIGRATION>/$migration_password/g" \
    -e "s/<STRONG_PASSWORD_HERE>/$public_password/g" \
    -e "s/<TARGET_DATABASE>/$database/g" \
    -e "s/<CURRENT_OWNER_ROLE>/postgres/g" \
    "$1"
}

fill "$repository/scripts/sql/phase-8b-public-role.sql" | psql_db
fill "$repository/scripts/sql/phase-8b-worker-admin-migration-roles.sql" | psql_db

# The nightly backup's role: reads everything (pg_dump needs that), writes
# nothing, and is never the migration credential.
psql_db <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'scraplify_backup') THEN
    EXECUTE \$create\$CREATE ROLE scraplify_backup LOGIN PASSWORD '$backup_password' NOCREATEDB NOCREATEROLE\$create\$;
  END IF;
END \$\$;
GRANT CONNECT ON DATABASE $database TO scraplify_backup;
GRANT pg_read_all_data TO scraplify_backup;
SQL

# The public role must be able to write nothing; the public process refuses
# to start otherwise, but finding out here is cheaper.
writable="$(runuser -u postgres -- psql -X -tA --dbname="$database" -c "
  select count(*) from information_schema.table_privileges
  where grantee = 'scraplify_public'
    and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')")"
[ "$writable" = 0 ] || { echo "scraplify_public can write to $writable relation(s)" >&2; exit 1; }
echo "Roles and grants applied to $database; scraplify_public is read-only."
