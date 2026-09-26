# scraplify — implementation status

Last updated: 2026-09-26 (PR #23, Phase 8D).

This file is the **current-state index**: what is done, what is open, and what gates were waived. The full build records, review rounds and incident write-ups through 2026-09-25 are kept verbatim in [`status-history.md`](status-history.md). Read that when you need the evidence behind a line here, and not otherwise; it is ~600 KB. Update this file in the same commit as any work that changes phase or exit-gate status (CLAUDE.md). Keep new entries short: evidence in a few bullets, full narrative only where a future reader genuinely needs it.

## Current phase: Phase 8E — hosted readiness

**In progress: every item that needs no host is done (stages 1–6); stage 7 is owner and host work.** **Branch:** `phase-8e-hosted-readiness`. **Scope** (change.md §10, §11, §13, §15): production runbook and restore rehearsal, least-privilege secrets, schedules and heartbeats, two hosted profiles and domains, TLS/CSP/rate limits/probes, an alert channel, load/accessibility/security evidence, rights and licences, and rollback drills.

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
7. **Needs a host or an owner decision** (nothing else is left):
   - **hr.ge republication permission**, which blocks public launch (`docs/RIGHTS.md`). jobs.ge permission is granted (owner, 2026-09-26), and the hero video and logo come from free sources;
   - the hosting provider and domains;
   - a production GitHub OAuth app;
   - role passwords on the host;
   - off-host backup storage;
   - the alert channel;
   - hosted probe, restore and rollback evidence.

## Open operational issues (not phase work, but blocking real freshness)

- **2026-09-26 update:** the Task Scheduler tasks fire again (both ran at 2026-09-25 20:10), but each crawl exits 1 at once. It refuses to start because of its own stale `running` row from 2026-09-16 (`crawl_runs` `77c999c9…` hr.ge and `2d030dcf…` jobs.ge). No crawl process was running. Dedupe and taxonomy still run after it. **Owner action:** settle the two rows as the crawler's own message says, `update crawl_runs set status = 'failed', reconciled_at = now() where id in ('77c999c9-0e6b-4452-9f49-abbd2ebd92c4', '2d030dcf-69a8-41a2-b756-439c487381e0') and status = 'running' and reconciled_at is null`. The next scheduled run (20:10 daily) then crawls. The automation was not allowed to write this to the real DB.
- **Scheduled crawls have not run for 9+ days** (`npm run health:check`, 2026-09-25): both `jobs-ge` and `hr-ge` are critical `run_overdue`, each with a `crawl_runs` row stuck `running`. This is the second time. The first time, both schedules silently stopped after their first run on 2026-09-16 and were found on 2026-09-23 (a battery-power setting). That root cause was fixed, but the recovery was never confirmed. Because of the stale crawls, the Phase 8C bundle health gate correctly refuses to publish. The one active public bundle was built with `--override-health-gate`, which is recorded on the build and shown on `/admin/matching`. Needs: check the Task Scheduler registration (`scripts/register-crawl-schedule.ps1`), settle the stuck runs, and run one crawl per source. Self-healing of a stuck `running` row is Phase 7B work and is not built.
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
| 8E — hosted readiness | **in progress**; host-independent work done | — | Remaining: host, domains, OAuth app, role passwords, alert channel, hr.ge permission (`docs/RIGHTS.md`), hosted drills. |

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
2. **Phase 8E — hosted readiness** (current phase above). Real deployment evidence; a local demo is not hosted readiness.
3. **Phase 7B — supervised repair**, once 7A schedules have run for days: stuck-run self-healing, parser-repair proposals and canaries, `pg-boss` only if heterogeneous durable work appears.
4. **Phase 1C remainder:** full-coverage runs per source, closure against live data, coverage and overlap reports.
5. **Model re-evaluation for semantic matching** (8A follow-up): a smaller multilingual candidate plus the 300+ human-labelled judgments. Only then add `embedding_models`/`opportunity_embeddings` and a vector bundle contract.
