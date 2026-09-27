#!/usr/bin/env bash
# Run one command on the host exactly as the matching unit would see it: as
# that process's user, with its /etc/xtelo/<name>.env, in the release this
# script belongs to (the live one through /opt/xtelo/current, or a new one
# before it goes live, to run its migrations).
#
#   sudo /opt/xtelo/current/deploy/with-env.sh worker node dist/cli/health-check.js
#   sudo /opt/xtelo/current/deploy/with-env.sh worker npm run matching:rollback
#   sudo /opt/xtelo/releases/<sha>/deploy/with-env.sh migration npm run db:migrate
#
# The env files are root-only (0600), so this goes through systemd-run, which
# reads them the same way the units do (the same parser, so a value with `&`
# or `$` means the same thing here as in production). --wait returns the
# command's own exit code.
set -euo pipefail

name="${1:-}"
case "$name" in
  public | admin) user="xtelo-$name" ;;
  worker | migration | backup) user=xtelo ;;
  *)
    echo "usage: $0 public|admin|worker|migration|backup <command> [args...]" >&2
    exit 2
    ;;
esac
shift
[ "$#" -gt 0 ] || { echo "no command given" >&2; exit 2; }

release="$(cd "$(dirname "$0")/.." && pwd)"
file="/etc/xtelo/$name.env"
[ -r "$file" ] || { echo "cannot read $file (run with sudo)" >&2; exit 1; }

surface=()
case "$name" in public | admin) surface=(--setenv="XTELO_SURFACE=$name") ;; esac

tty=--pipe
[ -t 0 ] && [ -t 1 ] && tty=--pty

exec systemd-run --quiet --wait --collect "$tty" \
  --uid="$user" --gid="$user" \
  --working-directory="$release" \
  --property=EnvironmentFile="$file" \
  --setenv=NODE_ENV=production \
  --setenv=NEXT_TELEMETRY_DISABLED=1 \
  "${surface[@]}" \
  -- "$@"
