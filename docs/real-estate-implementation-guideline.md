# Real estate tab from ss.ge: study and implementation guideline

**Status:** in progress. Phase 11A (foundation) is being built on the branch `phase-11a-real-estate-foundation`; see `docs/STATUS.md` for what is done.
**Scope change, 2026-10-12:** the owner dropped myhome.ge the same day this was first written, after the production server test showed it challenges our server (Appendix A). This revision covers ss.ge alone. The full two-site study, with every myhome.ge finding, is the previous revision of this file (commit `6d5ee32`).
**Date of measurements:** 2026-10-12, 11:50–14:00 UTC (15:50–18:00 in Tbilisi).
**How it was measured:** about 125 read-only requests to `home.ss.ge`, one at a time, 2–3 s apart, from a Georgian residential connection, with a desktop browser User-Agent and with the project's own `ScraplifyBot/0.1 (+https://github.com/Knight-Panther/scraplify)`. One Playwright page load watched what the site's own frontend requests, and three requests came from the production server. No sign-in, no form submission, no state-changing request. Every number is a dated observation. Re-measure before relying on one, and keep fresh results in `src/adapters/ss-ge/RECON_NOTES.md`.

---

## 1. Summary

- **What is being built:** a Real estate tab on the website that shows ss.ge's residential listings in one searchable, filterable table, refreshed nightly, with every row linking to the original listing. Website only; a ChatGPT, Claude or local-LLM connection is deferred.
- **ss.ge can be crawled with plain HTTP, including from the production server.** It is a Next.js site that embeds its data as JSON in every page. It answered the project's bot User-Agent normally everywhere it was tried: no challenge, no CAPTCHA, no 429.
- **Size:** about **117,000 readable listings** in scope (flats, houses and summer cottages, for sale and long-term rent). The site's own counters add up to about 289,000, but its lists hide listings it considers duplicates (§4.5).
- **It is a slow, awkward source.** Results pages take about 7 s and hold 16 listings. Asking for a page past the end silently returns page 1. There is no sitemap of listings, so removal has to be inferred from each listing's 30-day life.
- **A full read is about 7,300 pages, most of a day.** A nightly run needs about 650 pages plus up to 1,000 fast detail checks, about three hours.
- **Duplicates remain after the site's own collapsing.** In one sampled slice, 38–42% of ss.ge rows still had a look-alike. Grouping them is a later phase (§5).
- **Isolation:** real-estate rows live in their own Postgres schema with their own nightly timer. The vacancy and tender pipeline is changed in exactly two places, both to make it ignore the new source (§7.2).
- **Order of work:** foundation (11A), the ss.ge crawler (11B), the tab (11C), grouping (11D), hosted rollout (11E). Gates are in §14.

---

## 2. Decisions

### 2.1 Made by the owner on 2026-10-12

| Decision | Detail |
|---|---|
| Website first | Build the tab on the site. Any LLM or connector work comes later. |
| Source | ss.ge only, on a verbal OK. myhome.ge was dropped (Appendix A). |
| Scope of version 1 | Flats and houses, for sale and long-term rent, all of Georgia. |
| Presentation | Text-only rows, no photos. Each row links to the source. |
| Separation | A separate tab and a separate table structure, not merged into vacancies and tenders. |
| Usage | Limited public usage, not a full-scale launch. |

### 2.2 Built in as defaults, each open to the owner's no

| # | Question | Default taken | Why |
|---|---|---|---|
| 1 | Summer cottages (აგარაკი) | Included as a third property kind | 1,280 listings; residential; the same filters apply |
| 2 | Request budget | One request at a time, 3 s apart; one first pass of about 7,300. Since 2026-11-03 no request-count cap (about 4,000 whole-list pages a night plus each list's new rows, the listing checks and, from Phase 12B, the pages of new and changed listings), bounded by the spacing and the run's 16 hours | Settled by the owner on 2026-10-12: no budget is negotiated with ss.ge. Widened by the owner on 2026-11-03 ("as many as safe", Phase 12): the spacing is never lowered, any refusal stops the run, and from Phase 12B a run also stops at 16 hours or 20,000 requests. |
| 3 | How to read ss.ge | Public pages only | Its frontend pages through a JSON gateway with a site-issued token (§4.8). Faster, but using it needs ss.ge to say so. |
| 4 | Listing descriptions | Stored and searched; not shown on the public site | Same reasoning as the 2026-10-07 decision for the job boards |
| 5 | Default view | One row per listing first; grouped view when Phase 11D lands | §5 |
| 6 | Backups | Listing rows left out of the nightly backup; price history kept | Listings can be re-read in a day; the backup must stay inside the R2 free tier |
| 7 | Name and address of the tab | `/real-estate`, "Real estate" and "უძრავი ქონება" | The sites' own wording |
| 8 | Concept amendment | §31 added to `docs/scraplify-concept.md` | The concept is written around "opportunities" and takes precedence |

---

## 3. Scope

**Phase 12 (owner, 2026-11-03): filters identical to ss.ge's.** 12A crawls every kind (flats, houses, summer cottages, commercial spaces, land, hotels) for every deal (sale, rent, daily rent, pledge): 24 lists, smallest first, with the commercial space type, land type, photo count, furniture, built-in kitchen, exclusive and video viewing from the results rows. 12B reads each listing's own page once when it is new, changed, renewed or reopened (no backlog) for building status, condition and amenities. 12C builds each kind's "more filters" panel as ss.ge showed it on 2026-11-03, group for group (`web/lib/real-estate-panels.ts`): building status beside the kind, rooms as chips, a total or per-m² switch on the price, and in the panel condition, kitchen, house and yard area, floor range and type, balconies, bathrooms, project, other information, listing type and amenities, each kept in the address and dropped when the applied kind does not offer it. A filter on a field from the listing's own page matches only listings whose page was read (unknown is never "no"), and the page says how many of the matching listings that is. "Owner only" is one of those: results rows never mark an owner. Plan and recon: `src/adapters/ss-ge/RECON_NOTES.md`, "Recon 2026-11-03".

**In (version 1, 2026-10-12, widened by Phase 12):** all of Georgia; one row per listing with deal, kind, rooms, area, floor, price, location, street, who posted it where the site says, when it was updated, and a link to the source; filters, sorting and text search; a price-change record per listing; grouping of look-alike listings (Phase 11D).

**Out:** photos of any kind (only the photo count is kept, for the "with photos" filter); phone numbers and people's names (never stored); maps (coordinates are stored from 12B, not shown); alerts (dropped project-wide on 2026-09-27); anything involving an account on the site; ss.ge's developer-projects section (`/mshenebare`), whose flats are reached through the "under construction" status instead.

**Later:** a municipality filter; a second source; a connector.

---

## 4. ss.ge: findings

### 4.1 Platform

| Item | Finding |
|---|---|
| Operator | შპს „საქმე.ჯი", per the site's privacy policy page |
| Stack | Next.js (pages router) on `home.ss.ge` behind Cloudflare. Data is in a `<script id="__NEXT_DATA__">` JSON block, under `props.pageProps`. |
| Where the data sits | Results: `applicationList.realStateItemModel` (the misspelling is theirs), with `initialTotalApplicationCount` and `initialPage`. Detail: `applicationData`. |
| Location dictionary | **Gone by 2026-11-06.** It was embedded in every page as `pageProps.locations`: 9 main cities (Tbilisi with 5 districts and 51 sub-districts) and 63 municipalities holding 3,751 settlements, in Georgian names only. Pages no longer carry it, and ss.ge's own place lists sit behind `api-gateway.ss.ge`, which the policy refuses (§4.8). Since Phase 14A the place tree is learned from the listings themselves (§8.2, `places`). |
| Time zone | Results rows carry an explicit `+04:00`. Detail pages show the same wall-clock value with a `Z` suffix, which is wrong (§15). Georgia is UTC+4 all year. |
| Bot handling | None seen, from a Georgian residential connection, a hosted datacenter fetch, and the production server. |

### 4.2 robots.txt and terms

`home.ss.ge/robots.txt` disallows only `/ka/user`, `/en/user` and `/ru/user`, with no `Crawl-delay`. The posting-rules page (`ss.ge/ka/home/help?index=13`) was read in a browser: no clause on automated access or reuse. The sitemap it points to lists filter pages, not listings, and its "classifieds" sitemap addresses return the HTML homepage. **There is no usable inventory of listings.**

### 4.3 Addresses and filters

`https://home.ss.ge/ka/udzravi-qoneba/l/<kind>/<deal>?order=1&page=N`

| Part | Values |
|---|---|
| Kind | `bina` (flat, code 5), `kerdzo-saxli` (house, code 4), `agaraki` (summer cottage) |
| Deal | `iyideba` (sale, code 4), `qiravdeba` (long-term rent, code 1), `qiravdeba-dghiurad` (daily rent, code 3; out of scope) |
| `order=1` | Newest first. Without it the list is promoted-first. |
| Filters confirmed | `cityIdList=95` (Tbilisi), `subdistrictIds=<id>`, `rooms=<n>`, `areaFrom`, `areaTo` |
| Not found | A price filter: `priceFrom` and `priceTo` were ignored |

### 4.4 Size: counted against readable

The last real page of each list was found by bisection (§4.5 explains why that works).

| List | Site counter | Last real page | Readable listings | Share |
|---|---|---|---|---|
| Flats for sale | 95,807 | 2,596 | 41,528 | 43% |
| Flats for rent | 163,112 | 2,798 | 44,757 | 27% |
| Houses for sale | 12,032 | 752 | 12,030 | 100% |
| Houses for rent | 17,818 | 1,114 | 17,813 | 100% |
| Cottages for sale | 949 | 60 | 949 | 100% |
| Cottages for rent | 331 | 21 | 331 | 100% |
| **Total** | **290,049** | **7,341** | **117,408** | 40% |

### 4.5 Results pages

| Property | Measured |
|---|---|
| Page size | 16 listings |
| Speed | Median 6.8 s over 16 pages of broad lists (3.5–13.1 s). Median 4.3 s over 11 pages of a narrow one. |
| **The counter overstates flats** | Flat lists hide listings the site considers look-alikes. A narrow query counted at 483 returned 168 rows over 11 pages and ended. House and cottage lists do not collapse. |
| **Past the end, it returns page 1** | A page beyond the real end answers HTTP 200 with `initialPage: 1` and the first page's rows. These took 8–20 s. |
| Deep pages work to the real end | Page 2,596 of flats for sale and page 4,000 of all flats (64,000 rows deep) returned rows |
| What "newest first" means | Ordered by each listing's latest order time. Promoted listings are re-ordered constantly, so the top churns: 16 rows spanned under a minute at peak. About 300 pages cover a day of flats for rent, about 250 a day of flats for sale. |

### 4.6 What a results row contains

42 fields. Used in version 1: `applicationId`, `type`, `dealType`, `title`, `totalArea`, `floorNumber` (a string, sometimes empty), `totalAmountOfFloor`, `numberOfBedrooms`, `price` (`priceGeo`, `priceUsd`, the per-m² `unitPriceGeo` and `unitPriceUsd`, and `currencyType`), `address` (ids and names for city, district, sub-district and street, plus the street number), `orderDate`, `createDate`, `vipStatus`, `similarityGroup`, and `description`.

- **There is no room count.** It is read from the title ("3 ოთახიანი"), which the site generates. It parsed on 168 of 168 sampled rows.
- **The description is complete** (identical to the detail page on two samples).
- **Who posted it is partial.** `userInfo` (a name, an image and `userType` 2 or 3) is present on about a third of rows and appears to mark agents and companies. Its exact meaning is not confirmed.
- **`similarityGroup`** holds the id of the listing that represents a group of look-alikes. Each visible row had a distinct value.
- **Personal data to drop in the parser:** `userId`, `userInfo.name`, `userInfo.image`.
- **Also read since Phase 14A (recon 2026-11-06):**
  - `address.streetId`, ss.ge's street id. Tbilisi has 1,819, each in exactly one of its 51 sub-districts, and 57 of them are microdistrict blocks. Names repeat, ids do not.
  - `nearbySubwayStations`: each station's slug, an entrance id (`stationId`, several per station) and walking minutes on a 5/10/15/20 scale. It is on about 40% of Tbilisi rows. ss.ge works it out from the poster's pin, not from the address, so a wrong pin gives a wrong station, and a missing list does not mean far (one listing 264 m from a station had none).
  - `floorNumber` as a developer's list or range ("7, 10, 11", "2-14").

### 4.7 Detail pages

| Property | Measured |
|---|---|
| Address | `/ka/udzravi-qoneba/<id>` works. The slug is ignored, and there is no redirect. |
| Speed | Median 1.25 s over 13 pages. Much faster than results pages. |
| Adds over a results row | `rooms`, `status`, `isInactiveApplication`, `endDate`, condition (`state`), new or old build (`realEstateStatus`), street coordinates, `userEntityType`, view count |
| Expiry | `endDate` was exactly `orderDate` plus 30 days on 8 of 8 ordinary listings. Exceptions exist: two long-running house listings ended on `2040-01-01` and one 218 days out. |
| An expired listing | HTTP 200, `status: "Expired"`, `isInactiveApplication: true` |
| A listing that does not exist | HTTP 200 with no `applicationData`. Never a 404. |
| Personal data to drop | `applicationPhones`, `contactPerson`, `userId` |
| Places, read since Phase 14A | `isManualPin` (whether the poster placed the pin; otherwise it is the map's default point); `streetLocationLatitude`/`Longitude`, ss.ge's own point for the street, the same on every listing with that street id, and 0/0 when ss.ge has none (every Batumi street sampled on 2026-11-06); `cadastralCode`; `projectId`/`projectName` and `companyId`/`companyName` for a developer's complex; the municipality, for settlements only. Good pins sit 25–100 m from their street point; bad ones 1.4–11 km away. |

### 4.8 The site's own JSON gateway (not used)

The frontend loads further pages with `POST https://api-gateway.ss.ge/v1/RealEstate/LegendSearch`, body `{"order":1,"page":1,"pageSize":16}`. It authenticates with a token embedded in every page as `pageProps.credentialsToken`: a one-hour anonymous token for the site's own web client, with scopes that reach well beyond reading listings. Using it would mean acting as ss.ge's website, so the policy names that host as disallowed. If ss.ge agrees to it, it would replace the 7-second pages with a fast call.

### 4.9 From the production server

Measured 2026-10-12 at 13:30 UTC with the bot User-Agent: a results page returned 200 with real content in 5.2 s (3.5 s with a browser User-Agent), and a detail page 200 in 1.2 s. The server has 2 CPUs, 3.0 GB of memory available and 18 GB of disk free out of 38 GB.

---

## 5. Duplicates

One narrow slice was read in full: three-room flats for sale in Saburtalo, 79–81 m². Listings were matched as the same flat when area (±0.6 m²), floor, building height and price (±3%) agreed, and in the strict version when the street name also agreed.

- **ss.ge had already collapsed 483 counted listings to 168 rows.**
- **Of those 168 rows, 38–42% still had a look-alike**, and they described roughly 122–127 distinct flats. The largest group was 6.
- For comparison, the same slice on myhome.ge had 496 rows describing about 131–145 flats, with 84–86% of rows duplicated.

So ss.ge's own collapsing does most of the work, and the tab is usable without grouping. Grouping is still worth doing as Phase 11D: about one row in four is a repeat. This is one slice in the busiest neighbourhood, and the match rule can merge genuinely different identical units in a new building, so treat the figures as an upper estimate.

---

## 6. Gates before the hosted rollout

| Gate | State |
|---|---|
| The production server reaches ss.ge | Passed, 2026-10-12 (§4.9) |
| Request budget and channel agreed with ss.ge | Closed (owner, 2026-10-12): not negotiated. The cautious limits in §2.2 rows 2 and 3 stand, and only public pages are read. |
| `docs/RIGHTS.md` has a row for ss.ge | Done with Phase 11A |
| Concept §31 | Done with Phase 11A |
| Migration `0039` on the real databases | Needs the owner's approval and the `migration-safety-reviewer` pass first. The owner applies it. |
| Server capacity | 18 GB free against an estimate of under 1 GB (§12.4) |

---

## 7. How it fits the codebase

### 7.1 What is reused and what is not

| Existing piece | Reuse? | Note |
|---|---|---|
| `src/net/http-fetcher.ts`, `rate-limiter.ts`, `user-agent.ts` | Yes, unchanged | Policy check on every request and redirect, SSRF guard, response-size cap. `requestTimeoutMs` is set to 60,000: pages take up to 20 s and the default is 15 s. |
| `sources` and `source_policies`, `syncSourcePolicy`, `withPolicyRevalidation` | Yes | `src/policies/ss-ge.ts` holds the source, the policy and `isSsGeUrlAllowed`, which pins the exact address shapes. |
| `src/db/crawl-process-lock.ts` | Yes | One crawl of the source at a time |
| `source_listings`, revisions, `opportunities`, dedupe, taxonomy, the matching bundle | **No** | Built for 15,000 text listings with full revision history |
| `resources`, `fetch_attempts`, `crawl_runs` | **No** | Real estate has `realestate.crawl_runs` with counters per run |
| `deploy/run-pipeline.sh` and `xtelo-pipeline@.timer` | **No** | That pipeline runs dedupe, taxonomy, the bundle and retention after each crawl. Real estate gets its own script and timer. |

### 7.2 The two places the existing product changed

Registering ss.ge in the shared `sources` table has side effects, because two functions walk every source as a job board:

1. **`getSourceHealth()` in `src/browse/queries.ts`** feeds the health page, the admin sources page, the landing page, the source filters on Browse and Listings, `npm run health:check` and the matching bundle's health gate. A source with no job-style runs would raise a critical alert there and could stop the vacancy bundle from building.
2. **`retentionSourceIds()` in `src/retention/run-retention.ts`** decides whose crawl locks retention takes. A real-estate crawl that runs for hours would make every retention pass skip.

Both now leave out the slugs in `REAL_ESTATE_SOURCES` (`src/source-traits.ts`), each with a test. `CRAWL_SCHEDULES` in `src/crawl-schedule.ts` is opt-in, so the landing page's board rows are unaffected.

### 7.3 Layout

| Path | Contents |
|---|---|
| `src/policies/ss-ge.ts` | Source and policy records, `isSsGeUrlAllowed` |
| `src/db/schema/real-estate.ts` | The `realestate` schema (drizzle `pgSchema`); migration `0039` |
| `src/realestate/` | `ingest.ts` (upsert and price change), later queries and health; `test-support.ts` |
| `src/adapters/ss-ge/` | Parsers, crawl logic, scrubbed fixtures, `RECON_NOTES.md` (Phase 11B) |
| `src/cli/run-ss-ge-crawl.ts` | Command-line entry point (Phase 11B). The name already matches the pattern `scripts/db-write-guard.sh` asks about. |
| `web/app/(local)/real-estate/page.tsx` | The tab (Phase 11C) |
| `deploy/run-realestate.sh`, `deploy/systemd/xtelo-realestate@.service` and `.timer` | Hosted schedule (Phase 11E) |

---

## 8. Data model

All in the schema `realestate`, created by migration `0039`.

### 8.1 `listings`: one row per source listing, current state only

Unique on `(source_id, source_listing_key)`. Columns: deal and property kind; rooms and bedrooms; area; floor and building height; price in lari and dollars as the source gives them, price per m², and the currency the poster chose; the source's own city, district and sub-district ids with the names shown beside them; street name and number; who posted it (`owner`, `agent`, `developer` or `unknown`); whether it is promoted; description; ss.ge's `similarity_group`; a `group_key` left null until Phase 11D; the source's update and creation times; `expected_end_at` and `verified_at` for removal (§9.3); first and last seen; status (`active` or `gone`) with when and why; and a content hash.

Indexes: the unique key; one for browsing on `(status, deal_type, property_type, city_ref, subdistrict_ref)`; and one each on update time, price, area and expected end.

Phase 14A (migration `0049`) adds ss.ge's street id, the house number and its letter read from the street number, the lowest and highest floor, ss.ge's metro list, and `district_inferred`. These are outside the content hash, so they are written on every sighting and never count as a change. From the listing's page it adds whether the poster placed the pin, the cadastral code, and the developer complex and developer. The pin, its kind, the cadastral code and the metro list stay out of the public view and the archive (`docs/hermes-contracts.md`, C5).

### 8.2 Other tables

| Table | Purpose |
|---|---|
| `price_changes` | Each time a listing's price moved: when, old and new price in both currencies. Copied to the archive with its listing, then deleted with it (§8.4). |
| `crawl_runs` | One row per run: mode, times, status, counters, and a `progress` JSON so an interrupted sweep resumes |
| `places` (Phase 14A, migration `0049`) | ss.ge's place tree by its own ids: municipalities, cities and settlements, districts, sub-districts and streets. Each place has the name most of its active listings give it, its parent, old names as aliases and how many active listings name it. A street also has ss.ge's own point for it (`point_status` `unknown`, `known` or `none`). `syncPlaces` (`src/realestate/places.ts`) rebuilds it from the active listings after every run, and it is filled by hand with `npm run places:ss-ge`; nothing is deleted. Each run also reads up to 300 listing pages to learn street points, busiest streets first, and the municipality of settlements with no page read. The tree supplies the district that ss.ge leaves out of its oldest listings (`district_inferred`). It is private for now; Phase 14B publishes it as `public_places` (`docs/hermes-contracts.md`, C6). |

Not built yet, added when their phase needs them: a search column (11C), English location names (11C), groups (11D).

### 8.3 Rules that keep it small and healthy

- **An unchanged listing costs one small update.** `upsertListing` compares a hash of the fields that matter. Promotion and the source's own timestamps are outside the hash, because promoted listings are re-ordered many times a day.
- **Five outcomes per sighting:** `new`, `changed` (with a price-change row when the price moved), `bumped` (only the order time moved), `unchanged`, `reopened` (it had been marked gone).
- **Archive, then delete, gone rows after 14 days.** Otherwise the table grows without limit (§8.4).
- **No phone number, name or user id is ever stored.**

---

### 8.4 History (Phases 13A and 13D)

`realestate_archive` keeps what the live tables let go of. When a gone row reaches 14 days, `deleteLongGoneListings` copies it to `realestate_archive.listings`, and its price changes to `realestate_archive.price_changes`, in the same statement as the delete, so the archive receives exactly the rows deleted. A copy keeps the listing's facts: kind and deal, size, floor, both prices, area ids and names, street name and number, poster type, the 12B details, the source's own dates, first and last seen, when and why it left, and whether its price or area was a typo by the tab's sorting rule (`src/realestate/plausibility.ts`). It leaves out the link, the description and its search words, and the coordinates. Nothing in the archive is ever updated or removed. The view `realestate_archive.recently_gone` shows the same columns for rows gone but not yet archived, so the two together hold every listing that has left. Hermes reads all three as `scraplify_public`; the website reads none of them. Owner decision 2026-11-05: the street stays, for re-grouping and for linking a flat listed again.

`realestate_archive.daily_totals` (Phase 13D) records what was on the market each day: one row per area (all, city, district, sub-district) × deal × kind × room band (all, 1 to 4, 5+). Its figures are those of the listings a statistic counts, by the tab's own rules (`src/realestate/filters.ts`): on show, reposts merged into their group's newest listing, and typo prices left out. They are the count, the count before merging, how many have details, the price's quartiles and median in dollars, and the medians of the lari price, the price per m² in both and the area. `takeDailyTotals` (`src/realestate/totals.ts`) takes them after each night's grouping, dated by the Tbilisi calendar, and keeps no cell under five listings. A day's market cannot be worked out again later: which listings were on show and which were reposts is not kept, and the dates the live table holds reflect the crawl's own growth (64,734 listings first seen on 2026-11-04, the night 12A added the other kinds). So the totals are the record, and a change to the rules raises `TOTALS_RULES_VERSION` and shows as a step. Arrivals, departures, days on the market and price cuts need no such table: they are worked out from each listing's own dates and price changes in the live table, `recently_gone` and the archive.

## 9. Acquisition

### 9.1 The sweep (also the first pass)

Walk each list (kind × deal: six until Phase 12A, 24 since) newest first, smallest first, page by page, upserting every row.

- **After every page, compare `initialPage` with the page asked for.** If they differ, the walk has passed the end: discard the rows and stop. Ingesting them would file page 1's listings under the wrong position.
- Also stop at the first page with fewer than 16 rows.
- Never plan from `initialTotalApplicationCount`. Since Phase 12A a list is sized from `initialCardCount`, which counts what the list can show, and a page 1 with no rows and a count of 0 is an empty list only for a list never sized or last known to fit on one page.
- Record the last finished page per list in the run's `progress`, with the oldest order time on it, and resume a few pages before it after an interruption. If every row on that page is older than the recorded time, the list has moved up past it (listings above were renewed away, deleted or expired), and the walk steps back 20 pages, then 40, until it overlaps (2026-10-27). A nightly run resumes an interrupted nightly run the same way.
- Rows shift while a list is walked, because renewed listings jump to the front. That produces repeats, which the upsert absorbs, and can skip a just-renewed row, which the next nightly run picks up.

Cost: about 7,300 pages for the six lists of version 1. At 6.8 s a page plus the 3 s spacing, about 20 hours. All 24 lists come to about 12,900 pages, about 12.5 hours at the speeds of 2026-11-03.

### 9.2 The nightly run

Walk each list newest first and stop once a page holds only rows older than the previous successful run's start, minus a six-hour overlap. Expect about 650 pages for the six lists of version 1, a little under two hours; more for 24.

**An edit usually moves a listing's order time, but not always** (measured 2026-10-27): of 140 stored listings re-read from deep pages without a new order time, 1 carried an edited price; of 47 checked one by one, 1 more. So since 2026-10-27 each nightly run also reads lists to their end, those whose last full read is oldest (a sweep, or any run that reached a list's end, counts): one a night until Phase 12A, and since then as many as fit 4,000 pages, so each of the 24 is read whole every three or four nights. A full read refreshes every listing in it, picks up such edits and any rows a long walk slipped past (one band of about 200 from the first pass), and marks what it no longer finds (§9.3, rule 6). It costs up to 4,000 extra pages a night (one list, up to about 2,600 pages, before Phase 12A).

### 9.3 Removal, without an inventory

Absence from a list proves nothing, because flat lists hide look-alikes.

1. On every sighting, `expected_end_at` is the order time plus 30 days.
2. A row is shown only while the current time is before the later of `expected_end_at` and `last_seen_at`, plus a two-day grace period. `last_seen_at` counts because a row the site listed this week is live, whatever its order time says.
3. Each run, after its lists, fetches the detail pages of the rows due, with no count of their own since Phase 12B (1,500 a run until then, 1,000 until 2026-10-27): the run's 16 hours and 20,000 requests bound them (§9.4). First the rows past their expected end that the site still listed after that date; then the rows a full read missed (rule 6), the longest-lived first; then the rest past their end, most recently expired first. `Active` extends the row to its `endDate`, records its price (§10) and keeps its details (§9.4); `Expired` or inactive marks it gone. A page with no listing in it marks the row gone only when its list last showed it more than two days before, or a full read missed it (rule 6): ss.ge renders a live listing's page that way now and then (two of eight new ones on 2026-11-04, live on the next request), so such a row is looked at again in three days instead. A page that fails to load changes nothing.
4. An `endDate` is never believed more than 30 days ahead, so a long-running listing is re-checked monthly. An `Active` listing whose `endDate` has passed is re-checked in three days.
5. A row nobody has seen or confirmed for a week past its expected end is marked gone (`lapsed`). A gone row is archived and deleted after 14 days (§8.4).
6. When a full read of a list ends, an active row of it that the read did not see, and none of whose look-alikes (the same `group_key` or `similarity_group`) it saw, gets `missed_at`, which puts it in rule 3's queue. Being seen or confirmed clears it. It is never a reason to mark a row gone by itself: on 2026-10-27, 47,864 active flats were in 15,053 look-alike groups, and the flat lists show one of each. A sample of 50 rows unseen since the first pass found 3 gone early (6%).

A row that is neither re-seen nor checked in time is hidden at its expected end. That errs towards hiding a live listing over showing a dead one.

### 9.4 Listing details (Phase 12B)

A listing's own page says what its results row does not: building status, condition, project, floor type, bathrooms, balconies, kitchen, house and yard areas, who posted it (owner, broker, agency or developer), 33 amenities, coordinates and municipality (`src/realestate/details.ts`, vocabularies in `src/realestate/kinds.ts`). Each listing's page is read once, from 12B on, and never as a backlog:

1. A row stored new, or changed, renewed or reopened while its page was never read, wants it read (`details_wanted_at`). A row only seen unchanged is never wanted, so the rows stored before 12B wait for such a reason.
2. After its lists and its checks (§9.3), each run reads the wanted pages, the newest listing first, until none is left or the run has spent its 16 hours (`--stop-after-hours`) or 20,000 requests. A run that runs out of time there still completes, with the note `time limit reached`; the rest wait for the next night, behind that night's newer listings. Out of time or requests while lists are unread, the run is partial, so the nightly baseline stays put. A run that read every list and was then stopped while reading listing pages (a refusal, the proxy, failing pages) is partial too, but the next night measures from it and starts a walk of its own (§9.2): its lists were read.
3. A page is asked at most once a run. Every page that comes back live keeps the listing's details, the checks' pages too (`details_count` counts them), and overwrites every field: what a later page no longer says becomes unknown.
4. Unknown is never "no": a filter on a detail matches only rows whose page was read (Phase 12C), and wording the vocabularies do not hold is unknown.
5. Coordinates are kept and not shown; they stay out of the public view.

**Measured while building (2026-10-12, `src/adapters/ss-ge/RECON_NOTES.md`):** the first 90–95% of each list is in strict order of order time, down to about 29 days. Rent lists then end with listings 30–45 days old; sale lists end with a block of business listings in no date order, up to 943 days old. Thirteen listings older than 30 days were checked, and all were live with an end 45 days after their order time. Rule 3's ordering exists for these.

---

## 10. Normalisation

- **Kind and deal** come from the list being walked and are checked against the row's `type` and `dealType` codes.
- **Rooms** come from the title; null when the title has none.
- **Floor** is parsed from a string; empty or non-numeric becomes null.
- **Prices** are stored in both currencies as given. `currencyType` 1 is taken as lari and 2 as dollars; a fixture test pins this. A price change is judged in the currency the listing was posted in: the site converts it to the other at each day's rate, so the converted price moves on its own and is only kept current. Until 2026-10-27 that drift was recorded as change, 3,979 of 5,440 price changes (migration `0043` removed them). 11% of listings are posted in lari, mostly rentals.
- **Times** are converted from Tbilisi time to UTC. The `Z` on detail-page dates is ignored.
- **Who posted it:** `userInfo` present means `agent`; absent means `unknown`, never `owner`.
- **Promoted:** any `vipStatus` above 0.

---

## 11. The tab (Phase 11C)

- Invoke the repo's `professional-frontend` skill before writing components and again before calling the work done. **Never render invented data. Never uppercase text that may be Georgian.** UI work is finished only after it has been rendered in a real browser and inspected.
- **Columns:** Deal · Kind · Rooms · Area · Floor (as "3 / 9") · Price · Price per m² · Location · Street · Posted by · Updated · Source link.
- **Filters:** deal, kind, city, district and sub-district, price range with a lari or dollar switch, area range, rooms, floor, posted by, updated within 1, 3, 7 or 30 days, text. **Sort:** newest, price, price per m², area. State lives in the address bar, following `web/lib/listing-params.ts`.
- **Search** covers street, location names and description through an indexed `tsvector` column, with query terms built by the same `tokenize` and `stem` the Phase 10A search uses. The existing search runs a regular expression over 15,000 rows at query time, which would not hold here.
- **Surfaces:** the page is surface-aware like `/listings`. On the public surface it reads only through a view that exposes active rows and leaves out `description`. Add `/real-estate` to `isPublicRoute` and to both nav lists. Grants go in a new SQL file the owner runs.
- **Speed:** return 50–100 rows at a time with keyset paging. Count up to a ceiling and show "10,000+" above it.

---

## 12. Operations

### 12.1 Schedule

One timer, at 21:30 UTC (01:30 in Tbilisi), away from the 16:10 UTC job pipeline. The nightly run should finish in about three hours. The first pass is started by hand once.

### 12.2 Health

Real estate gets its own health section: the last run and its counters, the age of the newest listing, how many rows are past their expected end and unchecked, and pages that fell back to page 1 before the expected end of a list. A results page that parses to zero rows where rows are expected is an incident.

### 12.3 Backups

`deploy/backup-db.sh` dumps the whole database and keeps the off-host copies under 8 GB in total by deleting the oldest. The exclusion of `realestate.listings` and `realestate.crawl_runs` row data planned here was never built: the dump holds every schema, 143 MB on 2026-11-05. The archive (§8.4) must stay in it, since nothing else can rebuild it.

### 12.4 Capacity

A stored row averaged about 1.9 KB in the sample, of which the description is about 1.2 KB. For 117,000 active rows plus 14 days of gone rows: roughly 300 MB of table and under 1 GB with indexes and a search column. This is an estimate; the measured size after the first pass is an exit gate.

### 12.5 Local development and real data

Develop against fixtures and a throwaway database. Writing the first pass into the real `scraplify` database is a real-data write: the guard hook will ask, and the owner runs it. Test every production-bound change on the local surface servers before the host.

---

## 13. Testing

- **Parsers:** fixture tests per page type, colocated `*.test.ts` under vitest. Fixtures are the embedded JSON of real pages, trimmed.
- **Fixtures must be scrubbed.** The repository is public. Remove `credentialsToken`, `userId`, `userInfo`, `applicationPhones` and `contactPerson`, and blank phone-like digits in descriptions. A test fails if any fixture contains a phone-shaped number or a token.
- **Named traps get named tests:** the page-1 fallback, the missing-listing page, the false `Z`, rooms from the title, the empty floor string.
- **Isolation:** the two tests in §7.2, and `src/db/real-data-guard.ts` covering the new schema so a test can never change real real-estate rows.
- **Surfaces (11C):** `/real-estate` exists on local and public and is refused on admin; the public role cannot read `description`.
- **Browser (11C):** the tab with real data, in Georgian and English, at desktop and phone widths.

---

## 14. Phases and exit gates

One branch per phase. `docs/STATUS.md` carries the live state of these boxes.

### Phase 11A: foundation

- [ ] ss.ge source and policy records with `isSsGeUrlAllowed`, tested
- [ ] `REAL_ESTATE_SOURCES` and the two exclusions, tested; the existing health and retention tests still pass
- [ ] The `realestate` schema and migration `0039`
- [ ] `upsertListing` with its five outcomes and price changes, tested
- [ ] `real-data-guard.ts` covers the new schema
- [ ] Concept §31, the `docs/RIGHTS.md` row, STATUS
- [ ] Full suite green on a throwaway database; typecheck and lint clean

### Phase 11B: the ss.ge crawler

- [ ] Results-page and detail-page parsers with scrubbed fixtures
- [ ] The walker with the fallback check, resumable progress, and the nightly stop rule
- [ ] The expiry rule and the nightly checking budget
- [ ] `run-ss-ge-crawl` command; runs recorded in `realestate.crawl_runs`
- [ ] First pass complete on a local database: readable rows within 5% of §4.4
- [ ] Table and index size measured and recorded
- [ ] No phone number, name or token in any table or fixture
- [ ] `RECON_NOTES.md` written with fresh measurements

### Phase 11C: the tab

- [ ] Queries, public view, grants, search column
- [ ] The page with every filter, sort and search in §11
- [ ] Each filtered page answers in under a second on the local corpus
- [ ] Browser check passed in both languages and at phone width

### Phase 11D: grouping

- [ ] A street key, a group key and a groups table
- [ ] On a fresh read of the §5 slice, 50 groups checked by hand: in at least 45, every member is plausibly the same flat
- [ ] Grouped view available, with a switch to every listing

### Phase 11E: hosted rollout

- [ ] Migration and grants applied on the host by the owner
- [ ] Timer installed; backup exclusion in place and a dump size checked
- [ ] First pass run on the host; disk headroom confirmed
- [ ] `/real-estate` public, in the nav, and checked live

---

## 15. Traps

1. **A page past the end returns page 1**, with HTTP 200. Always compare `initialPage` with the page requested.
2. **The counter is not the row count** for flats. A query counted at 483 held 168 rows.
3. **A missing listing is not a 404.** It answers 200 with a page that has no listing record.
4. **Detail dates carry a false `Z`.** The value is Tbilisi time.
5. **Results rows have no room count.** It is in the title.
6. **`floorNumber` is a string and is sometimes empty.**
7. **Every page embeds a working access token.** Never log it, never store it in a fixture, never send it anywhere.
8. **Payloads carry phone numbers and names.** Drop them in the parser, before anything is stored or logged.
9. **Descriptions contain phone numbers typed by posters.** They are searched but not displayed publicly; remember this before any later feature shows or exports them.
10. **Without `order=1` a list is promoted-first**, and a walk that stops at the first old row stops in the wrong place.
11. **Promoted listings are re-ordered constantly.** Counting that as a change would rewrite the same rows every run.
12. **Absence from a flat list is not removal.** The list hides look-alikes.
13. **Listings live only by renewal.** Without deleting gone rows the table grows without limit.
14. **A real-estate source in the shared `sources` table can stop the vacancy matching bundle** unless it is excluded (§7.2).
15. **`cleanupTestSource` knows nothing of the `realestate` schema.** Tests must call `cleanupRealEstateSource` first, or the `sources` row cannot be deleted.

---

## 16. Not verified

- Any tolerance for more than one request at a time, or for sustained running over hours. The longest unbroken run was 56 requests over about twelve minutes.
- Other listing end states besides `Active` and `Expired` (sold, deleted, blocked).
- The exact meaning of `userInfo.userType` 2 and 3, and of `currencyType`.
- Whether every edit moves a listing's order time.
- The site outside Tbilisi afternoon and evening hours.
- English location names: whether the `/en/` pages carry them.
- Duplicate rates beyond one slice.

---

## Appendix A: myhome.ge, dropped on 2026-10-12

myhome.ge (TNET) was studied alongside ss.ge and was the easier source technically: twelve sitemap files list all 345,711 live listings with a last-modified day, and results pages return 24 listings in 1.5 s.

It was dropped because, from the production server, every page except `robots.txt` answers with a Cloudflare challenge (HTTP 403, `cf-mitigated: challenge`), whatever the User-Agent. It works from a Georgian residential connection. TNET's API hosts answer the server normally, but the listings endpoint there needs authorization.

What would reopen it: TNET allowing the server's outbound IP, partner access to their API, or running that one crawler from a Georgian connection. The full findings, the crawl design and the cross-site duplicate study (about two thirds of each site's rows matched a flat on the other) are in commit `6d5ee32` of this file.
