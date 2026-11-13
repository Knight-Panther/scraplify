#!/usr/bin/env bash
# Whether Ubuntu's automatic security updates may run now. Installed as the
# ExecCondition= of apt-daily-upgrade.service by deploy/updates/install.sh
# (RUNBOOK §2 step 0). Exit 0 lets them run; exit 1 skips this try, which
# systemd logs without failing the unit. The timer tries every hour and apt
# installs at most once a calendar day, so the updates land in the day's first
# quiet hour, wherever the jobs happen to be scheduled.
#
# An update can restart Postgres and every service still on an old library
# (needrestart), and one that needs a reboot reboots the host right after it
# (52xtelo-reboot). On 2026-11-13 at 06:40 a libc update did the first in the
# middle of an ss.ge run. So the updates run only when:
#   - no Xtelo job is running: an active oneshot xtelo-*.service, whether its
#     timer or a person started it;
#   - no Xtelo timer fires within the next XTELO_UPDATE_QUIET_MINUTES (60);
#   - no person is logged in over SSH (UID 1000 or more): a deploy or a
#     migration by hand. Service accounts, such as the laptop's tunnel and
#     Hermes's database tunnel, are system users and do not count.
# Timers whose schedule fires at least every two hours (the proxy watch, the
# Hermes sender) start short jobs that are harmless to interrupt; they are
# ignored on both counts.
#
# Nothing about the schedule is written here: it is read from systemd on every
# try, so a job added or moved later is respected as long as its units are
# named xtelo-*. Anything it cannot read counts as "not now".
set -uo pipefail

QUIET_SECONDS=$(( ${XTELO_UPDATE_QUIET_MINUTES:-60} * 60 ))
FREQUENT_SECONDS=$(( 2 * 60 * 60 ))

not_now() {
  echo "xtelo-update-guard: not now: $*"
  exit 1
}

# Seconds between a timer's next two firings by its own OnCalendar= schedule,
# or nothing when it has none (a timer with only monotonic triggers is never
# taken for frequent). Read from the schedule, not from when it last fired: a
# timer that has not fired since a boot has no last firing.
interval() {
  local spec times first second
  spec=$(systemctl show -P TimersCalendar "$1" | grep -o 'OnCalendar=[^;]*' | head -n1)
  spec=${spec#OnCalendar=}
  spec=${spec% }
  [ -n "$spec" ] || return 0
  times=$(systemd-analyze calendar --iterations=2 "$spec" 2>/dev/null |
    sed -n 's/^ *\(Next elapse\|Iteration #2\): [A-Za-z]* //p')
  # A one-off date has no second firing; `date -d ""` would read today's midnight.
  [ "$(grep -c . <<<"$times")" -eq 2 ] || return 0
  first=$(date -d "$(sed -n 1p <<<"$times")" +%s 2>/dev/null) || return 0
  second=$(date -d "$(sed -n 2p <<<"$times")" +%s 2>/dev/null) || return 0
  [ "$second" -gt "$first" ] || return 0
  echo $(( second - first ))
}

timers=$(systemctl list-timers --all --output=json 'xtelo-*') || not_now "cannot list the timers"
listed=$(jq -r '.[] | "\(.unit) \(.activates) \(.next // 0)"' <<<"$timers") || not_now "cannot read the timers"
now=$(date +%s)
frequent=()  # the services frequent timers start
due=()       # the other timers, firing within the quiet window
while read -r timer service next_us; do
  [ -n "$timer" ] || continue
  every=$(interval "$timer")
  if [ -n "$every" ] && [ "$every" -le "$FREQUENT_SECONDS" ]; then
    frequent+=("$service")
  elif [ "$next_us" -gt 0 ] && [ $(( next_us / 1000000 - now )) -le "$QUIET_SECONDS" ]; then
    due+=("$timer at $(date -u -d "@$(( next_us / 1000000 ))" '+%H:%M UTC')")
  fi
done <<<"$listed"
[ "${#due[@]}" -eq 0 ] || not_now "due within $(( QUIET_SECONDS / 60 )) min: ${due[*]}"

running=$(systemctl list-units --type=service --state=active,activating,deactivating,reloading \
  --plain --no-legend 'xtelo-*') || not_now "cannot list the services"
busy=()
while read -r unit _; do
  [ -n "$unit" ] || continue
  [[ " ${frequent[*]} " == *" $unit "* ]] && continue
  [ "$(systemctl show -P Type "$unit")" = oneshot ] || continue
  busy+=("$unit")
done <<<"$running"
[ "${#busy[@]}" -eq 0 ] || not_now "running: ${busy[*]}"

sessions=$(loginctl list-sessions --no-legend) || not_now "cannot list the sessions"
people=$(awk '$2 >= 1000 && $2 < 65534 { print $3 }' <<<"$sessions" | sort -u | paste -sd' ')
[ -z "$people" ] || not_now "logged in: $people"

echo "xtelo-update-guard: quiet, the updates may run"
exit 0
