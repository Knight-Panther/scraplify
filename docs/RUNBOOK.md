# Xtelo production runbook

How to deploy, check, roll back and recover the hosted edition (Phase 8E; change.md §10, §15). It assumes a Linux host with systemd, Caddy and Node, which is what `deploy/` targets. The hosting provider is not chosen yet: where a step depends on it, it says so.

## 1. Shape

| Piece | Runs as | Listens on | Database role | Config |
| --- | --- | --- | --- | --- |
| Public site | `xtelo-web@public` | `127.0.0.1:3000` | `scraplify_public` (read-only views) | `/etc/xtelo/public.env` |
| Admin site | `xtelo-web@admin` | `127.0.0.1:3001` | `scraplify_admin` | `/etc/xtelo/admin.env` |
| Crawl pipeline | `xtelo-pipeline@jobs-ge`, `@hr-ge` (daily timers) | — | `scraplify_worker` | `/etc/xtelo/worker.env` |
| Backup | `xtelo-backup` (nightly timer) | — | owner or backup role | `/etc/xtelo/backup.env` |
| TLS and routing | Caddy | `:443` (`PUBLIC_HOST`, `ADMIN_HOST`) | — | `deploy/Caddyfile` |

Directories:
- `/opt/xtelo/releases/<git-sha>/` holds one build per release, and `/opt/xtelo/current` is a symlink to the live one.
- `/var/lib/xtelo/bundles` is written by the pipeline and read by the public site.
- `/var/backups/xtelo` holds the backups.

The templates in `deploy/env/` list every variable. They hold placeholders only, and real values never go in the repository.

Each process refuses to start when misconfigured:
- `public` refuses without its bundle directory, with any admin credential present, or on a database role that can write.
- `admin` refuses without all four auth values, with a short secret, or with a non-numeric admin id.
- Any process refuses a mistyped `XTELO_SURFACE` or `XTELO_CV_RANKED`.

A refused process answers every request with a 500 and logs the reason to its journal: `journalctl -u xtelo-web@public`.

## 2. First deployment

This follows change.md §15's release order.

1. **Database.** Postgres 17 with pgvector (the `pgvector/pgvector:pg17` image locally). Create the database, then the roles, running `scripts/sql/phase-8b-public-role.sql` and `scripts/sql/phase-8b-worker-admin-migration-roles.sql` with real passwords in place of their placeholders. Verify privileges as those scripts describe.
2. **Code.** Put the release at `/opt/xtelo/releases/<sha>` as the `xtelo` user, then run `npm ci`, `npm run build` and `npm run build:web`. Point `/opt/xtelo/current` at it.
3. **Schema.** `DATABASE_URL=<migration role> npm run db:migrate`. Migrations are additive (change.md §15).
4. **Config.** Copy each `deploy/env/*.template` to `/etc/xtelo/<name>.env`, fill it in, `chown root:xtelo` and `chmod 0640`, or `0600` for `backup.env`.
   - The admin OAuth app is a **production GitHub OAuth app** whose callback is `https://<ADMIN_HOST>/api/auth/callback/github`.
   - `ADMIN_GITHUB_IDS` holds numeric ids.
5. **Units.** Copy `deploy/systemd/*` to `/etc/systemd/system/` and run `systemctl daemon-reload`.
6. **Data.** Start one pipeline run per source (`systemctl start xtelo-pipeline@jobs-ge`, then `@hr-ge`) and wait for both. The last step builds the first matching bundle; check `journalctl -u xtelo-pipeline@hr-ge` for `matching bundle exit code 0`.
7. **Admin first**, then public: `systemctl enable --now xtelo-web@admin`, then `xtelo-web@public`.
8. **TLS.** Install `deploy/Caddyfile` with `PUBLIC_HOST`, `ADMIN_HOST` and `ACME_EMAIL` set in Caddy's environment, then reload Caddy. Certificates are automatic.
9. **Check.** `npm run probe -- https://<PUBLIC_HOST>` must print `probe: ok` (see §4). Sign in on the admin host once.
10. **Schedules.** `systemctl enable --now xtelo-pipeline@jobs-ge.timer xtelo-pipeline@hr-ge.timer xtelo-backup.timer`.
11. **Observe** the probe and `npm run health:check` for a few days before announcing anything (change.md §15 step 7). Public launch is also gated on `docs/RIGHTS.md`.

## 3. Deploying a new version

1. Build the new release in `/opt/xtelo/releases/<new-sha>` (step 2 above). Nothing live changes yet.
2. If it has migrations: take a backup (`systemctl start xtelo-backup`), then run `db:migrate` as the migration role. Migrations are additive, so the old release keeps working against the new schema.
3. Repoint `/opt/xtelo/current` to the new release and run `systemctl restart xtelo-web@admin xtelo-web@public`.
4. Run `npm run probe -- https://<PUBLIC_HOST>`. If it does not print `probe: ok`, roll back (§5, "Web").

## 4. Health signals

| Check | What it means | Where |
| --- | --- | --- |
| `GET /api/healthz` → 200 | The process is up. It touches no database, so a restart policy acting on it never restarts a healthy process over a database blip. | Every surface |
| `GET /api/readyz` → 200 or 503 | 503 means the process cannot reach its database. The body also reports `matching` (`ok`, `stale`, `unavailable` or `not_served`). A stale bundle is reported but never fails readiness, because Browse keeps working. | Every surface |
| `npm run probe -- <origin>` | A visitor's path: readiness, landing (with nonce CSP), Browse, a detail page, the manifest, and the bundle download with checksum check. It exits 1 on any failure; a stale bundle is only a warning. | Run from anywhere; schedule it on an uptime service once one is chosen |
| `npm run health:check` | Crawl freshness per source and matching-bundle age. It exits 1 on anything critical. | On the host, with the worker env |

**Alerting** is not wired yet: change.md §10 asks for one operator-chosen push channel once these signals have been stable. Until then, the probe and `health:check` exit codes are the alert.

## 5. Rollback

In change.md §15's order. Each step is independent; stop at the first one that fixes it.

1. **CV Ranked misbehaves.** Set `XTELO_CV_RANKED=off` in `/etc/xtelo/public.env` and `systemctl restart xtelo-web@public`. The nav link and landing chooser disappear and `/cv-ranked` says CV Ranked is paused; Browse and Listings are untouched. Turn it back on by removing the line and restarting.
2. **The matching bundle is wrong.** `npm run matching:rollback` with the worker env. It repoints to the previous verified build and re-checks that build's files first; it refuses, and changes nothing, if they no longer match.
3. **Web.** Repoint `/opt/xtelo/current` to the previous release and restart both web units. Leave the additive schema in place; a migration down is its own reviewed change.
4. A crawler, builder or admin outage never needs the public site taken down: it keeps serving the last good catalogue and bundle.

## 6. Backup and restore

- The nightly `xtelo-backup` writes `/var/backups/xtelo/xtelo-<utc>.dump` (`pg_dump -Fc`). It checks each archive with `pg_restore --list` and keeps 14. Copy them off the host: the destination depends on the provider (**owner decision**).
- **Restore:**
  1. Stop the web units and timers.
  2. `createdb` a fresh database.
  3. Run `pg_restore --no-owner --dbname=<fresh> <dump>`.
  4. Re-apply role grants with the `scripts/sql/phase-8b-*.sql` files.
  5. Point the env files at it and start everything again in the §2 order.
- **Drill:** `scripts/restore-db-drill.ps1` (on the operator machine) restores the newest backup into a throwaway database and compares every table's row count with the source. Last run: 2026-09-26, on a fresh 11.1 MB backup of the real corpus. It passed: every table's count matched, and the throwaway database was dropped. A hosted drill is still owed once the host exists.

## 7. Incidents

| Symptom | Likely cause | Action |
| --- | --- | --- |
| A crawl logs "settled runs left unsettled by a crawl process that died" | A previous crawl process was killed or the host went down mid-run. The new process holds that source's advisory lock, so no live process owned the run, and it was settled as `failed` automatically (`src/db/crawl-process-lock.ts`). | Nothing. The crawl continues normally. Frequent occurrences mean crawls are being killed; check the timer's timeout and the host. |
| A crawl exits at once with "another crawl process for this source is running" | A crawl for that source is genuinely still in flight, holding its lock. | Nothing, unless it keeps happening: then a crawl is hanging. Find and stop that process; the next run settles its row. |
| After a parser change, fields look stale on old listings | Scheduled crawls fetch a detail page only when its list-page row changed (Phase 7C), so an improved parser reaches old listings only when they change. | Run each crawl once with `--refetch=all` (e.g. `node dist/cli/run-jobs-ge-crawl.js --refetch=all`). That is a multi-hour run at the sources' crawl delays. |
| A crawl's log shows a high `refetch.canaryChanged` over several runs | The 20 random canaries re-fetched each run found content changes the list-page fingerprint did not reveal. | Widen the fingerprint fields in that adapter's discovery parser (`docs/PHASE_7C_PLAN.md` §1), not a periodic full re-scrape. |
| `readyz` → 503 | The database is unreachable or refusing the role. | Check Postgres and the env file's `DATABASE_URL`. The web process needs no restart once the database is back. |
| Probe `manifest` warns `stale` | No bundle published for 72 h, usually because crawls stopped and the builder's health gate refused. | Fix the crawls. `matching:build --override-health-gate` exists but is recorded on the build and shown on `/admin/matching`; use it knowingly. |
| Visitors get 429 | One address exceeded a limit (`web/lib/rate-limit.ts`). Several people behind one NAT share an address. | If it is real traffic, raise that class's numbers in code and deploy. Probes are never limited. |
| `public` will not start: "can change N relation(s)" | Its `DATABASE_URL` is not `scraplify_public`. | Fix the env file. Never set `XTELO_E2E_ALLOW_WRITABLE_PUBLIC_ROLE` on a host. |
| Admin sign-in loops or 404s | The GitHub account is not in `ADMIN_GITHUB_IDS`, or the OAuth app callback URL is wrong. | Check the numeric id and the app's callback. |

## 8. Secrets

- Each process reads only its own env file, so rotating one affects one process.
- **Role password:** `ALTER ROLE … PASSWORD …`, update that env file, then restart that unit.
- **`AUTH_SECRET`:** regenerate it with `openssl rand -base64 32` and restart admin. Every admin session ends, which is the point.
- **GitHub OAuth secret:** rotate it in the GitHub app settings, update `admin.env`, then restart admin.
