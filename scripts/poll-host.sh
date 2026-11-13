#!/usr/bin/env bash
# One compact look at the hosted edition, for the standing 30-minute poll
# (owner request, 2026-11-13; the poll's own note is the machine-local
# .git/standing-poll, which the SessionStart hook prints so every new session
# re-arms it). Read-only on the host. Prints a few status lines and, when
# something needs a person, lines starting with FLAG.
#
#   bash scripts/poll-host.sh [ssh-host]     (default: xtelo-host)
#
# The previous poll's numbers are kept in .git/poll-state, so the ss.ge line
# can say what the run did since then and spot a stall.
set -u

host=${1:-xtelo-host}
root=$(git rev-parse --show-toplevel 2>/dev/null) || root=.
state="$(git -C "$root" rev-parse --git-common-dir 2>/dev/null || echo "$root/.git")/poll-state"
case $state in /*|[A-Za-z]:*) ;; *) state="$root/$state" ;; esac

raw=$(ssh -o BatchMode=yes -o ConnectTimeout=15 "$host" 'bash -s' <<'EOF' 2>&1
set -u
q() { sudo -n -u postgres psql -X -qAt -F '|' -d scraplify -c 'set default_transaction_read_only = on' -c "$1" 2>/dev/null; }
echo "UPSINCE|$(date -u -d "$(uptime -s)" +%s 2>/dev/null)"
echo "RUN|$(q "select left(id::text,8), status, extract(epoch from started_at)::bigint, coalesce(extract(epoch from finished_at)::bigint, 0), request_count, failed_request_count, replace(coalesce(notes, ''), '|', '/') from realestate.crawl_runs order by started_at desc limit 1")"
echo "LIST|$(q "select k || ' p.' || (v->>'lastPage') from realestate.crawl_runs r, jsonb_each(r.progress->'lists') e(k, v) where r.id = (select id from realestate.crawl_runs order by started_at desc limit 1) and v->>'finished' is null limit 1")"
j=$(sudo -n journalctl -u 'xtelo-realestate@*' --since -24h --no-pager -o short-unix 2>/dev/null)
echo "PROXY|$(grep -E 'proxy unreachable|proxy is back' <<<"$j" | tail -1 | awk '{ split($1, t, "."); print t[1] "|" ($0 ~ /unreachable/ ? "down" : "up") }')"
echo "FAILED|$(systemctl --failed --no-legend --plain | awk '{ print $1 }' | paste -sd' ')"
echo "SERVICES|$(for u in xtelo-web@public xtelo-web@admin postgresql@17-main caddy; do printf '%s ' "$(systemctl is-active "$u")"; done)"
for s in jobs-ge hr-ge etenders-ge; do
  echo "PIPE|$s|$(systemctl show "xtelo-pipeline@$s" -P Result)|$(systemctl show "xtelo-pipeline@$s" -P ActiveState)|$(date -u -d "$(systemctl show "xtelo-pipeline@$s" -P ExecMainExitTimestamp)" +%s 2>/dev/null || echo 0)"
done
echo "BACKUP|$(systemctl show xtelo-backup -P Result)|$(sudo -n journalctl -u xtelo-backup --since -36h --no-pager -o cat 2>/dev/null | grep -c 'Copied off the host')"
echo "GUARD|$(sudo -n journalctl -u apt-daily-upgrade --since -3h --no-pager -o cat 2>/dev/null | grep 'xtelo-update-guard' | tail -1 | sed 's/^xtelo-update-guard: //')"
echo "UPGRADE|$(date -u -r /var/lib/apt/periodic/upgrade-stamp +%s 2>/dev/null || echo 0)|$(date -u -r /var/run/reboot-required +%s 2>/dev/null || echo 0)"
echo "TUNNEL|$(ss -ltn | grep -cE '127\.0\.0\.1:(18888|2222) ')"
hc=$(cd /opt/xtelo/current && sudo -n deploy/with-env.sh worker node dist/cli/health-check.js 2>&1); hce=$?
echo "HEALTH|$hce|$(grep -v ': ok$' <<<"$hc" | tail -3 | paste -sd';')"
EOF
)
ssh_exit=$?
site=$(curl -s -o /dev/null -m 20 -w '%{http_code} %{time_total}' https://jobster.fun/ 2>/dev/null || echo "000 0")

now=$(date +%s)
tbilisi() { date -u -d "@$(( $1 + 4 * 3600 ))" '+%H:%M'; }
field() { grep "^$1|" <<<"$raw" | head -n1 | cut -d'|' -f2-; }
flags=()

echo "poll $(date -u '+%H:%M UTC') ($(tbilisi "$now") Tbilisi)"
if [ "$ssh_exit" -ne 0 ] && ! grep -q '^RUN|' <<<"$raw"; then
  echo "FLAG host unreachable over SSH: $(tail -n1 <<<"$raw")"
  echo "site: $site"
  exit 0
fi

# ss.ge run, and what it did since the previous poll.
IFS='|' read -r id status started finished req failed notes <<<"$(field RUN)"
prev_id='' prev_req=0 prev_failed=0 prev_at=0 prev_up=0
# shellcheck disable=SC1090
[ -f "$state" ] && . "$state"
since=''
if [ "$id" = "$prev_id" ] && [ "$prev_at" -gt 0 ]; then
  mins=$(( (now - prev_at) / 60 ))
  dreq=$(( req - prev_req )); dfail=$(( failed - prev_failed ))
  since=", last ${mins} min: ${dreq} req, ${dfail} failed"
fi
read -r proxy_at proxy_state <<<"$(field PROXY | tr '|' ' ')"
list=$(field LIST)
if [ "$status" = running ]; then
  elapsed=$(( (now - started) / 60 ))
  echo "ss.ge: run $id running $((elapsed / 60))h$((elapsed % 60))m, ${req} req, ${failed} failed${since}; at ${list:-the checks/details}${notes:+; notes: $notes}"
  if [ "${proxy_state:-up}" = down ]; then
    down=$(( (now - proxy_at) / 60 ))
    [ "$down" -ge 15 ] && flags+=("laptop proxy down since $(tbilisi "$proxy_at") Tbilisi (${down} min)")
  elif [ -n "$since" ] && [ "$mins" -ge 20 ] && [ "$dreq" -eq 0 ]; then
    flags+=("ss.ge run made no request in ${mins} min")
  fi
  if [ -n "$since" ] && [ "$dreq" -ge 20 ] && [ $(( dfail * 100 / dreq )) -gt 15 ]; then
    flags+=("ss.ge failures ${dfail} of ${dreq} since the last poll")
  fi
else
  echo "ss.ge: run $id ended $status at $(tbilisi "$finished") Tbilisi, ${req} req, ${failed} failed${notes:+; notes: $notes}"
  case $status in
    completed) [ $(( now - finished )) -lt 3600 ] && echo "NOTE the run just ended: do the post-run checks (.git/session-handoff, NEXT)" ;;
    *) [ $(( now - finished )) -lt 86400 ] && flags+=("ss.ge run $id ended $status: ${notes:-no notes}") ;;
  esac
fi

# Host, services, site.
up=$(field UPSINCE)
failed_units=$(field FAILED)
read -r pub adm pg caddy <<<"$(field SERVICES)"
tunnel=$(field TUNNEL)
IFS='|' read -r hc_exit hc_bad <<<"$(field HEALTH)"
echo "host: up since $(tbilisi "${up:-0}") Tbilisi; web $pub/$adm, postgres $pg, caddy $caddy; tunnel ports $tunnel/2; health $([ "$hc_exit" = 0 ] && echo ok || echo "exit $hc_exit: $hc_bad"); site $site"
[ -n "$prev_up" ] && [ "$prev_up" != 0 ] && [ "${up:-0}" != "$prev_up" ] && echo "NOTE the host rebooted at $(tbilisi "$up") Tbilisi"
[ -n "$failed_units" ] && flags+=("failed units: $failed_units")
for s in "$pub" "$adm" "$pg" "$caddy"; do [ "$s" = active ] || { flags+=("a service is $s (web/web/postgres/caddy: $pub $adm $pg $caddy)"); break; }; done
[ "${site%% *}" = 200 ] || flags+=("jobster.fun answered ${site%% *}")
[ "$hc_exit" = 0 ] || flags+=("health check exit $hc_exit: $hc_bad")
[ "${tunnel:-0}" -ge 2 ] || [ "${proxy_state:-up}" = down ] || flags+=("laptop tunnel ports: ${tunnel:-0} of 2")

# Pipelines, backup, security updates.
pipes=''
while IFS='|' read -r _ slug result active at; do
  pipes+="$slug $([ "$active" = activating ] && echo running || echo "$result")  "
  [ "$active" != activating ] && [ "$result" != success ] && [ $(( now - at )) -lt 86400 ] && flags+=("pipeline $slug: $result")
done <<<"$(grep '^PIPE|' <<<"$raw")"
IFS='|' read -r b_result b_copied <<<"$(field BACKUP)"
IFS='|' read -r upg reboot <<<"$(field UPGRADE)"
guard=$(field GUARD)
echo "jobs: ${pipes}| backup $b_result, copied off host ${b_copied}x in 36 h | updates: last run $(date -u -d "@$upg" '+%m-%d %H:%M' 2>/dev/null), reboot owed $([ "$reboot" = 0 ] && echo no || echo "since $(tbilisi "$reboot")"); guard: ${guard:-silent in 3 h}"
[ "${b_copied:-0}" -ge 1 ] || flags+=("no off-host backup copy in 36 h")
[ $(( now - upg )) -gt $(( 3 * 86400 )) ] && flags+=("security updates have not run for $(( (now - upg) / 86400 )) days")
[ "$reboot" != 0 ] && [ $(( now - reboot )) -gt 86400 ] && flags+=("a reboot has been owed for over a day")

for f in "${flags[@]}"; do echo "FLAG $f"; done
[ "${#flags[@]}" -eq 0 ] && echo "flags: none"

printf "prev_id='%s'\nprev_req=%s\nprev_failed=%s\nprev_at=%s\nprev_up=%s\n" "$id" "${req:-0}" "${failed:-0}" "$now" "${up:-0}" >"$state"
