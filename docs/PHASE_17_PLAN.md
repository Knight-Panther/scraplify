# Phase 17 plan: permanent market history (jobs, tenders, real estate)

Approved by the owner 2026-11-17. Copied from the plan-mode file; this repo copy is the one kept current.

## Tracker

| Mark | Item | Waits on | Next |
|---|---|---|---|
| ⏳ | **17.0** Keep job and tender history: retention tiers 2 and 3 off for good; concept §6.1 amended. Built 2026-11-17 on `phase-17-0-keep-job-history`: `RETENTION_POLICY.keepListingHistory`, tiers 2 and 3 run only for their own tests; a test proves a listing dead 220 days keeps every revision and description Merged 2026-11-17 as `8a37a49` (PR #118, CI green) | a code-only deploy after the ss.ge run ends | 2026-11-17, 13:40 to 16:00 UTC, before the evening pipelines |
| ❌ | **Recon** (about ten ss.ge requests): poster fields and photo references | 17.0 | this week |
| ❌ | **17A** Real estate: versions, show spells, run quality, fuller archive | recon | after recon |
| ❌ | **17B** Private poster directory (zero-request sources first, then profile reads and identity) | recon, 17A | after 17A |
| ❌ | **17G** Photo references only (no image fetched or saved) | recon | with 17A |
| ❌ | **17F** Durability: monthly history export to R2, archive out of the nightly dump | 17A | alongside 17A |
| ❌ | **17C** Jobs and tenders: status events, tender outcomes, job_lives | 17.0 | after 17B |
| ❌ | **17D** Exchange rates (NBG) | — | after 17C |
| ❌ | **17E** One statistics builder, scraplify_stats role, Hermes | 17A-17D | last |
| ❌ | Multimodal phase (fetch and fingerprint photos) | the owner's go | — |


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
- **Budgeted profile reads.** A masked number ("598 90 99 **") is stored as a weak key that never merges anything on its own.

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
