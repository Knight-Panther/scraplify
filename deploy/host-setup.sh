#!/usr/bin/env bash
# RUNBOOK §2 step 0: prepare a fresh Ubuntu 24.04 host. Idempotent; run as root:
#
#   sudo bash deploy/host-setup.sh
#
# Installs the host prerequisites the units rely on (swap, firewall, Node 24 at
# /usr/bin/node, Postgres 17 from PGDG, Caddy from its own repository, rclone,
# git), locks SSH to keys only, and creates the service users and directories.
# Used for the first deployment (OVH VPS-1, 2026-09-28).
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo)" >&2; exit 1; }
. /etc/os-release
[ "$VERSION_ID" = "24.04" ] || { echo "expected Ubuntu 24.04, got $VERSION_ID" >&2; exit 1; }

echo "== apt baseline"
apt-get update -q
apt-get -y -q upgrade
apt-get -y -q install ca-certificates curl gnupg git rclone openssl ufw \
  debian-keyring debian-archive-keyring apt-transport-https postgresql-common

echo "== swap (2G): a 4 GB host builds Next beside Postgres and two web processes"
if ! swapon --show | grep -q /swapfile; then
  [ -f /swapfile ] || fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
fi
grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab

echo "== SSH: keys only, no root login"
# Check first that someone can still get in with a key: this turns passwords off.
if ! grep -qs . /home/*/.ssh/authorized_keys; then
  echo "no authorized_keys for any user; refusing to turn off password logins" >&2
  exit 1
fi
cat > /etc/ssh/sshd_config.d/00-xtelo.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
EOF
# Ubuntu 24.04 starts sshd per connection (socket activation), so its runtime
# directory may not exist yet, and `sshd -t` needs it.
install -d -m 0755 /run/sshd
sshd -t
systemctl try-reload-or-restart ssh

echo "== firewall"
ufw allow OpenSSH
ufw allow 80,443/tcp
ufw --force enable

echo "== Node 24 (NodeSource) at /usr/bin/node, not fnm/nvm: the units cannot see a home directory"
if ! /usr/bin/node --version 2>/dev/null | grep -q '^v24\.'; then
  curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/nodesource_setup.sh
  bash /tmp/nodesource_setup.sh
  apt-get -y -q install nodejs
fi

echo "== Postgres 17 from PGDG (Ubuntu 24.04 ships 16); listens on localhost only"
if ! dpkg -s postgresql-17 >/dev/null 2>&1; then
  /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
  apt-get -y -q install postgresql-17
fi

echo "== Caddy (its official repository)"
if ! dpkg -s caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' |
    gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get -y -q install caddy
fi

echo "== users and directories (systemd refuses a unit whose ReadWritePaths is missing)"
id xtelo >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/xtelo --shell /usr/sbin/nologin xtelo
id xtelo-public >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin xtelo-public
id xtelo-admin >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin xtelo-admin
# 0755, not useradd's 0750: the public site reads the bundles below it.
install -d -o xtelo -g xtelo -m 0755 /var/lib/xtelo /opt/xtelo /opt/xtelo/releases /var/lib/xtelo/bundles /var/lib/xtelo/models
install -d -o xtelo -g xtelo -m 0700 /var/backups/xtelo
install -d -o root -g root -m 0700 /etc/xtelo

echo "== summary"
echo "node $(/usr/bin/node --version), npm $(npm --version)"
psql --version
pg_lsclusters
caddy version
rclone version | head -1
ufw status | head -6
free -h | head -3
df -h / | tail -1
