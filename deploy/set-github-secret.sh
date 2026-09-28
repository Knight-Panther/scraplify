#!/usr/bin/env bash
# Owner-run: store the production GitHub OAuth app's client secret in
# /etc/xtelo/admin.env from hidden input, so it never touches a chat, a
# terminal log or a command line. Restarts admin if it is enabled.
#
#   ssh -t <host> sudo /opt/xtelo/current/deploy/set-github-secret.sh
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }
file=/etc/xtelo/admin.env
[ -f "$file" ] || { echo "$file is missing; run deploy/make-env.sh first" >&2; exit 1; }

read -rsp "GitHub OAuth client secret (input hidden): " secret
echo
[[ "$secret" =~ ^[0-9a-f]{40}$ ]] || {
  echo "that does not look like a GitHub client secret (40 hex characters); nothing changed" >&2
  exit 1
}
sed -i "s/^AUTH_GITHUB_SECRET=.*/AUTH_GITHUB_SECRET=$secret/" "$file"
echo "Saved to $file."
if systemctl is-enabled --quiet xtelo-web@admin 2>/dev/null; then
  systemctl restart xtelo-web@admin
  echo "Restarted xtelo-web@admin."
fi
