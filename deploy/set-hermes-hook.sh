#!/usr/bin/env bash
# Owner-run: point the Hermes hook at Hermes (docs/hermes-hook.md). Takes the
# webhook address as an argument and reads the three secrets from hidden
# input, writes /etc/xtelo/hermes-hook.env, and sends one test event to prove
# the path.
#
#   ssh -t <host> sudo /opt/xtelo/current/deploy/set-hermes-hook.sh \
#     https://hooks.jobster.fun/webhooks/xtelo-pipeline
#
# The values come from Hermes' side: the webhook route's HMAC secret, and the
# Cloudflare Access service token that lets the host through to the tunnel.
# This only sets where events go. Events are written once HERMES_HOOK_ENABLED=1
# is in /etc/xtelo/worker.env.
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }
url="${1:-}"
[[ "$url" =~ ^https://[a-z0-9.-]+/webhooks/[A-Za-z0-9_-]+$ ]] ||
  { echo "usage: $0 https://<hook host>/webhooks/<route>" >&2; exit 2; }
[ -d /etc/xtelo ] || { echo "/etc/xtelo is missing; run deploy/host-setup.sh first" >&2; exit 1; }
id xtelo-hermes >/dev/null 2>&1 ||
  { echo "the xtelo-hermes user is missing; do RUNBOOK section 3 step 7 first" >&2; exit 1; }
release="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$release/dist/cli/hermes-event.js" ] || { echo "$release is not a built release" >&2; exit 1; }

read -rsp "Webhook HMAC secret (input hidden): " secret
echo
read -rsp "Cloudflare Access Client ID (input hidden): " access_id
echo
read -rsp "Cloudflare Access Client Secret (input hidden): " access_secret
echo
# Characters systemd reads from an env file as they are, with no quoting.
[[ "$secret" =~ ^[A-Za-z0-9._~+/=-]{16,}$ ]] ||
  { echo "the HMAC secret is 16 or more letters, digits or . _ ~ + / = -; nothing changed" >&2; exit 1; }
[[ "$access_id" =~ ^[0-9a-f]{32}\.access$ ]] ||
  { echo "the Access Client ID is 32 hex characters followed by .access; nothing changed" >&2; exit 1; }
# Cloudflare has issued this as 64 hex characters and (2026-10-13) as 54
# letters, digits and underscores. Checked for what an env file takes unquoted.
[[ "$access_secret" =~ ^[A-Za-z0-9_-]{32,128}$ ]] ||
  { echo "the Access Client Secret is 32 to 128 letters, digits, _ or -; nothing changed" >&2; exit 1; }

file=/etc/xtelo/hermes-hook.env
tmp="$(mktemp /etc/xtelo/.hermes-hook.env.XXXXXX)"
{
  echo "HERMES_HOOK_URL=$url"
  echo "HERMES_HOOK_SECRET=$secret"
  echo "CF_ACCESS_CLIENT_ID=$access_id"
  echo "CF_ACCESS_CLIENT_SECRET=$access_secret"
} > "$tmp"
chown root:root "$tmp"
chmod 0600 "$tmp"
mv "$tmp" "$file"

outbox=/var/lib/xtelo/hermes/outbox
dead=/var/lib/xtelo/hermes/dead
install -d -o xtelo-hermes -g xtelo-hermes -m 0755 /var/lib/xtelo/hermes
install -d -o xtelo -g xtelo-hermes -m 2770 "$outbox"
install -d -o xtelo-hermes -g xtelo-hermes -m 0700 "$dead"

echo "Saved. Sending one test event..."
# An earlier attempt's refused test event would read as this one's.
rm -f "$dead"/test_*.json
(cd "$release" && runuser -u xtelo -- /usr/bin/node dist/cli/hermes-event.js --test > /dev/null)
systemctl start xtelo-hermes-notify || true
journalctl -u xtelo-hermes-notify -n 5 -o cat --no-pager
if compgen -G "$outbox/test_*.json" > /dev/null; then
  echo "Not delivered: Hermes did not take it (see the lines above). It stays in $outbox and is tried again every 15 minutes."
elif compgen -G "$dead/test_*.json" > /dev/null; then
  echo "Refused: Hermes or Cloudflare Access turned it down (see the status above). A wrong secret or service token does this. The event is in $dead; delete it once fixed."
  exit 1
else
  echo "Delivered."
fi
