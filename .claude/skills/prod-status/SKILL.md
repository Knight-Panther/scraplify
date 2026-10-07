---
name: prod-status
description: Read-only health check of the hosted edition (jobster.fun on the OVH host) — live release, web units, failed units, running jobs and timers, last pipeline and backup results, health-check, last crawl run per source, unlinked listings, open parser incidents, and the visitor-path probe — reported as one verdict table. Changes nothing anywhere. Use when asked whether production is healthy, after a deploy, or before starting one.
---

# Production status

This is the read-only half of RUNBOOK §4 ("Health signals") in one pass. It
replaces the hand-assembled `ssh … systemctl …; psql …` one-liners that kept
being rebuilt per session. It **changes nothing**: no restart, no
`reset-failed`, no timer change, no write. If a check finds something wrong,
it reports it, and the fix is a separate action the owner chooses.

## Connection

The host address and SSH key are deliberately kept out of this public
repository (`docs/RUNBOOK.md` writes `<host>`). Use the ones in this session's
own context, the owner's local notes on hosting, or ask. Never write them into
a committed file. Always pass `-o BatchMode=yes -o ConnectTimeout=15`, so a
missing key fails fast instead of hanging on a prompt.

## Steps

1. **Host checks, one SSH session.** Run this with your connection filled in.
   The database part runs as `scraplify_backup` (RUNBOOK §1: reads everything,
   writes nothing) inside read-only transactions, never as the bare `postgres`
   superuser.

   ```sh
   ssh -o BatchMode=yes -o ConnectTimeout=15 -i <key> <user>@<host> 'bash -s' <<'EOF'
   set -u
   echo "== time";            date -u '+%F %T UTC'
   echo "== release";         readlink /opt/xtelo/current
   echo "== services";        for u in xtelo-web@public xtelo-web@admin caddy postgresql; do printf '%s=%s ' "$u" "$(systemctl is-active "$u")"; done; echo
   echo "== failed units";    systemctl --failed --no-legend --plain | head -20
   echo "== running jobs";    systemctl list-units 'xtelo-pipeline@*' 'xtelo-backup*' --state=active,activating --no-legend --plain
   echo "== timers";          systemctl list-timers 'xtelo-*' --no-legend --plain
   echo "== pipeline results"
   for s in jobs-ge hr-ge etenders-ge; do printf '%s: ' "$s"; systemctl show "xtelo-pipeline@$s" -p Result -p ExecMainStatus -p ExecMainExitTimestamp | paste -sd' '; done
   echo "== backup";          systemctl show xtelo-backup -p Result -p ExecMainStatus -p ExecMainExitTimestamp | paste -sd' '
   printf 'copied off host in last 36h: '; sudo -n journalctl -u xtelo-backup --since -36h --no-pager -o cat | grep -c 'Copied off the host'
   echo "== health-check";    sudo -n /opt/xtelo/current/deploy/with-env.sh worker node dist/cli/health-check.js 2>&1 | tail -15; echo "exit=${PIPESTATUS[0]}"
   echo "== disk/mem";        df -h / | tail -1; free -m | sed -n 2p
   q() { sudo -n -u postgres psql -X -qAt -F ' | ' -d scraplify -v ON_ERROR_STOP=1 -c 'set default_transaction_read_only = on' -c 'set role scraplify_backup' -c "$1"; }
   echo "== last crawl run per source (slug | status | started | finished | full coverage | unreconciled)"
   q "select distinct on (s.slug) s.slug, r.status, r.started_at, r.finished_at, r.full_coverage, r.reconciled_at is null from crawl_runs r join sources s on s.id = r.source_id order by s.slug, r.started_at desc"
   echo "== active / active_unlinked per source"
   q "select s.slug, count(*) filter (where sl.status = 'active'), count(*) filter (where sl.status = 'active' and not exists (select 1 from opportunity_source_memberships m where m.source_listing_id = sl.id and m.superseded_at is null)) from source_listings sl join sources s on s.id = sl.source_id group by s.slug order by s.slug"
   echo "== open parser incidents (slug | kind | severity | count | latest)"
   q "select s.slug, i.kind, i.severity, count(*), max(i.detected_at) from parser_incidents i join sources s on s.id = i.source_id where not i.resolved group by 1, 2, 3 order by 1, 2, 3"
   EOF
   ```

   If a section errors, keep going and report that section as "not checked"
   with the error. One broken check must not hide the others.

2. **Visitor path, from this machine.** `npm run probe -- https://jobster.fun`.
   It must print `probe: ok`. A stale bundle is only a warning (RUNBOOK §4). It
   runs `dist/cli/probe.js`, so if `dist/` is missing, say so and skip it rather
   than building.

3. **Report** as one table, with a ✅ / ⚠️ / ❌ per row and one line of evidence
   each. Rows: release (short sha), services, failed units, running jobs,
   next pipeline run, each source's last pipeline result and last crawl run,
   backup, health-check exit, unlinked listings, open parser incidents, disk
   and memory, probe. Then one verdict line, and a short "needs attention"
   list if anything is ⚠️ or ❌.

   How to read the signals:
   - `active_unlinked` above 0 after a finished pipeline run is the
     2026-09-15 incident signature (`refresh-corpus` skill): ❌, not a footnote.
   - A row with `unreconciled = t` while no `xtelo-pipeline@` unit is running
     is a stuck run: ❌.
   - Open `warning`-severity incidents that already existed are ⚠️. Say
     whether their count grew since the latest run, if the evidence shows it.
   - No "Copied off the host" in the last 36 h means the nightly off-host
     backup did not land: ❌.
   - A pipeline or backup `Result` other than `success` is ❌. If its timestamp
     is older than the latest successful run, it is history, not current state.

## What this skill will not do

- Restart, reset, re-run, or reconfigure anything, even to "just clear" a
  failed unit. It offers the fix and the exact command. Running it is a
  separate, confirmed step.
- Read or print anything under `/etc/xtelo` (secrets).
- Query production as the `postgres` superuser outside the read-only,
  `scraplify_backup`-role block above.
