# scraplify — implementation status

Last updated: 2026-09-25 (`main` at `823c7be`, PR #22).

This file is the **current-state index**: what is done, what is open, and what gates were waived. The full build records, review rounds and incident write-ups through 2026-09-25 are kept verbatim in [`status-history.md`](status-history.md). Read that when you need the evidence behind a line here, and not otherwise; it is ~600 KB. Update this file in the same commit as any work that changes phase or exit-gate status (CLAUDE.md). Keep new entries short: evidence in a few bullets, full narrative only where a future reader genuinely needs it.

## Current phase: Phase 8D — browser CV Ranked

**Exit gate met; not yet merged** (push, PR and whole-branch review outstanding). **Branch:** `phase-8d-browser-cv-ranked`. **Scope** (change.md §7/§13, concept §30): a lazy, self-hosted Web Worker that parses a PDF/DOCX CV in the browser, a memory-only profile provider, the landing CV chooser with client navigation to `/cv-ranked`, a combined profile/preferences/results UI, cleanup states, lexical/taxonomy ranking with explanations against the Phase 8C `lexical-v1` bundle (`GET /api/matching/manifest`), failure and fallback states, and privacy/no-network tests. No semantic vectors: Phase 8A approved no model, so this ships honest lexical/taxonomy matching and must not call it "semantic".

**Exit:** a canary CV produces only allowlisted same-origin `GET` requests for public assets (no upload, no mutation) and leaves no canary text, file metadata, candidate row or ranking in server logs or the database. ✔ `npm run test:e2e:privacy` passes against a `public` production server, and a deliberate file-name leak into a URL made it fail.

**What the `lexical-v1` bundle can and cannot support** (checked 2026-09-25 against the active bundle: 2,522 rows, 2.8 MB): each row has a title, organization, deadline, locations and hr.ge taxonomy labels (Georgian only), and no description text. About 75% of rows (hr.ge) carry taxonomy and locations; jobs.ge rows carry a title only. So ranking can use role↔title, profession/industry fields↔taxonomy, and skills↔title. It **cannot** check language or work mode, because no bundle field states either. The UI will not offer those as filters rather than offer filters that do nothing. English CVs reach Georgian titles and labels only through a small curated bilingual alias list, and that list is recorded as a matching lexicon, never shown as data.

**Stage plan:**

1. **Pure lexical core** (`src/matching/lexical/`, browser-safe with no Node imports; the zod bundle schemas are split out of `contract.ts` so the browser can import them without `node:crypto`). It covers Georgian-aware tokenizing and suffix stemming, the lexicon (fields and locations derived from the bundle, plus curated EN↔KA role, skill and city aliases), `deriveProfile(text)` (suggestions, each with its local evidence snippet), and `rankOpportunities(profile, rows, now)`. `rankOpportunities` applies hard filters only on stated data (a passed deadline; a location preference only when the row states a location), scores only the components that apply to a row, and returns explanations built only from named matches. The versioned name is `lexical-rank-v1`. Vitest unit tests cover it. **Done** (`558094b`).
2. **Worker** (`web/lib/cv-ranked/`): a Turbopack module worker, created only on explicit CV choice, so landing and Browse load none of it. It runs pinned `pdfjs-dist@6.3.289` in-thread (fake worker via `globalThis.pdfjsWorker`, no nested or remote worker) and mammoth's browser build. Checks: extension plus magic bytes, 8 MiB, ≤40 pages, ≤200k chars, a DOCX decompressed-size cap, and a 45 s timeout. Encrypted, image-only and empty files are rejected. The worker reads `GET /api/matching/manifest` and then the listed file, verifies SHA-256 with SubtleCrypto, and refuses stale or incompatible bundles. Errors cross to the UI as bounded codes only. **Done** (`302b03d`). In a real browser under Turbopack the worker loads as same-origin `_next/static` chunks only; a text PDF (Georgian or English) and a DOCX each reach ranked results in 0.4–1.3 s including the 2.8 MB bundle download and SHA-256 check.
3. **Memory-only provider + landing chooser**: a client context in the root layout owns the worker and its state. Nothing goes to storage, cookies, the URL or the server. The landing CV chooser starts processing and client-navigates to `/cv-ranked`. `/cv-ranked` is allowed on `public` and `local` (proxy allow-list + route tests) and added to both navs. **Done.** The provider is not mounted on `admin`. The tenth nav link moved the desktop-nav breakpoints to 1560px (en) and 1810px (ka), bisected on real page loads. The surface-boundary-reviewer found no P0/P1.
4. **`/cv-ranked` UI** (`professional-frontend` skill first): a chooser for a direct or refreshed visit ("no prior session was kept"), progress with cancel, an editable profile (roles, fields, skills, locations) showing evidence, and ranked results with per-row explanations and source links. It also covers change/clear CV, and the failure, stale-bundle, unavailable and no-results states. **Done.** Browser-checked at 390/768/1280/1920 with no body overflow: add/remove/toggle terms, a location filter (with "States no location" on rows that name none), show more, clear, cancel mid-processing, and the stub-PDF, renamed-file, empty-DOCX and `.txt` failures, each with its own message. `web-design-guidelines` review: fixed the MB non-breaking spaces; URL state is deliberately absent (no CV-derived value may enter a URL). Known limit, not a bug: the corpus holds about six developer vacancies, so an English developer CV finds 7 matches.
5. **Privacy proof**: a Playwright canary-CV test. It records every request and asserts only allowlisted same-origin `GET`s (page, `_next` assets, manifest, bundle file), no request body, and no canary in URLs. Afterwards it greps the server log for the canary and scans the DB (candidate tables' row counts are unchanged, and the canary appears in no text column). `docs/THREAT_MODEL.md` gets the browser-CV section. Strict CSP headers are 8E (hosting) work, but the worker needs no `eval` or remote origin, so they will fit. **Done.** The request capture includes the worker's own fetches: the test asserts it saw the worker script, the manifest and the bundle. Beyond the plan, it also asserts no cookie, Web Storage, IndexedDB or Cache Storage entry holds the canary. `docs/THREAT_MODEL.md` §7.1 records each mitigation with its evidence and residuals: declared zip sizes can lie, and the CSP is still to come.
6. **Browser QA** at 390/768/1280/1920 with real Georgian and English CVs; the exit gate is ticked here. **Done** (during stage 4, with text PDFs generated from synthetic Georgian and English CVs, plus the DOCX fixture).

Invoke the `professional-frontend` skill before UI work.

## Open operational issues (not phase work, but blocking real freshness)

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
| 8D — browser CV Ranked | in progress | — | — |
| 8E — hosted readiness | not started | — | Production OAuth app, per-process role credentials, TLS/CSP/rate limits, probes, restore drill, rights/licences. |

Codex review debt: per-commit reviews recorded as **OWED** during usage-limit outages are listed in `status-history.md` (`rg -n OWED docs/status-history.md`). Since 2026-09-23 the owner's standing instruction is not to wait on Codex cooldowns, and since 2026-09-25 work done on Opus skips both the per-commit and whole-branch Codex gates. So those items are historical, not merge blockers; `discharge-codex-debt` can still pay them back if wanted.

## What exists now (short map)

- **Acquisition:** `src/adapters/jobs-ge`, `src/adapters/hr-ge` (HTTP + Cheerio, policy-bound fetcher, per-fetch policy revalidation, append-only `source_policies` with a fail-closed conflict flag), scheduled through `scripts/run-crawl.ps1` (crawl → dedupe `--auto-link` → taxonomy backfill → matching bundle).
- **Canonicalization:** dedupe with audited, reversible membership (`src/dedupe`), hr.ge taxonomy (765 terms) with human correction (`src/taxonomy`).
- **Local/operator surface** (`XTELO_SURFACE` unset or `local`): browse, listings, detail, review, taxonomy review, health, CV profile (Opus extraction, consented), ranking, shortlist, outreach drafts. `npm run dev:web` never writes; `dev:web:qa` writes to `scraplify_qa`.
- **Public surface:** `/`, `/opportunities`, `/listings`, `/api/matching/*`, read through the public views only (`src/browse/public-queries.ts`), with descriptions redacted in SQL per source policy.
- **Admin surface:** `/admin`, `/admin/sources`, `/admin/duplicates`, `/admin/taxonomy`, `/admin/matching`, behind GitHub OAuth + `ADMIN_GITHUB_IDS`, with `requireAdmin()` at the data layer and a three-outcome admin audit trail.
- **Database roles:** `scraplify_public`, `_worker`, `_admin`, `_migration` created and verified on both local DBs (`scripts/sql/phase-8b-*.sql`; passwords in gitignored `.env.roles`). Migrations 0034+ are applied as `scraplify_migration`. Local dev and tests still use the broad owner credential on purpose.
- **Matching bundle:** `npm run matching:build` / `matching:rollback`; the active bundle is served by `GET /api/matching/manifest`; the maximum bundle age is 72h (concept §30.3).
- **Tests:** `npm test` (vitest, real DB; 3 `queries.test.ts` tests fail locally only because the live DB's review queue is larger than the test's 500-row page; they pass in CI), `npm run test:e2e:surfaces` (three real servers, 84 route checks), `npm run test:e2e` (design-system rendering checks).

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
2. **Phase 8D — browser CV Ranked** (current phase above).
3. **Phase 8E — hosted readiness.** Real deployment evidence; a local demo is not hosted readiness.
4. **Phase 7B — supervised repair**, once 7A schedules have run for days: stuck-run self-healing, parser-repair proposals and canaries, `pg-boss` only if heterogeneous durable work appears.
5. **Phase 1C remainder:** full-coverage runs per source, closure against live data, coverage and overlap reports.
6. **Model re-evaluation for semantic matching** (8A follow-up): a smaller multilingual candidate plus the 300+ human-labelled judgments. Only then add `embedding_models`/`opportunity_embeddings` and a vector bundle contract.
