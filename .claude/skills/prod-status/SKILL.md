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
   for s in jobs-ge hr-ge etenders-ge summerschoolsineurope-eu; do printf '%s: ' "$s"; systemctl show "xtelo-pipeline@$s" -p Result -p ExecMainStatus -p ExecMainExitTimestamp | paste -sd' '; done
   echo "== backup";          systemctl show xtelo-backup -p Result -p ExecMainStatus -p ExecMainExitTimestamp | paste -sd' '
   printf 'copied off host in last 36h: '; sudo -n journalctl -u xtelo-backup --since -36h --no-pager -o cat | grep -c 'Copied off the host'
   echo "== health-check";    sudo -n /opt/xtelo/current/deploy/with-env.sh worker node dist/cli/health-check.js 2>&1 | tail -15; echo "exit=${PIPESTATUS[0]}"
   echo "== disk/mem";        df -h / | tail -1; free -m | sed -n 2p
   echo "== security updates (last completed run | reboot owed since | guard's last word)"
   printf '%s | %s | ' "$(date -u -r /var/lib/apt/periodic/upgrade-stamp '+%F %H:%M' 2>/dev/null || echo never)" "$(date -u -r /var/run/reboot-required '+%F %H:%M' 2>/dev/null || echo no)"
   sudo -n journalctl -u apt-daily-upgrade --since -2d --no-pager -o cat 2>/dev/null | grep 'xtelo-update-guard' | tail -1
   echo "== ss.ge tunnel (listeners held by the laptop)"; ss -ltn | grep -oE '127\.0\.0\.1:(18888|2222) ' | paste -sd' '
   echo "== ss.ge run unit";  systemctl show xtelo-realestate@ss-ge -p ActiveState -p Result -p ExecMainStatus -p ExecMainExitTimestamp | paste -sd' '
   q() { sudo -n -u postgres psql -X -qAt -F ' | ' -d scraplify -v ON_ERROR_STOP=1 -c 'set default_transaction_read_only = on' -c 'set role scraplify_backup' -c "$1"; }
   echo "== last crawl run per source (slug | status | started | finished | full coverage | unreconciled)"
   q "select distinct on (s.slug) s.slug, r.status, r.started_at, r.finished_at, r.full_coverage, r.reconciled_at is null from crawl_runs r join sources s on s.id = r.source_id order by s.slug, r.started_at desc"
   echo "== active / active_unlinked per source"
   q "select s.slug, count(*) filter (where sl.status = 'active'), count(*) filter (where sl.status = 'active' and not exists (select 1 from opportunity_source_memberships m where m.source_listing_id = sl.id and m.superseded_at is null)) from source_listings sl join sources s on s.id = sl.source_id group by s.slug order by s.slug"
   echo "== open parser incidents (slug | kind | severity | count | latest)"
   q "select s.slug, i.kind, i.severity, count(*), max(i.detected_at) from parser_incidents i join sources s on s.id = i.source_id where not i.resolved group by 1, 2, 3 order by 1, 2, 3"
   echo "== last ss.ge runs (started | mode | status | requests | failed | pages | listing pages read | notes)"
   q "select started_at, mode, status, request_count, failed_request_count, page_count, details_count, left(coalesce(notes, ''), 120) from realestate.crawl_runs order by started_at desc limit 3"
   echo "== real-estate archive (archived | newest archived_at | gone, not yet archived | gone over 14 days)"
   q "select (select count(*) from realestate_archive.listings), (select max(archived_at) from realestate_archive.listings), (select count(*) from realestate_archive.recently_gone), (select count(*) from realestate.listings where status = 'gone' and gone_at < now() - interval '15 days')"
   echo "== real-estate daily totals (latest day | cells | listings, every place and kind | taken at)"
   q "select day, count(*), sum(listings) filter (where area_level = 'all' and rooms_band = 'all'), max(taken_at) from realestate_archive.daily_totals group by day order by day desc limit 1"
   echo "== ss.ge place tree (level | places | named by active listings | street points known | none | newest last_seen_at)"
   q "select level, count(*), count(*) filter (where active_listings > 0), count(*) filter (where point_status = 'known'), count(*) filter (where point_status = 'none'), max(last_seen_at) from realestate.places group by level order by level"
   echo "== place catalogue (official districts | stations | streets with an official district | streets with a known point | Tbilisi areas with overlaps | listings located in them)"
   q "select count(*) filter (where level = 'official_district'), count(*) filter (where level = 'metro_station'), count(*) filter (where level = 'street' and official_district_ref is not null), count(*) filter (where level = 'street' and point_status = 'known'), count(*) filter (where official_shares is not null), sum((official_shares->>'located')::int) filter (where level = 'district') || ' of ' || sum((official_shares->>'listings')::int) filter (where level = 'district') from realestate.places"
   echo "== listing locations (Phase 14C: active judged of active | rules | uncertain | Tbilisi official district by pin | street | area | none | streets located by pins | by ss.ge's point)"
   q "select count(*) filter (where location_rules is not null) || ' of ' || count(*), max(location_rules), count(*) filter (where location_uncertain), count(*) filter (where city_ref = 95 and official_district_basis = 'pin'), count(*) filter (where city_ref = 95 and official_district_basis = 'street'), count(*) filter (where city_ref = 95 and official_district_basis = 'area'), count(*) filter (where city_ref = 95 and official_district_basis is null), (select count(*) from realestate.places where level = 'street' and located_basis = 'pins'), (select count(*) from realestate.places where level = 'street' and located_basis = 'ss.ge') from realestate.listings where status = 'active'"
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
   and memory, security updates, ss.ge tunnel and last ss.ge run, real-estate archive, daily totals, place tree, place catalogue, listing locations, probe. Then one verdict line,
   and a short "needs attention" list if anything is ⚠️ or ❌.

   How to read the signals:
   - `active_unlinked` above 0 after a finished pipeline run is the
     2026-09-15 incident signature (`refresh-corpus` skill): ❌, not a footnote.
   - A row with `unreconciled = t` while no `xtelo-pipeline@` unit is running
     is a stuck run: ❌.
   - Open `warning`-severity incidents that already existed are ⚠️. Say
     whether their count grew since the latest run, if the evidence shows it.
   - No "Copied off the host" in the last 36 h means the nightly off-host
     backup did not land: ❌.
   - Security updates (RUNBOOK §2 step 0): a last completed run more than
     three days old, or a reboot owed for more than a day, is ⚠️ with the guard's
     last word as evidence (it names what kept the hour busy).
   - A pipeline or backup `Result` other than `success` is ❌. If its timestamp
     is older than the latest successful run, it is history, not current state.
   - ss.ge leaves through the owner's laptop in Tbilisi (RUNBOOK §3 step 9).
     Both listeners present and `ss.ge proxy: ok` in the health check is ✅.
     A missing listener or `proxy_unreachable` is ⚠️, not ❌: the laptop may
     simply be off, and the nightly run waits up to 10 hours for it. A
     `partial` ss.ge run whose notes say the proxy `stayed unreachable` is ⚠️
     too; the next run carries on from the last completed one.
   - Since Phase 12B a run also reads the own page of each new, changed,
     renewed or reopened listing (RUNBOOK §3 step 8, "Listing details").
     A finished run with `listing pages read` at 0 is ⚠️ when it stored any
     new or changed listings. A run whose notes say `time limit reached` is
     still ✅: the pages left over wait for the next night.
   - The real-estate archive (Phase 13A) gains the listings each completed
     ss.ge run deletes, 14 days after they left. Gone listings older than
     15 days in the live table mean no run has deleted, and so archived,
     for a night or more: ⚠️ after one night, ❌ after two. Nothing is lost
     meanwhile; the copy happens whenever the delete next runs. An error that `realestate_archive` does not exist means the
     release before Phase 13A: say so, it is not a fault.
   - The daily totals (Phase 13D) are taken at the end of every ss.ge run
     that got as far as a crawl row. A latest day older than the last
     finished ss.ge run is ⚠️: its journal says `ss.ge daily totals
     failed`. About 4,000 cells a day is normal. An error that
     `daily_totals` does not exist means the release before Phase 13D.
   - The place tree (Phase 14A) is updated at the end of every ss.ge run
     that got as far as its grouping. A newest `last_seen_at` older than the
     last finished ss.ge run is ⚠️: its journal says `ss.ge place tree update
     failed`. Tbilisi alone has about 1,800 streets and 51 sub-districts.
     Known street points should rise night by night until the busy streets
     are placed; a level whose count jumps from one night to the next means
     ss.ge renumbered its places: ⚠️. An error that `places` does not exist
     means the release before Phase 14A.
   - The place catalogue (Phase 14B, contract C6) is refreshed as the last
     step of every ss.ge run. 10 official districts and 22 stations is ✅;
     fewer means it has not been refreshed since the deploy (journal:
     `ss.ge place catalogue refresh failed`, or the by-hand step was
     skipped): ⚠️. Streets with an official district follow the known
     street points inside Tbilisi (Batumi's and other cities' points have
     none), and the located listings grow with them. An error that column
     `origin` does not exist means the release before Phase 14B.
   - Listing locations (Phase 14C, contract C5) are judged right after the
     catalogue in every ss.ge run (`ss.ge listing locations judged`). Every
     active listing judged under the current `LOCATION_RULES_VERSION` is ✅.
     While a run is going, the listings it has added wait for its last step,
     so a few thousand unjudged then is normal; after a finished run, any
     unjudged listing is ⚠️ (journal: `ss.ge listing locations failed`;
     they keep the night before's judgement). Uncertain listings were 235 of
     303,134 on the trial copy (2026-11-08): many times that is ⚠️, a sign a
     rule or the street locations went wrong. The official district grows
     from street and area as pins and street points arrive. An error that
     column `location_rules` does not exist means the release before
     Phase 14C.

## What this skill will not do

- Restart, reset, re-run, or reconfigure anything, even to "just clear" a
  failed unit. It offers the fix and the exact command. Running it is a
  separate, confirmed step.
- Read or print anything under `/etc/xtelo` (secrets).
- Query production as the `postgres` superuser outside the read-only,
  `scraplify_backup`-role block above.
