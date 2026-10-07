# scraplify — implementation status

Last updated: 2026-10-07 (Phase 9B built: job-board tender posts are typed as tenders and merged with their etenders.ge copies; PR pending).

This file is the **current-state index**: what is done, what is open, and what gates were waived. The full build records, review rounds, per-phase narratives and incident write-ups are kept verbatim in [`archive/status-history.md`](archive/status-history.md); read that when you need the evidence behind a line here, and not otherwise (it is ~700 KB). Finished plans and handoff documents are in [`archive/`](archive/README.md). Update this file in the same commit as any work that changes phase or exit-gate status (CLAUDE.md), and keep new entries short.

## Current phase: Phase 9B — job-board tender posts and tender dedupe (live operations continue)

The hosted edition has been live at `jobster.fun` since 2026-09-28. Every phase in the index is merged except 7B, the Phase 1C remainder and Phase 9 (tenders, in progress).

- **Phase 9 (tenders from etenders.ge), started 2026-10-07; 9A merged the same day (PR #41).** Study and strategy: [`addEtender.md`](addEtender.md). Three sub-phases, each its own PR:
  - **9A, acquisition (merged, PR #41):** etenders.ge source policy, adapter and CLI (`npm run crawl:etenders-ge`), fetcher `redirect: 'manual'` mode, the `tender` opportunity type (migration 0038), dedupe typing by source (never pairing a tender with a vacancy), and tenders kept out of the CV Ranked bundle. Until tenders have their own rows, Browse, its counts and the sitemap leave the `tender` type and the etenders.ge board out by default (`TYPES_HIDDEN_BY_DEFAULT`, `SOURCES_HIDDEN_FROM_BROWSE` in `src/browse/queries.ts`); the Listings page shows them. **Not** added to the hosted pipeline: nothing reaches `jobster.fun` until 9C. Migration 0038 is applied to `scraplify_qa` (2026-10-07); applying it to `scraplify` and the host waits on the owner.
  - **9B, job-board tender posts and tender dedupe (built 2026-10-07, PR pending):** `addEtender.md` §14.6 has the measured rules.
    - **Detector** (`src/dedupe/tender-post.ts`): a jobs.ge or hr.ge listing is a tender when its title opens with "ტენდერი"/"ტენ."/"tender" or names a procurement act ("…შესყიდვაზე", "მომსახურების გაწევა", "სამუშაოების შესრულება", RFQ, expression of interest…), or its description says "აცხადებს ტენდერს"; a job-role word in the title ("მენეჯერი", "Tender Manager") vetoes all of it. On the real corpus it flags 27 of 14,655 listings, all tender posts (read one by one).
    - **Tender dedupe** (`score-tender-pair.ts`, `tender-buyer.ts`, ruleset `tender-v1`): tenders block by buyer (legal forms, dashes, a GE/EN alias list, leading-words match). An automatic merge needs the same buyer, deadlines on the same Tbilisi day, publication within 7 days and agreeing subjects (or an equal reference code); a near miss or a pair in two languages goes to review. A listing matching two listings of one other source is held for review, and no opportunity takes a second listing from a source it already holds. Old single-listing tender opportunities made by the ruleset are folded together, so posts from before 9B merge too.
    - **The two 9A review P2s are closed:** the resolver derives `job`/`tender` from the live members on every resolve (any tender member makes a tender), and a reviewer's accept or reassign refuses to mix the two. An automatic vacancy merge whose listing turns out to be a tender post is queued for review.
    - **Order of operations:** 9B code writes the `tender` type, so migration 0038 must be applied before the first dedupe pass on this code: on `scraplify` (`npm run db:migrate`) and on the host (the usual release order). Once deployed, the job boards' tender posts leave Browse and CV Ranked until 9C shows tenders.
  - **9C, tenders in Browse** (owner, 2026-10-07; `addEtender.md` §14.7, replacing the separate Tenders tab): tenders and vacancies in one list by default; a "tender" tag on tender rows; "tender" in the Kind filter and etenders.ge in the Board filter; a simple tender detail page (title, buyer, dates, estimated value when stated, "Open on etenders.ge"; no CPV codes, method, documents or Q&A); Georgian and English copy that mentions tenders; the two interim hide-lists emptied; public-view handling of the type; and etenders.ge in the hosted pipeline.
  - **9A exit gate:**
    - [x] Fixture and crawl tests green in CI (PR #41, 2026-10-07).
    - [x] A live run into `scraplify_qa` completes with no quarantines (2026-10-07: 209 tenders, 37 open and 172 closed by their own pages, 224 requests, 0 failed; a second run the same morning fetched 1 changed tender and skipped 208).
    - [x] Dedupe on QA types every etenders.ge opportunity `tender` (209 of 209; 0 tender–vacancy candidate pairs).
    - [x] The local surface shows them: the Listings page lists all 209, and Browse leaves them out (browser-checked on QA).
    - [x] The bundle builder leaves them out: on QA, 37 open tenders are in the public views and none reach the snapshot (966 vacancies).
  - **9B exit gate:**
    - [ ] Tests green in CI.
    - [x] Precision on the golden pairs (2026-10-07): the 27 real board tender posts scored against QA's 209 etenders.ge tenders give 12 automatic merges, all true; 8 pairs go to review (3 true, 5 wrong but same-buyer); no golden pair is lost; every hard negative stays apart (`score-tender-pair.test.ts`).
    - [x] No tender posts left in the vacancy catalogue: on QA a dedupe pass retyped all 7 board tender posts there to `tender` and folded hr.ge 492864 into etenders.ge 69470's opportunity.
    - [x] Every new guard is load-bearing: each DB test in `tender-typing.test.ts` fails with its fix removed. Full suite on `scraplify_qa`: 1,594 passed, 7 skipped.

- **Live release:** `cf4efe0` (PR #39, the ops follow-ups), deployed 2026-10-05 at 17:16 UTC as a plain deploy. The previous release, `30e68a7`, stays on the host for rollback.
- **Live bundle:** `b9b8e49a` (8,663 vacancies), built by hand at the end of the rollback drill.
- **Schedules:** both pipelines run on the host daily at 16:10 UTC (`xtelo-pipeline@jobs-ge.timer`, `xtelo-pipeline@hr-ge.timer`); the nightly backup runs at 09:00 UTC. Backup copies off the host are in R2, whose lifecycle rule deletes them after 30 days; `deploy/backup-db.sh` also keeps the off-host copies under 8 GB, oldest first and never the newest.
- **MVP is complete (owner, 2026-09-30):** no P0 or P1 is open. What stays open is P2/P3, optional clean-up and post-MVP work. The next step is to watch real users' feedback and traffic, then tune step by step. With no alert channel, a crawl failure or a source layout change leaves the catalogue quietly stale (the site keeps serving the last good one). The "Board updates" panel on `/admin` says "Late" or "last attempt incomplete" when a run misses; a look every day or two catches it.
- **Still to see (2026-10-06):** the first scheduled run on `cf4efe0` (16:10 UTC) should show hr.ge's `canaryChanged` back near 0, and the 09:00 backup should log no rclone error.

**Five-day ops check of `30e68a7` (2026-10-05, read-only on the host): all fine.**

- All 10 scheduled runs (2026-10-01 to -05) completed with full coverage, 0 failed, 0 quarantined and 0 rate-limit back-offs; every step exited 0 with no warn or error lines. All 5 nightly backups succeeded and the 8 R2 copies match the local dumps byte for byte.
- Both web units had 0 restarts and 0 5xx in about 23,800 requests; about 470 distinct non-bot visitors and 6 CV Ranked users (rough figures: bot filtering is heuristic).
- Three small findings, fixed in PR #39 and deployed 2026-10-05: the nightly backup's "501 Not Implemented" from R2 (the host now runs the official rclone 1.75.1, pinned by SHA-256 in `deploy/host-setup.sh`); hr.ge `canaryChanged` counting promotion-only (`isPriority`) flips; and closed vacancy links showing "No such opportunity" instead of "no longer listed" (still a 404).

**Hosted restore and rollback drills: passed (2026-10-05, 17:24–17:30 UTC, owner-approved).** They close 8E stage 7; the site ended where it started (release `cf4efe0`, 8,663 vacancies).

- **Restore:** a fresh backup downloaded back from R2 matched its host copy by SHA-256 and restored (RUNBOOK §6) into a throwaway database with exit 0; all 30 tables' row counts matched the live database (123,473 rows). The throwaway database and the downloaded copy were removed.
- **Web rollback (RUNBOOK §5 step 3):** `current` pointed at `30e68a7` and back to `cf4efe0`, `probe: ok` both ways; a 4 Hz health monitor saw 1 failed request (one 502, about a second) out of 100.
- **Bundle rollback (RUNBOOK §5 step 2):** `matching:rollback` repointed to the previous bundle (8,625 vacancies), which served with matching checksums; `matching:build` then rebuilt `b9b8e49a`, since there is no roll-forward command.

Older release records (`30e68a7`, `0b3476d`, the first scheduled run of `9a2b141`), the 2026-09-30 public-repository audit and the backup-storage details are in [`archive/status-history.md`](archive/status-history.md), section "Former current-phase section".

## Owner decisions in force

- **Alert channel dropped** (2026-09-27; concept §30.6): no alerting functionality.
- **Review severity:** only P0/P1 findings are implemented; P2 and lower are skipped under "the P0/P1 rule" and recorded as open items.
- **Codex reviews are manual only** (2026-10-05): `.githooks/pre-commit` no longer runs Codex, and no review is required before merging; `/codex:review` or `/codex:adversarial-review` run only when the owner asks. Before that, waivers applied: not waiting on Codex cooldowns (2026-09-23), and work done on Opus skipping both Codex gates (2026-09-25). 8B's whole-branch review was owner-waived (not passed); 8D used one Opus high-effort pass in place of the Codex adversarial review (owner decision).
- **Source permissions:** granted for jobs.ge and hr.ge (2026-09-26) and etenders.ge (2026-10-07), `docs/RIGHTS.md`.
- **Tenders (2026-10-07):** build tenders from etenders.ge for freelancers and small firms, shown in Browse together with vacancies (a "tender" tag and Kind filter; this replaced a separate Tenders tab the same day) and kept out of CV Ranked; v1 ingests public purchase tenders only (no asset sales, invite-only or anonymous tenders); the job boards' own tender posts are reclassified as tenders.
- **Crawl pacing:** jobs.ge crawl delay removed under policy v2 (2026-09-26), then set to 2 s under v3 after a soft block (2026-09-27); hr.ge keeps 3 s.
- **Retention:** the 60/60/180-day policy was owner-approved (2026-09-27; concept §6.1 amendment).
- **Schema and role changes on the real database** need the owner's approval (migration and grants approval is asked for first).
- **Semantic matching:** E1 chosen 2026-09-26; matching work was to stop for the MVP the same day, then reopened by the owner on 2026-09-30 for A′ (PR #35) and role quality (PR #36). The model question is closed (A′).
- **Hosting:** OVH VPS-1, deployed 2026-09-28.
- **R2 backups kept inside the free tier** (owner request, 2026-09-30): 30-day expiry and a spend alert.
- **MVP complete** (2026-09-30).

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
| 7A — operations baseline (+ taxonomy automation) | merged | #16, #18 | Schedules silently stopped twice early on; they have run daily since 2026-09-27. |
| 7B — supervised repair, pg-boss, hosting reassessment | **open, deferred** | — | Evidence-gated on 7A schedules running for days; they have run daily since 2026-09-27 (local) and 2026-09-28 (host), so the gate can now be assessed. Hosting was settled by 8E. |
| 8A — private matching feasibility | merged | #19, #20 | Closed **lexical-first** (`multilingual-e5-small` too big: 118 MB int8, cold load 126 s against a 20 s gate). The 300+ human-labelled set was never built. |
| 8B — surfaces and admin boundary | merged | #21 | All exit-gate boxes checked; the whole-branch Codex review was **owner-waived, not passed**. |
| 8C — matching bundle | merged | #22 | Vectors deferred then (no approved model); `semanticInputHash` is in place for incremental embedding. |
| 8D — browser CV Ranked | merged; A′ and role quality deployed 2026-09-30 | #23, #35, #36 | Opus review in place of Codex adversarial review (owner decision); open P2/P3 under Open items. |
| 8E — hosted readiness | **deployed** 2026-09-28 (`jobster.fun`); all 7 stages closed 2026-10-05 | #24 | Nothing remaining. Also carries hybrid CV matching (E1). Whole-branch Codex review skipped (Opus rule). |
| 7C — incremental crawling and retention | merged (#25); retention merged (#31) | #25, #31 | Plan in `archive/PHASE_7C_PLAN.md`. Also carries crawl self-healing (advisory lock). Migration 0037 (retention) is applied to `scraplify` (38 recorded, checked 2026-09-30) and on the host; `scraplify_qa` was not rechecked. |
| 9A — etenders.ge tender acquisition | **merged** 2026-10-07 | #41 | Study `addEtender.md`; migration 0038 (`tender` type) applied to `scraplify_qa`, waiting on the owner for `scraplify` and the host; not in the hosted pipeline yet. 9B (job-board reclassification) and 9C (tenders in Browse) follow. |
| 9B — job-board tender posts and tender dedupe | built 2026-10-07, PR pending | — | Detector, tender scorer, buyer key, the two 9A P2s. Needs migration 0038 before its first dedupe pass on `scraplify` and the host. |

Codex review debt: per-commit reviews recorded as **OWED** during usage-limit outages are listed in `archive/status-history.md` (`rg -n OWED docs/archive/status-history.md`). They are historical, not merge blockers, now that Codex reviews are manual; the `discharge-codex-debt` skill that paid them back was retired on 2026-10-05.

## What exists now (short map)

- **Acquisition:** `src/adapters/jobs-ge`, `src/adapters/hr-ge` (HTTP + Cheerio, policy-bound fetcher, per-fetch policy revalidation, append-only `source_policies` with a fail-closed conflict flag), scheduled through `deploy/run-pipeline.sh` on the host and `scripts/run-crawl.ps1` locally (crawl → dedupe `--auto-link` → taxonomy backfill → matching bundle → retention).
- **Canonicalization:** dedupe with audited, reversible membership (`src/dedupe`), hr.ge taxonomy (765 terms) with human correction (`src/taxonomy`).
- **Local/operator surface** (`XTELO_SURFACE` unset or `local`): browse, listings, detail, review, taxonomy review, health, CV profile (Opus extraction, consented), ranking, shortlist, outreach drafts. `npm run dev:web` never writes; `dev:web:qa` writes to `scraplify_qa`.
- **Public surface:** `/`, `/opportunities`, `/listings`, `/api/matching/*`, read through the public views only (`src/browse/public-queries.ts`), with descriptions redacted in SQL per source policy.
- **Admin surface:** `/admin`, `/admin/sources`, `/admin/duplicates`, `/admin/taxonomy`, `/admin/matching`, behind GitHub OAuth + `ADMIN_GITHUB_IDS`, with `requireAdmin()` at the data layer and a three-outcome admin audit trail.
- **Database roles:** `scraplify_public`, `_worker`, `_admin`, `_migration` created and verified on both local DBs (`scripts/sql/phase-8b-*.sql`; passwords in gitignored `.env.roles`). Migrations 0034+ are applied as `scraplify_migration`. Local dev and tests still use the broad owner credential on purpose.
- **Matching bundle:** `npm run matching:build` / `matching:rollback`; the active bundle is served by `GET /api/matching/manifest`; the maximum bundle age is 72h (concept §30.3).
- **Tests:** `npm test` (vitest, real DB), `npm run test:e2e:surfaces` (three real servers, route and probe checks), `npm run test:e2e` (design-system rendering, viewport overflow, CSP/hydration), `npm run test:e2e:privacy` (canary CV against a `public` production build).

## Open items

All P2/P3 or optional; no P0 or P1 is open. "Archive" below means `archive/status-history.md`.

**Operations and crawling**

- Open (Phase 1C items 1, 2, 4): a correct live closure of vanished listings has not been confirmed; full walks complete, but closure on live data is unverified. Detail: Archive, "Open operational issues".
- Small (no severity recorded): an unparseable detail page for a listing whose stored deadline has passed should expire it rather than quarantine it; only long runs crossing midnight hit this. Archive, "Phase 7C".

**Retention (Phase 7C open P2s, skipped under the P0/P1 rule)** — Archive, "Phase 7C":

- P2: tier 2's classification-chain skip is broader than needed.
- P2: tier 2 excludes drafts only through the listing's live membership.
- P2: tier 2 does not re-check eligibility under the lock.
- P2: the crawl locks are held while waiting on the dedupe, taxonomy and bundle locks.
- P2: the dry run can settle orphaned crawl runs, as any crawl start does.
- P2: a re-fetched trimmed expired jobs.ge listing re-parses its deadline.
- P2: `filterTier3Candidates` ignores `sourceIds`.
- P2: the grants file has a stale verification note, and the `rankings.opportunity_revision_id` grant is unused.
- P2: there is an em dash in `run-crawl.ps1`.
- P2: the `public_crawl_status` view has no row filter over `sources` (only the two public boards exist).

**Hosted deployment (Phase 8E branch-review P2s)** — Archive, "Phase 8E":

- P2: `apply-db-roles.sh` passes the passwords to `sed` as arguments (briefly visible in `ps`), and a failing `CREATE ROLE` would log its statement.
- P2: the backup and migrations run as the crawler's OS user, `xtelo`.
- P2: `createdb` does not pin UTF-8 (check the cluster encoding on the host).
- P2: watch `journalctl -u xtelo-web@public` for `EACCES`/`EROFS` (none in the rehearsal, nor in the web and pipeline journals through 2026-10-05).
- P3 (operator-only): `local`'s hover-revealed Save/Dismiss controls sit at 35% opacity until hover or focus, which axe flags as contrast; they do not exist on `public`.

**CV Ranked (Phase 8D)** — Archive, "Phase 8D":

- P2: a DOCX whose declared zip sizes lie can still exhaust the tab's memory (THREAT_MODEL §7.1 residual).
- P3: loose aliases (delivery, bare "hr", "head of").
- P3: duplicate location terms across languages.

**Public repository (owner)** — Archive, "Former current-phase section":

- Optional: `src/matching/eval/fixtures/golden-vectors.node.json` holds 40 real vacancy texts, with one named recruiter's email and 8 phone numbers; redacting them means regenerating the vectors (`npm run matching:embed-eval-corpus`).
- Owner, on GitHub: turn on email privacy in the account's email settings (36 web merge commits carry the owner's address). Dependabot alerts: **on** since 2026-10-05, 0 open.

## Upcoming, most valuable first

1. **Public-repository follow-up** (Open items): optionally redact the eval fixture's contact details. The unused-code removal is done.
2. **Privacy e2e outside CI.** CI runs `test:e2e` and `test:e2e:surfaces` but not `test:e2e:privacy`, so the canary-CV test went stale when PR #36 moved role entry to "Your roles", and nobody noticed until PR #38's local QA. Run it by hand before any CV Ranked change, or add it to CI if its database and bundle needs allow.
3. **Phase 7B — supervised repair:** resolving parser incidents in code (today the owner resolves them by hand), parser-repair proposals and canaries, and `pg-boss` only if heterogeneous durable work appears. Stuck-run self-healing is already built (Phase 7C).
4. **Phase 1C remainder:** closure against live data, coverage and overlap reports.
5. **Matching quality, post-MVP only:** description-derived skill terms in the bundle (Archive, "Phase 8E", end of the CV matching notes). The model question is closed (A′: precomputed `bge-small-en` title vectors, Phase 8D).
6. **Phase 9, tenders from etenders.ge:** in progress (see the current-phase section). 9A acquisition, then 9B job-board reclassification and dedupe, then 9C tenders in Browse.
