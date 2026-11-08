import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  type BuildingStatus,
  type CatalogueLevel,
  type Condition,
  DEAL_TYPES,
  type LocationPrecision,
  type MetroBasis,
  type OfficialBasis,
  type OfficialDistrictBasis,
  type PlaceOrigin,
  type PointStatus,
  PROPERTY_TYPES,
  type StreetLocationSource,
} from '../../realestate/kinds.js';
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

/** From `src/realestate/kinds.ts`, which keeps new values at the end (Postgres only appends). */
export const realEstateDealTypeEnum = realEstate.enum('deal_type', DEAL_TYPES);
export const realEstatePropertyTypeEnum = realEstate.enum('property_type', PROPERTY_TYPES);
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
 * thing kept over time is the price (`price_changes`). A listing deleted
 * fourteen days after it left the source is copied to `realestate_archive`
 * first (Phase 13A).
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
    /*
     * Phase 14A, kept current on every sighting and never a change
     * (`rowExtrasOf`, src/realestate/ingest.ts). `street_ref` is the source's
     * own street id: one street in one sub-district, where names repeat (six
     * Tbilisi streets are called Chavchavadze). The house number is read from
     * `street_number` (src/realestate/address.ts), which stays as typed.
     */
    streetRef: integer('street_ref'),
    houseNumber: integer('house_number'),
    houseSuffix: text('house_suffix'),
    /** The lowest and highest floor named: a developer's "7, 10, 11" or "2-14" too, where `floor` is null. */
    floorLow: smallint('floor_low'),
    floorHigh: smallint('floor_high'),
    /**
     * The metro stations the source lists near it, station → walking minutes.
     * ss.ge works them out from the poster's map pin, so a wrong pin makes them
     * wrong: kept, not shown, and not in the public view or the archive.
     */
    ssMetro: jsonb('ss_metro').$type<Record<string, number>>(),
    /**
     * The district was filled in from the sub-district's own (the source left
     * it out on its oldest listings), not stated by the source. Kept current on
     * every sighting.
     */
    districtInferred: boolean('district_inferred').notNull().default(false),
    posterType: realEstatePosterTypeEnum('poster_type').notNull().default('unknown'),
    /** Any paid placement on the source. */
    promoted: boolean('promoted').notNull().default(false),
    /**
     * ss.ge's own codes for a commercial space's type and a plot's land type
     * (`src/realestate/kinds.ts`), stored as numbers like the location refs so
     * a code it adds later is kept. Null when the row gives none.
     */
    commercialType: smallint('commercial_type'),
    landType: smallint('land_type'),
    /** How many photos the listing has. No photo is ever fetched or stored (Phase 12, decision 4). */
    imageCount: smallint('image_count'),
    /** Null when the source does not say: unknown is not "no". */
    hasFurniture: boolean('has_furniture'),
    hasBuiltInKitchen: boolean('has_built_in_kitchen'),
    exclusive: boolean('exclusive').notNull().default(false),
    /** The poster offers a viewing by video call. */
    videoViewing: boolean('video_viewing').notNull().default(false),
    pricePerM2Gel: numeric('price_per_m2_gel', { precision: 12, scale: 2 }),
    /*
     * From the listing's own page (Phase 12B), read once when it is new,
     * changed, renewed or reopened after 12B shipped; listings stored before
     * then stay unread until that happens (no backlog). Null is unknown, never
     * "no": a filter on these matches only rows with `details_read_at`. Keys
     * come from the vocabularies in `src/realestate/kinds.ts`.
     */
    buildingStatus: text('building_status'),
    condition: text('condition'),
    project: text('project'),
    floorType: text('floor_type'),
    bathrooms: smallint('bathrooms'),
    balconies: smallint('balconies'),
    kitchenArea: numeric('kitchen_area', { precision: 8, scale: 2 }),
    houseArea: numeric('house_area', { precision: 10, scale: 2 }),
    yardArea: numeric('yard_area', { precision: 12, scale: 2 }),
    /** individual, broker, agency or developer, as the page says. */
    posterEntity: text('poster_entity'),
    /** The amenities the page marks true, as keys (`AMENITY_FIELDS`). */
    amenities: text('amenities').array().notNull().default(sql`'{}'::text[]`),
    /** Kept, not shown, and not in the public view: on an owner's own listing they point at a home. */
    latitude: numeric('latitude', { precision: 9, scale: 6 }),
    longitude: numeric('longitude', { precision: 9, scale: 6 }),
    municipalityRef: integer('municipality_ref'),
    municipalityName: text('municipality_name'),
    /*
     * Phase 14A, from the page too. Whether the poster placed the pin (the
     * map's default point otherwise); private like the pin. A parcel's
     * cadastral code leads to its owner through the public registry, so it is
     * private too. The complex and its developer are businesses.
     */
    pinManual: boolean('pin_manual'),
    cadastralCode: text('cadastral_code'),
    complexRef: integer('complex_ref'),
    complexName: text('complex_name'),
    developerRef: integer('developer_ref'),
    developerName: text('developer_name'),
    /** When the listing's own page was last read for these fields. */
    detailsReadAt: timestamp('details_read_at', { mode: 'string', withTimezone: true }),
    /** Since when the crawl means to read its page; cleared once read. */
    detailsWantedAt: timestamp('details_wanted_at', { mode: 'string', withTimezone: true }),
    /** Searched, never shown on the public surface (the source policy's display rule). */
    description: text('description'),
    /** ss.ge's own id for a set of look-alike listings, when it gives one. */
    similarityGroup: text('similarity_group'),
    /**
     * The look-alike group it belongs to (`listing_groups`, Phase 11D), or
     * null when it matches no other listing or lacks a field the rule needs.
     */
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
    /**
     * When a full read of its list ended without it or any look-alike of it
     * in sight: a reason to ask its own page soon. Never a reason to drop it
     * by itself, since flat lists fold look-alikes. Cleared when it is seen or
     * confirmed again.
     */
    missedAt: timestamp('missed_at', { mode: 'string', withTimezone: true }),
    firstSeenAt: timestamp('first_seen_at', { mode: 'string', withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { mode: 'string', withTimezone: true }).notNull(),
    status: realEstateListingStatusEnum('status').notNull().default('active'),
    goneAt: timestamp('gone_at', { mode: 'string', withTimezone: true }),
    goneReason: text('gone_reason'),
    /**
     * Hash of the fields whose change matters, as of the last results-page
     * sighting. Changes are judged from the stored fields themselves
     * (src/realestate/ingest.ts), so a row stored under an older definition
     * of this hash is not taken for changed.
     */
    contentHash: text('content_hash').notNull(),
    search: tsvector('search').generatedAlwaysAs(LISTING_SEARCH_SQL),
    /*
     * Phase 14C, location quality (migration 0051). Derived every night by
     * `refreshListingLocations` (src/realestate/location.ts) from the fields
     * above and the place catalogue; outside the content hash, so a change
     * here is never a change of the listing. The first eleven are public.
     */
    /** The official district (OSM ref) and what it rests on: the trusted pin, the street's location, or the sub-district. */
    officialDistrictRef: integer('official_district_ref'),
    officialDistrictBasis: text('official_district_basis').$type<OfficialDistrictBasis>(),
    locationPrecision: text('location_precision').$type<LocationPrecision>(),
    /** True when the pin or ss.ge's metro claim contradicts the street; the flags say which. */
    locationUncertain: boolean('location_uncertain').notNull().default(false),
    locationFlags: text('location_flags').array().notNull().default(sql`'{}'::text[]`),
    /** Our metro, from the best location: the nearest station, its straight-line distance and ss.ge's minutes band. */
    metroStation: text('metro_station'),
    metroDistanceM: integer('metro_distance_m'),
    metroMinutes: smallint('metro_minutes'),
    metroBasis: text('metro_basis').$type<MetroBasis>(),
    /** Every station within the farthest minutes band, by its code, with its distance in metres. */
    metroNearby: jsonb('metro_nearby').$type<Record<string, number>>(),
    /** `c<complex_ref>` or `s<street_ref>-<number><suffix>`: one building, for grouping (13E). */
    buildingKey: text('building_key'),
    /** `LOCATION_RULES_VERSION` the derived columns were worked out under; null until the first refresh. */
    locationRules: smallint('location_rules'),
    /** Private, like the pin: whether it is trusted, its distance to the street's location, and its official district. */
    pinTrusted: boolean('pin_trusted'),
    pinStreetM: integer('pin_street_m'),
    pinOfficialDistrictRef: integer('pin_official_district_ref'),
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
    index('listings_group_key_idx').on(table.groupKey),
    index('listings_missed_idx')
      .on(table.sourceId, table.missedAt)
      .where(sql`${table.missedAt} is not null`),
    index('listings_amenities_idx').using('gin', table.amenities),
    index('listings_details_wanted_idx')
      .on(table.sourceId, table.detailsWantedAt)
      .where(sql`${table.detailsReadAt} is null`),
    index('listings_street_idx')
      .on(table.sourceId, table.streetRef)
      .where(sql`${table.streetRef} is not null`),
    check(
      'listings_official_district_basis_check',
      sql`${table.officialDistrictBasis} in ('pin', 'street', 'area')`,
    ),
    check(
      'listings_location_precision_check',
      sql`${table.locationPrecision} in ('none', 'municipality', 'city', 'district', 'subdistrict', 'street', 'house', 'pin')`,
    ),
    check('listings_metro_basis_check', sql`${table.metroBasis} in ('pin', 'building', 'street')`),
  ],
);

/**
 * A source's places (Phase 14A): its own tree of municipalities, cities and
 * settlements, districts, sub-districts and streets, each by the source's own
 * id, with the name its listings give it and its parent. Built from the
 * listings after every run (`syncPlaces`, src/realestate/places.ts), since
 * ss.ge's own lists are behind a host the source policy refuses. A street also
 * gets ss.ge's own point for it, from any one of its listings' pages: the
 * same point for every listing on the street, not anyone's home.
 *
 * Nothing is deleted: a place no active listing names keeps its row, with
 * `active_listings` at 0.
 *
 * Phase 14B adds the other map, under the same source: Tbilisi's official
 * districts and metro stations from OpenStreetMap (`origin` osm), the
 * owner's neighbourhoods (`origin` owner), English names, the keys a lookup
 * matches (`match_keys`, src/realestate/place-lookup.ts), each street
 * point's official district, and how each ss.ge district and sub-district
 * overlaps the official ones. Refreshed after every run
 * (`refreshPlaceCatalogue`, src/realestate/places/catalogue.ts).
 */
export const realEstatePlaces = realEstate.table(
  'places',
  {
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id),
    level: text('level').$type<CatalogueLevel>().notNull(),
    /** The source's own id; OSM's relation id for an official district; ours for a station or neighbourhood. */
    ref: integer('ref').notNull(),
    parentLevel: text('parent_level').$type<CatalogueLevel>(),
    parentRef: integer('parent_ref'),
    /** The name most of its active listings give it. */
    nameKa: text('name_ka').notNull(),
    /** Names it went by before. */
    aliases: text('aliases').array().notNull().default(sql`'{}'::text[]`),
    /** A street's point, as ss.ge places the street; a station's, from OSM. */
    latitude: numeric('latitude', { precision: 9, scale: 6 }),
    longitude: numeric('longitude', { precision: 9, scale: 6 }),
    pointStatus: text('point_status').$type<PointStatus>().notNull().default('unknown'),
    pointCheckedAt: timestamp('point_checked_at', { mode: 'string', withTimezone: true }),
    activeListings: integer('active_listings').notNull().default(0),
    firstSeenAt: timestamp('first_seen_at', { mode: 'string', withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { mode: 'string', withTimezone: true }).notNull(),
    // Phase 14B (migration 0050).
    origin: text('origin').$type<PlaceOrigin>().notNull().default('ss.ge'),
    /** A short fixed name: ss.ge's station code, an official district's English name. */
    code: text('code'),
    nameEn: text('name_en'),
    /** Every name's key (`nameKey`): what `placeLookupSql` matches. */
    matchKeys: text('match_keys').array().notNull().default(sql`'{}'::text[]`),
    /** A street's or a station's official district, by its point. */
    officialDistrictRef: integer('official_district_ref'),
    officialBasis: text('official_basis').$type<OfficialBasis>(),
    /** An ss.ge district's or sub-district's overlap with the official districts (C6). */
    officialShares: jsonb('official_shares').$type<OfficialShares>(),
    /** `name_ka` in Latin letters, for showing where there is no English name (`romanizedName`). */
    nameRoman: text('name_roman'),
    // Phase 14C (migration 0051).
    /**
     * A street's location: the median of its active listings' poster-placed
     * pins when there are enough, else ss.ge's point when those pins do not
     * contradict it. Private: a median of a few pins can sit on one building.
     */
    locatedLatitude: numeric('located_latitude', { precision: 9, scale: 6 }),
    locatedLongitude: numeric('located_longitude', { precision: 9, scale: 6 }),
    locatedBasis: text('located_basis').$type<StreetLocationSource>(),
    /** How many pins the median was taken over; 0 when the location is ss.ge's point. */
    locatedPins: integer('located_pins'),
    /** What a street's official district was worked out from: its listings' pins or ss.ge's point. Public. */
    officialSource: text('official_source').$type<StreetLocationSource>(),
  },
  (table) => [
    primaryKey({ name: 'places_pk', columns: [table.sourceId, table.level, table.ref] }),
    index('places_parent_idx').on(table.sourceId, table.parentLevel, table.parentRef),
    index('places_match_keys_idx').using('gin', table.matchKeys),
    check(
      'places_level_check',
      sql`${table.level} in ('municipality', 'city', 'district', 'subdistrict', 'street', 'official_district', 'metro_station', 'neighbourhood')`,
    ),
    check(
      'places_parent_level_check',
      sql`${table.parentLevel} in ('municipality', 'city', 'district', 'subdistrict', 'official_district')`,
    ),
    check('places_point_status_check', sql`${table.pointStatus} in ('unknown', 'known', 'none')`),
    check('places_origin_check', sql`${table.origin} in ('ss.ge', 'osm', 'owner')`),
    check('places_official_basis_check', sql`${table.officialBasis} in ('inside', 'border')`),
    check('places_located_basis_check', sql`${table.locatedBasis} in ('pins', 'ss.ge')`),
    check('places_official_source_check', sql`${table.officialSource} in ('pins', 'ss.ge')`),
  ],
);

/**
 * How an ss.ge district or sub-district lies on the official map: of its
 * active listings, how many are on a street whose point is known, and how
 * many of those each official district holds, by its code.
 */
export interface OfficialShares {
  listings: number;
  located: number;
  by_district: Record<string, number>;
}

/**
 * Hermes's place catalogue (contract C6, Phase 14B): every place on both
 * maps, with its names, parent, point, official district or overlaps, and the
 * keys a lookup matches. Nothing in `places` is private (a street's point is
 * ss.ge's point for the street, not anyone's home), so the view is the whole
 * table; it exists so the public role reads a view, as with every other
 * contract, and `places` can gain columns the contract does not promise.
 */
export const realEstatePublicPlaces = realEstate
  .view('public_places', {
    sourceId: uuid('source_id').notNull(),
    level: text('level').$type<CatalogueLevel>().notNull(),
    ref: integer('ref').notNull(),
    origin: text('origin').$type<PlaceOrigin>().notNull(),
    code: text('code'),
    nameKa: text('name_ka').notNull(),
    nameEn: text('name_en'),
    aliases: text('aliases').array().notNull(),
    matchKeys: text('match_keys').array().notNull(),
    parentLevel: text('parent_level').$type<CatalogueLevel>(),
    parentRef: integer('parent_ref'),
    latitude: numeric('latitude', { precision: 9, scale: 6 }),
    longitude: numeric('longitude', { precision: 9, scale: 6 }),
    pointStatus: text('point_status').$type<PointStatus>().notNull(),
    officialDistrictRef: integer('official_district_ref'),
    officialBasis: text('official_basis').$type<OfficialBasis>(),
    officialShares: jsonb('official_shares').$type<OfficialShares>(),
    activeListings: integer('active_listings').notNull(),
    firstSeenAt: timestamp('first_seen_at', { mode: 'string', withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { mode: 'string', withTimezone: true }).notNull(),
    nameRoman: text('name_roman'),
    // Phase 14C: appended, so `create or replace` keeps the grant (migration 0051).
    // Not the street's location, which is private.
    officialSource: text('official_source').$type<StreetLocationSource>(),
  })
  .as(sql`
    select
      ${realEstatePlaces.sourceId} as source_id,
      ${realEstatePlaces.level} as level,
      ${realEstatePlaces.ref} as ref,
      ${realEstatePlaces.origin} as origin,
      ${realEstatePlaces.code} as code,
      ${realEstatePlaces.nameKa} as name_ka,
      ${realEstatePlaces.nameEn} as name_en,
      ${realEstatePlaces.aliases} as aliases,
      ${realEstatePlaces.matchKeys} as match_keys,
      ${realEstatePlaces.parentLevel} as parent_level,
      ${realEstatePlaces.parentRef} as parent_ref,
      ${realEstatePlaces.latitude} as latitude,
      ${realEstatePlaces.longitude} as longitude,
      ${realEstatePlaces.pointStatus} as point_status,
      ${realEstatePlaces.officialDistrictRef} as official_district_ref,
      ${realEstatePlaces.officialBasis} as official_basis,
      ${realEstatePlaces.officialShares} as official_shares,
      ${realEstatePlaces.activeListings} as active_listings,
      ${realEstatePlaces.firstSeenAt} as first_seen_at,
      ${realEstatePlaces.lastSeenAt} as last_seen_at,
      ${realEstatePlaces.nameRoman} as name_roman,
      ${realEstatePlaces.officialSource} as official_source
    from ${realEstatePlaces}
  `);

/**
 * Look-alike listings, grouped after every crawl by `src/realestate/grouping.ts`
 * (guideline §5, Phase 11D): the same flat or house posted more than once,
 * by its owner and by agents. A row exists while a group has two or more
 * active members. Its key outlives a change of members, so a link to a group
 * keeps working from one night to the next.
 */
export const realEstateListingGroups = realEstate.table('listing_groups', {
  groupKey: text('group_key').primaryKey(),
  memberCount: integer('member_count').notNull(),
  formedAt: timestamp('formed_at', { mode: 'string', withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { mode: 'string', withTimezone: true }).notNull(),
});

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
    groupKey: text('group_key'),
    // Phase 12A: appended, so `create or replace` keeps the grant (migration 0044).
    commercialType: smallint('commercial_type'),
    landType: smallint('land_type'),
    imageCount: smallint('image_count'),
    hasFurniture: boolean('has_furniture'),
    hasBuiltInKitchen: boolean('has_built_in_kitchen'),
    exclusive: boolean('exclusive').notNull(),
    videoViewing: boolean('video_viewing').notNull(),
    pricePerM2Gel: numeric('price_per_m2_gel', { precision: 12, scale: 2 }),
    // Phase 12B: appended, so `create or replace` keeps the grant (migration 0045).
    // Not the coordinates, nor `details_wanted_at`, which is the crawl's own.
    buildingStatus: text('building_status').$type<BuildingStatus>(),
    condition: text('condition').$type<Condition>(),
    project: text('project'),
    floorType: text('floor_type'),
    bathrooms: smallint('bathrooms'),
    balconies: smallint('balconies'),
    kitchenArea: numeric('kitchen_area', { precision: 8, scale: 2 }),
    houseArea: numeric('house_area', { precision: 10, scale: 2 }),
    yardArea: numeric('yard_area', { precision: 12, scale: 2 }),
    posterEntity: text('poster_entity'),
    amenities: text('amenities').array().notNull(),
    municipalityRef: integer('municipality_ref'),
    municipalityName: text('municipality_name'),
    detailsReadAt: timestamp('details_read_at', { mode: 'string', withTimezone: true }),
    // Phase 14A: appended, so `create or replace` keeps the grant (migration 0049).
    // Not the metro list, the pin's kind or the cadastral code, which are private.
    streetRef: integer('street_ref'),
    houseNumber: integer('house_number'),
    houseSuffix: text('house_suffix'),
    floorLow: smallint('floor_low'),
    floorHigh: smallint('floor_high'),
    districtInferred: boolean('district_inferred').notNull(),
    complexRef: integer('complex_ref'),
    complexName: text('complex_name'),
    developerRef: integer('developer_ref'),
    developerName: text('developer_name'),
    // Phase 14C: appended, so `create or replace` keeps the grant (migration 0051).
    // Not the pin's trust, its distance to the street or its official district, which are private.
    officialDistrictRef: integer('official_district_ref'),
    officialDistrictBasis: text('official_district_basis').$type<OfficialDistrictBasis>(),
    locationPrecision: text('location_precision').$type<LocationPrecision>(),
    locationUncertain: boolean('location_uncertain').notNull(),
    locationFlags: text('location_flags').array().notNull(),
    metroStation: text('metro_station'),
    metroDistanceM: integer('metro_distance_m'),
    metroMinutes: smallint('metro_minutes'),
    metroBasis: text('metro_basis').$type<MetroBasis>(),
    metroNearby: jsonb('metro_nearby').$type<Record<string, number>>(),
    buildingKey: text('building_key'),
    locationRules: smallint('location_rules'),
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
      ${realEstateListings.search} as search,
      ${realEstateListings.groupKey} as group_key,
      ${realEstateListings.commercialType} as commercial_type,
      ${realEstateListings.landType} as land_type,
      ${realEstateListings.imageCount} as image_count,
      ${realEstateListings.hasFurniture} as has_furniture,
      ${realEstateListings.hasBuiltInKitchen} as has_built_in_kitchen,
      ${realEstateListings.exclusive} as exclusive,
      ${realEstateListings.videoViewing} as video_viewing,
      ${realEstateListings.pricePerM2Gel} as price_per_m2_gel,
      ${realEstateListings.buildingStatus} as building_status,
      ${realEstateListings.condition} as condition,
      ${realEstateListings.project} as project,
      ${realEstateListings.floorType} as floor_type,
      ${realEstateListings.bathrooms} as bathrooms,
      ${realEstateListings.balconies} as balconies,
      ${realEstateListings.kitchenArea} as kitchen_area,
      ${realEstateListings.houseArea} as house_area,
      ${realEstateListings.yardArea} as yard_area,
      ${realEstateListings.posterEntity} as poster_entity,
      ${realEstateListings.amenities} as amenities,
      ${realEstateListings.municipalityRef} as municipality_ref,
      ${realEstateListings.municipalityName} as municipality_name,
      ${realEstateListings.detailsReadAt} as details_read_at,
      ${realEstateListings.streetRef} as street_ref,
      ${realEstateListings.houseNumber} as house_number,
      ${realEstateListings.houseSuffix} as house_suffix,
      ${realEstateListings.floorLow} as floor_low,
      ${realEstateListings.floorHigh} as floor_high,
      ${realEstateListings.districtInferred} as district_inferred,
      ${realEstateListings.complexRef} as complex_ref,
      ${realEstateListings.complexName} as complex_name,
      ${realEstateListings.developerRef} as developer_ref,
      ${realEstateListings.developerName} as developer_name,
      ${realEstateListings.officialDistrictRef} as official_district_ref,
      ${realEstateListings.officialDistrictBasis} as official_district_basis,
      ${realEstateListings.locationPrecision} as location_precision,
      ${realEstateListings.locationUncertain} as location_uncertain,
      ${realEstateListings.locationFlags} as location_flags,
      ${realEstateListings.metroStation} as metro_station,
      ${realEstateListings.metroDistanceM} as metro_distance_m,
      ${realEstateListings.metroMinutes} as metro_minutes,
      ${realEstateListings.metroBasis} as metro_basis,
      ${realEstateListings.metroNearby} as metro_nearby,
      ${realEstateListings.buildingKey} as building_key,
      ${realEstateListings.locationRules} as location_rules
    from ${realEstateListings}
    where ${realEstateListings.status} = 'active'
  `);

/** Each time a listing's price moved, and from what to what; archived with its listing (`realestate_archive`). */
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
    /** Listing pages whose details this run saved (Phase 12B). */
    detailsCount: integer('details_count').notNull().default(0),
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
export type RealEstatePlaceRow = typeof realEstatePlaces.$inferSelect;
