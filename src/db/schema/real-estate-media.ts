import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  index,
  primaryKey,
  pgSchema,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sources } from './sources.js';

/**
 * Photo references (Phase 17G, docs/PHASE_17_PLAN.md): the precondition for
 * a later, owner-approved image analysis. **No image is fetched, hashed,
 * thumbnailed or stored**: only each photo's path as the page names it,
 * without host or size (`canonicalPhotoRef`, src/adapters/ss-ge/poster.ts),
 * read from pages the crawler reads anyway. Private like the poster
 * directory: no public or admin grant.
 */
export const realEstateMedia = pgSchema('realestate_media');

/**
 * A listing's ordered photos as one kind of page shows them, one row per
 * change of that set: from when it was first seen (`valid_from`) until it
 * changed (`valid_to`, null while it holds). A results row shows a few of
 * them and a listing page all, so each `origin` keeps its own line and the
 * two never take turns. An unchanged set writes nothing. Keyed by the
 * source's listing key, so it outlives the live row.
 */
export const listingPhotoRefs = realEstateMedia.table(
  'listing_photo_refs',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id),
    sourceListingKey: text('source_listing_key').notNull(),
    /** `row` (a results row) or `listing_page`. */
    origin: text('origin').notNull(),
    validFrom: timestamp('valid_from', { mode: 'string', withTimezone: true }).notNull(),
    validTo: timestamp('valid_to', { mode: 'string', withTimezone: true }),
    refs: text('refs').array().notNull(),
    mainRef: text('main_ref'),
    /** How many photos the listing has, as the page says; a row shows fewer. */
    imageCount: smallint('image_count'),
    /** md5 of the refs in order, the main one and the count. */
    setHash: text('set_hash').notNull(),
  },
  (table) => [
    uniqueIndex('listing_photo_refs_open_idx')
      .on(table.sourceId, table.sourceListingKey, table.origin)
      .where(sql`${table.validTo} is null`),
    index('listing_photo_refs_listing_idx').on(
      table.sourceId,
      table.sourceListingKey,
      table.validFrom,
    ),
    // Which listings used a photo: the exact-match reuse the plan names.
    index('listing_photo_refs_refs_idx').using('gin', table.refs),
    check('listing_photo_refs_origin_check', sql`${table.origin} in ('row', 'listing_page')`),
    check(
      'listing_photo_refs_valid_check',
      sql`${table.validTo} is null or ${table.validTo} >= ${table.validFrom}`,
    ),
  ],
);

/** One row per distinct photo, with the listing it was first seen on: where a photo's chain begins. */
export const photoRefs = realEstateMedia.table(
  'photo_refs',
  {
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id),
    ref: text('ref').notNull(),
    firstSeenAt: timestamp('first_seen_at', { mode: 'string', withTimezone: true }).notNull(),
    firstListingKey: text('first_listing_key').notNull(),
    /** The date in the path, when it is one (`photoUploadDay`); a reading, not a fact. */
    uploadDay: date('upload_day', { mode: 'string' }),
    is360: boolean('is_360'),
    imageType: smallint('image_type'),
  },
  (table) => [primaryKey({ name: 'photo_refs_pk', columns: [table.sourceId, table.ref] })],
);

export type ListingPhotoRefRow = typeof listingPhotoRefs.$inferSelect;
export type PhotoRefRow = typeof photoRefs.$inferSelect;
