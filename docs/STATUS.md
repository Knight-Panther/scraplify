# scraplify — implementation status

Last updated: 2026-09-04

Tracks progress against the phased plan in [`scraplify-concept.md`](./scraplify-concept.md) §25. Update this file in the same commit/PR as the work that changes its status — that keeps it honest (Codex reviews the status change alongside the code) instead of a self-reported log that can drift from reality.

Check an item only when it's actually true, not aspirationally.

## Current phase: Phase 1A — jobs.ge vertical slice

On branch `phase-1a-jobsge` off merged `main`. Milestone 1 (reconnaissance and fixture capture) is done — see `src/adapters/jobs-ge/RECON_NOTES.md` for the full findings and `src/policies/jobs-ge.ts` for the resulting policy/authorization update. Per §25: capture sanitized index/detail fixtures, implement VIP and standard discovery partitions, investigate filters/date ordering and define completeness, implement source-compliant HTTP fetching, store source listings/revisions/resources/attempts/crawl runs, implement incremental overlap and conservative closure logic, schedule local read-only runs.

Carries one requirement forward from Phase 0's adversarial review: `source_listing_revisions` has no DB-level uniqueness on `(sourceListingId, meaningfulContentHash)` (removed deliberately — see `src/db/schema/source-listings.ts`; a lifetime-unique index would reject a listing whose content legitimately reverts to an earlier hash). Retry-safe idempotency has to be enforced in the ingestion write path itself: `SELECT ... FOR UPDATE` the `source_listings` row, re-read its current revision's hash after acquiring the lock, insert a new revision only if the freshly fetched hash differs, then update `currentRevisionId` — all inside one transaction, proven by a concurrency test.

### Exit gate

- [x] Sanitized index and detail HTML fixtures captured (read-only reconnaissance per concept §25's skill-adoption note — no sign-in, upload, submit, or send against jobs.ge) — 5 real fixtures saved to `src/adapters/jobs-ge/fixtures/`: the browse page, its last paginated page, and 3 detail pages chosen to represent 3 distinct application-method structures found (mailto, inline external link in description text, direct external ATS link). Full recon writeup in `src/adapters/jobs-ge/RECON_NOTES.md`
- [ ] VIP and standard discovery partitions implemented — structure confirmed by recon (clean disjoint split, `.vipEntries` vs `#job_list_table`, zero ID overlap), not yet implemented in code
- [x] Filters/date ordering investigated; completeness defined and documented — confirmed via live recon (`src/adapters/jobs-ge/RECON_NOTES.md`): `#job_list_table` is itself date/ID-descending and VIP-independent, resolving concept §27's open question. Category/location filters are redundant for discovery (unfiltered page already covers both). Announcement-type filter (`jid`): project decision (2026-09-03) is to aggregate all types (vacancies/scholarships/trainings/tenders/other), not vacancies-only, matching the domain model's "Opportunity" naming — so `jid` is unused. Pagination bisected: 18 full pages of 300 + 1 partial page of 247 = 5,647 total current listings (site clamps out-of-range page numbers to the last real page rather than erroring)
- [x] Source-compliant HTTP fetching implemented (respects `src/policies/jobs-ge.ts`'s policy: allowed paths/query shape via `isJobsGeUrlAllowed`, rate limit, disallowed hosts) — `src/net/http-fetcher.ts`: GET-only, hand-rolled redirect loop (not undici's own redirect follower) so the caller's URL allow-list is re-checked before the initial request and before every redirect hop, per concept §16/§23.1's "reapply SSRF and policy checks after every redirect." Two independent SSRF enforcement points, since neither alone is sufficient: `src/net/ssrf-lookup.ts` hooks undici `Agent`'s `connect.lookup` to validate DNS-resolved addresses atomically with the real connection (closing the DNS-rebinding TOCTOU a separate pre-resolve step would leave open); `src/domain/ip-policy.ts` + a literal-IP-hostname pre-check in `http-fetcher.ts` cover the case DNS resolution never happens at all (Node's socket layer skips the `lookup` hook when the connection target is already an IP literal, confirmed empirically). Per-source pacing via `src/net/rate-limiter.ts` (concurrency + crawl-delay measured from the prior request's completion, not its start), injected rather than built internally so a future browser-based acquisition path for the same source can share its budget. Bounded redirects, per-request timeout, and response size. Not yet wired into an actual jobs.ge adapter or DB writes — that's the remaining exit-gate items below.
- [ ] Source listings, revisions, resources, fetch attempts, and crawl runs stored via `src/db/schema/`
- [ ] Incremental overlap and conservative closure logic implemented (an incomplete run cannot mass-close records)
- [ ] Local read-only runs scheduled
- [ ] Concurrency-safe revision write protocol implemented and tested (carried forward from Phase 0, see above)

**Exit gate condition (concept §25):** jobs.ge reruns idempotently; new, changed, unchanged, missing, expired, and failed states are correct; incomplete runs cannot mass-close records.

## Upcoming phases

Not started, listed in order:

- Phase 1B — hr.ge acquisition decision and adapter
- Phase 1C — cross-source reconciliation
- Phase 2 — normalization, taxonomy, deduplication
- Phase 3 — browse and shortlist
- Phase 4 — attachments and resource expansion
- Phase 5 — CV matching
- Phase 6 — outreach assistance
- Phase 7 — operations and supervised repair

## Completed

### Phase 0 — policy and domain foundation

Merged to `main` via PR #1 (`a45332f`). `/codex:adversarial-review --base main` ran once and returned 3 P1 findings, all fixed. A second confirming run was intended but skipped by explicit user decision after the Codex CLI hung unresponsively twice (`/codex:cancel` found no job to cancel both times); the last commits before merge landed via `--no-verify` instead, verified by hand against a real local Postgres instance (seeded legacy/invalid data, confirmed both the intended rejections and successes) plus the full local gate (format, lint, typecheck, test, build, clean install). CI ran green on GitHub for the first time on the pre-merge push.

Delivered: TypeScript/Node tooling scaffold (package.json, tsconfig, Biome, Vitest), CI (`.github/workflows/ci.yml`), domain contracts as Zod schemas (`src/domain/`), source-policy records for jobs.ge and hr.ge (`src/policies/`), threat model and approval boundaries doc (`docs/THREAT_MODEL.md`), Postgres + Drizzle migrations 0000-0006 (`docker-compose.yml`, `drizzle.config.ts`, `src/db/`) including a composite ownership FK on `source_listings.currentRevisionId` added after adversarial review.
