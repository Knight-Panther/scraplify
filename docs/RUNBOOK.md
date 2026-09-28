# Xtelo production runbook

How to deploy, check, roll back and recover the hosted edition (Phase 8E; change.md §10, §15). It assumes a Linux host with systemd, Caddy and Node, which is what `deploy/` targets. The host is an OVHcloud VPS-1 (2 vCore, 4 GB RAM, 40 GB NVMe) in Gravelines, France, running Ubuntu 24.04, with no commitment (ordered 2026-09-28; Hetzner's CX23 was sold out). The domain is `jobster.fun`, registered at Cloudflare on 2026-09-28: the public site is `jobster.fun` and the admin site is `admin.jobster.fun`.

## 1. Shape

| Piece | Unit | OS user | Listens on | Database role | Config |
| --- | --- | --- | --- | --- | --- |
| Public site | `xtelo-web@public` | `xtelo-public` | `127.0.0.1:3000` | `scraplify_public` (read-only views) | `/etc/xtelo/public.env` |
| Admin site | `xtelo-web@admin` | `xtelo-admin` | `127.0.0.1:3001` | `scraplify_admin` | `/etc/xtelo/admin.env` |
| Crawl pipeline | `xtelo-pipeline@jobs-ge`, `@hr-ge` (daily timers) | `xtelo` | — | `scraplify_worker` | `/etc/xtelo/worker.env` |
| Backup | `xtelo-backup` (nightly timer) | `xtelo` | — | `scraplify_backup` (reads all, writes nothing) | `/etc/xtelo/backup.env` |
| Migrations | none (by hand, per release) | `xtelo` | — | `scraplify_migration` | `/etc/xtelo/migration.env` |
| TLS and routing | Caddy | `caddy` | `:443` (`PUBLIC_HOST`, `ADMIN_HOST`) | — | `deploy/Caddyfile` |

Each web surface has its own OS user, and every env file is `0600 root`: systemd reads it before dropping privileges, and the units make `/etc/xtelo` and the backups inaccessible and other users' processes invisible. So a compromised public process cannot read the admin secrets, the worker's password or a dump.

Directories:
- `/opt/xtelo/releases/<git-sha>/` holds one build per release (owned by `xtelo`, world-readable: code only, no secrets), and `/opt/xtelo/current` is a symlink to the live one.
- `/var/lib/xtelo/bundles` is written by the pipeline and read by the public site.
- `/var/backups/xtelo` (`0700 xtelo`) holds the local backups; each is also copied off the host.

The templates in `deploy/env/` list every variable. They hold placeholders only, and real values never go in the repository.

To run any command as a process would (health check, rollback, migrations), use `deploy/with-env.sh`: `sudo /opt/xtelo/current/deploy/with-env.sh worker node dist/cli/health-check.js`. It runs as that process's user with its env file, in the live release, and returns the command's exit code.

Each process refuses to start when misconfigured:
- `public` refuses without its bundle directory, with any admin credential present, or on a database role that can write.
- `admin` refuses without all four auth values, with a short secret, or with a non-numeric admin id.
- Any process refuses a mistyped `XTELO_SURFACE` or `XTELO_CV_RANKED`.

A refused process answers every request with a 500 and logs the reason to its journal: `journalctl -u xtelo-web@public`.

## 2. First deployment

This follows change.md §15's release order. Commands run as root (`sudo -i`) unless a step says otherwise. Tested pieces: the database order in steps 2, 5 and 6 was drilled on a fresh Postgres 17 (2026-09-27: 37 migrations, every object owned by `scraplify_migration`, public read-only, both helper scripts idempotent), and the units pass `systemd-analyze verify` on Ubuntu 24.04 (systemd 255).

0. **Host.** Ubuntu 24.04. `sudo bash deploy/host-setup.sh` does everything in this step and is idempotent. Copy it to the host before step 2's checkout exists. It also turns SSH password logins and root logins off, and refuses to do that unless some user has an `authorized_keys`. The bullets below say what it does.
   - On OVH: reinstall the ordered VPS with an SSH key: `ovhcloud vps reinstall <vps> --image-id <Ubuntu 24.04 id from ovhcloud vps image list> --public-ssh-key "<key.pub>" --wait`. This only works once OVH's own `deliverVm` task has finished (`ovhcloud vps list-tasks <vps>`). The `ubuntu` user's password arrives expired, and every login, even with a key, is refused until it is changed. The first login therefore has to be interactive: the current password comes from the one-time link in OVH's email sent after the reinstall, not the first email. Afterwards, `sudo` needs no password.
   - Swap, because a 4 GB host builds Next beside Postgres and two web processes: `fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab`.
   - Firewall: `ufw allow OpenSSH && ufw allow 80,443/tcp && ufw enable`. Postgres listens on localhost only (its default).
   - Node 24 at `/usr/bin/node`, which the units call: the NodeSource `nodesource_setup.sh` for 24.x, then `apt install nodejs`. Not fnm or nvm: those install under a home directory, which the units cannot see.
   - Postgres 17 from the PGDG apt repository (Ubuntu 24.04 ships 16): `apt install postgresql-17`. No extension is needed.
   - Caddy (its official apt repository), `rclone` and `git` from apt.
   - Log retention, 60 days like everything operational: `install -D -m 0644 deploy/journald/xtelo-retention.conf /etc/systemd/journald.conf.d/xtelo-retention.conf && systemctl restart systemd-journald` (from the release checkout, after step 2). Caddy's own access logs expire after 60 days by `deploy/Caddyfile`.
   - Users and directories:
     ```sh
     useradd --system --create-home --home-dir /var/lib/xtelo --shell /usr/sbin/nologin xtelo
     useradd --system --no-create-home --shell /usr/sbin/nologin xtelo-public
     useradd --system --no-create-home --shell /usr/sbin/nologin xtelo-admin
     # 0755, not useradd's 0750: the public site reads the bundles below it.
     install -d -o xtelo -g xtelo -m 0755 /var/lib/xtelo /opt/xtelo /opt/xtelo/releases /var/lib/xtelo/bundles
     install -d -o xtelo -g xtelo -m 0700 /var/backups/xtelo
     install -d -o root -g root -m 0700 /etc/xtelo
     ```
     systemd refuses to start a unit whose `ReadWritePaths` directory is missing, so these must exist before step 7.
1. **Config.** Copy each `deploy/env/*.template` (`public`, `admin`, `worker`, `backup`, `migration`) to `/etc/xtelo/<name>.env`, fill it in, then `chmod 0600 /etc/xtelo/*.env` (owner root). `deploy/make-env.sh` does this and generates every password and `AUTH_SECRET` on the host without printing them: `sudo PUBLIC_HOST=jobster.fun ADMIN_HOST=admin.jobster.fun AUTH_GITHUB_ID=<client id> ADMIN_GITHUB_IDS=<ids> CRAWLER_CONTACT_URL=https://jobster.fun deploy/make-env.sh`. It never overwrites an existing file. The owner then sets the two remaining secrets from hidden input, so they never pass through a chat or a command line:
   - `ssh -t <host> sudo /opt/xtelo/current/deploy/set-github-secret.sh`
   - `ssh -t <host> sudo /opt/xtelo/current/deploy/set-r2-credentials.sh <account id> <bucket> <host IPv4>`. It also runs one backup to prove the upload.

   Give the R2 token Object Read & Write on that one bucket only, filtered to the host's IPv4. That filter refuses IPv6, and a dual-stack host reaches R2 over IPv6. So the script pins rclone with `RCLONE_BIND=<host IPv4>`: binding to `0.0.0.0` was not enough, and rclone still used IPv6 and got 403s.
   - Every role password: `openssl rand -hex 32`. `apply-db-roles.sh` accepts letters and digits only, so nothing needs escaping.
   - The admin OAuth app is a **production GitHub OAuth app** ("Xtelo Admin", registered 2026-09-27): homepage `https://admin.jobster.fun`, callback `https://admin.jobster.fun/api/auth/callback/github`, and `AUTH_URL=https://admin.jobster.fun`. Generate its client secret on deploy day, straight into `admin.env`. `ADMIN_GITHUB_IDS` holds numeric ids.
   - `backup.env`: the off-host remote (R2 example in the template). `BACKUP_REMOTE=none` only until that storage exists; each run then warns.
2. **Code.** As `xtelo`, clone the release into `/opt/xtelo/releases/<sha>` and build it:
   ```sh
   sudo -u xtelo -H bash -c 'cd /opt/xtelo/releases/<sha> && npm ci && npm run build && NEXT_TELEMETRY_DISABLED=1 npm run build:web'
   ln -sfn /opt/xtelo/releases/<sha> /opt/xtelo/current
   ```
3. **Database and migration role.** `/opt/xtelo/current/deploy/apply-db-roles.sh bootstrap` creates the database if missing and the migration role, with its password from `migration.env`.
4. **Schema.** `/opt/xtelo/current/deploy/with-env.sh migration npm run db:migrate`. Every table and view is created, and owned, by `scraplify_migration`. Migrations are additive (change.md §15).
5. **Roles and grants.** `/opt/xtelo/current/deploy/apply-db-roles.sh grants` runs both `scripts/sql/phase-8b-*.sql` files with the passwords from the env files, creates `scraplify_backup`, and fails if `scraplify_public` can write anything. It has to run after step 4: the grants name tables that only exist once migrated.
6. **Units.** `cp /opt/xtelo/current/deploy/systemd/* /etc/systemd/system/ && systemctl daemon-reload`.
7. **Data.** Start one pipeline run per source without waiting on it, then follow it: `systemctl start --no-block xtelo-pipeline@jobs-ge`, `journalctl -fu xtelo-pipeline@jobs-ge`, and the same for `@hr-ge` once jobs.ge is done. The last step builds the first matching bundle: look for `matching bundle exit code 0`. The first jobs.ge run fetches every listing at 2 s apart, so it takes hours.
8. **Admin first**, then public: `systemctl enable --now xtelo-web@admin`, then `xtelo-web@public`.
9. **DNS and TLS.**
   - In Cloudflare, DNS for `jobster.fun`: add `A jobster.fun <host IPv4>` and `A admin <host IPv4>` (plus `AAAA` for the host's IPv6), both **DNS only (grey cloud), never proxied**. The rate limiter keys on the client address Caddy sees (`web/lib/rate-limit.ts`), and proxied traffic would put every visitor behind a handful of Cloudflare addresses. Caddy also gets its own certificates. Check with `dig +short jobster.fun admin.jobster.fun`.
   - The zone is already set (2026-09-28): DNSSEC on; CAA allows only `letsencrypt.org` and `sectigo.com` (ZeroSSL, Caddy's fallback), no wildcards; mail lockdown (null MX, `v=spf1 -all`, DMARC `p=reject`), since the domain sends no mail. Its proxy-only settings (Full (strict), TLS 1.2 minimum, Always Use HTTPS) only matter if a record is ever proxied.
   - `cp /opt/xtelo/current/deploy/Caddyfile /etc/caddy/Caddyfile`, then `systemctl edit caddy` and add:
     ```ini
     [Service]
     Environment=PUBLIC_HOST=jobster.fun ADMIN_HOST=admin.jobster.fun ACME_EMAIL=<email>
     ```
   - `systemctl restart caddy`. Certificates are automatic once DNS points at the host. On 2026-09-28 both certificates were issued within seconds.
   - Never run `caddy validate` or `caddy run` as root against this Caddyfile. Root creates `/var/log/caddy/xtelo-*.log` owned by root, and the `caddy` service user then fails to start with `permission denied`. If it happened, `chown caddy:caddy /var/log/caddy/xtelo-*.log`.
   - Scanners find a new hostname within seconds of its certificate appearing in the public certificate logs, so start `admin` before or together with Caddy. The admin surface serves only `/admin*`, auth and health: `https://admin.jobster.fun/` is a 404 by design, and `/admin` redirects to GitHub sign-in.
10. **Check.** `npm run probe -- https://jobster.fun` (from the release directory, or anywhere with the repo) must print `probe: ok` (see §4). Sign in on `https://admin.jobster.fun` once.
11. **Backup.** `systemctl start xtelo-backup && journalctl -u xtelo-backup -n 20`: it must say `Copied off the host`.
12. **Schedules.** `systemctl enable --now xtelo-pipeline@jobs-ge.timer xtelo-pipeline@hr-ge.timer xtelo-backup.timer`.
13. **Observe** the probe and `deploy/with-env.sh worker node dist/cli/health-check.js` for a few days before announcing anything (change.md §15 step 7). Public launch is also gated on `docs/RIGHTS.md`.

## 3. Deploying a new version

1. Build the new release in `/opt/xtelo/releases/<new-sha>` (step 2 above). Nothing live changes yet.
2. If it has migrations: take a backup (`systemctl start xtelo-backup`), then run them from the new release: `/opt/xtelo/releases/<new-sha>/deploy/with-env.sh migration npm run db:migrate`. **Then always `/opt/xtelo/releases/<new-sha>/deploy/apply-db-roles.sh grants`**: a migration that recreates a view drops its grants, and a new table has none. Migrations are additive, so the old release keeps working against the new schema.
3. Repoint `/opt/xtelo/current` to the new release and run `systemctl restart xtelo-web@admin xtelo-web@public`.
4. Run `npm run probe -- https://jobster.fun`. If it does not print `probe: ok`, roll back (§5, "Web").
5. **Retention (Phase 7C, first deploy after merge only).** Migration 0037 (`source_listing_revisions.trimmed_at`) and its worker grants land the same way as any other migration — step 2 above already covers `db:migrate` then `apply-db-roles.sh grants`, in that order, since the grants name a column that only exists once migrated. Before letting it run for real, do one dry run: `deploy/with-env.sh worker npm run retention` (no `--apply`) and read its logged tier counts. `deploy/run-pipeline.sh`/`scripts/run-crawl.ps1` then run it with `--apply` automatically after every crawl and dedupe that both exit 0 — no separate schedule to enable.

## 4. Health signals

| Check | What it means | Where |
| --- | --- | --- |
| `GET /api/healthz` → 200 | The process is up. It touches no database, so a restart policy acting on it never restarts a healthy process over a database blip. | Every surface |
| `GET /api/readyz` → 200 or 503 | 503 means the process cannot reach its database. The body also reports `matching` (`ok`, `stale`, `unavailable` or `not_served`). A stale bundle is reported but never fails readiness, because Browse keeps working. | Every surface |
| `npm run probe -- <origin>` | A visitor's path: readiness, landing (with nonce CSP), Browse, a detail page, the manifest, and the bundle download with checksum check. It exits 1 on any failure; a stale bundle is only a warning. | Run from anywhere; schedule it on an uptime service once one is chosen |
| `npm run health:check` | Crawl freshness per source and matching-bundle age. It exits 1 on anything critical. | On the host: `sudo /opt/xtelo/current/deploy/with-env.sh worker node dist/cli/health-check.js` |

**No alerting** (owner decision, 2026-09-27; concept §30.6): nothing pushes a notification. Check the signals above yourself: the probe, `health:check`, `/admin` and the board update line on `/`, which shows a late or failed run.

## 5. Rollback

In change.md §15's order. Each step is independent; stop at the first one that fixes it.

1. **CV Ranked misbehaves.** Set `XTELO_CV_RANKED=off` in `/etc/xtelo/public.env` and `systemctl restart xtelo-web@public`. The nav link and landing chooser disappear and `/cv-ranked` says CV Ranked is paused; Browse and Listings are untouched. Turn it back on by removing the line and restarting.
2. **The matching bundle is wrong.** `sudo /opt/xtelo/current/deploy/with-env.sh worker npm run matching:rollback`. It repoints to the previous verified build and re-checks that build's files first; it refuses, and changes nothing, if they no longer match.
3. **Web.** Repoint `/opt/xtelo/current` to the previous release and restart both web units. Leave the additive schema in place; a migration down is its own reviewed change.
4. A crawler, builder or admin outage never needs the public site taken down: it keeps serving the last good catalogue and bundle.

## 6. Backup and restore

- The nightly `xtelo-backup` writes `/var/backups/xtelo/xtelo-<utc>.dump` (`pg_dump -Fc`, as `scraplify_backup`). It checks each archive with `pg_restore --list`, copies it off the host with rclone (`BACKUP_REMOTE`; a failed upload fails the run), and keeps 14 locally. Old off-host copies expire by the bucket's lifecycle rule: in the Cloudflare dashboard, R2 → the bucket → Settings → Object lifecycle rules → delete objects 60 days after upload (owner decision, 2026-09-27). A restore can therefore reach back 60 days at most. Which storage is an **owner decision**; the template shows Cloudflare R2.
- **Restore:**
  1. Stop the web units and timers.
  2. If the dump is off-host only: `rclone copyto <remote>/<file> /var/backups/xtelo/<file>` with the backup env's variables.
  3. `sudo -u postgres createdb <fresh>`, then `sudo -u postgres pg_restore --no-owner --dbname=<fresh> <dump>`. Everything is now owned by `postgres`.
  4. Point every `/etc/xtelo/*.env` `DATABASE_URL` at `<fresh>` (or rename the databases), then `deploy/apply-db-roles.sh grants`: it hands ownership back to `scraplify_migration` and re-grants every role.
  5. Start everything again in the §2 order.
- **Drill:** `scripts/restore-db-drill.ps1` (on the operator machine) restores the newest backup into a throwaway database and compares every table's row count with the source. Last run: 2026-09-26, on a fresh 11.1 MB backup of the real corpus. It passed: every table's count matched, and the throwaway database was dropped. A hosted drill is still owed once the host exists.

## 7. Incidents

| Symptom | Likely cause | Action |
| --- | --- | --- |
| A crawl logs "settled runs left unsettled by a crawl process that died" | A previous crawl process was killed or the host went down mid-run. The new process holds that source's advisory lock, so no live process owned the run, and it was settled as `failed` automatically (`src/db/crawl-process-lock.ts`). | Nothing. The crawl continues normally. Frequent occurrences mean crawls are being killed; check the timer's timeout and the host. |
| A crawl exits at once with "another crawl process for this source is running" | A crawl for that source is genuinely still in flight, holding its lock. | Nothing, unless it keeps happening: then a crawl is hanging. Find and stop that process; the next run settles its row. |
| After a parser change, fields look stale on old listings | Scheduled crawls fetch a detail page only when its list-page row changed (Phase 7C), so an improved parser reaches old listings only when they change. | Run each crawl once with `--refetch=all` (e.g. `node dist/cli/run-jobs-ge-crawl.js --refetch=all`). That is a multi-hour run at the sources' crawl delays. |
| A crawl's log shows a high `refetch.canaryChanged` over several runs | The 20 random canaries re-fetched each run found content changes the list-page fingerprint did not reveal. | Widen the fingerprint fields in that adapter's discovery parser (`docs/PHASE_7C_PLAN.md` §1), not a periodic full re-scrape. |
| `readyz` → 503 | The database is unreachable or refusing the role. | Check Postgres and the env file's `DATABASE_URL`. The web process needs no restart once the database is back. |
| Probe `manifest` warns `stale` | No bundle published for 72 h, usually because crawls stopped and the builder's health gate refused. | Fix the crawls. `deploy/with-env.sh worker npm run matching:build -- --override-health-gate` exists but is recorded on the build and shown on `/admin/matching`; use it knowingly. |
| Visitors get 429 | One address exceeded a limit (`web/lib/rate-limit.ts`). Several people behind one NAT share an address. | If it is real traffic, raise that class's numbers in code and deploy. Probes are never limited. |
| `public` will not start: "can change N relation(s)" | Its `DATABASE_URL` is not `scraplify_public`. | Fix the env file. Never set `XTELO_E2E_ALLOW_WRITABLE_PUBLIC_ROLE` on a host. |
| Admin sign-in loops or 404s | The GitHub account is not in `ADMIN_GITHUB_IDS`, or the OAuth app callback URL is wrong. | Check the numeric id and the app's callback. |

## 8. Secrets

- Each process reads only its own env file, so rotating one affects one process.
- **Role password:** `sudo -u postgres psql -c "ALTER ROLE … PASSWORD '…'"`, update that env file, then restart that unit. `apply-db-roles.sh` sets a password only when it creates a role, so it never changes an existing one.
- **`AUTH_SECRET`:** regenerate it with `openssl rand -base64 32` and restart admin. Every admin session ends, which is the point.
- **GitHub OAuth secret:** rotate it in the GitHub app settings, update `admin.env`, then restart admin.
