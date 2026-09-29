#!/usr/bin/env bash
# RUNBOOK §2 step 1: write /etc/xtelo/*.env from deploy/env/*.template's shape,
# generating every role password and AUTH_SECRET on the host. Run as root:
#
#   sudo PUBLIC_HOST=jobster.fun ADMIN_HOST=admin.jobster.fun AUTH_GITHUB_ID=<client id> \
#     ADMIN_GITHUB_IDS=<numeric ids> CRAWLER_CONTACT_URL=https://jobster.fun \
#     deploy/make-env.sh
#
# It never overwrites an existing file (so secrets are generated exactly once)
# and never prints a secret. Two values are left for the owner, each set with
# its own hidden-input helper: the GitHub OAuth client secret
# (deploy/set-github-secret.sh) and the off-host backup credentials
# (deploy/set-r2-credentials.sh). Until the latter runs, BACKUP_REMOTE=none.
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo)" >&2; exit 1; }
: "${PUBLIC_HOST:?set PUBLIC_HOST, e.g. jobster.fun}"
: "${ADMIN_HOST:?set ADMIN_HOST, e.g. admin.jobster.fun}"
: "${AUTH_GITHUB_ID:?set AUTH_GITHUB_ID (the client id of the production OAuth app)}"
: "${ADMIN_GITHUB_IDS:?set ADMIN_GITHUB_IDS (numeric GitHub user ids, comma-separated)}"
: "${CRAWLER_CONTACT_URL:?set CRAWLER_CONTACT_URL (a page the sources can reach us through)}"
[[ "$ADMIN_GITHUB_IDS" =~ ^[0-9]+(,[0-9]+)*$ ]] || { echo "ADMIN_GITHUB_IDS must be numeric ids" >&2; exit 1; }

umask 077
install -d -o root -g root -m 0700 /etc/xtelo
cd /etc/xtelo

# Letters and digits only, which deploy/apply-db-roles.sh requires.
pw() { openssl rand -hex 32; }
db=127.0.0.1

write() { # write <name>: the file's content on stdin, only if it does not exist
  if [ -e "$1.env" ]; then
    echo "kept    /etc/xtelo/$1.env (exists)"
    cat > /dev/null
    return
  fi
  cat > "$1.env"
  chown root:root "$1.env"
  chmod 0600 "$1.env"
  echo "wrote   /etc/xtelo/$1.env"
}

write public <<EOF
XTELO_SURFACE=public
XTELO_PORT=3000
DATABASE_URL=postgres://scraplify_public:$(pw)@$db:5432/scraplify
XTELO_MATCHING_ARTIFACT_DIR=/var/lib/xtelo/bundles
XTELO_SITE_URL=https://$PUBLIC_HOST
LOG_LEVEL=info
EOF

write admin <<EOF
XTELO_SURFACE=admin
XTELO_PORT=3001
DATABASE_URL=postgres://scraplify_admin:$(pw)@$db:5432/scraplify
AUTH_GITHUB_ID=$AUTH_GITHUB_ID
AUTH_GITHUB_SECRET=SET_WITH_deploy/set-github-secret.sh
AUTH_SECRET=$(openssl rand -base64 32)
AUTH_URL=https://$ADMIN_HOST
ADMIN_GITHUB_IDS=$ADMIN_GITHUB_IDS
XTELO_WRITES_ENABLED=true
LOG_LEVEL=info
EOF

write worker <<EOF
DATABASE_URL=postgres://scraplify_worker:$(pw)@$db:5432/scraplify
XTELO_MATCHING_ARTIFACT_DIR=/var/lib/xtelo/bundles
XTELO_MATCHING_MODEL_DIR=/var/lib/xtelo/models
SCRAPLIFY_USER_AGENT=ScraplifyBot/0.1 (+$CRAWLER_CONTACT_URL; +https://github.com/Knight-Panther/scraplify)
LOG_LEVEL=info
EOF

write backup <<EOF
BACKUP_DATABASE_URL=postgres://scraplify_backup:$(pw)@$db:5432/scraplify
BACKUP_DIR=/var/backups/xtelo
BACKUP_RETENTION_COUNT=14
# Until deploy/set-r2-credentials.sh has run.
BACKUP_REMOTE=none
RCLONE_CONFIG=/dev/null
EOF

write migration <<EOF
DATABASE_URL=postgres://scraplify_migration:$(pw)@$db:5432/scraplify
EOF

ls -l /etc/xtelo
