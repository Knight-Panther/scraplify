#!/usr/bin/env bash
# The SSH user a Georgian proxy machine (the owner's home laptop) logs in as to
# hold one reverse tunnel: the host's 127.0.0.1:18888 then reaches the
# laptop's HTTP proxy, and the ss.ge crawl uses it through SS_GE_PROXY_URL
# (deploy/env/worker.env.template). ss.ge answers only Georgian addresses
# since 2026-10-22 (docs/STATUS.md).
#
# The key may do nothing but open those two listeners on loopback: no shell, no
# commands, no other forwarding, no agent or X11. Run as root with the
# laptop's public key (one line) on standard input:
#   sudo /opt/xtelo/current/deploy/set-proxy-tunnel.sh < laptop.pub
# Running it again replaces the key.
set -euo pipefail

user=xtelo-tunnel
home=/var/lib/xtelo-tunnel
listen=127.0.0.1:18888
# The laptop's own SSH, for managing it from the host (it sits behind a home
# router): ssh -J <host> -p 2222 xtelo@127.0.0.1
manage=127.0.0.1:2222

key="$(head -n 1)"
[[ "$key" =~ ^ssh-(ed25519|rsa)\ [A-Za-z0-9+/=]+(\ .*)?$ ]] || {
  echo "standard input must be one OpenSSH public key line" >&2
  exit 1
}

if ! id "$user" >/dev/null 2>&1; then
  useradd --system --home-dir "$home" --create-home --shell /usr/sbin/nologin "$user"
fi
install -d -m 0700 -o "$user" -g "$user" "$home/.ssh"
# permitopen names a closed port, so the key cannot forward into the host
# (Postgres and the web servers listen on its loopback).
printf 'restrict,port-forwarding,permitlisten="%s",permitlisten="%s",permitopen="127.0.0.1:1",command="/bin/false" %s\n' \
  "$listen" "$manage" "$key" > "$home/.ssh/authorized_keys.new"
chown "$user:$user" "$home/.ssh/authorized_keys.new"
chmod 0600 "$home/.ssh/authorized_keys.new"
mv "$home/.ssh/authorized_keys.new" "$home/.ssh/authorized_keys"
echo "$user may hold tunnels to $listen and $manage; nothing else."
