import { getTableColumns, type SQL, sql } from 'drizzle-orm';
import {
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
  uuid,
} from 'drizzle-orm/pg-core';
import { implausibleValuesOf } from '../../realestate/plausibility.js';
import {
  realEstateCurrencyEnum,
  realEstateDealTypeEnum,
  realEstateListings,
  realEstatePosterTypeEnum,
  realEstatePropertyTypeEnum,
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
 * Every column below except `listing_id`, `implausible` and `archived_at`
 * is copied from the `realestate.listings` column of the same name, so a
 * column added here is copied without touching the copy. Left out on
 * purpose: the link, the description and its search words, the coordinates,
 * photos (never stored), and the crawl's own bookkeeping. The street name and
 * number stay (owner decision, 2026-11-05): they are what re-grouping and
 * the "same flat listed again" fingerprint need, and the public site shows
 * them for every live listing anyway. No phone or person's name is stored
 * anywhere in the first place.
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
  },
  (table) => [
    index('archive_listings_source_key_idx').on(table.sourceId, table.sourceListingKey),
    index('archive_listings_gone_idx').on(table.goneAt),
  ],
);

/** The archive's columns that are not the listing's column of the same name. */
export const FILLED_AT_ARCHIVING = new Set(['listing_id', 'implausible', 'archived_at']);

const liveColumnsByName = new Map(
  Object.values(getTableColumns(realEstateListings)).map((column) => [column.name, column]),
);

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

export type RealEstateArchiveListingRow = typeof realEstateArchiveListings.$inferSelect;
export type RealEstateArchivePriceChangeRow = typeof realEstateArchivePriceChanges.$inferSelect;
export type RealEstateDailyTotalsRow = typeof realEstateDailyTotals.$inferSelect;
