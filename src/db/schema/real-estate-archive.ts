import { getTableColumns, type SQL, sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  numeric,
  pgSchema,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { implausibleValuesOf } from '../../realestate/plausibility.js';
import {
  realEstateCrawlRuns,
  realEstateCurrencyEnum,
  realEstateDealTypeEnum,
  realEstateListingStatusEnum,
  realEstateListings,
  realEstatePosterTypeEnum,
  realEstatePropertyTypeEnum,
  realEstateRunStatusEnum,
} from './real-estate.js';
import { sources } from './sources.js';

/**
 * Real-estate history (Phase 13A): a slim copy of every listing the nightly
 * crawl deletes, fourteen days after it left the source, and of its price
 * changes, written in the same statement as the delete
 * (`deleteLongGoneListings`, `src/realestate/expiry.ts`). Nothing else writes
 * here, and nothing is ever updated or removed: the archive keeps the
 * evidence, and statistics, groups and fingerprints are worked out from it.
 *
 * Read by statistics and trends only (Hermes, Grafana), never by the website,
 * which shows live listings. Its own schema, so live data and history never
 * mix and grants and dumps can tell them apart.
 *
 * Every column below except `listing_id`, `implausible`, `archived_at` and
 * `first_source_created_at` is copied from the `realestate.listings` column
 * of the same name, so a column added here is copied without touching the
 * copy. Left out on purpose: the link, the description and its search words,
 * the coordinates, photos (never stored), and the crawl's own bookkeeping.
 * The street name and number stay (owner decision, 2026-11-05): they are
 * what re-grouping and the "same flat listed again" fingerprint need, and the
 * public site shows them for every live listing anyway.
 *
 * Phase 17A (owner decision, 2026-11-17) keeps the pin, the description and
 * the cadastral code too, privately, in `listing_private`, which no public
 * grant reaches; and adds the history the live table cannot keep: each
 * listing's versions, its spells on show, its look-alike groups by night,
 * and each run's quality (`src/realestate/history.ts`).
 */
export const realEstateArchive = pgSchema('realestate_archive');

export const realEstateArchiveListings = realEstateArchive.table(
  'listings',
  {
    /** The live row's id. A listing ss.ge shows again after its deletion comes back as a new row, so one source key can have several lives here. */
    listingId: uuid('listing_id').primaryKey(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id),
    sourceListingKey: text('source_listing_key').notNull(),
    dealType: realEstateDealTypeEnum('deal_type').notNull(),
    propertyType: realEstatePropertyTypeEnum('property_type').notNull(),
    commercialType: smallint('commercial_type'),
    landType: smallint('land_type'),
    rooms: smallint('rooms'),
    bedrooms: smallint('bedrooms'),
    areaM2: numeric('area_m2', { precision: 10, scale: 2 }),
    floor: smallint('floor'),
    totalFloors: smallint('total_floors'),
    /**
     * Both prices as last seen (`last_seen_at`), the poster's currency first:
     * ss.ge converts the other one at each day's exchange rate, so their
     * ratio is that day's rate. A price that moved is in `price_changes`.
     */
    priceGel: numeric('price_gel', { precision: 14, scale: 2 }),
    priceUsd: numeric('price_usd', { precision: 14, scale: 2 }),
    pricePerM2Usd: numeric('price_per_m2_usd', { precision: 12, scale: 2 }),
    pricePerM2Gel: numeric('price_per_m2_gel', { precision: 12, scale: 2 }),
    currencyPosted: realEstateCurrencyEnum('currency_posted'),
    cityRef: integer('city_ref'),
    cityName: text('city_name'),
    districtRef: integer('district_ref'),
    districtName: text('district_name'),
    subdistrictRef: integer('subdistrict_ref'),
    subdistrictName: text('subdistrict_name'),
    municipalityRef: integer('municipality_ref'),
    municipalityName: text('municipality_name'),
    streetName: text('street_name'),
    streetNumber: text('street_number'),
    posterType: realEstatePosterTypeEnum('poster_type').notNull(),
    posterEntity: text('poster_entity'),
    imageCount: smallint('image_count'),
    hasFurniture: boolean('has_furniture'),
    hasBuiltInKitchen: boolean('has_built_in_kitchen'),
    /** From the listing's own page (Phase 12B); null unless `details_read_at` is set. */
    buildingStatus: text('building_status'),
    condition: text('condition'),
    project: text('project'),
    floorType: text('floor_type'),
    bathrooms: smallint('bathrooms'),
    balconies: smallint('balconies'),
    kitchenArea: numeric('kitchen_area', { precision: 8, scale: 2 }),
    houseArea: numeric('house_area', { precision: 10, scale: 2 }),
    yardArea: numeric('yard_area', { precision: 12, scale: 2 }),
    amenities: text('amenities').array().notNull().default(sql`'{}'::text[]`),
    detailsReadAt: timestamp('details_read_at', { mode: 'string', withTimezone: true }),
    /** ss.ge's own id for a set of look-alike listings, when it gave one. */
    similarityGroup: text('similarity_group'),
    /** When the source says it was posted, which may be long before the crawl first saw it. */
    sourceCreatedAt: timestamp('source_created_at', { mode: 'string', withTimezone: true }),
    sourceUpdatedAt: timestamp('source_updated_at', {
      mode: 'string',
      withTimezone: true,
    }).notNull(),
    firstSeenAt: timestamp('first_seen_at', { mode: 'string', withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { mode: 'string', withTimezone: true }).notNull(),
    goneAt: timestamp('gone_at', { mode: 'string', withTimezone: true }).notNull(),
    goneReason: text('gone_reason'),
    /**
     * A price or area no real listing has, by the Real estate tab's rule
     * (`implausibleValuesOf`) when the row was archived. The fields it reads
     * are kept, so a later rule can be applied to old rows instead.
     */
    implausible: boolean('implausible').notNull(),
    archivedAt: timestamp('archived_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
    /*
     * Phase 14A (migration 0049). Declared last, in the order the migration
     * added them, so `recently_gone` keeps the table's own column order. Not
     * the metro list, the pin's kind or the cadastral code (private).
     */
    streetRef: integer('street_ref'),
    houseNumber: integer('house_number'),
    houseSuffix: text('house_suffix'),
    floorLow: smallint('floor_low'),
    floorHigh: smallint('floor_high'),
    districtInferred: boolean('district_inferred').notNull().default(false),
    complexRef: integer('complex_ref'),
    complexName: text('complex_name'),
    developerRef: integer('developer_ref'),
    developerName: text('developer_name'),
    /*
     * Phase 14C (migration 0051), in the order the migration adds them: the
     * public location columns as worked out the night before the listing left.
     * Not the pin's trust, its distance to the street or to the metro, or its
     * official district (private).
     */
    officialDistrictRef: integer('official_district_ref'),
    officialDistrictBasis: text('official_district_basis'),
    locationPrecision: text('location_precision'),
    locationUncertain: boolean('location_uncertain').notNull().default(false),
    locationFlags: text('location_flags').array().notNull().default(sql`'{}'::text[]`),
    metroStation: text('metro_station'),
    metroMinutes: smallint('metro_minutes'),
    metroBasis: text('metro_basis'),
    metroNearby: text('metro_nearby').array(),
    buildingKey: text('building_key'),
    locationRules: smallint('location_rules'),
    /* Phase 14D (migration 0053): each nearby station's band, in `metro_nearby`'s order. */
    metroNearbyMinutes: smallint('metro_nearby_minutes').array(),
    /*
     * Phase 17A (migration 0057), in the order the migration adds them. When
     * the listing was expected to end, and when its own page last confirmed
     * it, as they stood when it left.
     */
    expectedEndAt: timestamp('expected_end_at', { mode: 'string', withTimezone: true }),
    verifiedAt: timestamp('verified_at', { mode: 'string', withTimezone: true }),
    /**
     * The earliest posting time ever seen for it: the least of its own
     * `source_created_at` and every one its versions (`listing_versions`)
     * recorded, since a renewal can move the source's own date on.
     */
    firstSourceCreatedAt: timestamp('first_source_created_at', {
      mode: 'string',
      withTimezone: true,
    }),
  },
  (table) => [
    index('archive_listings_source_key_idx').on(table.sourceId, table.sourceListingKey),
    index('archive_listings_gone_idx').on(table.goneAt),
  ],
);

/** The archive's columns that are not the listing's column of the same name. */
export const FILLED_AT_ARCHIVING = new Set([
  'listing_id',
  'implausible',
  'archived_at',
  'first_source_created_at',
]);

const liveColumnsByName = new Map(
  Object.values(getTableColumns(realEstateListings)).map((column) => [column.name, column]),
);

/**
 * The earliest posting time known for a live row (`row` names it, with its
 * `id` and `source_created_at`): its own, or an earlier one its versions
 * recorded (Phase 17A). The row is named in full, since `listing_versions`
 * has columns of the same names.
 */
export function firstSourceCreatedAtOf(row: SQL): SQL {
  return sql`least(${row}.source_created_at, (
    select min(versions.source_created_at) from realestate_archive.listing_versions versions
     where versions.listing_id = ${row}.id))`;
}

type ArchivedRow = typeof realEstateArchiveListings.$inferSelect;
/** The view's fields, typed as the archive's (`archived_at` is always null in it). */
type RecentlyGoneFields = { [K in keyof ArchivedRow]: SQL.Aliased<ArchivedRow[K]> };

/**
 * Listings gone from the source but not yet archived (the fourteen days
 * before `deleteLongGoneListings` copies and deletes them), in the archive's
 * own columns and order, so that `listings` and this view together hold every
 * listing that has left: `select * from realestate_archive.listings union all
 * select * from realestate_archive.recently_gone`. `archived_at` is null here.
 * A row can still come back to life (the source lists it again), and then it
 * leaves this view for the live one.
 */
export const realEstateRecentlyGone = realEstateArchive.view('recently_gone').as((qb) =>
  qb
    .select(
      Object.fromEntries(
        Object.entries(getTableColumns(realEstateArchiveListings)).map(([key, column]) => {
          if (column.name === 'listing_id')
            return [key, sql`${realEstateListings.id}`.as(column.name)];
          if (column.name === 'implausible')
            return [key, implausibleValuesOf(realEstateListings).as(column.name)];
          if (column.name === 'archived_at') return [key, sql`null::timestamptz`.as(column.name)];
          if (column.name === 'first_source_created_at')
            return [
              key,
              firstSourceCreatedAtOf(sql.raw('"realestate"."listings"')).as(column.name),
            ];
          const live = liveColumnsByName.get(column.name);
          if (live === undefined) throw new Error(`realestate.listings has no ${column.name}`);
          return [key, sql`${live}`.as(column.name)];
        }),
      ) as RecentlyGoneFields,
    )
    .from(realEstateListings)
    .where(sql`${realEstateListings.status} = 'gone'`),
);

/** Every price change of an archived listing, copied as recorded (`realestate.price_changes`). */
export const realEstateArchivePriceChanges = realEstateArchive.table(
  'price_changes',
  {
    /** The live row's id. */
    id: uuid('id').primaryKey(),
    listingId: uuid('listing_id')
      .notNull()
      .references(() => realEstateArchiveListings.listingId, { onDelete: 'cascade' }),
    observedAt: timestamp('observed_at', { mode: 'string', withTimezone: true }).notNull(),
    oldPriceGel: numeric('old_price_gel', { precision: 14, scale: 2 }),
    newPriceGel: numeric('new_price_gel', { precision: 14, scale: 2 }),
    oldPriceUsd: numeric('old_price_usd', { precision: 14, scale: 2 }),
    newPriceUsd: numeric('new_price_usd', { precision: 14, scale: 2 }),
  },
  (table) => [index('archive_price_changes_listing_idx').on(table.listingId, table.observedAt)],
);

/** The area levels of `daily_totals`: `all` is every listing, whatever its place. */
export const TOTALS_AREA_LEVELS = ['all', 'city', 'district', 'subdistrict'] as const;
/** Room bands of `daily_totals`: `all` is every listing of the kind, rooms known or not. */
export const TOTALS_ROOMS_BANDS = ['all', '1', '2', '3', '4', '5+'] as const;

/**
 * What was on the market each day (Phase 13D, contract C3): one row per area
 * × deal × kind × room band, taken after each night's ss.ge run by the Real
 * estate tab's own rules (`src/realestate/totals.ts`). A day's listings cannot
 * be worked out again later, since which ones were on show and which were
 * reposts of one another is not kept, so this is the record of it. The
 * evidence of what came and went is in the archive, and those counts are
 * worked out from there instead.
 *
 * A cell with fewer than `TOTALS_MIN_LISTINGS` listings is left out.
 */
export const realEstateDailyTotals = realEstateArchive.table(
  'daily_totals',
  {
    /** The date in Tbilisi when the totals were taken. */
    day: date('day', { mode: 'string' }).notNull(),
    areaLevel: text('area_level').$type<(typeof TOTALS_AREA_LEVELS)[number]>().notNull(),
    /** ss.ge's id of the city, district or sub-district; 0 at level `all`. */
    areaRef: integer('area_ref').notNull(),
    /** Its Georgian name, as ss.ge showed it that day; null at level `all`. */
    areaName: text('area_name'),
    dealType: realEstateDealTypeEnum('deal_type').notNull(),
    propertyType: realEstatePropertyTypeEnum('property_type').notNull(),
    roomsBand: text('rooms_band').$type<(typeof TOTALS_ROOMS_BANDS)[number]>().notNull(),
    /** On show, reposts merged, typo prices left out: what the figures below are of. */
    listings: integer('listings').notNull(),
    /** The same before reposts are merged. */
    posts: integer('posts').notNull(),
    /** Of `listings`, those whose own page was read (Phase 12B). */
    withDetails: integer('with_details').notNull(),
    priceUsdP25: numeric('price_usd_p25', { precision: 14, scale: 2 }),
    priceUsdMedian: numeric('price_usd_median', { precision: 14, scale: 2 }),
    priceUsdP75: numeric('price_usd_p75', { precision: 14, scale: 2 }),
    pricePerM2UsdMedian: numeric('price_per_m2_usd_median', { precision: 12, scale: 2 }),
    priceGelMedian: numeric('price_gel_median', { precision: 14, scale: 2 }),
    pricePerM2GelMedian: numeric('price_per_m2_gel_median', { precision: 12, scale: 2 }),
    areaM2Median: numeric('area_m2_median', { precision: 10, scale: 2 }),
    takenAt: timestamp('taken_at', { mode: 'string', withTimezone: true }).notNull(),
    /** The run the totals were taken after; null when taken by hand. */
    crawlRunId: uuid('crawl_run_id'),
    /** `TOTALS_RULES_VERSION` when taken: a change to the rules shows as a step, not a trend. */
    rulesVersion: smallint('rules_version').notNull(),
  },
  (table) => [
    primaryKey({
      name: 'daily_totals_pk',
      columns: [
        table.day,
        table.areaLevel,
        table.areaRef,
        table.dealType,
        table.propertyType,
        table.roomsBand,
      ],
    }),
    check(
      'daily_totals_area_level_check',
      sql`${table.areaLevel} in ('all', 'city', 'district', 'subdistrict')`,
    ),
    check(
      'daily_totals_rooms_band_check',
      sql`${table.roomsBand} in ('all', '1', '2', '3', '4', '5+')`,
    ),
  ],
);

/**
 * What the archive keeps privately about a listing (Phase 17A, owner
 * decision 2026-11-17): its pin, whether the poster placed it, its whole
 * description and its parcel's cadastral code, copied in the same statement
 * as the rest (`deleteLongGoneListings`). Never shown, and a table of its
 * own so that no grant on the archive reaches it: the public role
 * (`scraplify_public`, the website's and Hermes's) has none, the worker
 * writes it, and the backup role reads everything.
 */
export const realEstateArchiveListingPrivate = realEstateArchive.table('listing_private', {
  listingId: uuid('listing_id')
    .primaryKey()
    .references(() => realEstateArchiveListings.listingId, { onDelete: 'cascade' }),
  latitude: numeric('latitude', { precision: 9, scale: 6 }),
  longitude: numeric('longitude', { precision: 9, scale: 6 }),
  pinManual: boolean('pin_manual'),
  /** As the poster wrote it, phone numbers and all: nothing is stripped. */
  description: text('description'),
  cadastralCode: text('cadastral_code'),
});

/**
 * Each listing's statistics fields over time (Phase 17A): one row from when
 * a set of them was first seen (`valid_from`) until it changed or the listing
 * was archived (`valid_to`, null while it holds). Written only by the nightly
 * step (`recordListingHistory`, `src/realestate/history.ts`), from a diff of
 * the live rows against their open version, and closed by the archive copy.
 * Kept for good.
 *
 * `version_hash` covers the fields the source states, the price in the
 * currency it was posted in, and the status. The converted price and the
 * prices per m² move with each day's exchange rate, and the nightly location
 * judgement (official district, metro, building, precision) with its rules,
 * so neither makes a version: `price_usd` and `price_gel` are kept as they
 * were when the version opened, and the derived location stays the latest
 * on the listing and its archive row. `house_number` and `house_suffix` are
 * read from `street_number`, which is hashed, so a change of that reading
 * makes no version either.
 */
export const realEstateListingVersions = realEstateArchive.table(
  'listing_versions',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    /** The live row's id, and its archive row's once it is archived. */
    listingId: uuid('listing_id').notNull(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id),
    sourceListingKey: text('source_listing_key').notNull(),
    validFrom: timestamp('valid_from', { mode: 'string', withTimezone: true }).notNull(),
    validTo: timestamp('valid_to', { mode: 'string', withTimezone: true }),
    versionHash: text('version_hash').notNull(),
    /**
     * A first version taken from a listing the step had not seen before it
     * (the backfill, or after a night the step failed): `valid_from` is when
     * the listing was first seen, and it may have changed since then.
     */
    approximate: boolean('approximate').notNull().default(false),
    dealType: realEstateDealTypeEnum('deal_type').notNull(),
    propertyType: realEstatePropertyTypeEnum('property_type').notNull(),
    commercialType: smallint('commercial_type'),
    landType: smallint('land_type'),
    rooms: smallint('rooms'),
    bedrooms: smallint('bedrooms'),
    areaM2: numeric('area_m2', { precision: 10, scale: 2 }),
    floor: smallint('floor'),
    totalFloors: smallint('total_floors'),
    floorLow: smallint('floor_low'),
    floorHigh: smallint('floor_high'),
    currencyPosted: realEstateCurrencyEnum('currency_posted'),
    /** The amount in `currency_posted`: what the poster typed. Null when no currency is given. */
    pricePosted: numeric('price_posted', { precision: 14, scale: 2 }),
    /** Both prices as seen when the version opened; the converted one is that day's rate. */
    priceUsd: numeric('price_usd', { precision: 14, scale: 2 }),
    priceGel: numeric('price_gel', { precision: 14, scale: 2 }),
    cityRef: integer('city_ref'),
    cityName: text('city_name'),
    districtRef: integer('district_ref'),
    districtName: text('district_name'),
    subdistrictRef: integer('subdistrict_ref'),
    subdistrictName: text('subdistrict_name'),
    municipalityRef: integer('municipality_ref'),
    municipalityName: text('municipality_name'),
    streetRef: integer('street_ref'),
    streetName: text('street_name'),
    streetNumber: text('street_number'),
    houseNumber: integer('house_number'),
    houseSuffix: text('house_suffix'),
    condition: text('condition'),
    buildingStatus: text('building_status'),
    posterType: realEstatePosterTypeEnum('poster_type').notNull(),
    posterEntity: text('poster_entity'),
    similarityGroup: text('similarity_group'),
    promoted: boolean('promoted').notNull(),
    status: realEstateListingStatusEnum('status').notNull(),
    sourceCreatedAt: timestamp('source_created_at', { mode: 'string', withTimezone: true }),
  },
  (table) => [
    // At most one open version per listing; also the nightly diff's way in.
    uniqueIndex('listing_versions_open_idx')
      .on(table.sourceId, table.listingId)
      .where(sql`${table.validTo} is null`),
    index('listing_versions_listing_idx').on(table.listingId, table.validFrom),
    check(
      'listing_versions_valid_check',
      sql`${table.validTo} is null or ${table.validTo} >= ${table.validFrom}`,
    ),
  ],
);

/**
 * When each listing was on show (Phase 17A): one row per stretch the Real
 * estate tab's own rule held it (`conditions` in `src/realestate/filters.ts`,
 * contract C1), judged by the nightly step at the same instant the night's
 * totals are taken (`takeDailyTotals`). A listing is on show at a night's
 * instant T when `shown_from <= T` and `shown_until` is null or after T, so
 * a night's listings can be rebuilt as `daily_totals` counted them. Only the
 * changes are written: a listing on show night after night is one row.
 * History starts on the night the step first ran (Phase 17A's deploy).
 */
export const realEstateShowSpells = realEstateArchive.table(
  'show_spells',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    listingId: uuid('listing_id').notNull(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id),
    sourceListingKey: text('source_listing_key').notNull(),
    shownFrom: timestamp('shown_from', { mode: 'string', withTimezone: true }).notNull(),
    shownUntil: timestamp('shown_until', { mode: 'string', withTimezone: true }),
    /** Its look-alike group when the spell opened; `listing_group_days` has every night's. */
    groupKey: text('group_key'),
  },
  (table) => [
    uniqueIndex('show_spells_open_idx')
      .on(table.sourceId, table.listingId)
      .where(sql`${table.shownUntil} is null`),
    check(
      'show_spells_valid_check',
      sql`${table.shownUntil} is null or ${table.shownUntil} >= ${table.shownFrom}`,
    ),
  ],
);

/**
 * Which look-alike group (`group_key`, Phase 11D) each active listing was in,
 * night by night (Phase 17A): the live key is cleared when a listing goes and
 * the archive has none, so this is where a repost group survives. One row per
 * listing and group, with the first and last Tbilisi day it was seen in it
 * and on how many nights; `nights` short of the days between means it left
 * and came back.
 */
export const realEstateListingGroupDays = realEstateArchive.table(
  'listing_group_days',
  {
    listingId: uuid('listing_id').notNull(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id),
    groupKey: text('group_key').notNull(),
    firstDay: date('first_day', { mode: 'string' }).notNull(),
    lastDay: date('last_day', { mode: 'string' }).notNull(),
    nights: integer('nights').notNull(),
  },
  (table) => [
    primaryKey({ name: 'listing_group_days_pk', columns: [table.listingId, table.groupKey] }),
    index('listing_group_days_group_idx').on(table.groupKey),
  ],
);

/**
 * One row per run of the nightly history step (Phase 17A), whether it
 * worked or not: what it opened and closed, how long it took, and the error
 * when it failed. For monitoring (`npm run health:check`) and for the step
 * itself, which tells a first version's exactness from the last attempt.
 */
export const realEstateHistorySteps = realEstateArchive.table(
  'history_steps',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id),
    /** The step's instant: the same as that night's `daily_totals.taken_at`. */
    takenAt: timestamp('taken_at', { mode: 'string', withTimezone: true }).notNull(),
    /** The run it followed; null when run by hand. */
    crawlRunId: uuid('crawl_run_id'),
    versionsOpened: integer('versions_opened').notNull().default(0),
    versionsClosed: integer('versions_closed').notNull().default(0),
    spellsOpened: integer('spells_opened').notNull().default(0),
    spellsClosed: integer('spells_closed').notNull().default(0),
    groupDays: integer('group_days').notNull().default(0),
    durationMs: integer('duration_ms').notNull(),
    ok: boolean('ok').notNull(),
    error: text('error'),
  },
  (table) => [index('history_steps_source_idx').on(table.sourceId, table.takenAt)],
);

/**
 * How each crawl run went, kept as long as `realestate.crawl_runs` is (for
 * good), so statistics can flag a night whose run was partial or failed, or
 * whose history step did not run, rather than read it as a market move
 * (Phase 17A). `day` is the Tbilisi date the run finished on, the day its
 * totals carry; `history_ok` is null when no history step followed it.
 */
export const realEstateRunQuality = realEstateArchive
  .view('run_quality', {
    crawlRunId: uuid('crawl_run_id').notNull(),
    sourceId: uuid('source_id').notNull(),
    day: date('day', { mode: 'string' }).notNull(),
    mode: text('mode').notNull(),
    status: realEstateRunStatusEnum('status').notNull(),
    startedAt: timestamp('started_at', { mode: 'string', withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { mode: 'string', withTimezone: true }),
    requestCount: integer('request_count').notNull(),
    failedRequestCount: integer('failed_request_count').notNull(),
    pageCount: integer('page_count').notNull(),
    rowCount: integer('row_count').notNull(),
    newCount: integer('new_count').notNull(),
    changedCount: integer('changed_count').notNull(),
    goneCount: integer('gone_count').notNull(),
    detailsCount: integer('details_count').notNull(),
    notes: text('notes'),
    historyOk: boolean('history_ok'),
  })
  .as(sql`
    select
      runs.id as crawl_run_id,
      runs.source_id as source_id,
      ((coalesce(runs.finished_at, runs.started_at) at time zone 'UTC') + interval '4 hours')::date as day,
      runs.mode as mode,
      runs.status as status,
      runs.started_at as started_at,
      runs.finished_at as finished_at,
      runs.request_count as request_count,
      runs.failed_request_count as failed_request_count,
      runs.page_count as page_count,
      runs.row_count as row_count,
      runs.new_count as new_count,
      runs.changed_count as changed_count,
      runs.gone_count as gone_count,
      runs.details_count as details_count,
      runs.notes as notes,
      (select steps.ok from ${realEstateHistorySteps} steps
        where steps.crawl_run_id = runs.id
        order by steps.taken_at desc limit 1) as history_ok
    from ${realEstateCrawlRuns} runs
  `);

export type RealEstateArchiveListingRow = typeof realEstateArchiveListings.$inferSelect;
export type RealEstateArchivePriceChangeRow = typeof realEstateArchivePriceChanges.$inferSelect;
export type RealEstateDailyTotalsRow = typeof realEstateDailyTotals.$inferSelect;
export type RealEstateListingVersionRow = typeof realEstateListingVersions.$inferSelect;
export type RealEstateShowSpellRow = typeof realEstateShowSpells.$inferSelect;
export type RealEstateHistoryStepRow = typeof realEstateHistorySteps.$inferSelect;
