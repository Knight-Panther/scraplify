import { sql } from 'drizzle-orm';
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sources } from './sources.js';

/**
 * Real-estate listings (docs/real-estate-implementation-guideline.md §9), in
 * a schema of their own so that nothing built for job boards (revisions,
 * dedupe, taxonomy, the matching bundle, retention) ever reads or writes
 * them, and so backups and grants can treat them separately. Only the
 * `sources` row and its policy are shared with the rest of the database.
 */
export const realEstate = pgSchema('realestate');

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

/**
 * What a listing is searched by: its street, its location names and its
 * description, as a set of lowercased words.
 *
 * Built by hand, not by `to_tsvector`: the text-search parser decides what a
 * letter is from the database's locale, and the local and hosted databases
 * differ there (the same reason `src/browse/search-terms.ts` spells out its
 * letter ranges). Words are cut at anything outside digits, Latin and
 * Georgian letters.
 *
 * Two things are taken out of the description first. Any seven digits or
 * more with at most three non-letters between each pair, which is a phone
 * number however it is spaced (599 12 34 56, 599.12.34.56, +995 599-123-456),
 * because this column is readable through the public view and descriptions
 * are where posters type their numbers. And any
 * unbroken run of 60 characters or more, which is never a word and would be
 * refused as a lexeme.
 */
const LISTING_SEARCH_SQL = sql.raw(
  [
    'array_to_tsvector(array_remove(regexp_split_to_array(regexp_replace(lower(',
    "coalesce(street_name, '') || ' ' || coalesce(city_name, '') || ' ' || coalesce(subdistrict_name, '') || ' ' || ",
    "regexp_replace(coalesce(description, ''), '[0-9]([^0-9a-zA-Zა-ჿ]{0,3}[0-9]){6,}', ' ', 'g')",
    "), '[0-9a-zა-ჿ]{60,}', ' ', 'g'), '[^0-9a-zა-ჿ]+'), ''))",
  ].join(''),
);

export const realEstateDealTypeEnum = realEstate.enum('deal_type', ['sale', 'rent']);
export const realEstatePropertyTypeEnum = realEstate.enum('property_type', [
  'flat',
  'house',
  'cottage',
]);
export const realEstateCurrencyEnum = realEstate.enum('currency', ['gel', 'usd']);
/** `unknown` is a real answer: a source that does not say who posted is not saying "owner". */
export const realEstatePosterTypeEnum = realEstate.enum('poster_type', [
  'owner',
  'agent',
  'developer',
  'unknown',
]);
export const realEstateListingStatusEnum = realEstate.enum('listing_status', ['active', 'gone']);
export const realEstateRunStatusEnum = realEstate.enum('run_status', [
  'running',
  'completed',
  'partial',
  'failed',
]);

/**
 * One row per source listing, current state only. There is no revision
 * history: a full pass re-reads every listing, and at this volume a revision
 * per change would outgrow the rest of the database within weeks. The one
 * thing kept over time is the price (`price_changes`).
 *
 * No phone number, person's name or user id is stored; the parsers drop them.
 */
export const realEstateListings = realEstate.table(
  'listings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id),
    /** The source's own listing id. */
    sourceListingKey: text('source_listing_key').notNull(),
    canonicalUrl: text('canonical_url').notNull(),
    dealType: realEstateDealTypeEnum('deal_type').notNull(),
    propertyType: realEstatePropertyTypeEnum('property_type').notNull(),
    rooms: smallint('rooms'),
    bedrooms: smallint('bedrooms'),
    areaM2: numeric('area_m2', { precision: 10, scale: 2 }),
    floor: smallint('floor'),
    totalFloors: smallint('total_floors'),
    /** Both prices as the source gives them; nothing is converted here. */
    priceGel: numeric('price_gel', { precision: 14, scale: 2 }),
    priceUsd: numeric('price_usd', { precision: 14, scale: 2 }),
    pricePerM2Usd: numeric('price_per_m2_usd', { precision: 12, scale: 2 }),
    /** The currency the poster chose. */
    currencyPosted: realEstateCurrencyEnum('currency_posted'),
    /** The source's own location ids, with the names it showed beside them. */
    cityRef: integer('city_ref'),
    cityName: text('city_name'),
    districtRef: integer('district_ref'),
    districtName: text('district_name'),
    subdistrictRef: integer('subdistrict_ref'),
    subdistrictName: text('subdistrict_name'),
    streetName: text('street_name'),
    streetNumber: text('street_number'),
    posterType: realEstatePosterTypeEnum('poster_type').notNull().default('unknown'),
    /** Any paid placement on the source. */
    promoted: boolean('promoted').notNull().default(false),
    /** Searched, never shown on the public surface (the source policy's display rule). */
    description: text('description'),
    /** ss.ge's own id for a set of look-alike listings, when it gives one. */
    similarityGroup: text('similarity_group'),
    /** Set by the grouping phase; null until then. */
    groupKey: text('group_key'),
    sourceUpdatedAt: timestamp('source_updated_at', {
      mode: 'string',
      withTimezone: true,
    }).notNull(),
    sourceCreatedAt: timestamp('source_created_at', { mode: 'string', withTimezone: true }),
    /** When the source is expected to drop the listing unless it is renewed. */
    expectedEndAt: timestamp('expected_end_at', { mode: 'string', withTimezone: true }),
    /** When its detail page last confirmed it. */
    verifiedAt: timestamp('verified_at', { mode: 'string', withTimezone: true }),
    firstSeenAt: timestamp('first_seen_at', { mode: 'string', withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { mode: 'string', withTimezone: true }).notNull(),
    status: realEstateListingStatusEnum('status').notNull().default('active'),
    goneAt: timestamp('gone_at', { mode: 'string', withTimezone: true }),
    goneReason: text('gone_reason'),
    /** Hash of the fields whose change matters, so an unchanged row is never rewritten. */
    contentHash: text('content_hash').notNull(),
    search: tsvector('search').generatedAlwaysAs(LISTING_SEARCH_SQL),
  },
  (table) => [
    uniqueIndex('listings_source_key_idx').on(table.sourceId, table.sourceListingKey),
    index('listings_browse_idx').on(
      table.status,
      table.dealType,
      table.propertyType,
      table.cityRef,
      table.subdistrictRef,
    ),
    index('listings_source_updated_idx').on(table.sourceUpdatedAt),
    index('listings_price_usd_idx').on(table.priceUsd),
    index('listings_area_idx').on(table.areaM2),
    index('listings_expected_end_idx').on(table.status, table.expectedEndAt),
    index('listings_search_idx').using('gin', table.search),
  ],
);

/**
 * What the Real estate tab reads, on every surface, and all the public
 * database role can see of this schema: active listings without their
 * description. The description is searched (through `search`, which holds
 * its words but not its text) and never shown, by the source policy's
 * display rule.
 *
 * Whether a listing is still on show depends on the time of asking, so that
 * part is in `src/realestate/queries.ts`, as with the other public views.
 */
export const realEstatePublicListings = realEstate
  .view('public_listings', {
    id: uuid('id').notNull(),
    sourceId: uuid('source_id').notNull(),
    canonicalUrl: text('canonical_url').notNull(),
    dealType: realEstateDealTypeEnum('deal_type').notNull(),
    propertyType: realEstatePropertyTypeEnum('property_type').notNull(),
    rooms: smallint('rooms'),
    bedrooms: smallint('bedrooms'),
    areaM2: numeric('area_m2', { precision: 10, scale: 2 }),
    floor: smallint('floor'),
    totalFloors: smallint('total_floors'),
    priceGel: numeric('price_gel', { precision: 14, scale: 2 }),
    priceUsd: numeric('price_usd', { precision: 14, scale: 2 }),
    pricePerM2Usd: numeric('price_per_m2_usd', { precision: 12, scale: 2 }),
    currencyPosted: realEstateCurrencyEnum('currency_posted'),
    cityRef: integer('city_ref'),
    cityName: text('city_name'),
    districtRef: integer('district_ref'),
    districtName: text('district_name'),
    subdistrictRef: integer('subdistrict_ref'),
    subdistrictName: text('subdistrict_name'),
    streetName: text('street_name'),
    streetNumber: text('street_number'),
    posterType: realEstatePosterTypeEnum('poster_type').notNull(),
    promoted: boolean('promoted').notNull(),
    sourceUpdatedAt: timestamp('source_updated_at', {
      mode: 'string',
      withTimezone: true,
    }).notNull(),
    expectedEndAt: timestamp('expected_end_at', { mode: 'string', withTimezone: true }),
    firstSeenAt: timestamp('first_seen_at', { mode: 'string', withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { mode: 'string', withTimezone: true }).notNull(),
    search: tsvector('search'),
  })
  .as(sql`
    select
      ${realEstateListings.id} as id,
      ${realEstateListings.sourceId} as source_id,
      ${realEstateListings.canonicalUrl} as canonical_url,
      ${realEstateListings.dealType} as deal_type,
      ${realEstateListings.propertyType} as property_type,
      ${realEstateListings.rooms} as rooms,
      ${realEstateListings.bedrooms} as bedrooms,
      ${realEstateListings.areaM2} as area_m2,
      ${realEstateListings.floor} as floor,
      ${realEstateListings.totalFloors} as total_floors,
      ${realEstateListings.priceGel} as price_gel,
      ${realEstateListings.priceUsd} as price_usd,
      ${realEstateListings.pricePerM2Usd} as price_per_m2_usd,
      ${realEstateListings.currencyPosted} as currency_posted,
      ${realEstateListings.cityRef} as city_ref,
      ${realEstateListings.cityName} as city_name,
      ${realEstateListings.districtRef} as district_ref,
      ${realEstateListings.districtName} as district_name,
      ${realEstateListings.subdistrictRef} as subdistrict_ref,
      ${realEstateListings.subdistrictName} as subdistrict_name,
      ${realEstateListings.streetName} as street_name,
      ${realEstateListings.streetNumber} as street_number,
      ${realEstateListings.posterType} as poster_type,
      ${realEstateListings.promoted} as promoted,
      ${realEstateListings.sourceUpdatedAt} as source_updated_at,
      ${realEstateListings.expectedEndAt} as expected_end_at,
      ${realEstateListings.firstSeenAt} as first_seen_at,
      ${realEstateListings.lastSeenAt} as last_seen_at,
      ${realEstateListings.search} as search
    from ${realEstateListings}
    where ${realEstateListings.status} = 'active'
  `);

/** The only history kept: each time a listing's price moved, and from what to what. */
export const realEstatePriceChanges = realEstate.table(
  'price_changes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    listingId: uuid('listing_id')
      .notNull()
      .references(() => realEstateListings.id, { onDelete: 'cascade' }),
    observedAt: timestamp('observed_at', { mode: 'string', withTimezone: true }).notNull(),
    oldPriceGel: numeric('old_price_gel', { precision: 14, scale: 2 }),
    newPriceGel: numeric('new_price_gel', { precision: 14, scale: 2 }),
    oldPriceUsd: numeric('old_price_usd', { precision: 14, scale: 2 }),
    newPriceUsd: numeric('new_price_usd', { precision: 14, scale: 2 }),
  },
  (table) => [index('price_changes_listing_idx').on(table.listingId, table.observedAt)],
);

/**
 * One row per crawl run. Counters only: one row per request, as
 * `fetch_attempts` keeps for job boards, would add thousands of rows a night.
 */
export const realEstateCrawlRuns = realEstate.table(
  'crawl_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id),
    /** `sweep` reads every list to its end; `nightly` stops at rows the last run already saw. */
    mode: text('mode').notNull(),
    startedAt: timestamp('started_at', { mode: 'string', withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { mode: 'string', withTimezone: true }),
    status: realEstateRunStatusEnum('status').notNull().default('running'),
    requestCount: integer('request_count').notNull().default(0),
    failedRequestCount: integer('failed_request_count').notNull().default(0),
    pageCount: integer('page_count').notNull().default(0),
    rowCount: integer('row_count').notNull().default(0),
    newCount: integer('new_count').notNull().default(0),
    changedCount: integer('changed_count').notNull().default(0),
    bumpedCount: integer('bumped_count').notNull().default(0),
    unchangedCount: integer('unchanged_count').notNull().default(0),
    reopenedCount: integer('reopened_count').notNull().default(0),
    goneCount: integer('gone_count').notNull().default(0),
    verifiedCount: integer('verified_count').notNull().default(0),
    /** Where each list stopped, so an interrupted sweep resumes instead of restarting. */
    progress: jsonb('progress').notNull().default({}),
    notes: text('notes'),
  },
  (table) => [index('crawl_runs_source_started_idx').on(table.sourceId, table.startedAt)],
);

export type RealEstateListingRow = typeof realEstateListings.$inferSelect;
export type NewRealEstateListingRow = typeof realEstateListings.$inferInsert;
export type RealEstatePriceChangeRow = typeof realEstatePriceChanges.$inferSelect;
export type RealEstateCrawlRunRow = typeof realEstateCrawlRuns.$inferSelect;
