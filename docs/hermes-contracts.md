# What scraplify promises Hermes

The owner's Hermes agent reads Xtelo's data and code read-only (`docs/RUNBOOK.md` §1, "Hermes' database tunnel"). This file defines the parts Hermes builds on. Scraplify owns each contract. Hermes reads it, checks it in its own tests, and falls back when it is missing. A change that removes or renames anything here is agreed with the owner first, and is a new version. Adding a column is not.

| Contract | What | State |
|---|---|---|
| C1 | Real-estate filter builder (SQL and parameters for `realestate.public_listings`) | v1, merged 2026-11-06 (`873ceec`); v2 (Phase 14D: places on both maps, the metro, location quality) built on branch `phase-14d-c1-v2`, for Hermes's review before it merges |
| C2 | Real-estate archive (`realestate_archive`) | v1, live since 2026-11-05 (`6e48865`); Phase 14A appends ten columns (`0049`) |
| C3 | Nightly real-estate totals (`realestate_archive.daily_totals`) | v1, live since 2026-11-06 (`3925192`); `rules_version` 3 from Phase 14A's deploy, 4 from 2026-11-10, 5 from 2026-11-12 (the list-end read, live 2026-11-11 13:51 UTC) |
| C4 | Grafana dashboard links and variables | not yet built (S4) |
| C5 | `realestate.public_listings`, live listings | live (migrations `0040`–`0045`, `src/db/schema/real-estate.ts`); Phase 14A appends ten columns (`0049`), Phase 14C eleven (`0051`), Phase 14D one (`0053`, on branch `phase-14d-c1-v2`), all below |
| C6 | `realestate.public_places` and the place lookup: ss.ge's places and Tbilisi's official map | live since 2026-11-08 (`f81599a`, migration `0050`, Phase 14B); lookup v2 and `official_source` live since 2026-11-10 (`743c034`, migration `0051`, Phase 14C) |

## C1: the real-estate filter builder (v1)

### Where

`dist/realestate/filter-builder.js` in a built scraplify clone (`npm run build`), imported the way `site_search.mjs` imports `browse/search-terms.js`. It opens no database connection. Its rules are `src/realestate/filters.ts`, the same code the Real estate tab's own queries run (`src/realestate/queries.ts`), so the two cannot drift apart.

```js
import { FILTER_BUILDER_VERSION, realEstateWhere } from '<scraplify>/dist/realestate/filter-builder.js';
const built = realEstateWhere(filters, new Date().toISOString(), { placeholders: 'psycopg' });
```

### Input

- **`filters`:** a JSON object with the keys of `RealEstateFilters` (`src/realestate/filters.ts`, each one documented there), except `limit` and `offset`, which you add as SQL of your own. The input is checked strictly. An unknown key, a misspelling, a value of the wrong kind or a choice that does not exist throws a `ZodError` whose issues name the key. Nothing is silently ignored.
- **`now`:** an ISO 8601 instant with a zone. It decides which listings are still on show: those whose `expected_end_at` is after it. Until 2026-11-10 the tab kept a listing two more days; of 60 such listings asked on ss.ge that day, 51 were gone, so the grace went. This is the tab's rule changing, not the builder's input or output, so the version stays; C3's `rules_version` 4 records it. A listing that outlives its 30 days (an owner's 45) keeps a later `expected_end_at` for as long as its list shows it: each night the crawl reads every list's end and moves that date to sixty hours after the sighting, never past the order time plus 45 days where the row names no business (C3's `rules_version` 5). The rule you are handed does not change.
- **`placeholders`:**
  - `postgres` (the default) writes `$1…$n`;
  - `psycopg` writes `%s` and doubles every literal `%`.

Values:
- **Choices:** the keys in `src/realestate/kinds.ts`, never the Georgian labels:
  - `dealType`: `DEAL_TYPES`;
  - `propertyType`: `PROPERTY_TYPES`;
  - `buildingStatuses`, `conditions`, `projects`, `floorTypes`, `amenities`: the values of `BUILDING_STATUSES`, `CONDITIONS`, `PROJECTS`, `FLOOR_TYPES`, `AMENITY_FIELDS`.
- **Prices:** `priceMin` and `priceMax` are in `currency` (`usd` unless it says `gel`). With `pricePerM2: true` they are per m².
- **Counts:** `roomsIn: [3, 10]` is "3 rooms, or 10 or more". `bathrooms` and `balconies` work the same way, with 5 as their top.

### Output

| Field | What |
|---|---|
| `version` | `FILTER_BUILDER_VERSION` |
| `where` | `{ sql, params }`: the rows the Real estate tab would show. These are listings on show at `now` that match every filter. With `grouped: true` there is one row per look-alike group (`group_key`, Phase 11D), led by the group's first listing in `sort` order. Parameters are strings, numbers and booleans; an array value arrives as a Postgres array literal. |
| `orderBy` | The tab's order for `sort`, typo prices last, ending in `id`. It has no parameters. |
| `coverage` | `{ sql, params }` when a filter on a listing-page field (Phase 12B) is set, otherwise `null`: the listings matching every other filter, never folded. |
| `implausible` | A boolean expression: the price or area is a poster's typo (`src/realestate/plausibility.ts`). It has no parameters. |

### Using it

- **No alias.** The SQL names its columns as `"public_listings"."column"`, so query the view as is: `select … from realestate.public_listings where <where> order by <orderBy> limit %s`. To aggregate, put that select in a CTE and work on the CTE.
- **Statistics:** pass `grouped: true, plausibleOnly: true`. That gives live listings only, reposts merged and typo prices out. Typos are dropped before groups are folded, so a group led by a typo still counts once, by its next listing. This is the rule the archive's `implausible` column uses and the nightly totals (C3) will use, so the bot's figures and Grafana's agree. To count posts with reposts unmerged, send the same filters with `grouped: false`.
- **The coverage line:** run `select count(*), count(details_read_at) from realestate.public_listings where <coverage>`. That is "details known for *read* of *total*".
- **Places:**
  - `places: [{ "level": "subdistrict", "ref": 1 }, { "level": "district", "ref": 7 }]` means any of these. The levels are `city`, `district` and `subdistrict`.
  - The refs are the view's `city_ref`, `district_ref` and `subdistrict_ref`, with the Georgian names beside them.
  - Street names go in `text`, which searches the words of the street, city, sub-district and description.
  - From Phase 14A's deploy, a district also matches the listings whose district was filled from their sub-district (`district_inferred`, C5), about 1,200 of ss.ge's oldest. Streets, municipalities, official districts, stations and the metro are filters from C1 v2 (below).
- **Not in v1: municipality.** ss.ge gives it only on a listing's own page, and only 123 of 293,355 live listings had it on 2026-11-06. Name a municipality's towns and villages through `places` instead.
- **What it replaces in Hermes's current query:**
  - its own live rule (`expected_end_at > now()`);
  - its repost key (area, rooms, floor, price and street);
  - its relative suspect-price rule.

  Hermes may keep the last as a note of its own, but figures meant to match Grafana use `plausibleOnly`.
- **Cost on the host, 2026-11-06:**
  - all 45,173 flats for sale, grouped and typos out, with two medians: 1.2 s;
  - the same with one 12B condition: 0.8 s;
  - 3-room rents in Vake: 0.1 s.

### Version and cases

- **Version:** `FILTER_BUILDER_VERSION` goes up whenever the input, its meaning or the output changes, new filters included. Hermes reads it at run time, and falls back when the module or the version it was written for is missing.
- **The typo bounds** live in `src/realestate/plausibility.ts` and are tightened when a real case slips through. That is not a new version, since `plausibleOnly` still means "what that rule marks". C3's `rules_version` records each change for trends. The last change, 2026-11-06, found by Hermes: a monthly rent of $200 a m² or more is a typo (a sale price), however far under the $50,000 bound.
- **Cases:** `src/realestate/filter-cases.json` holds fixture listings and 19 cases, each with the listings it must return (some in order) and its coverage counts. scraplify's `src/realestate/filter-builder.test.ts` runs every case two ways, through the SQL handed on and through the tab's own query, and both must match the file.
- **Hermes's side:** its suite has no database. It can check that every case compiles with `psycopg` placeholders and that the file's version is the one it was written for. Its live test can `EXPLAIN` each case, read-only, on the host.
- **Checked on 2026-11-06:** every case returned its listings, in order where asked, through psycopg 3.3.6 on the fixture.

## C1 v2: places on both maps, the metro and location quality (Phase 14D)

`FILTER_BUILDER_VERSION` 2. Every v1 input is taken as before and means what it meant. Version 2 adds filters on C5's Phase 14C columns and C6's places, and three output fields. It reads C6 (`realestate.public_places`) inside the SQL, which `scraplify_public` already may. It comes with one column, `metro_nearby_minutes` (C5, Phase 14D, migration `0053`), which a named station's band needs.

### The rule for every location filter

**Unknown never matches, and is counted.** A listing whose location does not say whether it is in an official district, or near a station, is left out of `where`. `locationCoverage` lists those that might be. So the bot says "at least 4,922, and 14,488 more whose location is not known well enough" rather than a figure that reads as complete. This is the rule the listing-page filters (12B) already follow, with their own `coverage`.

### Input, added

- **`places` takes every level of C6.** Pass a C6 row's `level` and `ref` as they are. `places` stays "any of these".

  | Level | Matches | Unknown |
  |---|---|---|
  | `city`, `district`, `subdistrict` | as in v1 | — |
  | `street` | `street_ref`, ss.ge's street id (one street in one sub-district) | — |
  | `municipality` | `municipality_ref` (only on a read page), or a settlement C6 places under it (its `city` row's parent). On 2026-11-12 C6 knew the municipality of 139 of 1,261 settlements, learned from listing pages. A settlement not yet placed is not matched: name it as a `city`. | — |
  | `official_district` | the listing's own `official_district_ref` (C5): by its trusted pin, its street's location or its sub-district | no official district, in an ss.ge sub-district whose `official_shares` count a located listing in it (in a district, for a listing with no sub-district) |
  | `metro_station` | the station is in `metro_nearby`: within 20 minutes' walk, nearest or not. For a closer band, use `metro` | not located (`metro_basis` null), in a sub-district where a located listing is near it |
  | `neighbourhood` | the ss.ge place its listings are under (C6's `parent_level`, `parent_ref`): Zgvisubani is all of Tbilisi Sea. It comes back in `widenedPlaces`, so the bot can say so. | — |

  A listing another place in the list holds is a match, never unknown.
- **`metro`: `{ "maxMinutes": 10, "stations": ["rustaveli"] }`**, by our checked metro (C5), never ss.ge's claim.
  - `maxMinutes` is one of ss.ge's bands, 5, 10, 15 or 20, and 20 when absent. Any other number is refused: round the person's "12 minutes" yourself.
  - `stations` are ss.ge's codes (C6's `metro_station` `code`, the values of C5's `metro_station`). Absent or empty means any station.
  - No stations: the nearest station is within `maxMinutes`.
  - Stations, with `maxMinutes` 20: any of them is in `metro_nearby`.
  - Stations, under 20: one of them is within the band by its own band (`metro_nearby_minutes`), nearest or not. Changed before the merge (owner, 2026-11-12): the first build read only the nearest station's band, which found 97% of the true matches at 5 minutes, 93% at 10 and 68% at 15 (measured on production's located listings).
  - Unknown: not located, in a sub-district where a located listing matches.
  - Located and further than 20 minutes from every station is known: no.
- **`minPrecision`**: one of `none`, `municipality`, `city`, `district`, `subdistrict`, `street`, `house`, `pin` (C5's `location_precision`); that or more exact.
- **`excludeUncertain: true`**: leaves out listings with `location_uncertain`.
- **Refused**, like every bad input: a level that is not one, a band that is not one, a station by its name ("Rustaveli") instead of its code, an unknown key inside `metro`, a precision that is not one.

### Output, added

| Field | What |
|---|---|
| `locationCoverage` | `{ sql, params }` with a filter on an `official_district`, a `metro_station` or `metro`; otherwise `null`. The listings matching every other filter that the location filters might hold though their location does not say: each location filter matches or cannot be told, and not all are known to match. Never folded into look-alike groups, like `coverage`. |
| `widenedPlaces` | The input's places matched as the ss.ge place holding them: its neighbourhoods. Empty otherwise. |
| `placeColumn` | A select-list entry with no parameters: one jsonb column, `place`, the listing's place on both maps with names (below). |

### Using it

- **The unknown count:** `select count(*) from realestate.public_listings where <locationCoverage>`. Word it as "at least N", then "M more whose location is not known well enough to say".
- **Both maps on a row:** `select id, …, <placeColumn> from realestate.public_listings where <where> order by <orderBy> limit %s`. Every key is present, `null` when unknown:

  ```json
  {
    "city": {"ref": 95, "ka": "თბილისი", "en": "Tbilisi", "roman": "Tbilisi"},
    "district": {"ref": 5, "ka": "ძველი თბილისი", "en": "Old Tbilisi", "roman": "Dzveli Tbilisi"},
    "subdistrict": {"ref": 21, "ka": "ავლაბარი", "en": "Avlabari", "roman": "Avlabari"},
    "street": {"ref": 851, "ka": "თელავის ქ.", "en": null, "roman": "Telavis K."},
    "official": {"ref": 13438808, "code": "isani", "ka": "ისნის რაიონი", "en": "Isani District", "basis": "street"},
    "area_official": {"level": "subdistrict", "ref": 21, "code": "isani", "ka": "ისნის რაიონი", "en": "Isani District", "listings": 2450, "located": 2502},
    "metro": {"code": "samasi_aragveli", "ka": "300 არაგველი", "en": "300 Aragveli", "minutes": 10, "basis": "street"}
  }
  ```

  A row from production, 2026-11-12. `city`, `district`, `subdistrict` and `street` are ss.ge's map. `official` is the listing's own official district (C5), and `area_official` how the official map sees its ss.ge area: the official district holding most of the area's located listings (C6's `official_shares`), with `listings` of `located`. `metro` is the nearest station by our checked metro. Show `en`, else `roman`. That gives "Avlabari: listed under Old Tbilisi on ss.ge; officially Isani" with no mapping of your own.
  Each part is a lookup by key, worked out for the rows a page returns: a page of 20 took 0.09 s on the host. It is for pages, not statistics.
- **What a basis means**, so a reply never claims more than the data:
  - `official.basis` `pin`: the poster's own pin, checked against its street (C5, "A trusted pin"); `street`: the street's location, so approximate along the street, and an avenue can cross a border; `area`: the sub-district lies 95% or more in one official district.
  - `metro.basis` `pin`, `building` or `street`, in the same order of exactness. From a street, the minutes are the street's, give or take its length.
  - `location_precision` `street` is a located street, `house` a located street and a house number, `pin` a trusted pin.
  - `location_uncertain`: the pin, or ss.ge's metro from it, contradicts the rest. Such a listing is still placed by its street.
- **Cost on the host, 2026-11-12** (`scraplify_public`, 286,000 listings on show):
  - flats for rent in Isani District: 0.48 s, its `locationCoverage` 0.28 s;
  - flats for sale in Vake District, grouped and typos out: 1.2 s, its `locationCoverage` 0.5 s;
  - rents within 10 minutes of Rustaveli: 0.29 s, its `locationCoverage` 1.0 s, measured on the first build, which read the nearest station's band; each station's own band is one more array read per listing;
  - a neighbourhood, a municipality, or any metro within 5 minutes at house precision: 0.25 to 0.4 s.

### Fallback and version

- **A v1 reader** sends what it sent and gets what it got. It sees `version` 2 and three output fields it can ignore.
- **A v2 reader** checks `version >= 2` at run time. On a clone still at 1 (the laptop's clone updates with Hermes's `deploy.sh`), a new filter is refused as an unknown key, never ignored. Fall back to v1's places and say what was left out.
- **Deploy order:** migration `0053` and the by-hand judgement that fills `metro_nearby_minutes` go live on the host before your clone builds v2. Until a listing is judged under `location_rules` 2, its bands are null and a named station under 20 minutes never matches it.

### Cases

`src/realestate/filter-cases.json` is version 2, with 34 cases, 15 of them new. Its `places` holds the catalogue rows the new cases need, inserted beside the fixture listings. A case's `unknown` lists the listings `locationCoverage` must return, and a case without it expects `null`. `placeColumn` holds the `place` one listing must get. The new cases include the plan's "both maps on their own": an Avlabari listing matches ss.ge's district Old Tbilisi and official Isani, each separately. Twelve faults planted in the rules (an unknown listing counted as known, a named station read by the nearest's band, a band ignored, precision off by one, and so on) each turned a test red.

## C3: daily real-estate totals (v1, migration `0047`)

`realestate_archive.daily_totals` records what was on the ss.ge market each day. `scraplify_public` may `SELECT` it. Definitions are in `src/db/schema/real-estate-archive.ts`; the code that fills it is in `src/realestate/totals.ts`.

### Grain

One row per `day` × `area_level` × `area_ref` × `deal_type` × `property_type` × `rooms_band`. That combination is the primary key.

| Column | What |
|---|---|
| `day` | the date in Tbilisi when the totals were taken |
| `area_level`, `area_ref`, `area_name` | the area level is one of the following: `all` (`area_ref` 0, `area_name` null), `city`, `district` or `subdistrict`. With a level, `area_ref` is ss.ge's id, the same refs C1's `places` take, and `area_name` is the Georgian name ss.ge showed that day. |
| `deal_type`, `property_type` | as in C1. There is no "every kind" row, since a flat's and a plot's prices do not mix. |
| `rooms_band` | `all`, `1`, `2`, `3`, `4` or `5+`. A listing with no room count is only in `all`. |

A cell with fewer than 5 listings is not kept. That leaves about 4,000 rows a day (2026-11-06): no row for a village with two flats means "too few to say".

### Figures

All figures are of the listings a statistic counts, by C1's own rules: `{ grouped: true, plausibleOnly: true }`. That means listings on show, with reposts merged into their group's newest listing and typo prices left out. A day's totals and the bot's C1 figures for that day agree.

| Column | What |
|---|---|
| `listings` | how many |
| `posts` | the same before reposts are merged |
| `with_details` | of `listings`, those whose own page was read (12B) |
| `price_usd_p25`, `price_usd_median`, `price_usd_p75` | the price in dollars |
| `price_per_m2_usd_median`, `price_gel_median`, `price_per_m2_gel_median`, `area_m2_median` | medians. The per-m² ones are over listings with a known area: with no area, ss.ge's price per m² is the whole price. |
| `taken_at`, `crawl_run_id` | when, and after which ss.ge run (null when taken by hand) |
| `rules_version` | the rules the figures follow. It goes up when they change, so the change shows as a step and is not mistaken for a trend. 1 was the first take only (2026-11-06). 2 adds two things: a rent of $200 a m² or more is a typo, and the per-m² medians come only from listings with a known area. 3 (Phase 14A): ss.ge's oldest listings, filed with no district, count in their sub-district's district (`district_inferred`, C5), about 1,200 more listings in the district cells; the city, sub-district and `all` cells do not move. 4 (2026-11-10): a listing counts only until its expected end, with no two days of grace, about 8,000 fewer listings at once in every cell; it is now your own earlier live rule, `expected_end_at > now()`. 5 (the list-end read): a listing its list still shows past its 30 days counts while the list shows it, where it was hidden until its own page was asked; some thousands more listings at once, nearly all naming no business and 30 to 45 days old. |

### When

- **Taken:** after each night's ss.ge run has regrouped the listings, about 13:30 UTC (17:30 in Tbilisi), or by hand.
- **Ready:** a day is ready when its rows exist. There is no extra field in the pipeline event: Hermes reads `max(day)`. A day taken twice keeps the later figures.
- **Gaps:** a night whose run fails before its crawl row has no totals, so read gaps as gaps.

### What it is not

- **No arrivals, departures, days on the market or price cuts.** They are worked out from each listing's own dates and price changes, which are kept: `first_seen_at` in `realestate.public_listings`; `first_seen_at` and `gone_at` in `realestate_archive.recently_gone` and `realestate_archive.listings`; and the archive's `price_changes`. Arrivals before 2026-11-05 mostly measure the crawl's own growth: 64,734 listings were first seen on 2026-11-04, the night all kinds were added.
- **No rebuild of past days.** Which listings were on show on a past day, and which were reposts, is not kept. That is why the totals are taken, not computed later. History starts on the first day taken.

## C2: the real-estate archive (v1, migration `0046`)

### Access

`scraplify_public`, the role Hermes logs in as, may `SELECT` three relations in schema `realestate_archive`. It can write nothing, and it still cannot read `realestate.listings` itself.

### What is where

At any moment, each ss.ge listing is in exactly one of these places:

| Relation | Holds | Key |
|---|---|---|
| `realestate.public_listings` (C5) | live listings | `id` |
| `realestate_archive.recently_gone` (view) | gone from ss.ge less than 14 days ago, not yet archived; `archived_at` is null. A row here can come back to life when ss.ge lists it again. | `listing_id` |
| `realestate_archive.listings` | gone for 14 days, then deleted from the live table and copied here in the same statement. Never updated or removed. | `listing_id` |

Every listing that has left is `select * from realestate_archive.listings union all select * from realestate_archive.recently_gone`. The view has the table's columns in the table's order.

`listing_id` is the live row's id. When ss.ge lists an id again after its deletion, it comes back as a new live row, so one `source_listing_key` can have several rows here, one per life.

`realestate_archive.price_changes` has every price change of an archived listing: `id`, `listing_id`, `observed_at`, and `old_price_gel`, `new_price_gel`, `old_price_usd`, `new_price_usd`. It cascades from the archived listing. Gone but unarchived listings' price changes are not readable.

### Columns of `listings` and `recently_gone`

Types are in migration `0046`; definitions are in `src/db/schema/real-estate-archive.ts`.

- **Identity:** `listing_id`, `source_id`, `source_listing_key` (ss.ge's id).
- **Kind:** `deal_type` (`sale`, `rent`, `daily`, `pledge`), `property_type` (`flat`, `house`, `cottage`, `commercial`, `land`, `hotel`), `commercial_type`, `land_type` (ss.ge's codes, `src/realestate/kinds.ts`).
- **Size:** `rooms`, `bedrooms`, `area_m2`, `floor`, `total_floors`.
- **Price, as last seen:** `price_gel`, `price_usd`, `price_per_m2_usd`, `price_per_m2_gel`, and `currency_posted`, the currency the poster chose.
- **Place:** `city_ref`/`city_name`, `district_ref`/`district_name`, `subdistrict_ref`/`subdistrict_name`, `municipality_ref`/`municipality_name` (ss.ge's ids, with the Georgian names it showed), and `street_name`, `street_number`.
- **Poster:** `poster_type` (`owner`, `agent`, `developer`, `unknown`), `poster_entity`.
- **Listing:** `image_count`, `has_furniture`, `has_built_in_kitchen`.
- **From the listing's own page (Phase 12B):** `building_status`, `condition`, `project`, `floor_type`, `bathrooms`, `balconies`, `kitchen_area`, `house_area`, `yard_area`, `amenities` (text array), `details_read_at`. They are null unless `details_read_at` is set, and unknown is not "no". Few rows have them before mid-November 2026.
- **ss.ge's own look-alike id:** `similarity_group`.
- **Dates:** `source_created_at` (when ss.ge says it was posted), `source_updated_at`, `first_seen_at`, `last_seen_at`, `gone_at`, `gone_reason`, `archived_at`.
- **`implausible`:** whether the price or area is a poster's typo, by the Real estate tab's sorting rule (`src/realestate/plausibility.ts`) as it stood when the row was archived, or as it stands now in `recently_gone`. Leave these rows out of statistics. The fields the rule reads are kept, so a later rule can be applied instead.
- **Places, Phase 14A (migration `0049`), after `archived_at`:** `street_ref`, `house_number`, `house_suffix`, `floor_low`, `floor_high`, `district_inferred`, `complex_ref`, `complex_name`, `developer_ref`, `developer_name`, meaning what they mean in C5. A listing that left before the deploy was never seen again, so it has no `street_ref`, floors or page fields; its house number and filled district come from the deploy's backfill.
- **Location, Phase 14C (migration `0051`), after those:** `official_district_ref`, `official_district_basis`, `location_precision`, `location_uncertain`, `location_flags`, `metro_station`, `metro_minutes`, `metro_basis`, `metro_nearby`, `building_key`, `location_rules`, meaning what they mean in C5, as judged the night before the listing left. A listing that left before 14C's deploy has them null (and `location_uncertain` false, `location_flags` empty).

Never in it: the link, the description and its search words, the coordinates and whether the poster placed them, the cadastral code, ss.ge's metro list, photos, the poster's name or phone. Scraplify stores neither of the last two anywhere. ss.ge's own id is kept (`source_listing_key`), so a listing's address on ss.ge can be rebuilt from it, as `public_listings` shows it for live ones. Rows are kept for good: nothing deletes from the archive.

### Working things out

- **That day's exchange rate:** `price_gel / price_usd` on `last_seen_at`. ss.ge converts the price out of `currency_posted` daily. Treat it as approximate for small prices.
- **First price:** the earliest price change's old price, or the row's own price when there are no changes.
- **A price change** is a change in the posted currency. Exchange-rate-only rows were removed by migration `0043` and are not recorded since.
- **Days on the market:** `gone_at - coalesce(source_created_at, first_seen_at)`. For listings already live at the first sweep (2026-10-12), `first_seen_at` is that date, not the posting date.
- **Reposts (the same flat posted more than once):** no group key is stored, because the live one is cleared as a listing goes. Re-group from `deal_type`, `property_type`, `city_ref`, `subdistrict_ref`, `street_name`, `rooms`, `floor`, `total_floors`, `area_m2` and `price_usd` by scraplify's rule (`src/realestate/grouping.ts`). C1 or a later contract may offer that rule ready-made.

### When history starts

The first rows appear after the first nightly ss.ge run on the Phase 13A release that deletes anything. The oldest gone listings on 2026-11-05 left on 2026-10-27 (5,270 of them) and were still in the live table, so nothing is known to have been deleted before the archive. Departures ran at about 500–2,300 a day in early November 2026.

## C5: live listings, Phase 14A's columns (migration `0049`)

`realestate.public_listings` gains ten columns at its end, by `create or replace`, so `scraplify_public`'s grant stays and every earlier column keeps its place. The archive and `recently_gone` gain the same ten after `archived_at` (C2).

| Column | What |
|---|---|
| `street_ref` | ss.ge's own street id. One id is one street in one sub-district. Names repeat (ჭავჭავაძე is six ids; აბულაძის ქ. sits in four sub-districts), so match or group streets by this, not by `street_name`. Null when the listing names no street. |
| `house_number`, `house_suffix` | Read from `street_number`, which stays as the poster typed it: "117დ" is 117 and `დ`; "49-51" is 49 with no letter; "№12" is 12. "0", punctuation, words or a block ("7ბ ბლოკი") give both null. The letter is lower-case. |
| `floor_low`, `floor_high` | The lowest and highest floor the listing names. One floor gives both. A developer's "7, 10, 11" or "2-14" gives its ends, where `floor` is null. |
| `district_inferred` | True when ss.ge gave no district (its oldest listings, about 1,200 live, posted 2023-10 to 2024-07) and `district_ref`/`district_name` were filled from the sub-district's district in ss.ge's own tree. False when ss.ge stated the district. Never null. Kept current on every sighting, so if ss.ge later states the district itself, the flag turns false. |
| `complex_ref`, `complex_name` | A developer's residential complex, from the listing's own page. |
| `developer_ref`, `developer_name` | The developer, from the listing's own page. The name is kept only when it names a company by its legal form (შპს, სს, LLC, JSC, Ltd and the like). Otherwise it is null and the ref is kept, since a name with no legal form may be a person's. |

### Reading them

- **When they fill.**
  - `street_ref`, the house number, the floors and `district_inferred` fill on every listing as the nightly run next sees it.
  - A listing ss.ge folds behind a look-alike gets them when its own page is read.
  - The complex and developer fill only once `details_read_at` is set. As with the 12B details, unknown is not "none".
- **Never a change.** None of them is in the listing's content hash. They never make a listing "changed", never set off a page read, and never touch `source_updated_at` or the price history.
- **C1 and C3.** C1's `places` filter on a district reads `district_ref`, so it matches the filled listings too. C3's district cells count them from `rules_version` 3.
- **Not public, on purpose:**
  - the pin (`latitude`/`longitude`) and whether the poster placed it;
  - the cadastral code, which leads to the owner through the public registry;
  - ss.ge's metro list. ss.ge works it out from the poster's pin, which is often wrong: a Didi Dighomi flat pinned on Liberty Square shows "Liberty Square, 5 min". Phase 14C publishes a checked metro instead (below).
- **The place tree** (ss.ge's municipalities, cities, districts, sub-districts and streets, with each street's point) is readable from Phase 14B as C6, below, together with Tbilisi's official districts and how the two maps overlap.

## C5: live listings, Phase 14C's columns (migration `0051`)

`realestate.public_listings` gains eleven more columns at its end, after `developer_name`, by `create or replace`. The archive and `recently_gone` gain the same eleven (C2), as they stood the night before the listing left. They are worked out at the end of every nightly ss.ge run, after the catalogue (`ss.ge listing locations judged` in its journal), and by `npm run places:ss-ge`. Every active listing has them after each run, including those first seen in it.

| Column | What |
|---|---|
| `official_district_ref`, `official_district_basis` | The Tbilisi official district the listing is in (C6's `official_district` ref), and what that rests on: `pin`, its own trusted pin; `street`, its street's location (C6); `area`, its ss.ge sub-district, when 10 or more distinct trusted pin positions there lie 95% in one district (all of them, below 20). Both null when none of these places it, and outside Tbilisi. |
| `location_precision` | How exactly the listing is placed, least to most: `none`, `municipality`, `city`, `district`, `subdistrict`, `street` (a located street), `house` (a located street and a house number), `pin` (a trusted pin). A street with no location places a listing no better than its sub-district. |
| `location_uncertain` | True when the pin, or ss.ge's metro claim worked out from it, contradicts the rest: one of the flags `pin_far_from_street`, `pin_far_from_area` or `metro_from_untrusted_pin`. Never null. An uncertain listing is placed by its street, never by its pin. |
| `location_flags` | Text array, empty when nothing is wrong. `pin_placeholder`: the map's default point, or one exact pin on 3 or more streets (an agency's default). `pin_broken`: more than 30 km from its city's pins, such as the latitude written as the longitude. `pin_far_from_street`, `pin_far_from_area`: see "Reading them". `metro_from_untrusted_pin`: ss.ge shows a metro for the listing, and the pin it was worked out from has one of those four flags. `house_number_junk`: the poster typed a number we could not read as a house number ("ოთახი25", "7ბ ბლოკი"; a bare "0" is no number). `district_inferred`: as C5's column. |
| `metro_station`, `metro_minutes`, `metro_basis`, `metro_nearby` | Our metro, from the best location: `metro_basis` is `pin` (its trusted pin), `building` (other listings' trusted pins in the same building), or `street` (its street's location). `metro_station` is the nearest station's ss.ge code (C6's `metro_station` code), `metro_minutes` ss.ge's own walking band (5, 10, 15, 20), and `metro_nearby` the codes of every station within 20 minutes, nearest first. A set basis with a null station and an empty `metro_nearby` means checked, and no station within 20 minutes. All four null when the listing is not located. |
| `building_key` | One building, for grouping: `c<complex_ref>`, else `s<street_ref>-<house number><letter>` (`s501-117დ`), else null. |
| `location_rules` | The rules version the columns were worked out under (`LOCATION_RULES_VERSION` in `src/realestate/location-rules.ts`): 1 from Phase 14C, 2 from Phase 14D (no rule changed; it adds `metro_nearby_minutes`). A change re-judges every listing the same night. |

### Reading them

- **A trusted pin** is one the poster placed (`pin_manual`), not the map's default, not one exact pin on 3 or more streets, and within 30 km of its city's pins. On a street its pins locate (C6's `official_source` `pins`), it must be within 600 m of the street's location, or have at least one other distinct pin position of the same street within 600 m, since an avenue runs for kilometres. Otherwise (a street located only by ss.ge's point, or not at all), it must be within 5 km of its sub-district's pin median instead (3 or more positions): a pin is never judged against ss.ge's point, which is off its street more often than a poster's pin is (see C6, "Reading it"). A pin with nothing to be checked against is neither trusted nor flagged. A candidate that fails is `pin_far_from_street` or `pin_far_from_area`. A pin ss.ge set itself is never trusted and never flagged. Each position counts once, so one flat posted three times is one position, not three.
- **Our metro is not ss.ge's list.** ss.ge's list is worked out from the pin, whatever the pin is, and stays private. Ours uses straight-line metres with edges fitted to ss.ge's own claims on poster-placed pins: up to 325 m is 5 minutes, 625 m is 10, 1,000 m is 15 and 1,325 m is 20. On 2026-11-08 that named ss.ge's nearest station for 97.5% of such listings, and its band within one step for 99%.
- **Coarse on purpose.** The pin, whether it is trusted, its distance to its street, its own official district and the distance to the metro are all private. Distances to two or three stations would give the pin back. So the public metro is as coarse as what ss.ge itself shows on a listing.
- **Unknown is not "no".** On a copy of production on 2026-11-08, of about 233,000 active Tbilisi listings, 44,563 had their official district by street, 37,319 by area and 2,826 by pin. 148,631 had none yet. Precision was mostly `subdistrict` (210,270 of 303,134); 235 listings were uncertain. Both grow as ss.ge's street points are read (300 a night) and as page reads bring pins.
- **Never a change.** Like Phase 14A's columns, none of them is in the content hash.
- **Comparing over time:** group by `location_rules`. The thresholds are recalibrated on more nights of data, and a change of rules moves listings between bases.

## C5: live listings, Phase 14D's column (migration `0053`)

`realestate.public_listings` gains one column at its end, after `location_rules`, by `create or replace`. The archive and `recently_gone` gain it too, after `location_rules` (C2).

| Column | What |
|---|---|
| `metro_nearby_minutes` | Each station's band in `metro_nearby`, in the same order: 5, 10, 15 or 20 minutes. Its first is `metro_minutes`; the rest never fall. Null where `metro_nearby` is. Worked out with the other location columns at the end of every run, under `location_rules` 2. |

- **Why it is public:** ss.ge's own results row shows every nearby station with its minutes, so this is no finer than ss.ge shows on each listing. Distances stay private, as before.
- **What it is for:** "within 10 minutes of Rustaveli" for a flat whose nearest station is another (C1 v2's `metro`).

## C6: places on both maps, and the place lookup (Phase 14B, migration `0050`; lookup v2 and `official_source` from Phase 14C, migration `0051`)

### Where

- **The catalogue:** the view `realestate.public_places`, which `scraplify_public` reads. It is refreshed as the last step of every nightly ss.ge run, after the totals (`ss.ge place catalogue refreshed` in its journal), and by `npm run places:ss-ge`.
- **The lookup:** `dist/realestate/place-lookup.js` in a built scraplify clone, imported the way C1 is. It opens no database connection: you run its SQL over your own connection. Use it for every place a person names, so their words and the catalogue's keys are folded by one implementation. Your `AREA_ALIASES`, `AREA_GROUPS` and `AREA_NEAREST` are ported into the catalogue (a test holds every one of them), so they can go. So can your splitting rule (N75): the text lookup applies it.

```js
import {
  PLACE_LOOKUP_VERSION, placeLookupSql, placeTextLookupSql, resolvePlaceText,
} from '<scraplify>/dist/realestate/place-lookup.js';

// One name:
const one = placeLookupSql('Vake', { placeholders: 'psycopg', limit: 20 });
// null when the words only name a kind of place ("street"); otherwise one.sql and one.params

// A whole text, which may name several places ("Vake, Saburtalo", "Temka/Zgvisubani"):
const text = placeTextLookupSql('Vake Saburtalo', { placeholders: 'psycopg', limit: 20 });
// run text.sql with text.params, then:
const { parts } = resolvePlaceText(text.text, rows);
// parts[i].segments[j] = { text, key, match, places }: the places each name in each part names, best first
```

`PLACE_LOOKUP_VERSION` is 2 (Phase 14C). It goes up whenever the folding or the lookup's output changes. Version 2 adds the city to every row, and keys every name with ჟ a second time with ჟ written "j", so "Vaja Pshavela" finds what "Vazha-Pshavela" does. Every other j stays j: folding it into z would merge ჯ with ჟ. `limit` is per name, a whole number from 1 to 500; anything else is 50.

### The two maps

Both are first-class and linked, and neither is renamed into the other (owner, 2026-11-06).

- **ss.ge's map**, as people use it: `city`, `district` (ss.ge's five combined Tbilisi districts, such as Old Tbilisi), `subdistrict` (its neighbourhoods), `street` and `municipality`. Each `ref` is ss.ge's own id, the same refs C1's `places` filter and C5's columns use.
- **The official map:**
  - `official_district`: Tbilisi's 10 districts by OpenStreetMap's borders. `ref` is OSM's relation id and `code` is a short name such as `isani`. Its parent is ss.ge's city Tbilisi (95).
  - `metro_station`: 22 stations. `ref` is ours and fixed (1–22), and `code` is ss.ge's station code, the key in ss.ge's metro lists. Station Square's two halls are one station, as on ss.ge. Its parent is the official district its point is in.
  - `neighbourhood`: the owner's names for places ss.ge does not have, under the ss.ge place their listings are listed under. For now this is only Zgvisubani, under Tbilisi Sea.
- **The links between the maps:** a street's and a station's `official_district_ref`, and an ss.ge district's and sub-district's `official_shares`.

### Columns

| Column | What |
|---|---|
| `source_id`, `level`, `ref` | The key. |
| `origin` | `ss.ge`, `osm` or `owner`. |
| `code` | A station's ss.ge code, an official district's short name, a neighbourhood's name. Null for ss.ge's places. |
| `name_ka`, `name_en` | The Georgian name: the one most active listings give, for ss.ge's places. The English name: OSM's for the official map, the owner's file for ss.ge's areas and cities (none for streets). |
| `name_roman` | `name_ka` in Latin letters, on every place: the national system, letter for letter as your `_ROMAN`, each word capitalized ("Chavchavadzis Gamz.", "Tsavkisi"). Show `name_en` where there is one, else this, so the bot and the website spell a place one way. Abbreviations stay as ss.ge writes them (ქ. is "K."). |
| `aliases` | Georgian names an ss.ge place went by before. |
| `match_keys` | What the lookup matches: every name's key. |
| `parent_level`, `parent_ref` | The parent on the place's own map. A neighbourhood's parent is an ss.ge place. |
| `latitude`, `longitude`, `point_status` | For a street: ss.ge's own point for the street, the same for every listing on it, and not anyone's home (`unknown`, `known`, or `none` where ss.ge has none). For a station: OSM's point. |
| `official_district_ref`, `official_basis` | For a street: the official district its location is in (Phase 14C). The location is the median of its active listings' poster-placed pins when they agree on it (one position, or at least two within 600 m of their median), else ss.ge's point, unless every one of those pins is more than 1 km from it; `official_source` says which. For a station: the district its point is in. `inside` means further than 50 m from any border; `border` means within 50 m, where either side is possible. Null outside Tbilisi's districts, for a street with neither agreeing pins nor a point, and for one whose pins all contradict its point. The street's location itself is private: a median of three pins can sit on one building. |
| `official_source` | For a street with an official district: `pins` or `ss.ge`, what its location came from. Null otherwise. Appended by migration `0051`; the last column of the view. |
| `official_shares` | For ss.ge's Tbilisi districts and sub-districts: `{"listings": n, "located": m, "by_district": {"isani": k, …}}`. Of its active listings, `located` are on a street whose official district is known, and `by_district` counts them per official district `code`. Null elsewhere. |
| `active_listings` | For ss.ge's places: the active listings that name it. For an official district: active listings on streets located in it (by pins or ss.ge's point). For a station: active listings whose ss.ge metro list names it; that is ss.ge's own claim, from the poster's pin, unchecked. A listing's checked metro is C5's `metro_station` (Phase 14C). Zero for a neighbourhood. |
| `first_seen_at`, `last_seen_at` | When the catalogue first and last held the place as it is. |

### The lookup's answer

Each row is a place for one `key` (a name's key; the text lookup asks for several), with its `rank` for that key and `match`.
- **The city (version 2):** `city_ref`, `city_name_ka`, `city_name_en`, `city_name_roman`, the last four columns: the city the place is in, up to three parents up (a city is its own). Null for a municipality. Use it to keep Batumi's street for "Rustaveli, Batumi", and to say when a city has no place of that name.
- **Names on the row:** the place's own, and its parent's (`parent_name_ka`, `parent_name_en`, `parent_name_roman`). For a street or station, its official district's (`official_name_ka`, `official_name_en`). For an ss.ge Tbilisi area, the official district holding most of its located listings: `official_top_code`, `official_top_name_ka`, `official_top_name_en` and `official_top_listings`, out of `official_shares.located`. That gives you "Avlabari: listed under Old Tbilisi; officially mostly in Isani (n of m located)" with no join.
- **`match`:** `exact` when one of the place's names has the same key as the words, and `partial` when the words come in order inside a name ("dighomi" in "Didi Dighomi").
- **Order (`rank`):** exact before partial. Then by group: ss.ge's areas (cities and villages, districts, sub-districts, the owner's neighbourhoods, municipalities), then the official map, then its stations, then streets. Within a group, the busiest comes first, so the Vake neighbourhood (21,367 listings) comes before the village called ვაკე (one listing).
- **The two-maps rule falls out of that order:**
  - a bare name means ss.ge's place: "Vake" is the neighbourhood first, with Vake District beside it, also exact;
  - "Vake district", "ვაკის რაიონი" and "vakis raioni" are the official district first;
  - a name only the official map has, such as "Krtsanisi", gives the official district first.
  - Word the difference from the rows: "Avlabari: listed under Old Tbilisi; officially in Isani".
- **Groups:** "Dighomi" is exact for its four ss.ge areas, as your `AREA_GROUPS` had it.
- **Several places can share a name.** Chavchavadze Avenue is several street ids in different sub-districts, so a lookup can give several exact rows. Choose among them with the person's other words, such as the city (`city_ref`).

### A text that names several places

`resolvePlaceText` applies your rule (N75, 2026-11-06), so it lives in one place.
- **Parts:** the text splits into parts on "/", "," and ";".
- **Names in a part:** each part is read left to right, taking the longest run of up to four words that is a place's whole name.
- **Words that each name a place stay separate:** "Vake Saburtalo" is two sub-districts, not the district their joined name is.
- **A hyphen keeps one word:** "vake-saburtalo" is the district.
- **Words that name nothing alone join:** "Old Tbilisi", "Didi Dighomi" and "Lisi Lake" are one place each.
- **A single word with no whole-name match** keeps its partial matches. A word naming nothing comes back with `match` null and no places.
- **Held by a test:** scraplify's `src/realestate/places/catalogue.test.ts` holds your six cases, plus "ვაკეში, საბურთალოზე" and "Chavchavadze Avenue".

### Reading it

- **Overlaps grow with the street locations.** `official_shares` counts each listing by its street's official district: from ss.ge's street points, 300 of which are read a night, busiest streets first, and from Phase 14C on, from streets' own pins. A listing's own pin is not used here (C5's `official_district_ref` uses it). Read `located` against `listings` before quoting a share.
- **ss.ge's street points are sometimes wrong, and pins win.** ss.ge places some streets by a namesake: Titsian Tabidze St in Vake carries Galaktion Tabidze St's point, 2.8 km away. Since Phase 14C, a street whose poster-placed pins agree is located by their median (`official_source` `pins`), wherever ss.ge's point is, even from one position: checked against OpenStreetMap's own line for 1,225 Tbilisi streets (2026-11-08), ss.ge's point was more than 500 m off its street for 29% of streets, a street's single pin position for 8%. A street whose pins disagree among themselves keeps ss.ge's point, unless they all lie more than 1 km from it; then it has none. The catalogue's journal line counts the streets whose pins contradict their point (`streetsDisputed`). From Phase 14B until then, a street with 3 or more such pins had no official district.
- **Some busy streets have no point at all.** ss.ge sends none for Chavchavadze Ave, Tsintsadze St, Vazha-Pshavela Ave and Gelovani Ave, among others: about 15% of Tbilisi's listings on 2026-11-08. With agreeing pins, they are located by them.
- **Unknown is not "no".** A street with neither agreeing pins nor a known point has no official district. That says nothing about where it is.
- **Credit.** The official districts and stations come from OpenStreetMap (ODbL). Anything showing them to people credits "© OpenStreetMap contributors" (`docs/RIGHTS.md`, Map data).
- **Not in it:** anything about a single listing. Pins, cadastral codes and ss.ge's per-listing metro lists stay private (C5).
