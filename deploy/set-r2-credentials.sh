#!/usr/bin/env bash
# Owner-run: point the nightly backup at a Cloudflare R2 bucket. Reads the R2
# API token's S3 credentials from hidden input (or stdin), rewrites the
# off-host lines of /etc/xtelo/backup.env, and runs one backup to prove the
# upload works.
#
#   ssh -t <host> sudo /opt/xtelo/current/deploy/set-r2-credentials.sh \
#     <cloudflare account id> <bucket> [<host IPv4>]
#
# Pass the host's IPv4 when the token is IP-filtered to it (recommended: a
# leaked key is then useless elsewhere). A dual-stack host otherwise reaches R2
# over IPv6, which that filter refuses with a 403; RCLONE_BIND pins rclone to
# the address. Binding to 0.0.0.0 is not enough: rclone still used IPv6 (first
# deployment, 2026-09-28).
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }
account="${1:-}"
bucket="${2:-}"
bind="${3:-}"
[[ "$account" =~ ^[0-9a-f]{32}$ ]] || { echo "usage: $0 <account id> <bucket> [<host IPv4>]" >&2; exit 2; }
[[ "$bucket" =~ ^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$ ]] || { echo "unexpected bucket name" >&2; exit 2; }
[ -z "$bind" ] || [[ "$bind" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || { echo "unexpected IPv4 address" >&2; exit 2; }
file=/etc/xtelo/backup.env
[ -f "$file" ] || { echo "$file is missing; run deploy/make-env.sh first" >&2; exit 1; }

read -rsp "R2 Access Key ID (input hidden): " id
echo
read -rsp "R2 Secret Access Key (input hidden): " secret
echo
[[ "$id" =~ ^[0-9a-f]{32}$ ]] || { echo "the Access Key ID is 32 hex characters; nothing changed" >&2; exit 1; }
[[ "$secret" =~ ^[0-9a-f]{64}$ ]] || { echo "the Secret Access Key is 64 hex characters; nothing changed" >&2; exit 1; }

tmp="$(mktemp /etc/xtelo/.backup.env.XXXXXX)"
grep -v -E '^(BACKUP_REMOTE|RCLONE_CONFIG|RCLONE_BIND|RCLONE_CONFIG_OFFSITE_[A-Z_]+)=|^# (Until deploy/set-r2|The R2 token is IP)' "$file" > "$tmp" || true
{
  echo "BACKUP_REMOTE=offsite:$bucket/xtelo"
  echo "RCLONE_CONFIG_OFFSITE_TYPE=s3"
  echo "RCLONE_CONFIG_OFFSITE_PROVIDER=Cloudflare"
  echo "RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID=$id"
  echo "RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY=$secret"
  echo "RCLONE_CONFIG_OFFSITE_ENDPOINT=https://$account.r2.cloudflarestorage.com"
  echo "RCLONE_CONFIG_OFFSITE_REGION=auto"
  # An object-scoped token cannot HeadBucket/CreateBucket; the bucket exists.
  echo "RCLONE_CONFIG_OFFSITE_NO_CHECK_BUCKET=true"
  echo "RCLONE_CONFIG=/dev/null"
  if [ -n "$bind" ]; then
    echo "# The R2 token is IP-filtered to this address; keep rclone off IPv6."
    echo "RCLONE_BIND=$bind"
  fi
} >> "$tmp"
chown root:root "$tmp"
chmod 0600 "$tmp"
mv "$tmp" "$file"

echo "Saved. Running one backup to test the upload..."
systemctl start xtelo-backup
journalctl -u xtelo-backup -n 4 -o cat --no-pager
