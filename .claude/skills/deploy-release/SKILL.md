---
name: deploy-release
description: Deploy one merged commit to the hosted edition (jobster.fun) in RUNBOOK §3's order — preflight, build the release beside the live one, back up and migrate and re-grant only when the range needs it, repoint and restart, probe, and roll the web back if the probe fails — pausing for confirmation before every step that changes what is live or touches the database.
disable-model-invocation: true
---

# Deploy a release

Usage: `/deploy-release <sha>` (a commit already on `main`).

This runs `docs/RUNBOOK.md` §3 ("Deploying a new version"), with §5's web
rollback ready. **The runbook is the source of truth.** Read §3 and §5 at the
start of every run: if they disagree with this file, follow the runbook and
say so. This skill exists because the sequence kept being rebuilt by hand per
release, as long SSH one-liners with the SHA pasted in, and because two of its
rules are easy to drop:
- always re-apply grants after a migration
- finish, probe included, before the 16:10 UTC pipeline

Every step that changes what is live, or touches the production database,
**stops for explicit confirmation first**. Approval for one step, or for the
last release, does not carry over.

## Connection

The host address and SSH key are deliberately kept out of this public
repository (`docs/RUNBOOK.md` writes `<host>`). Use the ones in this session's
own context, the owner's local notes on hosting, or ask. Never write them into
a committed file. Pass `-o BatchMode=yes -o ConnectTimeout=15` on every call,
and add `-o ServerAliveInterval=30` for the build, which runs for minutes.

## Steps

1. **Resolve and vet the commit (local, read-only).**
   - `git fetch origin`, then `SHA=$(git rev-parse --verify <sha>^{commit})` to
     get the full 40-character SHA. The release directory is named by it.
   - `git merge-base --is-ancestor $SHA origin/main` must succeed. Never deploy
     a commit that isn't on `main`.
   - CI must be green on it: `gh run list --commit $SHA --json workflowName,status,conclusion`.
     If CI is still running, wait. If it failed or there is no run, stop.

2. **Preflight on the host (read-only, one SSH session).**
   ```sh
   date -u '+%F %T UTC'; readlink /opt/xtelo/current
   systemctl list-units 'xtelo-pipeline@*' 'xtelo-backup*' --state=active,activating --no-legend --plain
   systemctl list-timers 'xtelo-*' --no-legend --plain
   test -e /opt/xtelo/releases/$SHA && echo "release dir exists" || echo "release dir new"
   df -h / | tail -1; free -m | sed -n 2p
   ```
   - The current target is `PREV`, the rollback target. Write it down now.
   - **Stop** if any pipeline or backup is running: a repoint during a run puts
     it on a different release's files (RUNBOOK §3).
   - **Stop** if the next `xtelo-pipeline@` timer is under about 45 minutes away.
     The build alone takes minutes, and the whole deploy must finish before
     it. Report when the window reopens.
   - If `PREV` already ends in `$SHA`, there is nothing to deploy. Say so and stop.

3. **Classify the range (local, read-only).** `PREV_SHA` is the last path
   component of `PREV`. Run `git diff --stat $PREV_SHA $SHA` over these paths:
   - `drizzle/migrations/` → **migrations**: step 5 applies.
   - `scripts/sql/`, `deploy/apply-db-roles.sh` → **grants**: step 5's grants
     part applies, even without a migration.
   - `deploy/systemd/`, `deploy/Caddyfile`, `deploy/journald/`, `deploy/env/` →
     **host config**. This skill never copies these. List them and ask the
     owner how to apply each one (RUNBOOK §2 steps 6 and 9 say how).
   - Anything in RUNBOOK §3 marked "first deploy after merge only" whose
     feature lands in this range (for example retention's dry run, or the
     title-vector model) → list it and ask before doing it.

   Show the owner the plan: `PREV_SHA → SHA`, the commit count, migrations
   yes/no, grants yes/no, host-config items, and first-deploy items. This is
   the first confirmation point.

4. **Build beside the live release.** Nothing live changes here. This is
   RUNBOOK §2 step 2 without the `ln`:
   ```sh
   R=/opt/xtelo/releases/$SHA
   test ! -e $R || { echo "exists: verify, do not re-clone"; exit 3; }
   sudo -u xtelo -H git clone -q https://github.com/Knight-Panther/scraplify.git $R
   sudo -u xtelo -H git -C $R checkout -q --detach $SHA
   sudo -u xtelo -H bash -c "cd $R && npm ci --no-audit --no-fund 2>&1 | tail -3 && npm run build 2>&1 | tail -3 && NEXT_TELEMETRY_DISABLED=1 npm run build:web 2>&1 | tail -15"
   ```
   If the directory already exists (an earlier attempt), don't delete it.
   Check that `git -C $R rev-parse HEAD` equals `$SHA`, then that `$R/web/.next/BUILD_ID`
   and `$R/dist/cli/probe.js` both exist, and only then reuse it. Any build
   failure stops here, and the live site is untouched.

5. **Database, only if step 3 said so. Confirm first.**
   - Backup first: `sudo systemctl start xtelo-backup`. It waits for the
     oneshot to finish. Then check that `systemctl show xtelo-backup -p Result`
     is `success` and that the journal says `Copied off the host`. No verified
     backup means no migration.
   - Migrate from the **new** release:
     `sudo $R/deploy/with-env.sh migration npm run db:migrate`. The
     `db-write-guard` hook will ask here, which is expected.
   - **Always then** `sudo $R/deploy/apply-db-roles.sh grants`: a migration that
     recreates a view drops its grants, and a new table has none. It fails by
     itself if `scraplify_public` could write.

   Migrations are additive, so the still-live old release keeps working
   against the new schema (RUNBOOK §3).

6. **Repoint and restart. Confirm first.** This is the moment the site changes.
   ```sh
   sudo ln -sfn /opt/xtelo/releases/$SHA /opt/xtelo/current && sudo systemctl restart xtelo-web@admin xtelo-web@public
   sleep 8; readlink /opt/xtelo/current; systemctl is-active xtelo-web@admin xtelo-web@public
   sudo journalctl -u xtelo-web@public -u xtelo-web@admin --since -1min --no-pager -o cat | grep -iE 'error|refus|Ready' | head -10
   ```
   A process that refuses to start logs why and answers every request with a
   500 (RUNBOOK §1).

7. **Probe from this machine.** `npm run probe -- https://jobster.fun` must
   print `probe: ok`. A stale bundle is only a warning. If local `dist/` is
   missing, run `npm run build` first. That only touches the local `dist/`, but
   say so before running it.

8. **If the probe fails or a unit is not active: offer the rollback, and
   confirm first.** RUNBOOK §5 "Web":
   `sudo ln -sfn $PREV /opt/xtelo/current && sudo systemctl restart xtelo-web@admin xtelo-web@public`,
   then probe again. Leave the additive schema in place: a migration down is
   its own reviewed change. Leave the failed release directory in place for
   diagnosis. If the problem is the matching bundle rather than the web, the
   rollback is §5's `matching:rollback` instead. Ask before running it.

9. **Report.** `PREV_SHA → SHA` (or the rollback), migrations and grants run
   or not, probe output, host-config and first-deploy items still open, and
   when the next pipeline run is due. Releases are recorded in
   `docs/STATUS.md`, so offer the line, but write and commit it only if the
   owner wants it now.

## What this skill will not do

- Deploy a commit that isn't on `main` with green CI, or start inside the
  pipeline window.
- Run a migration without a verified fresh backup, or skip `grants` after one.
- Copy units, the Caddyfile or env files, or edit anything under `/etc/xtelo`.
  Those are listed and handed to the owner.
- Delete any release directory, old or failed. They are the rollback targets.
- Push, merge, or change `main`. Shipping a branch is `/ship-phase`. This skill
  starts after that.
