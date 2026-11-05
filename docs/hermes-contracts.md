# What scraplify promises Hermes

The owner's Hermes agent reads Xtelo's data and code read-only (`docs/RUNBOOK.md` §1, "Hermes' database tunnel"). This file defines the parts Hermes builds on. Scraplify owns each contract. Hermes reads it, checks it in its own tests, and falls back when it is missing. A change that removes or renames anything here is agreed with the owner first, and is a new version. Adding a column is not.

| Contract | What | State |
|---|---|---|
| C1 | Real-estate filter builder (SQL and parameters for `realestate.public_listings`) | not yet built (Phase 13, S3) |
| C2 | Real-estate archive (`realestate_archive`) | **v1, this branch (Phase 13A)** |
| C3 | Nightly real-estate totals | not yet built (S2) |
| C4 | Grafana dashboard links and variables | not yet built (S4) |
| C5 | `realestate.public_listings`, live listings | live (migrations `0040`–`0045`, `src/db/schema/real-estate.ts`) |

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

Never in it: the link, the description and its search words, the coordinates, photos, the poster's name or phone. Scraplify stores neither of the last two anywhere. ss.ge's own id is kept (`source_listing_key`), so a listing's address on ss.ge can be rebuilt from it, as `public_listings` shows it for live ones. Rows are kept for good: nothing deletes from the archive.

### Working things out

- **That day's exchange rate:** `price_gel / price_usd` on `last_seen_at`. ss.ge converts the price out of `currency_posted` daily. Treat it as approximate for small prices.
- **First price:** the earliest price change's old price, or the row's own price when there are no changes.
- **A price change** is a change in the posted currency. Exchange-rate-only rows were removed by migration `0043` and are not recorded since.
- **Days on the market:** `gone_at - coalesce(source_created_at, first_seen_at)`. For listings already live at the first sweep (2026-10-12), `first_seen_at` is that date, not the posting date.
- **Reposts (the same flat posted more than once):** no group key is stored, because the live one is cleared as a listing goes. Re-group from `deal_type`, `property_type`, `city_ref`, `subdistrict_ref`, `street_name`, `rooms`, `floor`, `total_floors`, `area_m2` and `price_usd` by scraplify's rule (`src/realestate/grouping.ts`). C1 or a later contract may offer that rule ready-made.

### When history starts

The first rows appear after the first nightly ss.ge run on the Phase 13A release that deletes anything. The oldest gone listings on 2026-11-05 left on 2026-10-27 (5,270 of them) and were still in the live table, so nothing is known to have been deleted before the archive. Departures ran at about 500–2,300 a day in early November 2026.
