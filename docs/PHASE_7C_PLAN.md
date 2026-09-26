# Phase 7C: incremental crawling and data retention

Written 2026-09-26, to be built next session on branch `phase-7c-incremental-crawl`. The owner approved the direction. Every claim below was checked against the code and the live corpus on 2026-09-26; the evidence is noted inline so it can be re-checked instead of trusted.

## Goal

Cut every scheduled crawl from hours to minutes, and with it requests and CPU on the production host, without losing reliability: closure, expiry, reopening and the health guards must keep working exactly as now. Also stop the database from growing forever, without disturbing the comparison each run makes.

**Owner decisions:**
- A listing already scraped is not scraped again just because time has passed.
- There is no periodic full re-scrape. Users follow our link to jobs.ge or hr.ge, so an edit we miss is still correct at the source.
- Keep it simple. No overengineering.

## Today (measured)

- Each run walks every list page, then fetches **every** listed vacancy's detail page (`runJobsGeCrawl`, `runHrGeCrawl`: the `for (const listing of rotatedListings)` loop). A content hash then labels the result `new`, `changed` or `unchanged`.
- Politeness is the bottleneck, not CPU. jobs.ge waits 5 s between requests (its robots.txt `Crawl-delay`). hr.ge waits 3 s (`src/policies/hr-ge.ts`). The 2026-09-26 runs:
  - hr.ge took 3 h 52 min for 3,430 fetches;
  - jobs.ge was still running after 4 h 20 min and 3,016 fetches, at about 12 a minute.
- Raw HTML is **not** stored. `resources` holds metadata only, and the whole database is 78 MB, of which `source_listing_revisions` is 39 MB (13,318 rows, about 3 KB each).

## Stress-test findings that shaped the design

1. **List pages carry the change signal.**
   - A jobs.ge row (`#job_list_table tr`) has the title, the employer, and yearless published and deadline dates.
   - An hr.ge list record (`ng-state` announcement-search) has `title`, `customerName`, `publishDate`, `renewalDate`, `deadlineDate`, `locations` and `isPriority`.

   So we can decide from the list pages alone whether a detail fetch is needed.
2. **Most stored hr.ge "changes" are not edits.** Of 4,461 revision-to-revision changes:
   - 3,340 came from parser-version upgrades;
   - 4,436 touched `structured_attributes`, mostly `isPriority` flipping when a paid promotion ends (227 of a 400 sample) and `renewalDate` (86);
   - only 70 changed the description, 12 the salary and 25 the application method.

   `isPriority` is deliberately never shown (`web/lib/opportunity-detail.ts`), so it must **not** be part of the fingerprint, or every promotion ending would trigger a pointless re-fetch.
3. **Blind spot:** category edits (`specialty`/`industry`, 105 and 35 of that sample) and description-only edits don't appear on list pages. The owner accepts this, and the canary sample in §4 below measures it on every run.
4. **The guards would get weaker, not stricter.** `quarantineRate` and `fetchFailureRate` divide by `listings.size`, the number *discovered*. With about 300 fetches out of about 5,600 discovered, a parser break failing every detail page would show as about 5% and pass the 10% ceiling. The denominators must become "detail pages fetched".
5. **Expired listings flicker today.** An `expired` vacancy still on the list is re-fetched with `allowReopen: true`, reopened, then re-expired by `expireOverdueListings` in the same run. With skipping, an expired listing whose fingerprint (including its deadline) hasn't changed simply stays expired. That is more correct.
6. **Don't auto-refetch on a parser-version change.** The unchanged-hash path never updates the revision's `parser_version`, so a rule like "re-fetch when the parser version differs" would re-fetch the same listings on every run forever. After a parser change, run the crawl with `--refetch=all` instead (see the Runbook step below).
7. **Closure is untouched.** `closeMissingListingsInTransaction` needs only `run.status === 'completed' && run.fullCoverage`, and "seen this run" is `lastSeenAt`. `touchSourceListingSeen` already advances `lastSeenAt`, resets `missingStreak` and moves `missing_suspected` back to `active` without a detail fetch. It correctly never reopens `closed`, `expired` or `quarantined`.
8. **hr.ge sitemap-only candidates:** IDs found only through the sitemap cross-check (`toRecoveredListing`, about 2 per run) carry no list fields. Keep fetching them: the fetch is their existence check.

## Design

### 1. The fingerprint (one new column)

`source_listings.discovery_fingerprint text null`: a sha256 of the normalised list fields, computed in each adapter's discovery parser.

| Source | Fields | Excluded, and why |
| --- | --- | --- |
| jobs.ge | title, employer name, published text, deadline text (whitespace-collapsed) | VIP/standard partition (placement, not content); the "new" badge (time-dependent) |
| hr.ge | title, `customerName`, `publishDate`, `renewalDate`, `deadlineDate`, `locations` | `isPriority`, `listingSection` (placement); logo URL |

The fingerprint is written **only after a successful detail fetch and write** (outcome new, changed or unchanged). A failed or quarantined fetch leaves the old value in place, so the next run retries naturally.

### 2. When to fetch a detail page

Fetch when **any** of these is true, otherwise call `touchSourceListingSeen` only:

- no `source_listings` row exists (new ID);
- the row has no `current_revision_id` (status `discovered`: never fetched successfully);
- the status is `quarantined` or `closed` (reappeared: reopening needs a real fetch);
- `discovery_fingerprint` is null (see the bootstrap below) or differs from this run's;
- the listing is a sitemap-only candidate (hr.ge);
- the listing is in this run's canary sample.

Both adapters get one pure function, `needsDetailFetch(row, discovered)`, with its own unit tests. Everything after the decision reuses the existing, tested fetch and write path unchanged.

### 3. Modes

- `--refetch=changed` is the new default for scheduled runs. It is still a full list walk, so `fullCoverage=true` and closure applies.
- `--refetch=all` is today's behaviour, for parser upgrades or suspected drift. It is a manual command, not scheduled.
- The existing `--mode incremental` (bounded pages, never closes) stays as it is.

### 4. Canary sample (the quality guard)

Every `changed` run also re-fetches **20 random listings** that would otherwise be skipped. That costs about 100 s on jobs.ge and about 60 s on hr.ge. It gives:

- **parser health every run**, even on a day with few new listings;
- **a measured blind-spot rate:** the run logs `canaryChangedCount`, the number of canaries whose content changed although their fingerprint didn't. If that stays high, widen the fingerprint; don't add full scrapes.

### 5. Guards

- `quarantineRate` and `fetchFailureRate` are computed over **detail pages fetched**, with a minimum sample. Below 20 fetches, use an absolute cap of 3 quarantined or failed pages. The canaries guarantee at least 20.
- The whole-corpus guards stay unchanged, because they are about discovery, which is still full: the floor, the baseline ratio, the VIP and standard partitions, and hr.ge's `totalCount`.
- The crawl run records a new `skipped_count` beside `new`, `changed` and `unchanged`, so reports stay honest. It goes in the same migration.

### 6. Bootstrap (avoids one extra full crawl)

On the first `changed` run, a listing whose fingerprint is null but which is `active`, has a current revision, and whose revision's `provenance_fetched_at` is within the last 7 days **adopts** the fingerprint without a fetch. Everything else is fetched once. Right after the 2026-09-26 full crawls, that makes even the first run cheap.

### 7. Expected effect (an estimate; the first week of runs verifies it)

| Source | New per day (estimate) | Fetches per run | Run time |
| --- | --- | --- | --- |
| jobs.ge | ≤ 270 (IDs 750,025 → 756,217 between 2026-09-03 and 2026-09-26) | about 19 list + 270 + about 30 fingerprint changes + 20 canaries | about 28 min (was 4–8 h) |
| hr.ge | about 170 (1,710 new after a 10-day gap) | about 34 list + 170 + about 50 renewals and deadline changes + 20 canaries | about 14 min (was about 4 h) |

That is about 90–95% fewer requests. With runs this short, twice a day is possible, which means fresher listings for the same load. Changing the schedule is a separate decision.

## Retention (the owner's question: don't keep dead vacancies forever)

**Principle: the comparison never reads dead rows.** Each run looks up only the IDs it discovers, through the unique index `(source_id, source_record_id)`. Closure and expiry filter to open statuses. So old rows cost disk space, not comparison speed or correctness. Retention is about size, not accuracy.

**Growth at the smart-crawl rate:** about 450 new listings a day, times about 3 KB per revision, is roughly 0.5 GB a year of revisions plus indexes. That's manageable, but not something to leave unbounded. `fetch_attempts` drops from about 7,000 to about 650 rows per run.

**Policy.** One `npm run retention` job, dry-run by default, run weekly as a pipeline step after the crawl:

| Data | Rule | Why this is safe |
| --- | --- | --- |
| `fetch_attempts`, orphaned `resources` | delete when older than 90 days | Operations telemetry only; `crawl_runs` (tiny) keeps the per-run totals forever. |
| Revisions of listings `closed` or `expired` for more than 180 days | keep only the current revision, and blank its `description` | Keeps the row and its ID, so a vacancy that reappears is still recognised as known and gets a real fetch through the `closed` rule. |
| `closed` or `expired` listings older than 2 years | delete the listing, its revisions, memberships and classifications | Not if any user data references its opportunity: `opportunity_decisions` (saved or dismissed), `rankings`, `outreach_drafts`. Those are kept. |

**Constraints found:**
- No foreign key has `ON DELETE CASCADE`, so the job deletes children first, in one transaction per batch. That is deliberate: no silent cascades.
- If an ID purged after 2 years reappears, it becomes "new" and is fetched. That's correct.
- jobs.ge and hr.ge IDs are monotonic and not reused.

**Indexes to add in the same migration:**
- a partial index on `source_listings (source_id) where status in (open statuses)`, for closure and expiry once the dead rows outnumber the live ones;
- an index on `fetch_attempts (attempted_at)`, for the retention delete and the health queries.

## Build order (each step tested before the next)

1. Migration:
   - `source_listings.discovery_fingerprint`;
   - `crawl_runs.skipped_count`;
   - the two indexes.

   Run `migration-safety-reviewer` on it, then apply it to `scraplify_qa` first. **Show the owner before applying it to the real `scraplify`.**
2. Fingerprints in both discovery parsers, with fixture tests against the committed `ads-page-1.html` and `search-posting-pg1.html`: stable across runs, changes when a field changes, ignores priority and partition.
3. `needsDetailFetch` plus the bootstrap rule, with a unit test for each case in §2.
4. Wire it into both crawls; switch the guard denominators to fetched pages; add the canary sample and `skipped_count`. Extend `crawl.test.ts`:
   - a second run over the same fixtures fetches only the canaries;
   - a changed deadline triggers a fetch;
   - a disappearing listing still reaches `missing_suspected` and then `closed`;
   - an injected parse failure still makes the run `partial`.
5. CLI: `--refetch=changed|all`; the scheduled scripts (`scripts/run-crawl.ps1`, `deploy/run-pipeline.sh`) use the default.
6. Retention job with dry-run output, tested on `scraplify_qa` with synthetic aged rows, including a user-referenced listing that must survive.
7. Live check: one real `changed` run per source. Record its time, fetches, skipped count and `canaryChangedCount` in `docs/STATUS.md`.
8. Runbook: `--refetch=all` after any parser change; the retention schedule.

## Out of scope

- Periodic full re-scrapes.
- `ETag`/`If-Modified-Since` handling.
- Early exit from the list walk (closure needs the full walk).
- Adaptive overlap windows (concept §10.1 stays deferred).
- Batching `touchSourceListingSeen` into one `UPDATE`: about 5,000 small transactions take about 25 s, so batch only if it measures slow.
