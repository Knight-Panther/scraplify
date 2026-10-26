#!/usr/bin/env bash
# Turns a home Ubuntu machine in Georgia into the ss.ge crawl's proxy exit
# (ss.ge answers only Georgian addresses since 2026-10-22; docs/STATUS.md).
#
#   - tinyproxy on 127.0.0.1:8888, for CONNECT to ss.ge on port 443 only;
#   - a reverse SSH tunnel kept up by autossh as the host's xtelo-tunnel user
#     (deploy/set-proxy-tunnel.sh): the host's 127.0.0.1:18888 reaches the
#     proxy, and its 127.0.0.1:2222 this machine's SSH, for managing it from
#     behind the home router;
#   - restarts for a crashed tinyproxy, and security-update reboots at 13:00.
#
# Run as root on the laptop, with the host's address (kept out of this public
# repository) and the user whose ~/.ssh/tunnel key the host trusts:
#   sudo bash setup.sh <host-address> xtelo
# The host's key must already be in that user's known_hosts (the first manual
# connection puts it there). Safe to run again.
set -euo pipefail

host="${1:?usage: setup.sh <host-address> <user>}"
user="${2:?usage: setup.sh <host-address> <user>}"
home="$(getent passwd "$user" | cut -d: -f6)"
[[ -f "$home/.ssh/tunnel" ]] || { echo "$home/.ssh/tunnel is missing" >&2; exit 1; }
# known_hosts is hashed on Ubuntu, so look the host up rather than grep for it.
ssh-keygen -F "$host" -f "$home/.ssh/known_hosts" >/dev/null || {
  echo "$host is not in $home/.ssh/known_hosts" >&2
  exit 1
}

cat > /etc/tinyproxy/tinyproxy.conf <<'EOF'
# The ss.ge crawl's exit (deploy/proxy-laptop/setup.sh). Reachable only on
# loopback, which the host reaches through the reverse tunnel.
User tinyproxy
Group tinyproxy
Port 8888
Listen 127.0.0.1
Timeout 120
DefaultErrorFile "/usr/share/tinyproxy/default.html"
LogFile "/var/log/tinyproxy/tinyproxy.log"
LogLevel Warning
PidFile "/run/tinyproxy/tinyproxy.pid"
MaxClients 20
Allow 127.0.0.1
DisableViaHeader Yes
# Tunnels to port 443 only, and only to ss.ge hosts.
ConnectPort 443
FilterType ere
FilterDefaultDeny Yes
Filter "/etc/tinyproxy/filter"
EOF
printf '%s\n' '(^|\.)ss\.ge$' > /etc/tinyproxy/filter
# Ubuntu's unit leaves a crashed tinyproxy down.
install -d /etc/systemd/system/tinyproxy.service.d
printf '[Service]\nRestart=on-failure\nRestartSec=5\n' \
  > /etc/systemd/system/tinyproxy.service.d/restart.conf
systemctl daemon-reload
systemctl restart tinyproxy

# Security updates install daily; a kernel or library update only takes
# effect after a reboot, so allow one at 13:00 Tbilisi (09:00 UTC), far from
# the 21:30 UTC crawl and the hours it may spend waiting for this machine.
timedatectl set-timezone Asia/Tbilisi
cat > /etc/apt/apt.conf.d/52xtelo-reboot <<'EOF'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-WithUsers "true";
Unattended-Upgrade::Automatic-Reboot-Time "13:00";
EOF

cat > /etc/systemd/system/xtelo-proxy-tunnel.service <<EOF
[Unit]
Description=Reverse tunnel to the xtelo host for the ss.ge proxy
Wants=network-online.target
After=network-online.target tinyproxy.service

[Service]
User=$user
Environment=AUTOSSH_GATETIME=0
ExecStart=/usr/bin/autossh -M 0 -N \\
  -o ServerAliveInterval=10 -o ServerAliveCountMax=3 \\
  -o ExitOnForwardFailure=yes -o StrictHostKeyChecking=yes -o BatchMode=yes \\
  -i $home/.ssh/tunnel \\
  -R 127.0.0.1:2222:127.0.0.1:22 -R 127.0.0.1:18888:127.0.0.1:8888 \\
  xtelo-tunnel@$host
Restart=always
RestartSec=15

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now xtelo-proxy-tunnel.service
echo "tinyproxy: $(systemctl is-active tinyproxy); tunnel: $(systemctl is-active xtelo-proxy-tunnel)"
