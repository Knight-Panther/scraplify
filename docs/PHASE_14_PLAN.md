# Phase 14 plan: where a listing is

The approved plan for Phase 14, kept as a tracker. Every item shows whether it is done, under way or not started, and what it waits on. Where building changed the plan, the item says so.

- **Approved** by the owner on 2026-11-06, in plan mode. The original is frozen at `~/.claude/plans/groovy-prancing-orbit.md` on the owner's PC. This copy is the one kept current.
- **Evidence and exit gates:** `docs/STATUS.md`, Phase 14. **All open work, every phase:** the Board at the top of `docs/STATUS.md`.
- **Keeping it current:** CLAUDE.md, "Tracking". It changes in the same commit as the STATUS gate it follows, and moves to `docs/archive/` when Phase 14 is complete.

**Marks:** ✅ done · ⏳ under way, or scheduled · ❌ not started · ↪ moved or dropped, with where it went. Times are UTC (Tbilisi is UTC+4).

## Where it stands (2026-11-07 19:30 UTC)

| Sub-phase | State | Waits on | Next |
|---|---|---|---|
| **14A** keep what ss.ge already sends | ✅ live since 2026-11-07 16:43 (`5006a19`, PR #80) | — | ⏳ the morning-after check on 2026-11-08, from the first run under 14A |
| **14B** official map, English names, Hermes's place catalogue (C6) | ✅ built, CI green, PR #81, not merged | 14A's morning-after check | merge 2026-11-08; deploy once that day's run has ended (13:40–20:30) |
| **14C** location quality | ❌ | 14B merged; two nights of 14A data | code 2026-11-08; thresholds 2026-11-09; deploy 2026-11-10 |
| **14D** C1 v2 for Hermes | ❌ | 14C live; Hermes's answer about 14D | build from 2026-11-11 |

## What waits on what

- **14A's morning-after check** waits on the first run under 14A: it starts about 2026-11-07 21:30 and ends about 13:40 the next day.
- **14B's merge** waits on that check passing. Until then `main` is the live release, so a 14A fix can ship alone.
- **14B's deploy** waits on the merge and on the ss.ge run having ended (its unit inactive), inside 13:30–20:30.
- **Hermes's combined note** waits on 14B being deployed and the catalogue filled. Its five asks are under "Docs and coordination".
- **14B's after-deploy checks** wait on the first nightly run on 14B (starting 2026-11-08 21:30), whose journal should say `ss.ge place catalogue refreshed`.
- **14C's code** waits on nothing. It is built on a branch stacked on 14B's.
- **14C's thresholds** wait on two nights of 14A data: pins with `pin_manual` beside their street points, and `ss_metro` claims. The second night's run ends about 2026-11-09 13:40.
- **14C's deploy** waits on 14B being live, the thresholds being set, and 13A's first-deletion check (the run starting 2026-11-09 21:30), so two first runs never share a night. That makes it 2026-11-10, after that run ends.
- **14C's threshold recheck** waits on a week of 14A data, about 2026-11-14. A changed threshold re-judges every listing overnight with no churn, because the raw evidence is kept and nothing derived is hashed.
- **14D's build** waits on 14C's columns, which its filters read, and on Hermes's answer about what C6 lacks for 14D.
- **14D's merge** waits on Hermes reviewing C1 v2's exact shape, as it reviewed C6.
- **`places:official-report`** waits on street points covering the busy streets, about four nights after 14B's deploy.
- **C3's official-district level** waits on a stable month of 14C.
- **13E, the building fingerprint** (outside this plan) waits on 14C's `building_key`.

## Goal

The owner wants Hermes to:
- tell flats, rents and sales apart down to the street and building;
- know Tbilisi's real map (is Bagebi in Vake or Saburtalo? Gldani or Nadzaladevi?);
- use metro proximity;
- never repeat a location claim the data contradicts.

Before Phase 14 we kept only the city, ss.ge's district and sub-district, the street name and number as free text, and a pin for 1.5% of Tbilisi listings. Hermes matched places with its own alias tables, which the owner's rule ("one implementation") puts in scraplify.

## Owner decisions (2026-11-06)

1. **Two maps, both first-class, linked; nothing renamed.**
   - ss.ge's names stay as people use them: "Old Tbilisi" (not an official district), the combined districts and the neighbourhoods. The 10 official districts are known exactly, and the catalogue records how the two maps overlap.
   - A search returns what the named place means on its own map. "Old Tbilisi" includes Avlabari, and so does "Isani district". Hermes says up front how the other map sees it: "Avlabari: listed under Old Tbilisi; officially Isani district".
   - A bare name ("Vake") means what people mean by it, ss.ge's neighbourhood. "Vake district" / "ვაკის რაიონი", or a name only the official map has (Krtsanisi), means the official district.
   - scraplify supplies the facts and links; Hermes does the wording.
2. **A contradicting location keeps the listing; only the safe part is trusted.**
   - The listing stays findable everywhere by its street and sub-district.
   - Its pin and metro claims are not used, and it is marked `location_uncertain`.
   - This is automatic, with no review queue.

## Ground rules every sub-phase keeps

- **No new kind of request to ss.ge.** `api-gateway.ss.ge` is refused (`src/policies/ss-ge.ts`), and `/en/` is outside the policy's paths. The catalogue comes only from results rows and listing pages, so a place that never had a listing is not in it. English names come from OpenStreetMap and a short owner-reviewed file.
- **Nothing new is hashed.** New results-row fields go through `rowExtrasOf` and the `MeaningfulFields` omit list (`src/realestate/ingest.ts`): written on every sighting, never a change, so no page-read backlog.
  - The district fill is the one fill of a hashed field. The hash, every write path and the unchanged path see the same filled row, and a stored inferred district is taken out and filled again before comparing.
  - Only the save path and one backfill CLI may write the hashed district. End-of-run refreshes write derived columns only.
- **Private stays private:** pins, `pin_manual`, `pin_street_m`, the pin's official district, `cadastral_code` and raw `ss_metro` stay out of the public views and the archive, and a test fails if one appears.
- **Views, archive and migrations:**
  - Views gain columns only at the end, by a hand-written `CREATE OR REPLACE`. drizzle-kit writes DROP and CREATE, which loses the grant.
  - New archive columns go after `archived_at`, in the same order as the `ALTER TABLE` statements and the re-issued `recently_gone`. The parity test in `expiry.test.ts` holds this, and every archive column needs a live column of the same name.
  - Migrations start with `SET lock_timeout = '10s'`, add only nullable or constant-default columns (no table rewrite), create no database functions, and are tried first on a Postgres 17 throwaway, the host's version.
  - Grants are applied after the migrate step, because `apply-db-roles.sh` stops at the first error.
- **No PostGIS** (the host's Postgres 17 has none). Distances are plain SQL arithmetic. Point-in-district runs in TypeScript against committed, simplified OSM borders, credited in `docs/RIGHTS.md` and C6. Runtime JSON is read from `src/` by URL, because `tsc` does not copy JSON.
- **Timing:** deploys and hand-run CLIs only between 13:30 and 20:30, outside the ss.ge crawl. CLIs that write listings take the crawl's process lock.

## What ss.ge sends (recon, 2026-11-06)

Kept because 14C calibrates against it.

- **Results rows** (read every night) carry `streetId`, `nearbySubwayStations` (a station and 5/10/15/20 minutes, on about 40% of Tbilisi rows) and developer floor lists such as "7, 10, 11".
- **Listing pages** add the pin and `isManualPin`, ss.ge's own point for the street (the same for every listing on a street id; 0/0 means none), `cadastralCode`, the developer complex and company, and the municipality (settlements only).
- **Street ids form a strict tree:** each Tbilisi street id is in one sub-district, each sub-district in one of 5 combined districts. Names repeat, ids don't: ჭავჭავაძე is 6 ids, and აბულაძის ქ. is in 4 sub-districts. 57 "streets" are microdistrict blocks (თემქა, გლდანი).
- **ss.ge works metro out from the pin**, not from the poster: a Didi Dighomi flat pinned on Liberty Square shows "Liberty Square, 5 min". A missing metro line does not mean far: one listing 264 m from Technical University had none.
- **Pins are often wrong.** Good pins are 25–100 m from their street point, up to about 1 km on long streets; bad ones are 1.4–11 km away. 399 of 3,476 Tbilisi pins were more than 3 km from their sub-district's centre. Repeated pins mark real buildings: 18 listings at Shartava 43.
- **The official map against ss.ge's:** most sub-districts sit 85–100% inside one official district (Bagebi: Vake, 93%). Officially Avlabari and Elia are Isani, Ortachala is Krtsanisi, Temqa is Nadzaladevi and Ivertubani is Chughureti. Some are split: "Saburtalo" 67% Saburtalo and 28% Vake, Lisi lake 67/33, the Vazha-Pshavela quarters 76/24 Vake/Saburtalo, Samgori 59/41 Samgori/Isani.

**Production on 2026-11-07, 18:55 UTC** (read for this tracker): 232,268 active Tbilisi listings, 6,224 of them with a pin (2.7%), and none yet with a street id, a street point, `pin_manual` or `ss_metro`. About 7,000 listing pages are read a night (7,444 on 2026-11-06), each bringing a pin, whether the poster placed it, and the street's point.

## Each level: what ss.ge gives and what we keep

| Level | Where ss.ge gives it | Decision | Public? | State |
|---|---|---|---|---|
| Municipality (64) | page only, for settlements | Learn settlement → municipality from one page read; copy it to the settlement's unread listings, flagged `municipality_inferred`. | yes | ✅ learned from page reads (14A); ❌ the copy and its flag (14C) |
| City / settlement | results row | as is | yes | ✅ |
| ss.ge district | results row; null on legacy listings | Filled at save from the sub-district's parent, marked `district_inferred`. | yes | ✅ 14A |
| **Official district** (10) | nobody: ours, from OSM borders | Per listing: trusted pin → street point → sub-district (≥ 95% in one district) → none, with the basis recorded. | yes | ✅ for street points, stations and area overlaps (14B); ❌ per listing (14C) |
| Sub-district | results row | as is | yes | ✅ |
| **Street** | results row `streetId`; page | `street_ref`, and a catalogue row per id | yes | ✅ 14A |
| House number | results row, free text | Keep raw; parse `house_number` and `house_suffix`; junk → null and a flag. | yes | ✅ parsed (14A); ❌ the junk flag (14C) |
| Floor | results row and page | `floor_low`/`floor_high` | yes | ✅ 14A |
| Building / complex | page | `complex_ref/name`, `developer_ref/name`, `cadastral_code`; derived `building_key` | complex and developer yes; cadastral **no** | ✅ kept (14A); ❌ `building_key` (14C) |
| Pin | page | Keep, with `pin_manual` and the pin's official district. | **no**, never archived | ✅ pin and `pin_manual` (14A); ↪ the pin's official district moved from 14B to 14C |
| **Street point** | page, one per street id | On the street's catalogue row (0/0 → "none"). | yes: ss.ge's point for a street, not a home | ✅ read (14A); its official district (14B) |
| **Metro** | results row and page, worked out from ss.ge's pin | Raw claims private (`ss_metro`); public, checked `metro_station`, `metro_minutes`, `metro_distance_m`, `metro_basis`, `metro_nearby`. | checked only | ✅ raw claims (14A); ❌ checked (14C) |
| Repost group | results row | as is | as is | ✅ |
| Apartment no., map POIs, house.ge link, mortgage rates | — | ignore | — | — |

## 14A: keep what ss.ge sends, with no churn, plus street points — ✅ live 2026-11-07

Gates and evidence: STATUS, Phase 14A.

- ✅ **Results row** (`toCard`, `src/adapters/ss-ge/list.ts`): `streetRef`, kept even when the phone rule drops the title; `ssMetro`, the smallest minutes per station, entrances merged (Isani is 81/82/84); `floorLow`/`floorHigh` from lists and ranges.
- ✅ **At save:** `house_number` and `house_suffix` from `src/realestate/address.ts`. "117დ" is 117 დ, "49-51" is 49, "№12" is 12; "0", punctuation or words are none.
  - Changed: "ხიზანიშვილის148" or "ოთახი25" also read as none; 14C flags them.
- ✅ **Listing page** (`readDetails`; `recordListingDetails`, `src/realestate/details.ts`): `pin_manual`, `cadastral_code` (shape-checked), complex and developer; the street, metro and floors again, reaching listings ss.ge folds behind a look-alike; the street point on the street's `places` row, 0/0 recorded as "none".
  - Changed: a developer's name is kept only with a legal form (შპს, სს, LLC), not "unless it reads as a person", because a sole trader trades under their own name (security review).
- ✅ **District fill at save:** a parents map loaded once per run, `district_inferred`, and the un-fill before comparing.
- ✅ **`realestate.places`**, keyed `(source_id, level, ref)`.
  - Changed: 14A created only the columns it fills. 14B added origin, code, English and Latin names, match keys and both maps' links in migration `0050`. There is no `curated` column: `name_en` says it.
- ✅ **`syncPlaces`** at the end of each run: new refs with their most common name and parent, counts and last seen, a renamed place's old name into `aliases`, settlement → municipality from read pages, and new refs per level logged.
- ✅ **Street-point reads:** up to 300 listing pages a night (about 18 minutes) after the checks and before the wanted details; busiest unknown street first, and one per settlement with no page read; counted in `details_count`, so Hermes's event is unchanged; a "none" asked again after 60 days.
  - Changed: a city is skipped only after 20 "none" answers and no known point, because Batumi has some points.
  - Expected: Tbilisi's streets without a point take about four nights, faster because every details read also brings its street's point.
- ✅ **By hand:** `npm run places:ss-ge`, with `-- --backfill` to re-read stored house numbers and fill stored districts. It makes no request to ss.ge and takes the crawl's lock. Changed: the plan called it `places-ss-ge sync --reparse`.
- ✅ **Migration `0049`:** listing columns, `places`, the `(source_id, street_ref)` index, the public view's and archive's appended columns, `recently_gone` re-issued, the worker's grant on `places`. Changed: `SET lock_timeout`, not `SET LOCAL`, so it holds with or without the migrator's transaction.
- ✅ **C3:** `TOTALS_RULES_VERSION` 3, since the fill moved about 1,200 listings into district cells; the day's totals retaken after the deploy.
- ✅ **Housekeeping:** test cleanup and the real-data fingerprint cover `places`; the capture allow-list keeps the new fields (cadastral digits masked, private posters' pins at 2 decimals, no company names); fixtures for a metro page, a developer page, a 0/0 street point and the default pin; test factories.
- ✅ **The morning after** (2026-11-08, the run that ended 13:39 UTC; numbers in STATUS's 14A gate):
  - ✅ new and changed counts like the nights before (changed 6.2% against 6.6%), and the wanted backlog grew as the night before 14A did;
  - ✅ `street_ref` on 99.8% of the Tbilisi listings seen. `ss_metro` on 29.1%: the plan's 40% was too high, and ss.ge's own cards show the same share;
  - ✅ active listings with a sub-district but no district: 0;
  - ✅ 1,894 streets in the tree, 677 with a point;
  - ✅ the public role sees the new columns and no private one.

## 14B: the official map, names and Hermes's catalogue (C6) — ✅ built, CI green, PR #81 not merged

Gates and evidence: STATUS, Phase 14B.

- ✅ **OpenStreetMap, fetched once** (`scripts/fetch-osm-places.mjs` → `src/realestate/places/tbilisi.json`, ODbL): the 10 districts with names, relation ids and borders simplified to about 10 m (54 KB).
  - Changed: 22 stations, not 23. Station Square's two halls are one station, as on ss.ge. Station refs are ours, 1–22, since OSM's node ids do not fit the integer key.
- ✅ **`officialDistrictAt`** (`src/realestate/places/official.ts`), marking a point within 50 m of a border as `border`.
- ✅ **Each street point's official district.** Changed: written by the catalogue refresh at the end of each run (`refreshPlaceCatalogue`, `src/realestate/places/catalogue.ts`), not inside `syncPlaces`.
  - Changed 2026-11-08, before the merge: ss.ge places some streets by a namesake (Titsian Tabidze St in Vake has Galaktion Tabidze's point, 2.8 km away). So a street whose own active listings' poster-placed pins (3 or more) sit more than 1 km from ss.ge's point gets no official district: 67 of the 245 checkable Tbilisi streets that night. This was the review's P3, which the first night's data turned into a correctness issue.
- ↪ **The pin's official district (private), with a one-off for older pins:** moved to 14C, because pins are unchecked until then.
- ✅ **Overlaps:** `official_shares` on ss.ge's Tbilisi districts and sub-districts, recomputed nightly. C1 never expands one map into the other.
  - Changed: counted from street points only, not pins, so a share grows with the street points. Read `located` against `listings` before quoting one.
- ✅ **Keys:** `placeKeys` and `nameKey` (`src/realestate/place-lookup.ts`), with Hermes's `_ROMAN` and `_LOOSE` letter for letter; type words dropped, initials and district words kept.
  - Changed: their own Georgian ending rule, not CV matching's `tokenize`/`stem`, which strips the plural -ები and would split ბაგები from "Bagebi".
- ✅ **The lookup:** `placeLookupSql` in both placeholder styles, and `PLACE_LOOKUP_VERSION` 1. Hermes imports it from `dist`, the way it calls C1.
  - Changed: an official district is also found by its name without the district word, in either language. That gives the two-maps rule from the lookup's order alone.
- ✅ **Added after Hermes's review (2026-11-07):** the whole-text lookup (`placeTextLookupSql` and `resolvePlaceText`, by Hermes's N75 rule), `name_roman` on every place, and each area's top official district on its lookup row.
- ✅ **`src/realestate/places/curated.json`:** English names and aliases for ss.ge's areas, with Hermes's `AREA_ALIASES`, `AREA_GROUPS` (Dighomi, four places) and `AREA_NEAREST` (Zgvisubani, an owner neighbourhood) ported in. Production has 53 Tbilisi sub-districts, not the plan's 51.
  - ⏳ The owner's one look. They are data, so not blocking.
- ❌ **`npm run places:official-report`** (per sub-district, its shares and split streets): deferred, not dropped. The overlaps are already in the view, and a report is worth reading once street points cover the busy streets, about four nights after the deploy.
- ✅ **C6:** the view `realestate.public_places`; `scraplify_public` reads the view only. Documented in `docs/hermes-contracts.md`, with the two-maps rule and the meanings.
- ⏳ **Hermes switches its item 3b (its H2 area words) to C6 and deletes its alias tables:** asked in the combined note at the deploy.
- ⏳ **Exit checks on production** (after the deploy):
  - 5 Tbilisi districts, 53 sub-districts and about 1,800 streets on ss.ge's map, with 10 official districts and 22 stations;
  - lookups: "Vake" gives the neighbourhood with Vake District beside it, "Chavchavadze" its streets, "dighomi" its four places, and "Medical University" the station;
  - Avlabari's row has Old Tbilisi as its parent and Isani as its official overlap;
  - the first nightly run's journal says `ss.ge place catalogue refreshed`.

## 14C: location quality — ❌ not started

- ❌ **Calibrate first**, read-only on production.
  - Changed 2026-11-07: on two nights of 14A data, not a week, then rechecked at a week. Each night brings thousands of pins with `pin_manual` beside their street points (see "Production on 2026-11-07" above). A week adds coverage, not a different spread, and a threshold change re-judges overnight.
  - Starting values: pin to street point 1,000 m; pin to sub-district centre 3,000 m; placeholder (41.6938, 44.8015) ± 50 m, or one pin on 3 or more street ids; metro minute edges for 5/10/15/20.
  - Known cases: the recon's 31 hand-checked listings were not kept by id. 14C builds its known cases from production while calibrating, including a Teimurazi St listing pinned on Liberty Square.
  - The chosen numbers go in STATUS and in the constants' comments, with their evidence.
- **What to expect:** pins reach about 3,000 more Tbilisi listings a night, so for months most listings are placed by their street, not their pin. `street` will be the common precision, and the official district and metro will mostly come from street points.
- **What the first night showed (2026-11-08), which 14C's design has to take in:**
  - **Street points are not as good as the recon sample suggested.** Poster-placed pins sat a median 434 m from their street's point, 75% within 1.2 km and 90% within 2.6 km (2,513 pins). Pins ss.ge set itself: median 491 m, 90% within 7.2 km (841). A fixed 1 km "far from street" rule would flag 29% of poster-placed pins.
  - **About a quarter of checkable street points are wrong:** 67 of 245 streets were more than 1 km from their own poster pins' median (namesake streets). The pin-to-street rule must compare against a checked street point (the catalogue now leaves a disputed one unplaced), or against the street's own pins.
  - **Some busy streets have no point at all:** Chavchavadze Ave, Tsintsadze St, Vazha-Pshavela Ave, Gelovani Ave and others, about 15% of Tbilisi listings. For them the street's location can come only from its listings' trusted pins (their median), and the plan's "building point" idea extends to a "street point from pins".
  - **Metro claims are on 29% of Tbilisi listings seen**, not the recon's 40% (flats 28–31%, daily flats 56%). A saved page agrees, so that is ss.ge's coverage.
  - **Broken pins exist:** some carry the latitude as the longitude (Shengelaia St, 41.7882, 41.7882). `pin_far_from_area` catches them.
- ❌ **`src/realestate/location.ts`:** `refreshListingLocations(db, {sourceId})`, one `UPDATE … FROM (CTEs)` over active rows that writes only rows whose derived values differ. It runs after the list walk and again before regrouping and totals (`src/cli/run-ss-ge-crawl.ts`). Its first run goes by hand, in chunks, outside the crawl. It computes:
  - ❌ the official district and its basis: trusted pin → street point → sub-district (share ≥ 0.95) → none, including the pin's own district, private (moved here from 14B);
  - ❌ `location_precision`: none < municipality < city < district < subdistrict < street < house < pin. "Pin" means placed by the poster, not a placeholder, and near its street point (or its sub-district's centre when the street has none);
  - ❌ `location_uncertain` (public) and `location_flags`: `pin_placeholder`, `pin_far_from_street`, `pin_far_from_area`, `metro_from_untrusted_pin`, `street_outside_subdistrict`, `district_mismatch`, `house_number_junk`, `district_inferred`, `municipality_inferred`. When uncertain, the precision comes from the street only, and the pin and ss.ge's metro claims are ignored but kept privately, so a threshold change judges them again;
  - ❌ metro from the best evidence: trusted pin → building point (the median trusted pin of one `building_key`) → ss.ge's claim when it agrees with the street point → street point. It gives `metro_station`, `metro_minutes` (on ss.ge's 5/10/15/20 scale), `metro_distance_m` (rounded to 50 m), `metro_basis` and `metro_nearby`;
  - ❌ `building_key`: `c<complex_ref>`, or `s<street_ref>-<number><suffix>`, for 13E;
  - ❌ the municipality copied to a settlement's unread listings;
  - ❌ `pin_street_m`, private.
- ❌ **`LOCATION_RULES_VERSION`**, exported for Hermes.
- ❌ **Migration `0051`:** the public derived columns appended to `public_listings` and the archive.
- ❌ **Docs:** the new columns in `docs/hermes-contracts.md`, a RUNBOOK §3 step 8 entry, `prod-status`, and 14C's gates in STATUS.

## 14D: Hermes's contracts — ❌ not started

- ⏳ **Agree first**, in Hermes's `.git/xtelo-speed/PLAN.md`:
  - ⏳ C6 and the bare-name rule: asked in the combined note at 14B's deploy;
  - ❌ the meanings of precision, flags and basis ("unknown" is not "no"; basis `street` means approximate);
  - ❌ C1 v2's exact JSON, with a v1 fallback;
  - ❌ C3's official level only after a stable month.
- ❌ **C1 v2** (`FILTER_BUILDER_VERSION` 2; `src/realestate/filters.ts`, `filter-builder.ts`, `filter-cases.json`):
  - `places` levels gain street, official_district and municipality (one line each in `PLACE_COLUMNS`);
  - `metro {maxMinutes, stations?}`, `minPrecision`, `excludeUncertain`;
  - output `locationCoverage`; unknown never matches, as with today's detail filters;
  - Hermes's ask (2026-11-07): each result row carries its place on both maps and how the other map sees it, from C6's overlaps, so the bot says "Avlabari: Old Tbilisi on ss.ge, officially Isani" without mapping anything itself.
- ❌ **Later:** C3's `area_level 'official_district'`, after a stable month of 14C.

**Not in this plan:** 13E's fingerprint itself (after 14A and 14C, on `street_ref` and `building_key`); street and metro filters on the website; korpus and block words read from descriptions.

## Docs and coordination

- ✅ After approval, Hermes was told that 14A only adds columns and how the district fill works (at 14A's deploy, session `hermes-5a`).
- ✅ STATUS has a Phase 14 section with a gate per sub-phase: 14A's and 14B's are written; 14C and 14D get theirs when they start.
- ✅ RUNBOOK §3 step 8: "Places" (14A) and "The place catalogue on both maps" (14B).
- ✅ Guideline: `pageProps.locations` marked gone, and places in §8.2.
- ✅ `docs/hermes-contracts.md`: C5's new columns and C6. ❌ C1 v2 (14D).
- ✅ `docs/RIGHTS.md`: OpenStreetMap's credit (ODbL).
- ✅ `prod-status`: places by level, known street points, and the catalogue.
- ✅ 13D's first nightly totals checked after the 2026-11-07 run.
- ⏳ **Hermes, for 14B** (owner, 2026-11-07: no piecemeal; the protocol's one line per event): one line at the merge; at the deploy, the notice and every ask in one message, shown to the owner first. The exact text waits in the session handoff until it is sent. The asks:
  1. add C6 to PLAN.md's contracts table;
  2. send H2's area words through `placeTextLookupSql` and `resolvePlaceText`, then delete `AREA_ALIASES`, `AREA_GROUPS`, `AREA_NEAREST`, the N75 splitter and whatever of `_ROMAN`/`_LOOSE` is left unused;
  3. show `name_en`, else `name_roman`; word the two maps from the rows; credit OpenStreetMap;
  4. 14A's coverage numbers from the morning-after check;
  5. anything C6 lacks for 14D.

## Verification still owed

14A's and 14B's are done and recorded in their STATUS gates.

- **14C, unit tests:** the flag and precision rules on the known cases (Teimurazi St pinned on Liberty Square: uncertain, precision from the street, metro from the street); the metro distance edges; placeholder pins.
- **14C, database tests:** the refresh leaves the hashed columns, `content_hash`, `details_*` and `last_seen_at` identical (snapshot before and after); a second refresh writes 0 rows; a street point arriving later, then a re-sighting, gives `unchanged`; the archive keeps the new columns and view parity holds; the public role reads the new public columns and no private one.
- **14C, planted faults** that must turn tests red: the refresh writing the district; archive columns out of order; a private column added to the view.
- **14D:** both maps on their own (an Avlabari listing matches district Old Tbilisi and official district Isani, each separately); C1 v2's cases in `filter-cases.json`; the v1 fallback.
- **Before each deploy:** a live trial into a disposable `scraplify_qa_*` database from the owner's PC, the deploy script inside 13:30–20:30, and `prod-status` the next morning.

## Risks and how each is contained

| Risk | Containment |
|---|---|
| Churn and a page-read backlog | nothing new hashed; one filled row everywhere; writer rules; tests and planted faults; the deploy checks watch the counters and the backlog |
| ss.ge renumbers or renames | refs kept raw and unhashed; renames become aliases; new refs per level logged by `syncPlaces` |
| A wrong street point or pin | the trusted-pin rule; a sub-district used only when ≥ 95% in one district; the basis recorded per row; border points marked; flags only lower trust and recompute overnight |
| Wrong thresholds | calibrated first and recorded with evidence; raw evidence kept, so a change re-judges overnight without churn |
| What "Vake" means | both maps explicit in C6; a bare name is the neighbourhood; Hermes words the difference |
| Privacy | pins, cadastral codes, raw metro claims and person-like developer names never public; a test enforces it |
| Locks during deploys | only in the 13:30–20:30 window; `lock_timeout`; no table rewrites; first refreshes by hand in chunks |
