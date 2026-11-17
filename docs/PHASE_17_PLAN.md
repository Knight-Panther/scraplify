# Phase 17 plan: permanent market history (jobs, tenders, real estate)

Approved by the owner 2026-11-17. Copied from the plan-mode file; this repo copy is the one kept current.

## Tracker

As of 2026-11-17, 18:00 Tbilisi (14:00 UTC).

- **Done and live:** 17.0, and since 17:39 Tbilisi (13:39 UTC) 17A, 17C, 17D and 17F, deployed together as `7465066`.
- **Done:** the recon (2026-11-17, merged as `ff81691`, PR #126).
- **Left to build:** 17B and 17G next, then 17E (last).
- **Only on the owner's go:** the multimodal phase.

| Mark | Item | Waits on | Next |
|---|---|---|---|
| ✅ | **17.0** Keep job and tender history: retention tiers 2 and 3 off for good. Live since 2026-11-17 10:00 UTC (`8a37a49`, PR #118) | — | the 16:10 UTC pipelines' retention: `listingsTrimmed` 0 |
| ✅ | **17A** Real estate: listing versions, show spells, group days, run quality, the archive's private table. Merged as `bc127c7` (PR #119), migration `0057`. **Live since 2026-11-17 13:39 UTC** as `7465066`; the backfill opened 409,218 versions, 296,579 spells and 126,780 group days in 28 s (197 MB) | — | the 21:30 UTC ss.ge run is the first to record history itself: `history_steps` ok next morning |
| ✅ | **17C** Jobs and tenders: status events, tender outcome re-reads. Merged as `5b22e43` (PR #120), migration `0058`. **Live since 2026-11-17 13:39 UTC**; the backfill wrote 28,689 status events in 1 s | — | after the 16:10 UTC pipelines, etenders.ge's log shows `outcomeRereadsDue` |
| ✅ | **17D** NBG exchange rates: `fx_rates`, `fx:sync`, a pipeline step; Browse converts at NBG's latest day. Merged as `31f5bf6` (PR #121), migration `0059`. **Live since 2026-11-17 13:39 UTC**: the back-fill's first request failed once (`fetch failed`; NBG answered curl and Node at once after), a second run stored 2026-01-01 to 11-18, 13,524 rows, 42 currencies, no day missing (USD 2.5928) | — | each pipeline's rates step; later, an alert when the newest rate is over 3 days old (owner's question 2026-11-17: no Google fallback, a day-old official rate is better) |
| ✅ | **17F** Monthly history export to R2 with a restore drill; each year's first copy kept. Merged as `fc3763b`, `99e1f6a`, `25e8a56` (PRs #123 to #125); R2 rules set 2026-11-17. **Switched on 2026-11-17 13:47 UTC**: the first export (76 MB) is in `history/` and kept as 2026's copy in `yearly/`, fetched back with the same sha256, and **drilled on the PC: 11 tables, 966,684 rows, every count equal, 16 s**. Timer next 2026-12-01 10:00 UTC | — | the 12-01 export; the drill quarterly |
| ✅ | **Recon** (shapes only): run twice on the host 2026-11-17 after the deploy, 14 requests, all 200; findings in `src/adapters/ss-ge/RECON_NOTES.md` ("Posters and photos"), merged as `ff81691` (PR #126). `userId` (GUID) on every results row; contact name, an unmasked phone and `userEntityType` on the listing page; **the profile page carries no data in its page props**; photos carry `fileName`, `fileNameThumb`, `isMain`, `is360`, `orderNo`, `imageType` | — | — |
| ❌ | **17B** Private poster directory (`realestate_contacts`): zero-request sources and identity. Changed: no profile reads (the recon found the profile page empty as the crawler reads it); the row's `userId` and the listing page's contacts are the sources | — | next |
| ❌ | **17G** Photo references only (no image fetched or saved): `fileName` path, `orderNo`, `isMain` from rows and listing pages | — | with 17B |
| ❌ | **17E** One statistics builder, `scraplify_stats` role, Hermes; also `job_lives` (moved from 17C) | 17A to 17D live, with a few nights of data | last |
| ❌ | Multimodal phase (fetch and fingerprint photos) | the owner's go | — |

## Built so far: details and changes

Each item as built, with its trials and the "Changed:" notes on where building departed from the plan below.

### 17.0
**17.0** Keep job and tender history: retention tiers 2 and 3 off for good (`RETENTION_POLICY.keepListingHistory`), concept §6.1 amended. Merged as `8a37a49` (PR #118); **live since 2026-11-17 10:00 UTC**, code only, deployed while the ss.ge run went on from its own release (no prune until it ends). Retention dry run with the new code on the host: tier 2 and tier 3 all 0; both sites ready, health check ok, probe ok

### 17A
**17A** Real estate: versions, show spells, run quality, fuller archive. **Merged 2026-11-17 as `bc127c7`** (PR #119, CI green), migration `0057`; deploy after the ss.ge run (migration, grants, release, then `history:ss-ge` once). Full suite on a throwaway Postgres: 2,918 passed, 9 skipped. Local corpus (133,229 rows): the backfill opened 133,229 approximate versions (63 MB) and 28,042 group days in 1.8 s, and a second run wrote nothing (1.2 s). Spells were tried at three past instants in a rolled-back transaction: 123,522, 96,520 and 64,884 on show, equal to C1's count each time, at about 1.4 s a step. **Changed:** (1) built before the recon, since it needs no new ss.ge field; (2) the private part is its own table, `realestate_archive.listing_private` (pin, `pin_manual`, the whole description, the cadastral code as is, not a salted hash), so no public grant reaches it; (3) `run_quality` is a view over `realestate.crawl_runs` with `history_ok`, plus a `history_steps` log; (4) the last `group_key` is kept as `listing_group_days` (listing × group, first and last Tbilisi day, nights), not as an archive column; (5) `building_key` stays out of versions, like the other derived location columns; (6) the "rebuilt day matches `daily_totals`" property holds for which listings were on show. It does not hold for the medians: versions keep the converted price as of their opening, and neither `price_per_m2_*` nor `source_updated_at` (which picks a group's leader). That is 17D's and 17E's to settle; (7) `npm run health:check` warns after two failed steps in a row; (8) `history:ss-ge` was added, and `totals:ss-ge` records the history first at the same instant

### 17C
**17C** **Merged 2026-11-17 as `5b22e43`** (PR #120, CI green); deploy together with 17A (migrations 0057, 0058; grants; `history:ss-ge` and `status-events:backfill` once). Jobs and tenders: status events and tender outcomes. Migration `0058`: `source_listing_status_events` (from and to status, at, crawl run, `approximate`, reason; index on listing and time; at most one first event per listing). Every writer of `source_listings.status` adds its event in the same statement or transaction, and only on a real change: the observation writers (first seen, activated, seen again, reopened, quarantined), reconciliation's missing, closed and expired passes, etenders.ge's source-status and not-found closes, and the course expiry. The bulk ones are set-based (one `UPDATE … FROM (SELECT … FOR UPDATE) RETURNING` CTE, `changeStatusWhere`). Backfill `npm run status-events:backfill`: on the local corpus 29,311 approximate first events in 0.24 s (16,626 expired, 7,863 active, 4,596 closed, 155 quarantined, 71 missing), equal to the listing counts by source and status; a second run wrote 0. Tender outcomes: each etenders.ge run re-reads up to 40 expired tenders whose last status is not 4, 5 or 99, oldest deadline first, each at most every 3 days, for 90 days after the deadline; a terminal status is stored as a new revision and never reopens the tender. 0 due locally: the local corpus has no etenders.ge rows. Full suite on a throwaway Postgres: 2,937 passed, 2 skipped. **Changed:** (1) `job_lives` moved to 17E, with the other statistics views; (2) the backfill is a one-shot CLI, not part of the migration. It also covers `discovered` (at first seen) and `quarantined` (at last seen), so every listing has a first event. A listing that changed after the release gets the status it had before, dated no later than that change; (3) a re-read page that cannot be parsed leaves the tender expired, with a parser incident, instead of quarantining it; (4) the re-read's counts are the run log's `outcome*` stats and touch neither the run's counts nor its guards; (5) the worker gets SELECT and INSERT only, so retention's tier 3 (off since 17.0) would fail under it rather than delete a timeline. No admin grant, and `apply-db-roles.sh` stops if `scraplify_public` can read the table; (6) the plan's "terminal outcome read in a local trial" is covered by fixture tests, since no live crawl was run and the local corpus has no tenders

### 17D
**17D** Exchange rates (NBG). **Merged 2026-11-17 as `31f5bf6`** (PR #121, CI green): migration `0059` adds `public.fx_rates`, one row per currency and calendar day with the rate NBG has in force that day (`valid_from` is the day it took effect, `gel_per_unit` = rate ÷ quantity). `npm run fx:sync` (`src/fx/sync.ts`) fills every day from the last stored one (or 2026-01-01) to tomorrow, one request a second; tomorrow only once NBG has set it (about 17:00 Tbilisi). Each job pipeline ends with an `exchange rates` step that never changes its exit code. Worker SELECT and INSERT, public SELECT. Live trial against NBG into the throwaway database: 2026-11-01 to 11-17 in 18 requests, 714 rows (42 currencies), Saturday 11-14's USD 2.5934 held on Sunday and Monday as NBG states, tomorrow held back, and a second run stored nothing. The host reaches NBG (200 in 0.6 s). Full suite: 2,950 passed, 9 skipped. **Changed:** (1) a row per calendar day rather than per rate change, so a missing day is a visible gap, not a carry-forward to guess; (2) Browse groups other currencies at the latest stored NBG day (owner, 2026-11-17: use the official rate by default): `loadReferenceRates` reads it with each index rebuild, the unit note names that day (checked in a browser at 1280 and 390: "rates of 2026-11-17"), and the committed table is only the fallback while `fx_rates` is empty. So the public and admin roles read `fx_rates` too; (3) no own timer: the pipelines already run daily, and a missed day is caught up by the next one

### 17F
**17F** Durability: monthly history export to R2. **Merged 2026-11-17 as `fc3763b`** (PR #123, CI green): `deploy/export-history.sh` with the `xtelo-history-export` timer (the 1st, 10:00 UTC) dumps the `realestate_archive` schema, `source_listing_revisions`, `source_listing_status_events` and `fx_rates` whole (zstd 9, `--strict-names`), with a `.counts` file (rows before and after), and copies both to `HISTORY_REMOTE` with `--immutable`. It deletes nothing off the host and only warns above 1.5 GB. `scripts/restore-history-drill.sh` restores an export, data only, into a freshly migrated throwaway database and checks every count. Local trial on the corpus: 36 MB, 11 tables, then the drill restored 227,850 rows in 9 s, all counts equal; with a wrong count it fails. 8 script tests with stand-in tools. **Changed:** (1) the archive stays in the nightly dump for now: it is 18 MB on the host, and leaving it out would leave up to a month of history with no off-host copy. It moves out once it passes about 250 MB (Board, archive size check); (2) the bucket's 30-day rule covered the whole bucket (checked 2026-11-17). With the owner's go it was scoped to `xtelo/` the same day; `history/` got a 395-day rule and a 365-day lock, and `yearly/` no expiry and a 365-day lock, not an indefinite one, since the exports hold private poster data that must stay erasable (RUNBOOK §6); (3) each year's first export is also kept for good in `yearly/` (owner, 2026-11-17), since each export holds the whole history

## Context

The owner wants every job, tender and real-estate listing remembered for good, so that any statistic can be built later, at any granularity, possibly for sale. Examples: "median price of 2-room flats in Vake in March 2027" and "average $/m² of commercial land in Kaklebi".

Changes made before a listing ends must be remembered. Listings removed early must not be lost. Hermes must always tell live listings apart from history, and must answer "over the last X months, including current listings" by one rule.

This plan comes from three read-only code surveys, measurements on the host (2026-11-17), and an independent Fable review whose P0 and P1 findings are folded in.

**Owner decisions (2026-11-17):**
1. Keep all job and tender data permanently. Retention's 60- and 180-day deletions go off for good.
2. The real-estate archive keeps coordinates and descriptions (private, never shown on the site).
3. **Build a private directory of ss.ge posters** (17B below), as the owner showed with the "ნინი" profile, which has 36 listings, a phone and an email:
   - keep each poster's ss.ge account id, display name, every phone number and email seen, and their listings over time;
   - identify a person or agency by phone first, then by email, allowing several of each, mixed over time;
   - measure size (active listings over time), to tell owners, individual brokers and agencies apart;
   - purpose: statistics and the owner's own later use;
   - **never shown on jobster.fun, never readable by the public role.**
   - This replaces the project's earlier rule that phones, names and user ids are "never read" (`src/adapters/ss-ge/RECON_NOTES.md:23`).
4. **Lay the preconditions for photo-based repost "genesis" analysis. No image is fetched or saved now** (17G below; owner, 2026-11-17).
   - Agencies copy an owner's listing and repost it 10-15 times, and the original sinks.
   - A later phase, started only on the owner's go, may use image models (Gemma, SigLIP, CLIP) to find which photos appeared first, under whom, and who reposted them.
   - **Now:** only each listing's photo *references* (ss.ge's image ids or links, their order, and when the set changed) are kept, from data already read, at zero extra requests. They are linked to the listing, the poster and the time.
   - "No photo is fetched, stored or shown" (`src/policies/ss-ge.ts`) stays true; the policy only gains "references are kept privately".

## Order of work
1. **17.0** this week: stop the job deletions before 2026-11-27.
2. **Recon:** about ten requests to ss.ge, covering poster fields and photo fields.
3. **Zero-request capture, started at once:**
   - 17A (versions, show spells, a fuller archive);
   - 17B's free sources (the poster id on results rows, phones in descriptions);
   - 17G (photo references only).
4. **17F durability**, so the new private data has an off-host copy.
5. **17B profile reads and identity.**
6. **17C** jobs status events and tender outcomes.
7. **17D** exchange rates.
8. **17E** statistics builder, `scraplify_stats` role, Hermes.
9. **Only on the owner's go, later:** the multimodal phase (fetching and fingerprinting photos, thumbnails, embeddings, genesis views, the separate real-estate page).

## What happens today (findings)

**Real estate, kept but lossy**
- The live table keeps only each listing's current state. Every field except the posted-currency price is overwritten on change (`src/realestate/ingest.ts:450-467`, `details.ts:78-128`).
- A listing that leaves gets `status='gone'` and a `gone_reason` (expired, inactive, missing or lapsed).
- **Early removals do reach the archive.** 22,990 of the 62,943 gone rows left before their expected end.
- 14 days after it is gone, `deleteLongGoneListings` (`expiry.ts:384-415`) moves a slim copy to `realestate_archive.listings`, with its price changes. 13,259 rows so far.
- The archive drops the description, coordinates, `expected_end_at`, `verified_at` and the repost `group_key`.
- "What was on show each day" exists only in `daily_totals`:
  - it cannot be rebuilt;
  - cells under 5 listings are dropped;
  - it has no land or commercial sub-type split.
- Reposts are merged only among currently active rows, and never for land: `blockOf` needs rooms and floors (`grouping.ts:83-98`).
- There is no exchange-rate table; the GEL/USD conversion is ss.ge's own daily one.
- **ss.ge has no place called Kaklebi**, only "კაკლების ქ." (Kaklebi Street) in sub-district 44. Coordinates come only from detail pages, read for about 19% of flats.

**Jobs and tenders, fully versioned but deleted**
- `source_listing_revisions` is append-only and written at observation time (`src/db/write-source-listing-revision.ts`).
- Retention (`src/retention/policy.ts`) removes the history:
  - at 60 days dead it deletes old revisions and their classifications, and blanks the description;
  - at 180 days it purges whole clusters.
  - Nothing is copied first. **The first trims land about 2026-11-27.**
- There are no status timestamps. `closed` is recoverable as `greatest(last_seen_at, last_reconciled_at)`; `expired`, `missing_suspected` and reopen times are not recorded.
- Tenders already marked expired at the bid deadline are never re-read for their outcome (`etenders-ge/crawl.ts:312-328`).

**Hermes**
- Reads as `scraplify_public`, the website's role, which can read the archive. It runs scraplify's compiled C1 builder through `realestate_bridge.mjs`.
- Has no history command. Its skill says the archive is empty and tells it to refuse trends.
- Its example SQL uses a different "live" rule from C1's on-show rule (`src/realestate/filters.ts:521`).

## Design

**Core idea.** Live tables serve the site. Permanent history is captured by:
- **(a) jobs:** keeping the immutable revisions that already exist, plus status events;
- **(b) real estate:** one nightly set-based step that records attribute versions and on-show spells by the site's own rule.

Statistics are built from that history through **one rules implementation**, the TypeScript C1 builder extended with as-of and window inputs, which the site, the daily totals and Hermes already share.

### 17.0 Stop the loss now (this week, before 2026-11-27)
- In `src/retention/policy.ts`/`run-retention.ts`, switch tiers 2 (trim) and 3 (purge) off permanently for job and tender sources. Tier 1 telemetry stays.
- Add a test asserting that tiers 2 and 3 are off.
- Amend `docs/scraplify-concept.md` §6.1 (the owner-approved exception) to say job and tender history is kept permanently.
- Measure `run-dedupe` duration and storage growth weekly, to check that keeping dead rows does not slow the whole-corpus pass. If it does, filter dead clusters out of candidate blocking rather than deleting them.

### 17A Real estate: versions, show spells, a fuller archive
New tables in `realestate_archive` (`src/db/schema/real-estate-archive.ts`):
- **`listing_versions`** (`listing_id`, `valid_from`, `valid_to`, plus the statistics fields):
  - deal, kind, `commercial_type`/`land_type`, rooms, bedrooms, area, floor, total floors, floor low/high;
  - posted amount and currency;
  - city, district, sub-district and municipality refs and names, street ref, house number;
  - condition, building status, poster type, `building_key`, status;
  - `similarity_group` (ss.ge's look-alike leader) and `promoted` (who pays to stay on top), both needed for repost genesis.
  - **The change hash covers raw fields and the posted price only.** Converted prices and nightly-derived location columns are outside it (the review's P0-1). Derived location stays the latest value on the listing, with `location_rules`.
- **`show_spells`** (`listing_id`, `shown_from`, `shown_until`, `group_key`): only the on/off transitions of C1's on-show predicate. They are evaluated with the same `now` that `takeDailyTotals` uses (`src/realestate/totals.ts:83-85`), so a rebuilt day matches `daily_totals` by construction.
- **`run_quality`:** one row per night, taken from `realestate.crawl_runs`. A partial or failed night is flagged so it never reads as a market move.

**One nightly step** in `src/cli/run-ss-ge-crawl.ts`, after `regroupListings` and before `takeDailyTotals`. A set-based diff of live rows against their open version and open spell does the inserting and closing. There are no hooks in the five writers, it needs no new column on the 1.16 GB table, and it heals itself after a failed night. Alert through the poll script if it fails two nights running: the hard limit is `GONE_RETENTION_DAYS = 14`.

**Archive additions:** the copy in `deleteLongGoneListings` gains:
- `latitude`, `longitude`;
- `description` (contacts in it are captured by 17B, not stripped);
- `expected_end_at`, `verified_at`;
- the last `group_key`, recorded by the nightly step while the row is still active;
- the earliest `source_created_at` seen;
- a salted hash of `cadastral_code` as a property identity (the review's P1-2).

**Backfill:**
- Each live row gets a first version, `valid_from = first_seen_at`, flagged as approximate.
- Show spells start on the deploy night. Earlier days remain covered by `daily_totals` only.

### 17B Real estate: private poster directory (ss.ge)
Data only accumulates from the day it starts, so this follows 17A immediately.

**1. Recon** (a handful of requests through the host's crawler path; findings go in `RECON_NOTES.md` with no real numbers in them). Find where each field lives:
- the poster's `userId` on **results rows** (every listing, every night, so no extra requests) versus only on the listing page;
- `applicationPhones`, `contactPerson` and `userInfo.name` on the listing page;
- the profile page `userlist?userId=…` (name, phone, email, every active listing of that account, as in the owner's screenshot).

This sets the cost:
- if results rows carry `userId`, every listing gets its poster for free;
- phones come from listing pages (about 20% read today) and from profile pages, which cost one request per account.

**2. Capture:**
- The ss.ge list and detail parsers (`src/adapters/ss-ge/list.ts`, `detail.ts`) also return the poster block.
- A new, budgeted step reads the profile page of each **new** account, and of known accounts every few weeks, busiest first. It sits inside the ss.ge run's request box, behind the checks and details, as the crawl's other steps do.

**3. Storage: a separate schema `realestate_contacts`**, so grants can keep it from every public path:
- `poster_accounts`: ss.ge `userId` as the key, display name, user type and entity type, profile listing count, first and last seen.
- `contacts`: kind (phone or email); normalised value (phones in +995 form, emails lower-cased); first and last seen.
- `account_contacts`: account × contact, first and last seen, and where it was seen (listing page, profile page, description).
- `listing_posters`: source listing key × account, with first and last seen. Keyed by `(source_id, source_listing_key)`, so the link survives archiving and a key's several lives.
- `listing_contacts`: listing key × contact × the contact name shown. One agency account shows different agents' phones on different listings, so contacts per account alone would lose who posted what.

**Contact sources, cheapest first:**
- **Phones typed into descriptions.** Free: every results row carries the description, and `PHONE_RE` (`src/adapters/ss-ge/list.ts:177`) already finds them. Back-filled from the live rows straight away.
- **The results row's poster id**, if recon confirms it.
- **Listing pages already being read:** `applicationPhones`, `contactPerson`, `userId`.
- ~~**Budgeted profile reads.**~~ Changed 2026-11-17: dropped, the recon found the profile page's page data empty, and the sources above already name the account. If a phone ever comes masked, a masked number ("598 90 99 **") is stored as a weak key that never merges anything on its own.

**4. Identity: `poster_entities`.** Accounts are joined into one person or agency when they share a phone number (the strongest proof) or an email (also strong, as the owner set). This is a union-find over the account–contact graph, recomputed nightly under a rule version. Entity ids stay stable, the way group keys do.
- Guards against false merges:
  - edges keep first and last seen;
  - a contact used by too many accounts (an office, a portal, a call centre) is capped and flagged, not merged;
  - entities are a versioned derived layer;
  - a manual split and merge override table handles recycled numbers and agents who change agency.
- A **same-account relist** (delete and repost for a fresh posting date) is told apart from a **cross-account copy**.
- **Profile pages** (`/ka/udzravi-qoneba/userlist?userId=…`) need a new pinned URL shape in `isSsGeUrlAllowed`. They are read only for accounts with 5 or more listings or with no contact yet, capped at about 300 a night (about 20 minutes, like `PLACE_POINT_READS_PER_RUN`).
- The fixtures test (`src/adapters/ss-ge/fixtures.test.ts`) changes to allow reserved fake values only. `scripts/capture-ss-ge-fixture.mjs` still drops real ones.

**5. Size over time: `poster_daily`** (entity × day: listings on show, new listings, distinct properties).
- It feeds a versioned classification: owner, individual broker, agency or developer. ss.ge's own `userType` and `userEntityType` are evidence alongside it.
- It gives the statistics an "owners only" filter.

**6. Access:**
- `realestate_contacts` is granted to the worker (write) and to `scraplify_stats` (the owner's Hermes) only. **Never** to `scraplify_public`, never in a public view, never in Browse, Real estate or the site's API.
- The public repo stays free of real contacts: the fixtures test (`src/adapters/ss-ge/fixtures.test.ts`) still scrubs samples, and tests use invented numbers.

**7. Kept permanently**, with last-seen dates showing which contacts are stale.

### 17C Jobs and tenders: status events and outcomes
- **New table `source_listing_status_events`** (listing, from, to, at, crawl run), written where status changes:
  - `write-source-listing-revision.ts` (reopen and activation);
  - `reconcile-source-listings.ts` (missing, closed, expired);
  - etenders `closeOnSourceStatus`;
  - quarantine.
- **Backfill:** `closed` at `greatest(last_seen_at, last_reconciled_at)`; `expired` at the deadline (flagged as approximate).
- **Tender outcomes:** re-read tenders expired at their bid deadline until the status is terminal (4, 5 or 99) or 90 days have passed. Fix the `crawl.ts:312-328` path.
- **`stats.job_lives` view:** one row per listing, derived (never copied) from listings, the current and first revisions, classifications (stated or guessed field and city) and memberships (cluster, cross-posts). It carries open and shown spells from the status events.

### 17D Exchange rates
- **`fx_rates`:** the National Bank of Georgia's official daily USD and EUR → GEL rates, back-filled from its public API and fetched in the nightly pipeline. It replaces the fixed table in `src/browse/reference-rates.ts`.
- **Rule:** the posted amount and currency are the truth. Any conversion uses **the rate of the day each listing's value is taken as of**. ss.ge's own conversion is kept but never mixed in.

### 17E One statistics implementation, a stats role, and Hermes
- **Extend the C1 builder** (`src/realestate/filters.ts`) with `asOf` (a day) and `window` (from, to) inputs over `show_spells` + `listing_versions` + the archive. A matching jobs builder works over `stats.job_lives`.
- **Period semantics:**
  - A listing counts if a spell overlaps the window.
  - Its attributes and price are taken from the version valid on its last shown day inside the window.
  - Reposts are merged by group key; for land and commercial, also by the cadastral property hash.
  - Implausible rows and bad-run days are excluded.
- **Outputs, every time:**
  - n, mean, median, p25 and p75;
  - for per-m², both the median of ratios and total price ÷ total area;
  - n live vs n history;
  - flagged days.
- **Place resolution** goes through C6 (`realestate/place-lookup`). Areas ss.ge doesn't name use a polygon over archived coordinates, and report how many listings had a point.
- **Role `scraplify_stats`**, staged: create it with read access to the public views, both archives and the stats views; move Hermes and verify; only then revoke the archive from `scraplify_public` (`scripts/sql/phase-8b-*.sql`, `deploy/apply-db-roles.sh`).
- **Hermes repo:**
  - a history command calling the builder through the bridge;
  - an updated skill: live means C1's on-show now; history means spells, versions and the archive; how period questions work; always report n and the live/history split; the stale "archive empty" text removed; `daily_totals` documented as the published-figure audit;
  - tests with live-only, history-only and mixed questions.
- **Indexes, added only where `EXPLAIN` shows a need:**
  - archive: `(deal_type, property_type, city_ref, district_ref, subdistrict_ref)` and `(gone_at)`;
  - `listing_versions (listing_id, valid_from)`;
  - `show_spells (shown_from, shown_until)`;
  - status events: `(source_listing_id, at)`.

### 17F Durability (runs alongside 17A)
- A monthly immutable export of the history tables and job revisions (zstd) to R2, under a prefix **without** the 30-day lifecycle.
- The archive is split out of the nightly dump, as Board row 46 planned.
- Budget the R2 free 10 GB, which Hermes' backups share.
- A restore drill into a throwaway database each quarter.

### 17G Photo references only (private schema `realestate_media`): the precondition for later image analysis
**Recon** (inside the same ~10 requests): today's fixtures keep only `imageCount` (`scripts/capture-ss-ge-fixture.mjs` allow-list). Find:
- the image array on results rows and on listing pages, with its field names;
- whether entries carry a stable image id, a CDN path (perhaps `static.ss.ge/<date>/<guid>.jpg`) and an upload date in the path;
- whether a cover or main flag exists.

**Capture now, zero extra requests.** The results-row parser (`src/adapters/ss-ge/list.ts`), and the listing-page parser when a page is read anyway, return the ordered references. They are stored as:
- `listing_photo_refs` (`source_id`, `source_listing_key`, `valid_from`, `valid_to`, `refs text[]`, `set_hash`): one row per change of a listing's set.
  - Keyed by the ss.ge listing key, so it survives archiving and a key's several lives.
  - Written by 17A's nightly step; an unchanged set writes nothing.
- `photo_refs` (`ref` unique, `first_seen_at`, the upload day if the path has one): one row per distinct reference. The same file reused across listings and posters is visible already, as an exact match.

**What this enables later**, when the owner gives the go for the multimodal phase:
- fetching and fingerprinting (pHash, embeddings) can start from these references for every listing still live;
- the genesis chain of reference → listing (ordered by `source_created_at`, the first posting time) → `listing_posters` → `poster_entities` is in place from day one.

**Accepted limit:** photos of listings deleted before that phase are not kept.

**Size:** about 0.5 KB per listing set change, roughly 2 GB a year at most. Kept out of the nightly dump and exported monthly under 17F.

**Not now:**
- downloading any image;
- hashes and thumbnails;
- storing images in R2;
- an image request lane;
- any proxy change.

### Deferred (the review's P2: add only when measured)
Place snapshots (versions already store refs and names), partitioning, materialised roll-ups and quantile sketches, BRIN indexes, a salary parser for jobs.ge text, filling `organizations`, more refetch canaries, and a jobs daily-totals table.

## The owner's examples under this plan
- **Median price of 2-room flats in Vake, March 2027:** C6 resolves "Vake" (ss.ge sub-district 47, today 933 on show, median $170k raw). Spells overlapping March, the version on each listing's last March day, `flat`, `rooms=2`, deal sale, reposts merged, implausible rows out. The result reports n and the live/history split.
- **Average $/m² of commercial land in Kaklebi:** `land` with `land_type=3` (409 on show nationwide). Kaklebi is drawn as a polygon over archived coordinates, because ss.ge does not name it. Listings are merged by cadastral hash. The answer gives both the mean of ratios and total÷total, plus how many had a point; expect a small n.

## Critical files
- `src/retention/policy.ts`, `run-retention.ts`, `docs/scraplify-concept.md` §6.1
- `src/db/schema/real-estate-archive.ts`, `src/realestate/expiry.ts`, `src/cli/run-ss-ge-crawl.ts`, `src/realestate/totals.ts`, `src/realestate/filters.ts`, `src/realestate/grouping.ts`
- `src/adapters/ss-ge/list.ts`, `detail.ts`, `RECON_NOTES.md`, `fixtures.test.ts`, plus the new `realestate_contacts` schema
- `src/policies/ss-ge.ts` (version 3: the profile-page URL shape; photo references kept privately), `scripts/capture-ss-ge-fixture.mjs`, plus the new `realestate_media` schema
- `src/db/write-source-listing-revision.ts`, `src/db/reconcile-source-listings.ts`, `src/adapters/etenders-ge/crawl.ts`
- `src/browse/reference-rates.ts`, `scripts/sql/phase-8b-*.sql`, `deploy/apply-db-roles.sh`, `deploy/backup-db.sh`
- Hermes: `workflows/integrations/xtelo.py`, `realestate.py`, `realestate_bridge.mjs`, `.hermes/skills/xtelo/`
- Tracking: `docs/PHASE_17_PLAN.md` (this plan, copied on approval), the STATUS Board

## Verification
- **17.0:** a test that tiers 2 and 3 never touch job sources. On the host, the retention log shows `listingsTrimmed: 0` after 11-27, and revision counts only grow.
- **17A:** tests on a throwaway database:
  - a raw-field change gives one version;
  - a conversion-only change gives none;
  - hide → show → hide gives two spells;
  - a failed night heals the next night;
  - archiving keeps coordinates, the description and the cadastral hash.
  - **Rebuild test:** recompute 7 days of `daily_totals` from spells and versions; they must match exactly.
- **17B:**
  - parser tests on invented numbers: results-row and listing-page poster blocks, profile page;
  - identity tests: shared phone → one entity; shared email → one entity; a contact shared by too many accounts is flagged, not merged; entity ids stay stable;
  - a grant test: `scraplify_public` cannot read `realestate_contacts`, and no public view exposes it;
  - the recon notes record each field's coverage and request cost.
- **17C:** status-event tests on every writer; backfill counts reconcile; a terminal outcome is read for an expired tender in a local trial.
- **17D:** rates for 2026-01-01 to today without gaps (weekends carried forward); the conversion tests use the as-of day.
- **17E:**
  - the builder's live-now answer equals the site's tab numbers;
  - a mixed-window answer equals hand SQL;
  - Hermes eval questions pass;
  - `EXPLAIN ANALYZE` under 1 s on the host for a 12-month city × kind window;
  - the role cutover is checked before the revoke.
- **17G:**
  - the recon notes record image fields, the id and path shape, a date in the path, and a cover flag;
  - parser tests on invented references: an unchanged set writes nothing, and a reorder or a new photo writes one row;
  - no image request is ever made (checked against the crawl's request log in tests and in the local trial);
  - `scraplify_public` reads neither private schema.
- **17F:** download a monthly export and restore it into a throwaway database.
- **Each phase:** local trial first, CI green, deploy outside the ss.ge run, `prod-status` plus a probe, and Board and plan-tracker updates.
