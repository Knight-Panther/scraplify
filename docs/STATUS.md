# scraplify — implementation status

Last updated: 2026-09-30 (CV Ranked A′ deployed; role quality steps 1–3 merged in PR #36, not yet deployed).

This file is the **current-state index**: what is done, what is open, and what gates were waived. The full build records, review rounds and incident write-ups through 2026-09-25 are kept verbatim in [`status-history.md`](status-history.md). Read that when you need the evidence behind a line here, and not otherwise; it is ~600 KB. Update this file in the same commit as any work that changes phase or exit-gate status (CLAUDE.md). Keep new entries short: evidence in a few bullets, full narrative only where a future reader genuinely needs it.

## Current phase: Phase 7C — incremental crawling and retention

**Merged 2026-09-26 (PR #25); retention (step 6) merged 2026-09-28 (PR #31).** Plan: [`docs/PHASE_7C_PLAN.md`](PHASE_7C_PLAN.md).

- **Plan steps 1–5 and 8 are done.** Migration 0035 is additive: `source_listings.discovery_fingerprint`, `crawl_runs.skipped_count`, a partial index on open listings and `fetch_attempts(attempted_at)`. It is applied to `scraplify_qa` and, with the owner's OK on 2026-09-26, to `scraplify` as `scraplify_migration` (columns and indexes verified; 9,701 listings untouched).
  - Both discovery parsers compute a list-page fingerprint, and `needsDetailFetch` decides per listing: `fetch`, `adopt` (bootstrap) or `skip`.
  - 20 random canaries are fetched each run.
  - The quarantine and fetch-failure guards divide by pages fetched.
  - `--refetch=changed` is the default; `--refetch=all` is for use after a parser change.
  - Tests: units for the decision, canaries and guard; fingerprint fixtures; per-source crawl runs covering skip, canary, changed deadline, hr.ge priority flip ignored, sitemap candidate always fetched, disappearance still reaching `closed`, parse failure still making the run `partial`, `refetch=all`, and bootstrap. Full suite: 1,311 pass.
- **Also built: crawl self-healing** (the part of 7B that blocked every schedule). Each crawl process holds a session-level Postgres advisory lock for its whole life (`src/db/crawl-process-lock.ts`). A process that gets the lock settles any unsettled run for its source as `failed`, because no live process owns it. A process that can't get the lock skips, as before. A shutdown mid-crawl (this happened on 2026-09-26) no longer blocks later runs.
- **Live check (step 7), on `scraplify_qa` against the real sites**, with `--mode incremental --pages 1` run twice:
  - hr.ge run 1: 100 fetched, 349 s. Run 2: **80 skipped, 20 canaries fetched, 0 canaries changed, 76 s**. The fingerprints are stable on live pages.
  - jobs.ge run 1: 310 fetched, 1,628 s (27 min at the 5 s crawl delay). Run 2: **290 skipped, 20 canaries fetched, 0 canaries changed, 105 s** (15× faster).
- **jobs.ge crawl delay removed (policy v2, owner decision, 2026-09-26).** Its robots.txt `Crawl-delay: 5` is a generic file unchanged since 2019-03-08, and the owner has jobs.ge's permission. One request at a time with no spacing, so the pace is jobs.ge's response time (about 0.36 s, against 5.36 s per request before). A 429 still stops the run and records a source back-off, as before. A 503 now slows the rest of the run (5 s doubling, or Retry-After, capped at 60 s). Both are logged, and the run's log reports `rateLimitBackOffs`. hr.ge keeps its 3 s.
- **v2 was soft-blocked; v3 is 2 s (2026-09-27).** v2's first run (`54d7e238`, 2 min 20 s) went at about 5 requests a second. After about 40 s, jobs.ge answered every request with the same 77-byte page and a 200, not a 429, so the back-off never fired and 971 listings were quarantined as unparseable (974 in total). The CV-matching bundle health gate refused the build and kept the previous bundle. v3 spaces requests 2 s apart. The crawl now treats a detail page byte-identical to the previous one as a soft block: it stops like a 429, and the listing is retried next run instead of quarantined. Quarantined listings are always re-fetched, so the next run restores the 974.
- **v3 is confirmed healthy (2026-09-27, both crawls started by hand).**
  - jobs.ge `9f14d7d8` completed: 991 fetched, **971 quarantined listings restored**, 0 quarantined, 0 rate-limit back-offs, no soft-block stop.
  - hr.ge `ee4bd556` completed: 591 fetched, 1,156 adopted, 0 failed. It settled the dead run `abbd6508` by itself.
  - Dedupe (940 opportunities) and taxonomy ran by hand.
  - **Found and fixed (`640c5d5`):** both wrappers exited 1 straight after the crawl, skipping dedupe, taxonomy and the bundle. `Add-Content` refuses to open a log another process holds open (here, a `tail -F`). `run-crawl.ps1` now logs through `Out-File` and never fails the run on a header line.
  - **Unblocked by the owner the same day.** The bundle build had refused (`upstream_unhealthy`) on the soft-blocked run's critical `run_guard` incident and on the `field_missing` incidents of the restored listings. Nothing in the code resolves incidents yet (supervised repair, Phase 7B), so the owner ran a prepared script: 972 resolved, 3 left open on the listings still quarantined. The owner also applied migration 0036 to `scraplify` (37 recorded). The bundle then built without the override (`b0704885`, 8,732 opportunities, from 8,991 active listings). `health:check`: hr-ge ok, matching bundle ok, jobs-ge warning (3 open incidents), no critical. The update line renders on `/` with the correct times.
- **First scheduled runs with the logging fix (2026-09-27 20:10): both clean.** Both tasks returned 0, so crawl, dedupe, taxonomy and the bundle all passed; each built a bundle without the override (8,725).
  - jobs.ge `5295671f`: 1 min 37 s, 5,752 discovered, 5,731 skipped, 21 fetched.
  - hr.ge `74b49798`: 3 min 36 s, 3,397 discovered, 3,377 skipped.
  - `health:check`: no critical.
- **jobs.ge yearless dates: publication dates in the future (fixed on branch `jobsge-yearless-dates`, 2026-09-27).** jobs.ge shows dates without a year, and one "closest year to the fetch" rule served both fields. A listing from last November that is still up ("03 ნოემბერი" / "07 ნოემბერი", seen on 26 September) came out as the coming November.
  - It topped Newest listings with a future publication date, and its long-past deadline looked open.
  - Two live listings were affected (679178 and 686839). Every long-lived listing, and each year boundary, would add more.
  - **Fix:** a publication date is the latest year not after the fetch, with one day of slack. A deadline is the earliest year on or after publication, falling back to the closest year with no publication date. There are 11 new unit tests, and the existing parser and fixture tests are unchanged (43 pass).
  - The `--refetch=all` run `732b5502` (2026-09-27 20:49) could not correct the stored rows. The writer keeps a listing's stored dates when its page hash is unchanged, and the hash covers the raw date strings. That is deliberate: re-parsing on every touch would roll past deadlines forward.
  - `732b5502` itself completed at 00:12 Tbilisi time: 5,752 discovered, 0 failed, and every pipeline step exited 0. The bundle `81a60223` has 8,652 opportunities and was built without the override.
  - **It also quarantined 152 listings, and that is not a block.** All 152 had a deadline of 2026-09-27. The run crossed midnight Tbilisi time, and jobs.ge then takes down the pages of vacancies whose deadline just passed. The crawler discovered them while they were still listed, and fetched their pages after midnight.
  - They should be `expired`; they are hidden either way. `health:check` shows a warning (155 open incidents) and nothing critical.
  - **Open, small:** an unparseable detail page for a listing whose stored deadline has passed should expire it rather than quarantine it. Scheduled runs take 2–4 minutes at 20:10, so only long runs crossing midnight hit this.
  - **Follow-up (branch `retention-60d`):** the writer now also stores a fresh revision when the parser version differs, and jobs.ge's parser is `v2`. Each jobs.ge listing gets one fresh revision on its next fetch. After merge, migration 0037 and a `dist/` rebuild, one more jobs.ge `--refetch=all` run corrects 679178 and 686839 and re-parses the rest; until then, incremental runs reach only changed pages and canaries.
- **Jobs.ge's first run on the new code was started by hand at 23:14 on 2026-09-26** (`5b35c90b`, still at 5 s). As it started, it settled the dead run `df60e7db` as failed by itself, so the self-healing is confirmed live.
- **Board update line (owner request, 2026-09-27).** `/` (local and public) and `/admin` show, per source, the last full update (Tbilisi time, with the year) and a countdown to the next scheduled one. A crawl in flight shows "updating now". A slot that passes by 30 minutes with no run shows "late", so a stopped scheduler is visible. A newest run that ended partial or failed is flagged.
  - The schedule is declared once in `src/crawl-schedule.ts` (both daily at 16:10 UTC), and a test checks the systemd timer against it.
  - Migration 0036 adds the view `public_crawl_status` (slug, newest run start and status, last completed finish; nothing else). Both role scripts grant it: `scraplify_public` for `/api/crawl-status`, which the landing page polls once a minute, and `scraplify_admin` for `/admin`, which re-renders instead.
  - Applied and granted on `scraplify_qa`, where the public role reads the view and is refused on `crawl_runs` and `sources`. Applied to `scraplify` by the owner on 2026-09-27. Both pages leave the line out if the query fails.
  - **Landing page fits one screen on desktop** (owner request, 2026-09-27). At 1024 px and wider, the hero fills the space between the header and the footer, and the headline and vertical spacing scale with the viewport height. The CV chooser joins the button row, and the update line sits above Newest listings. Screens 760 px tall or less show three newest listings instead of four. Measured with no vertical scroll at 1280×720, 1366×768, 1536×730, 1440×800, 1920×960, 1920×1080 and 2560×1300, in English and Georgian. Tablets and phones still scroll, with no horizontal overflow.
  - The surface-boundary review found the missing admin grant (P1, fixed). Its P2, a view with no row filter over `sources` (only the two public boards exist), was skipped under the P0/P1 rule.
  - Browser QA: 390, 768 and 1280 px, English and Georgian, and the late, updating and incomplete states. It found and fixed a hydration mismatch where Chromium has no `ka-GE` date data. `/admin` was then rendered too, under `next start` on `scraplify_qa` as `scraplify_admin` with a demo session (throwaway auth values, loopback only), and `/` as `scraplify_public`: each shows the line, and each has its own menu.
- **Step 6 (retention) is built** (branch `retention-60d`, 2026-09-27), on the owner-approved 60/60/180-day policy (retention plan, `docs/PHASE_7C_PLAN.md`'s Retention section, `docs/scraplify-concept.md` §6.1 amendment) — narrower than the deferred draft's 90/180-day/2-year numbers, since the corpus (starting 2026-09-02) will cross 60 days well before the MVP window the deferred version was timed against.
  - Migration 0037 (additive): `source_listing_revisions.trimmed_at`. The writer (`writeSourceListingRevision`) now requires `trimmedAt === null` alongside the hash match before taking its unchanged path, so a trimmed closed listing that reappears with the same hash gets a fresh full revision instead of reactivating with a blank description.
  - `src/retention/{policy,eligibility,run-retention,retention-lock}.ts`, `src/cli/run-retention.ts`, `npm run retention` (dry run by default, `--apply` mutates). Tier 1 (60d): `fetch_attempts`, resolved `parser_incidents`, orphan `resources`. Tier 2 (60d dead): blanks a closed/expired listing's current revision description in place and deletes its non-current revisions, skipping any pinned by an outreach draft or a live classification chain. Tier 3 (180d dead): purges a whole cluster only when every listing it ever held is itself uninvolved with user data or a human decision — computed by `closeOverClusters`, a pure function over a fully-loaded cluster graph (`loadClusterGraph` BFS-expands to the whole connected component before deciding, so a multi-hop reassignment chain cannot be partially purged).
  - Locking (`src/retention/retention-lock.ts`): the retention advisory lock (tried, not waited for), then every source's crawl-process lock (skip the whole pass if any is busy), then the dedupe/taxonomy/matching-bundle locks (waited for) — nobody waits on a crawl lock, so it cannot deadlock against the pipeline.
  - Wired into `deploy/run-pipeline.sh` and `scripts/run-crawl.ps1` as a step after the bundle, gated on the crawl AND dedupe themselves exiting 0 (not taxonomy or the bundle), folded into the existing exit-code precedence.
  - Worker grants added to `scripts/sql/phase-8b-worker-admin-migration-roles.sql`: DELETE on the tables each tier touches, a column-scoped UPDATE on `source_listing_revisions` (description, trimmed_at only), and column-scoped read-only SELECT on `opportunity_decisions`/`rankings`/`outreach_drafts`/`organization_aliases`/`resource_links` — enough to check for user data, never enough to read a decision's note, a ranking's score, or a draft's body.
  - **Adversarial review (Opus):** found no path that deletes user-referenced data, and two P1s, both fixed:
    - `closeOverClusters` was a two-step lookup, not a fixpoint. A candidate with a superseded membership in one opportunity and a live one in a kept opportunity made `--apply` throw and roll back on every run.
    - The candidate seeds took the first N ids without skipping blocked ones, so tier 3 could stall forever. Candidates now page by keyset until a page has real work.

    **Open P2s, skipped under the P0/P1 rule:**
    - tier 2's classification-chain skip is broader than needed;
    - tier 2 excludes drafts only through the listing's live membership;
    - tier 2 does not re-check eligibility under the lock;
    - the crawl locks are held while waiting on the dedupe, taxonomy and bundle locks;
    - the dry run can settle orphaned crawl runs, as any crawl start does;
    - a re-fetched trimmed expired jobs.ge listing re-parses its deadline;
    - `filterTier3Candidates` ignores `sourceIds`;
    - the grants file has a stale verification note, and the `rankings.opportunity_revision_id` grant is unused;
    - there is an em dash in `run-crawl.ps1`.
  - Tests (throwaway Postgres, not `scraplify`/`scraplify_qa`): 10 pure `closeOverClusters` unit tests (`eligibility.test.ts`) plus 12 real-DB scenarios, including the review's superseded-membership case and a stalled-page case (`run-retention.test.ts`) covering all three tiers, entangled-cluster survival, human-decision and user-data blocks, dry-run/apply parity, idempotency, and the crawl-lock skip; a new `write-source-listing-revision.test.ts` case for the trimmed-reappearance trap. Full affected suites re-run clean: dedupe, reconcile-source-listings, advisory-lock, crawl-process-lock, both adapters' crawl tests, and the whole `src/` suite (958 tests, one pre-existing timing-sensitive lock test flaky only under full-suite parallel load, confirmed passing alone).
  - Not yet done: a live run against `scraplify`/`scraplify_qa` (needs the owner's migration/grants approval first, same as every other Phase 7C/8E schema or role change) and `docs/RUNBOOK.md`'s retention step (added, unexercised on a real host).
- **Merged in PR #25 and built into `dist/` on 2026-09-26.** An hr.ge catch-up run started by Task Scheduler at 20:40 (before the rebuild) is a full old-code crawl and finishes on its own. The jobs.ge catch-up exited 1 on the dead run `df60e7db…` (its process died in the 2026-09-26 shutdown), still on old code. The next scheduled jobs.ge crawl (2026-09-27 20:10) is the first on the new code: it settles that run by itself, then runs incrementally. It then adopts fingerprints, without fetching, for listings fetched in the last 7 days (all of hr.ge and about 3,000 jobs.ge listings from the 2026-09-26 runs, if applied by 2026-10-03), and fetches the rest once.

## Phase 8E — hosted readiness (host-independent work merged 2026-09-26, PR #24)

**Stages 1–6 done and merged; stage 7 is owner and host work and stays open.** **Scope** (change.md §10, §11, §13, §15): production runbook and restore rehearsal, least-privilege secrets, schedules and heartbeats, two hosted profiles and domains, TLS/CSP/rate limits/probes, load/accessibility/security evidence, rights and licences, and rollback drills. **The alert channel is dropped** (owner decision, 2026-09-27; concept §30.6): no alerting functionality.

**Exit:** every release item has current evidence. A local demo is not hosted readiness. The owner has asked for everything that does not need a host to be finished first; the stages below are ordered that way, and the ones that need a host or an owner decision are marked.

**Stage plan:**

1. **Security headers and a strict CSP.** A per-response nonce with `'strict-dynamic'`, set in `web/proxy.ts` (`web/lib/security-headers.ts`), plus static headers in `web/next.config.ts`: nosniff, frame DENY, referrer policy, permissions policy, COOP/CORP, and no `X-Powered-By`. Only `connect-src` and `worker-src` `'self'`, no `unsafe-eval` in production, and `form-action` allows GitHub on `admin` only. HSTS belongs to the TLS proxy. **Done.**
   - Every rendered script carries the nonce.
   - `e2e/csp.spec.ts`: six local pages hydrate with no violation.
   - The privacy suite runs the CV worker, PDF.js and mammoth under the production policy with no violation, and asserts the headers. Setting `connect-src 'none'` made it fail, so the policy is enforced inside the worker too.
2. **Probes.** `GET /api/healthz` is liveness with no DB access. `GET /api/readyz` returns 503 only when the DB is unreachable. It reports the matching bundle's state (`ok`/`stale`/`unavailable`/`not_served`) without failing on it, since change.md §15 keeps the catalogue up through a builder outage. Both are served on every surface, return states only, and are never rate-limited. `npm run probe -- <origin>` walks a visitor's path: readiness, landing with nonce CSP, Browse, a detail page, the manifest, and the bundle download with checksum check. **Done.** Unit tests cover the logic, the surfaces e2e checks all three servers, and the probe prints `probe: ok` against a `public` production server.
3. **Rate limits.** Per-client token buckets in `web/proxy.ts` (`web/lib/rate-limit.ts`) on `public` and `admin`:
   - pages 240 burst at 4/s;
   - manifest 60 at 1/s;
   - bundle 20 at 1 per 30 s;
   - admin sign-in 20 at 1 per 6 s.

   They key on the last `X-Forwarded-For` entry only, and memory is bounded. Caddy adds request-body caps. **Done.** The surfaces e2e shows a real 429 with `Retry-After`, per-client isolation, and no limit on probes or on `local`.
4. **Deployment profiles and fail-closed startup.**
   - `deploy/Caddyfile`: two hosts to two loopback ports, HSTS, body caps. Validated with the official `caddy:2` image.
   - `deploy/systemd/`: web units per surface, hardened; pipeline and backup units with timers.
   - `deploy/run-pipeline.sh`: the same steps and exit rules as `run-crawl.ps1`, tested with stub steps. `deploy/backup-db.sh` is its backup counterpart. Both are shellcheck-clean.
   - `deploy/env/*.template`: one per process.

   `public` now refuses to start without its bundle directory, with any admin credential present, or on a DB role that can write:
   - a real-DB test shows the owner is refused and `scraplify_public` can write nothing;
   - a real `next start` on the owner credential refused, naming 33 relations.

   `XTELO_CV_RANKED=off` is the rollback switch from change.md §15 step 1; a typo refuses startup. It was checked on a real `public` build and in the browser at 390 and 1280. **Done.**
5. **Runbook and drills.** `docs/RUNBOOK.md`: shape, first deploy in change.md §15's order, upgrades, health signals, rollback, backup and restore, incidents, secret rotation. The restore drill passed on 2026-09-26 on a fresh backup of the real corpus: every table's count matched. **Done** locally. The bundle rollback is covered by the Phase 8C real-DB tests (two rollbacks, a tampered target refused); the one live bundle has no predecessor to repoint to. Hosted drills are owed.
6. **Evidence.**
   - **Accessibility.** axe WCAG 2.1 A/AA on the `public` server (`e2e/surfaces/a11y.spec.ts`, pinned `@axe-core/playwright@4.13.0`) found 0 violations on landing, Browse, Listings, CV Ranked and a detail page.
   - **Load** (`npm run load-test`). One `public` process serves Browse in about 110 ms p50 to a single client. At 20 concurrent loops it serves about 22 req/s, all 200, with Browse p50 about 1.2 s from queueing.
   - **Dependencies.** `npm audit` finds 0 vulnerabilities; 131 production packages, all permissive (`docs/RIGHTS.md`).
   - `docs/THREAT_MODEL.md` §7.2 records every control with its evidence and residuals.

   **Done.** P3, operator-only: `local`'s hover-revealed Save/Dismiss controls sit at 35% opacity until hover or focus, which axe flags as contrast. They do not exist on `public`.
7. **Needs a host or an owner decision** (nothing else is left). Source rights are settled: the owner has permission from jobs.ge and hr.ge (2026-09-26, `docs/RIGHTS.md`).
   - ~~the host~~: **deployed** 2026-09-28. It is an OVHcloud VPS-1 (2 vCore, 4 GB, 40 GB NVMe) in Gravelines, France, running Ubuntu 24.04, with no commitment at €4.49/month before tax (order #259205773). The IPv4 is `152.228.171.98`. Hetzner's CX23 and CAX11 were sold out in every EU location that day. OVH also beat Contabo and Netcup on price and terms. The first deployment followed RUNBOOK §2 end to end, and release `41c678d` is live:
     - host set-up, SSH on keys only, and the ufw firewall;
     - 38 migrations as `scraplify_migration`, then grants, with all five roles and public read-only;
     - both web units and Caddy;
     - the crawl and backup timers.
     The first jobs.ge run (a full fetch) started at 16:22 UTC, and hr.ge follows it automatically. The scripts written for it are in `deploy/` (`host-setup.sh`, `make-env.sh`, `set-github-secret.sh`, `set-r2-credentials.sh`);
   - ~~the domain~~: **done** 2026-09-28. `jobster.fun` is registered at Cloudflare with auto-renew on. The public site is `jobster.fun` and admin is `admin.jobster.fun`. DNSSEC, CAA (Let's Encrypt and ZeroSSL only) and mail lockdown are set. A and AAAA records exist for both names, DNS-only. Let's Encrypt certificates were issued for both on 2026-09-28;
   - ~~the production GitHub OAuth app~~: **done**. It was registered with its homepage and its only callback URL on `admin.jobster.fun`. The owner generated the client secret on 2026-09-28 and set it on the host through the hidden-input helper. The owner's first sign-in is still to be confirmed;
   - ~~role passwords on the host~~: **done**. They were generated on the host by `deploy/make-env.sh` and never printed;
   - ~~off-host backup storage~~: **done** 2026-09-28. The R2 bucket `xtelo-backups` (WEUR, private) has a 60-day expiry rule. Its token has Object Read & Write on that bucket only and is IP-filtered to the host. A real backup uploaded (`Copied off the host`);
   - ~~the alert channel~~: dropped (owner decision, 2026-09-27);
   - hosted probe, restore and rollback evidence. These are owed once the first crawl, dedupe and bundle build finish.

**Pre-deploy audit (2026-09-27, branch `phase-8e-deploy-hardening`).** A read-only audit of `deploy/` and the runbook against a fresh Ubuntu 24.04 host found 2 P0s and 5 P1s; all are fixed. A surface-boundary review of everything merged since 8E (7C, the board update line, jobs.ge v3) found nothing.
- **P0:** the runbook granted roles before the migrations had created any table, and psql carried on past the errors, so roles came out with no grants. It also never created the service user or the directories the units need, so systemd would refuse to start them. `deploy/apply-db-roles.sh` now does `bootstrap` (database and migration role) before `db:migrate` and `grants` (both role scripts, `ON_ERROR_STOP`, passwords taken from the env files) after it, and checks that the public role can write nothing. Runbook §2 step 0 creates the users and directories.
- **P1:**
  - Every unit ran as one user with group-readable env files, so the public process could read admin secrets and dumps. Each web surface now has its own user, the env files are `0600 root`, and the units hide `/etc/xtelo`, the backups and other users' processes.
  - The units had no ordering after Postgres, so a reboot could leave `public` answering 500 without restarting.
  - There was no off-host backup. `deploy/backup-db.sh` now copies each dump with rclone and fails the run if the upload fails; `BACKUP_REMOTE=none` is an explicit, loudly reported opt-out.
  - Upgrades never re-applied grants.
  - Host prerequisites (Node 24 path, Postgres 17 from PGDG, swap, firewall) were missing from the runbook.
  - Also: a `scraplify_backup` role (`pg_read_all_data`) replaces "owner" for backups, and `deploy/with-env.sh` runs one-off commands as their process would.
- **Evidence:**
  - On a throwaway `postgres:17`: bootstrap, all 37 migrations as `scraplify_migration`, then grants, each run twice. Every object is owned by `scraplify_migration`. `public` reads its views and is refused on `crawl_runs`. The worker can insert incidents, and the backup role can create nothing.
  - `backup-db.sh` was run for real. The rclone upload (local backend) is byte-identical, and a bad remote fails the run.
  - `systemd-analyze verify` is clean on Ubuntu 24.04 (systemd 255).
  - shellcheck is clean.
  - **Full runbook rehearsal** in a throwaway Ubuntu 24.04 container booted with systemd (Node 24.21 from NodeSource, Postgres 17.11 from PGDG, the branch from `git archive`, throwaway credentials). Steps 0–8 and 11 ran as written:
    - `npm ci` and both builds as `xtelo`;
    - `apply-db-roles.sh`, then `with-env.sh migration npm run db:migrate` (37 recorded), then grants;
    - `with-env.sh` propagates exit codes;
    - both web units run as their own users, and healthz, readyz, the landing page, Browse and `/api/crawl-status` answer 200. `/admin` is 404 on public.
  - **Isolation inside the public unit:**
    - `/etc/xtelo` and the backups are unreachable, as is the admin process's environment;
    - the release is read-only, and its Next cache is a private tmpfs.
  - The backup unit dumped and uploaded (rclone local backend). The pipeline unit starts without a namespace error.
  - **The rehearsal found one more bug:** `useradd --create-home` makes `/var/lib/xtelo` 0750, so the public user could not reach the bundles under it, and CV matching would have been unavailable on the host. Step 0 now sets 0755, re-verified: public reads a bundle file and cannot write there.
  - Not rehearsed: a live crawl (it would hit the real boards from a throwaway box), Caddy/TLS (needs the host) and OAuth sign-in (needs the production app).
- **Branch review (Opus, adversarial):** no P0. Two P1s: the same 0750 home (already fixed by the rehearsal), and rclone's bucket check failing with an object-scoped R2 token, fixed with `NO_CHECK_BUCKET` in the template (rclone's own R2 note). **Open P2s**, skipped under the P0/P1 rule:
  - the restore command runs `pg_restore` as `postgres`, which cannot read `/var/backups/xtelo`; redirect the file from the root shell instead;
  - `apply-db-roles.sh` passes the passwords to `sed` as arguments, so they are briefly visible in `ps`, and a failing `CREATE ROLE` would log its statement;
  - the backup and migrations run as the crawler's OS user, `xtelo`;
  - `createdb` does not pin UTF-8 (check the cluster encoding on the host);
  - watch the first `journalctl -u xtelo-web@public` for `EACCES`/`EROFS`. The rehearsal showed none.

**CV matching, also on this branch.** Evidence discipline plus a 32-CV synthetic regression suite (P@10 .397 → .709), then semantic matching:

- **Decided 2026-09-26: semantic CV matching uses E1** (`e1b`: multilingual-e5-small distilled into a static table, 256 dims, int8, 8.5 MB). On 1,270 judged CV–vacancy pairs (34 CVs), lexical plus E1 scores nDCG@10 .788 against .709 for lexical alone. It is the best of the three candidates (Potion-multilingual .752, static-similarity-MRL .743), the smallest, the best at Georgian tokenization, and MIT-licensed. The other candidates are closed.
- **Wired 2026-09-26: CV Ranked ranks with `hybrid-v1`** (`src/matching/semantic/hybrid.ts`). Weighted reciprocal-rank fusion of the lexical ranker (weight 1) with three quarter-weight lists: lexical matching against each title's dictionary English key (whole roles only), and E1 title similarity to the profile's active roles and the CV's short lines, Georgian titles and English keys. Similarity lists keep rows within 0.9 of their best cosine. Judged with the production code: nDCG@10 .798 (lexical .709; Russian CV .698 from 0). Non-relevant similarity-only rows in the suite's top 20s went from 56 to 18 with the floor. Pair-level similarity is noisy (static model), which is why it only ever ranks after word matches.
  - The model is fixed and corpus-independent, so it ships as pinned files (`matching-models/static-e1-v1/`, checksums in `src/matching/models/static-e1.ts`) served by `/api/matching/models/<id>/<file>` with immutable caching, not inside the per-crawl bundle. Titles are embedded in the worker (≈160 ms for 2,522), so the bundle schema is unchanged (`lexical-v1`).
  - If the model fails to load or verify, CV Ranked ranks by words alone and says so.
  - Switching off or removing a CV-derived term also drops the CV lines containing it from similarity.
  - Browser-checked on the dev server with a synthetic English CV: results in 2.4 s (localhost), only the four expected GETs, no console errors, no overflow at 390/768/1280/1920. After merge, on a production `public` build: the privacy e2e passes with the model (`npm run test:e2e:privacy`: both model files fetched, same-origin GETs only, no CSP violation, the canary nowhere). Cold first results with an empty cache: **12.4 s at 10 Mbps / 40 ms with 4× CPU throttling** (the 20 s gate passes); 28.9 s at 4 Mbps with 6× CPU. Both were measured uncompressed (8.9 MB table), which is also how production serves it: Caddy's `encode` skips `application/octet-stream` by default, and gzip would only save about 14% (7.6 MB) on int8 data anyway (deploy audit, 2026-09-27).
- **Matching work stops here for the MVP** (owner, 2026-09-26). The next real lever, if matching quality is revisited, is vacancy-side: skills and roles extracted from descriptions at bundle-build time and shipped as term ids, never as text (descriptions are not republishable). No more model tuning.

## Open operational issues (not phase work, but blocking real freshness)

- **Resolved 2026-09-26:** the two stale `running` rows from 2026-09-16 were settled (`reconciled_at` 2026-09-26 08:12 UTC) and a full jobs.ge crawl started (`df60e7db…`, still running at 17:40 local). Earlier note, kept for context: the Task Scheduler tasks fire again (both ran at 2026-09-25 20:10), but each crawl exits 1 at once. It refuses to start because of its own stale `running` row from 2026-09-16 (`crawl_runs` `77c999c9…` hr.ge and `2d030dcf…` jobs.ge). No crawl process was running. Dedupe and taxonomy still run after it. **Owner action:** settle the two rows as the crawler's own message says, `update crawl_runs set status = 'failed', reconciled_at = now() where id in ('77c999c9-0e6b-4452-9f49-abbd2ebd92c4', '2d030dcf-69a8-41a2-b756-439c487381e0') and status = 'running' and reconciled_at is null`. The next scheduled run (20:10 daily) then crawls. The automation was not allowed to write this to the real DB.
- **Scheduled crawls have not run for 9+ days** (`npm run health:check`, 2026-09-25): both `jobs-ge` and `hr-ge` are critical `run_overdue`, each with a `crawl_runs` row stuck `running`. This is the second time. The first time, both schedules silently stopped after their first run on 2026-09-16 and were found on 2026-09-23 (a battery-power setting). That root cause was fixed, but the recovery was never confirmed. Because of the stale crawls, the Phase 8C bundle health gate correctly refuses to publish. The one active public bundle was built with `--override-health-gate`, which is recorded on the build and shown on `/admin/matching`. Needs: check the Task Scheduler registration (`scripts/register-crawl-schedule.ps1`), settle the stuck runs, and run one crawl per source. **Self-healing of a stuck `running` row is built as of 2026-09-26** (Phase 7C branch, advisory lock); it takes effect once `dist/` is rebuilt.
- **Neither source has ever completed a full-coverage crawl** (jobs.ge ≈ 7.9h, hr.ge ≈ 2.75h), so closure of vanished listings has never run against live data (Phase 1C items 1, 2, 4).

## Phase index

| Phase | State | PR | Gates and waivers worth knowing |
| --- | --- | --- | --- |
| 0 — policy and domain foundation | merged | #1 | Last commits `--no-verify` after Codex hung; a second confirming review was skipped by decision. |
| 1A — jobs.ge vertical slice | merged | #2 | — |
| 1B — hr.ge acquisition | **merged with unmet gates** | #3, #4 | No completed whole-branch review; no live full-run validation; two commits never Codex-gated (usage limit). |
| 1C — cross-source reconciliation | **merged with unmet gates**, stopped deliberately | #5 (stacked) | Completeness gate unmet: no full-coverage run, closure never exercised live. Coverage/overlap reports, full-reconciliation validation and browser-vs-HTTP canaries not started. |
| 2A/2B/2C — normalization, dedupe, audited membership | merged | #5 | Three whole-branch rounds (6 → 11 → 4 P1s, all fixed); no fourth pass on the final state. |
| 3A — browse and inspect | merged | #5 | — |
| 3B — UI | merged, re-scoped 2026-09-14 | #6 | Two per-commit waivers (a docs-only commit; the test-debris commit). |
| 3C — duplicate review and taxonomy | merged | #9, #10 | jobs.ge taxonomy **assignment** deliberately not built: jobs.ge has no category data, so its listings show as an explicit "never categorized" count. |
| 3D — unified browse redesign | merged | #7, #8 | Per-commit and whole-branch review both waived. |
| 3E — landing hero (+ polish, bilingual front page) | merged | #11, #12, #13 | — |
| 4 — attachment visibility | merged, narrowed scope | landed via #18 (`24cd8ef`) | Re-scoped by owner; concept §16/§25 amended. |
| 5 — CV parsing (+ profile hub) | merged | #14, #15 | Whole-branch review waived by decision (Codex was available). |
| 5A — CV matching and ranking | merged | #5 | — |
| 6 — outreach drafts | merged | #17 | Whole-branch review waived; two post-merge review rounds fixed. |
| 7A — operations baseline (+ taxonomy automation) | merged | #16, #18 | Schedules exist but have silently stopped twice (see above). |
| 7B — supervised repair, pg-boss, hosting reassessment | **open, deferred** | — | Evidence-gated on 7A schedules running for days; that evidence does not exist yet. |
| 8A — private matching feasibility | merged | #19, #20 | Closed **lexical-first**: `multilingual-e5-small` is 118 MB (int8), cold load 126 s against a 20 s gate. Node/browser parity was proven (cosine 0.997+). The 300+ human-labelled set was never built (a human task). |
| 8B — surfaces and admin boundary | merged | #21 | All exit-gate boxes checked; the whole-branch Codex review was **owner-waived, not passed**. |
| 8C — matching bundle | merged | #22 | Vectors deferred (no approved model); `semanticInputHash` is in place for later incremental embedding. |
| 8D — browser CV Ranked | merged | #23 | Opus review in place of Codex adversarial review (owner decision); open P2/P3 in the 8D section below. |
| 8E — hosted readiness | **deployed** 2026-09-28 on OVH VPS-1 (`jobster.fun`); stage 7 almost closed | #24 | Remaining: the first crawl, dedupe and bundle build (running), then the hosted probe, restore and rollback drills, and the owner's first admin sign-in (alert channel dropped 2026-09-27). Source permissions granted for both (`docs/RIGHTS.md`). Also carries hybrid CV matching (E1). Whole-branch Codex review skipped (Opus rule). CV Ranked with the model: privacy e2e passed, cold load 12.4 s at the mid-range profile. |
| 7C — incremental crawling and retention | merged (#25); retention merged (#31) | #25, #31 | Plan in `docs/PHASE_7C_PLAN.md`. Also carries crawl self-healing (advisory lock). Migration 0035 applied to both DBs; migration 0037 (retention) generated and tested, not yet applied to `scraplify`/`scraplify_qa`. |

Codex review debt: per-commit reviews recorded as **OWED** during usage-limit outages are listed in `status-history.md` (`rg -n OWED docs/status-history.md`). Since 2026-09-23 the owner's standing instruction is not to wait on Codex cooldowns, and since 2026-09-25 work done on Opus skips both the per-commit and whole-branch Codex gates. So those items are historical, not merge blockers; `discharge-codex-debt` can still pay them back if wanted.

## What exists now (short map)

- **Acquisition:** `src/adapters/jobs-ge`, `src/adapters/hr-ge` (HTTP + Cheerio, policy-bound fetcher, per-fetch policy revalidation, append-only `source_policies` with a fail-closed conflict flag), scheduled through `scripts/run-crawl.ps1` (crawl → dedupe `--auto-link` → taxonomy backfill → matching bundle).
- **Canonicalization:** dedupe with audited, reversible membership (`src/dedupe`), hr.ge taxonomy (765 terms) with human correction (`src/taxonomy`).
- **Local/operator surface** (`XTELO_SURFACE` unset or `local`): browse, listings, detail, review, taxonomy review, health, CV profile (Opus extraction, consented), ranking, shortlist, outreach drafts. `npm run dev:web` never writes; `dev:web:qa` writes to `scraplify_qa`.
- **Public surface:** `/`, `/opportunities`, `/listings`, `/api/matching/*`, read through the public views only (`src/browse/public-queries.ts`), with descriptions redacted in SQL per source policy.
- **Admin surface:** `/admin`, `/admin/sources`, `/admin/duplicates`, `/admin/taxonomy`, `/admin/matching`, behind GitHub OAuth + `ADMIN_GITHUB_IDS`, with `requireAdmin()` at the data layer and a three-outcome admin audit trail.
- **Database roles:** `scraplify_public`, `_worker`, `_admin`, `_migration` created and verified on both local DBs (`scripts/sql/phase-8b-*.sql`; passwords in gitignored `.env.roles`). Migrations 0034+ are applied as `scraplify_migration`. Local dev and tests still use the broad owner credential on purpose.
- **Matching bundle:** `npm run matching:build` / `matching:rollback`; the active bundle is served by `GET /api/matching/manifest`; the maximum bundle age is 72h (concept §30.3).
- **Tests:** `npm test` (vitest, real DB; 3 `queries.test.ts` tests fail locally only because the live DB's review queue is larger than the test's 500-row page; they pass in CI), `npm run test:e2e:surfaces` (three real servers, 90 route and probe checks), `npm run test:e2e` (design-system rendering, viewport overflow, CSP/hydration), `npm run test:e2e:privacy` (canary CV against a `public` production build).

## Phase 8D — browser CV Ranked (merged 2026-09-26, PR #23)

- **Browser-only CV Ranked:** a lazy Turbopack worker parses a PDF (pinned `pdfjs-dist@6.3.289`, in-thread) or a DOCX (mammoth). The public `lexical-v1` bundle is fetched, checked with SHA-256 and zod, and ranked with `lexical-rank-v1` (`src/matching/lexical/`), with an evidence-backed, editable profile and per-row explanations.
- **State:** memory-only, in a root-layout provider (not on `admin`). Nothing goes to storage, cookies, the URL or the server. `/cv-ranked` is on `public` and `local`.
- **Evidence:**
  - `npm run test:e2e:privacy`: a canary CV, only allowlisted same-origin GETs, no canary in storage, server log or any DB text column, candidate tables unchanged;
  - browser QA at 390/768/1280/1920 with Georgian and English CVs;
  - `docs/THREAT_MODEL.md` §7.1.
- **Review:** one Opus high-effort pass in place of the Codex adversarial review (owner decision), with no P0/P1. Fixed before or after merge:
  - result links open in a new tab, so the session survives;
  - the colliding Georgian IFRS form was dropped;
  - a timeout during the index download is reported as a network failure;
  - the `RankingPayload.total` comment.
- **Post-deploy fix (2026-09-29, branch `cv-download-progress`):** one 45 s timer also covered the first-visit download, 10.8 MB on the wire, so a phone at ~200 KB/s (~55 s) always failed. Now:
  - reading and the first ranking get 45 s of running time each;
  - a download is abandoned only after 30 s with no data;
  - the page shows a percentage;
  - a stalled model falls back to word matching.

  Time a frozen or backgrounded tab did not run is not charged (`watchdog.ts`). Evidence: unit tests; Chrome throttled to 200 KB/s finished in ~52 s; a hung index file errored after 30 s of silence; a hung model file ranked by words; the privacy suite passes.
- **Role vectors, "A′" (merged 2026-09-30, PR #35; deployed 2026-09-30 as release `9a2b141`, first live bundle `7976abc1` with 8,570 vacancies; the owner's "CV Matching Model Options" doc, steps 2–5):** the daily bundle build now embeds each lexicon role's English label and each distinct English title key with a pinned `bge-small-en-v1.5` (q8 ONNX, MIT, Node only) and ships them as int8 rows. Bundle schema 2 (`lexical-v1+title-vectors-v1`) adds `title-vectors.json` and `title-vectors.int8`. Schema 1 is still read, for rolling deploys. The browser ranks each vacancy by its title's best cosine to the CV's active roles, fused with the word matches at weight 2. Titles under 0.8 of the best cosine, or under 0.6 absolute, are not offered.
  - The 9.3 MB static model is now fetched only when a role has no vector: a role typed outside the lexicon, a CV whose roles the lexicon does not know, or a schema 1 bundle.
  - Nothing is embedded on the visitor's side, and no CV-derived value reaches the network. A failed embed at build time is `model_unavailable` and keeps the previous bundle.
  - **Judged on the 34-CV suite, through production code:**

    | nDCG@10 | Static-model hybrid (today) | A′ |
    |---|---|---|
    | 32 English and Georgian CVs | .763 | .833 |
    | All 34 CVs | .724 | .790 |
    | The owner's CVs | .414 | .748 |

    The lexical list is identical to the study's on 34/34 CVs, and 2/34 CVs (Russian) need the static model.
  - **Measured on the real bundle (8,652 vacancies):** 65 roles plus 3,216 title keys, embedded in 2.2 s. Vectors add about 1 MB gzipped to the download, in place of the model's 9.3 MB. Ranking takes a median of 92 ms (worst 264 ms), against 207 ms (548 ms) for the static path; 86 ms of the 92 is the word matching both share.
  - **Evidence:**
    - unit tests for the format, quantisation, floors, fallback rules and the schema 2 build;
    - browser QA on `scraplify_qa`: the main path makes 4 GETs and no model request, and a typed role outside the lexicon fetches the static model;
    - the privacy suite passes against a schema 2 bundle and checks both vector files.
  - The bundle's GET rate limit is now 60 at 1 per 10 s, since a first visit fetches three files.
- **Role quality, step 1 (branch `cv-role-quality`, 2026-09-30; the doc's "next lever"):** CVs now yield specific roles, and every role they yield has a title vector.
  - **Corpus title roles get vectors.** The build also embeds each recurring corpus title a CV can yield as a role (`titleRoles`), by its dictionary English key: 508 role rows instead of 65 on the real bundle. Titles the dictionary cannot fully carry into English are left out.
  - **Specific lexicon rows,** picked by how often their titles recur in the corpus: graphic and UI/UX designer, family doctor, pediatrician, civil engineer, construction supervisor, operations, store, warehouse, restaurant and financial manager, procurement, sales director, recruiter, English and kindergarten teacher, lab technician, welder, confectioner, dispatcher and a dozen more. Designer, Doctor and Teacher became broad parents that step aside for them.
  - **The current post wins.** A role or hr.ge field found only on lines dated to the past ("Waiter, 2014–2017") is suggested, not applied, when the CV names a specific role it holds now or undated.
  - **False roles removed:** "customer service" in a skills list; "for the project manager"; a word before a plural ("frontend developers", "backend services").
  - **The ranker no longer reads "the director's X" as a director vacancy** (the owner's screenshot: with only Director ticked, the director's assistants and driver ranked first). A role word in the Georgian genitive before a helper noun (assistant, თანაშემწე, დამხმარე, driver, secretary), or in English before one or after "assistant to", is not that role. A generic head noun ("specialist", "manager") no longer earns partial credit.
  - **Judged:**

    | nDCG@10 | Live (A′) | This branch |
    |---|---|---|
    | 32 English and Georgian CVs of the suite | .833 | .857 |
    | 24 new held-out CVs (12 English, 12 Georgian) | .465 | .912 |
    | — English / Georgian | .366 / .565 | .863 / .960 |

    The held-out CVs were written before the changes and graded title by title with the suite's rubric (Claude-graded, 781 CV–title pairs, pooled from both versions plus a keyword search per CV). They were written knowing which role families were targeted, so treat their gain as optimistic; their five controls (accountant, barista, Python developer, corporate sales manager, nurse) held or improved.
  - **Corpus self-check** (no grades): for each of the 433 recurring titles, a one-line CV naming it; share of that title's own vacancies in the top 10: Georgian .590 → .854, English .146 → .220. English stays low mostly because many dictionary keys are word-by-word ("warehouse employee"), which no English CV says.
  - **Cost:** title-vector files +137 KB gzipped (1.03 → 1.17 MB); build 2.1 s for 508 roles.
  - **Browser QA** on `dev:web:qa` against a `scraplify_qa` bundle built from this code (`19797ae0`, 302 vacancies, 115 role rows including 14 corpus titles): an English store manager CV applies "Store manager" and only suggests the older assistant and sales-associate posts; a Georgian courier CV applies Courier and the corpus title "კურიერი საკუთარი ავტომობილით", only suggests the past waiter post and its café field; exact titles rank first. The main path makes the same 4 GETs and no model request, with no console errors or warnings.
- **Role quality, step 2: "Your roles" (branch `cv-confirm-roles`, on top of step 1, 2026-09-30; the doc's "confirm your roles"):** a panel above the results shows every role as a chip, ticked when used. One tap switches a role on or off in place, so a suggestion from an older post is one tap away.
  - **More specific suggestions:** while a broad role (Designer, Doctor, Teacher, Manager…) is on, the roles whose head word it is are offered, most common titles first ("Designer" → Graphic designer, UI/UX designer).
  - **Role picker** (native `datalist`, English or Georgian): every lexicon row plus every recurring corpus title no row covers (`roleOptions`). A picked role, or a Georgian corpus title typed in full, gets the id a CV naming it would yield, so it ranks by its title vector without the static model. Anything else stays a typed role and still falls back to the static model.
  - The profile column keeps each role's CV quote and checkbox. Its own "Add a role" box is gone, since the picker replaces it.
  - **Browser QA** on `dev:web:qa` with the step 1 QA bundle, at 390, 768, 1280 and 1920: no horizontal overflow, Georgian labels wrap, no uppercase. Chips and checkboxes stay in sync, and results re-rank. Picking roles makes no model request, and a role outside the list loads the static model as before. The keyboard reaches every chip with the focus ring. The `web-design-guidelines` review found two focus-loss bugs (a chip moving between lists, a chosen suggestion leaving its row), both fixed and re-checked. No console errors.
- **Visible ranking, step 3 (branch `cv-visible-ranking`, on top of step 2, 2026-09-30):** every result carries Strong, Good or Partial, and a key above the list gives the count of each over every match, shown or not. The full list stays behind "Show more"; no score is shown.
  - **By evidence, never by score** (`strength.ts`): Strong = the title names one of your roles; Good = close to one (near spelling, similar meaning, or its English equivalent); Partial = no role, only a field, a skill or a CV line. Judged on each CV's first 50 results (32 suite + 24 held-out CVs), relevant / strong fit: a named role 96–99% / 74–94%, a close title 50–68% / 20–46%, a field or skill alone 0–27% / 0–5%, a CV line alone (Russian CVs, 11 rows) 45% / 0%. Cosine bands did not separate grades consistently across the two sets, so they play no part.
  - **Grouped by strength, fused order within each** (`+strength-v1` on every rank version). Without it, a broad field buried 38 of a store manager's 55 Good rows among ~1,500 Partial ones. Condensed nDCG (judged rows only) @10/@20/@50: held-out .912/.873/.872 → .928/.893/.882; suite (the set the fusion weights were tuned on) .859/.833/.814 → .844/.819/.810.
  - A near-miss role now reads "(close title)", as an exact one reads "(same title)".
  - **Browser QA** on `dev:web` (read-only real bundle, 8,691 vacancies) and `dev:web:qa`, at 390, 768, 1280 and 1920: no horizontal overflow. The counts equal the labels on screen once every row is shown (1,667 matches), and follow re-ranking when a role is switched off and on. The labels add no tab stops. Screen readers hear "Strong, 33, the title names one of your roles". The `web-design-guidelines` review found one nit (a CSS variable in an SVG `fill` attribute), fixed. No console errors.
  - Tried and dropped: treating "director" as a generic head noun. It changed no judged score, and the director titles came back through the role vectors instead.
- **Steps 1–3 merged together in PR #36** (2026-09-30, merge `e18c263`, CI green). They build on each other and were QA'd together. **Not yet deployed**, and deploying is not urgent. The bundle schema is unchanged, so no one-time step is needed; the first build after the deploy ships the 508 role rows.
- **Open:**
  - P2: a DOCX whose declared zip sizes lie can still exhaust the tab's memory (THREAT_MODEL §7.1 residual).
  - P3: loose aliases (delivery, bare "hr", "head of").
  - P3: duplicate location terms across languages.
  - Moot: `isEvalSupported` no longer exists in PDF.js 6, and the production CSP has no `unsafe-eval`.
- The full stage record is in `status-history.md`.

## Phase 8C — matching bundle (merged 2026-09-25, PR #22)

- **Migration 0034** (additive), applied as `scraplify_migration`: `matching_bundle_builds`, `matching_bundle_publications` (a partial unique index allows one active pointer per channel; `previous_publication_id` is the rollback relation), and the `public_active_matching_bundle` view, the only matching object the public role can read. Role grants were extended and re-verified.
- **`src/matching/bundle/`:**
  - It reads a repeatable-read snapshot through the public views with Browse's own `publicEligibleMemberSql`.
  - It builds under an advisory lock plus the dedupe lock: commit `building` → upstream health gate → atomic artifact write → read-back checksum validation → provenance-drift re-check → one activation transaction with a count-collapse guard.
  - GC keeps the active bundle plus two predecessors; rollback re-verifies the target's files.
  - Every failure records a bounded error code and leaves the prior bundle active.
- **Delivery:** the manifest is `no-store` and reports `matchingAvailable: false` past 72h. Files are served for the active bundle only, re-checked against their checksums, and cached as immutable. Both are available on `public`/`local` only, and a `public` process without `XTELO_MATCHING_ARTIFACT_DIR` refuses.
- **Evidence:**
  - 12 real-DB bundle tests (interruption, orphaned build, incompatible schema, health gate, count collapse, empty corpus, idempotent rebuild, two rollbacks, tampered target, single-pointer constraint, health alerts);
  - the route suite at 81/81;
  - the live build was refused by the health gate as designed, then built with the override: 2,522 opportunities, equal to Browse's eligible count;
  - it was served while the process was connected as `scraplify_public`;
  - `/admin/matching` browser-QA'd at 390/768/1280/1920.
- **Exit gate:** interrupted or incompatible builds never replace active data ✔; every published row maps to a current public canonical revision and a real source ✔; scheduling was added after the idempotency proof ✔; incremental embedding deferred with the hash in place (narrower than change.md, by design).

## Phase 8B — surfaces and admin boundary (merged 2026-09-25, PR #21)

- `XTELO_SURFACE=local|public|admin` (fails closed on anything else). `web/proxy.ts` allow-lists routes per surface. Every local Server Action calls `assertLocalSurface()` first and every admin action calls `requireAdmin()`.
- **Evidence:**
  - `web/app/(local)/local-actions-surface.test.ts` covers all 18 local actions, discovered automatically, and refuses on `public`/`admin` with zero DB access; its mutation check caught a removed guard;
  - an admin crafted-action matrix plus a CSRF case;
  - `e2e/surfaces` with three real `next start` servers and forged Auth.js cookies;
  - all four DB roles provisioned and privilege-matrix-verified on `scraplify_qa` and `scraplify`, with a real `db:migrate` as `scraplify_migration` and the public site served as `scraplify_public`.
- **Policy-sync hardening** (a 12-round Codex loop closed by one Opus audit): locked `syncSourcePolicy`, a fail-closed same-date conflict flag, per-fetch revision revalidation during crawls, and the public view redacting while a conflict is unresolved.
- **Still deployment work (8E):** a production GitHub OAuth app, and each deployed process's `DATABASE_URL` built from its own role.

## Upcoming, most valuable first

1. **Restore crawl freshness** (see the operational issues above). Every downstream freshness claim depends on it.
2. **Phase 7C — incremental crawling and retention** (current phase above).
3. **Phase 8E stage 7 — hosting** (owner and host work). Real deployment evidence; a local demo is not hosted readiness.
4. **Phase 7B — supervised repair**, once 7A schedules have run for days: stuck-run self-healing, parser-repair proposals and canaries, `pg-boss` only if heterogeneous durable work appears.
5. **Phase 1C remainder:** full-coverage runs per source, closure against live data, coverage and overlap reports.
6. **Matching quality, post-MVP only:** description-derived skill terms in the bundle (see the 8E section). The model question is closed (E1).
