#!/usr/bin/env bash
# Ubuntu's automatic security updates, in a quiet hour only, with a reboot
# right after one that needs it (xtelo-update-guard.sh says what "quiet" is).
# RUNBOOK §2 step 0. Idempotent; run as root from a release checkout:
#
#   sudo bash deploy/updates/install.sh
#
# Undo: delete the four installed files, `systemctl daemon-reload`, and
# `systemctl restart apt-daily-upgrade.timer`.
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo)" >&2; exit 1; }
here=$(cd "$(dirname "$0")" && pwd)

command -v jq >/dev/null || { apt-get update -q && apt-get -y -q install jq; }
install -m 0755 "$here/xtelo-update-guard.sh" /usr/local/sbin/xtelo-update-guard
install -D -m 0644 "$here/apt-daily-upgrade.timer.conf" /etc/systemd/system/apt-daily-upgrade.timer.d/xtelo.conf
install -D -m 0644 "$here/apt-daily-upgrade.service.conf" /etc/systemd/system/apt-daily-upgrade.service.d/xtelo.conf
install -m 0644 "$here/52xtelo-reboot" /etc/apt/apt.conf.d/52xtelo-reboot
systemctl daemon-reload
systemctl restart apt-daily-upgrade.timer

echo "== reboot settings"
apt-config dump | grep -F 'Unattended-Upgrade::Automatic-Reboot'
echo "== next try"
systemctl list-timers apt-daily-upgrade.timer --no-pager --no-legend
echo "== the guard, now (a person logged in to run this counts as \"not now\")"
/usr/local/sbin/xtelo-update-guard || true
