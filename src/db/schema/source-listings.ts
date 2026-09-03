import { sql } from 'drizzle-orm';
import {
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { resources } from './resources.js';
import { sources } from './sources.js';

/** §13 lifecycle states. */
export const sourceListingStatusEnum = pgEnum('source_listing_status', [
  'discovered',
  'active',
  'missing_suspected',
  'closed',
  'expired',
  'quarantined',
]);

export const extractionMethodEnum = pgEnum('extraction_method', ['http', 'browser']);

/**
 * Mirrors SourceListingSchema. currentRevisionId intentionally has no FK
 * constraint: it points into source_listing_revisions, which itself
 * references this table, and enforcing that specific circular pointer at
 * the DB level isn't worth the migration-ordering complexity at this
 * stage — the application layer (Phase 1A adapters) is responsible for
 * only ever setting it to a revision that actually exists.
 */
export const sourceListings = pgTable(
  'source_listings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id),
    sourceRecordId: text('source_record_id'),
    canonicalSourceUrl: text('canonical_source_url').notNull(),
    currentRevisionId: uuid('current_revision_id'),
    firstSeenAt: timestamp('first_seen_at', { mode: 'string', withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { mode: 'string', withTimezone: true }).notNull(),
    status: sourceListingStatusEnum('status').notNull(),
    missingStreak: integer('missing_streak').notNull().default(0),
    sourcePublishedAt: timestamp('source_published_at', { mode: 'string', withTimezone: true }),
    sourceDeadlineAt: timestamp('source_deadline_at', { mode: 'string', withTimezone: true }),
  },
  (table) => [
    // §12.1's identity rule, enforced in the database rather than only in
    // application logic — without these, a re-crawl or two overlapping
    // retries can insert duplicate rows for the same real listing, and
    // there's no key to make an upsert atomic against.
    //
    // Two partial indexes, not one, because the rule is conditional: a
    // source with stable external IDs is identified by (source, record id);
    // a source without them falls back to (source, canonical URL). A single
    // index over both columns wouldn't constrain the fallback case at all,
    // since Postgres treats each NULL source_record_id as distinct.
    uniqueIndex('source_listings_source_record_idx')
      .on(table.sourceId, table.sourceRecordId)
      .where(sql`${table.sourceRecordId} is not null`),
    uniqueIndex('source_listings_canonical_url_idx')
      .on(table.sourceId, table.canonicalSourceUrl)
      .where(sql`${table.sourceRecordId} is null`),
  ],
);

/**
 * Mirrors SourceListingRevisionSchema. provenance is split into real
 * columns rather than kept as one jsonb blob — specifically so
 * provenanceResourceId can be a genuine, enforced foreign key (§6.2:
 * every normalized claim must be traceable to a source resource), not a
 * value inside JSON that the database never checks actually points
 * anywhere.
 */
export const sourceListingRevisions = pgTable(
  'source_listing_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceListingId: uuid('source_listing_id')
      .notNull()
      .references(() => sourceListings.id),
    parserVersion: text('parser_version').notNull(),
    extractionMethod: extractionMethodEnum('extraction_method').notNull(),
    rawResourceHash: text('raw_resource_hash').notNull(),
    meaningfulContentHash: text('meaningful_content_hash').notNull(),
    titleRaw: text('title_raw').notNull(),
    titleNormalized: text('title_normalized').notNull(),
    organizationRaw: text('organization_raw'),
    description: text('description').notNull(),
    locations: jsonb('locations').notNull(),
    salaryRaw: text('salary_raw'),
    publishedDate: jsonb('published_date').notNull(),
    deadlineDate: jsonb('deadline_date').notNull(),
    applicationMethod: jsonb('application_method'),
    sourceCategories: jsonb('source_categories').notNull(),
    structuredAttributes: jsonb('structured_attributes').notNull(),
    createdAt: timestamp('created_at', { mode: 'string', withTimezone: true }).notNull(),
    provenanceResourceId: uuid('provenance_resource_id')
      .notNull()
      .references(() => resources.id),
    provenanceFetchedAt: timestamp('provenance_fetched_at', {
      mode: 'string',
      withTimezone: true,
    }).notNull(),
    provenanceNotes: text('provenance_notes'),
  },
  // Deliberately no lifetime-unique index on (sourceListingId,
  // meaningfulContentHash) here. A revision's content can legitimately
  // revert to a hash it already had (listing edited A -> B -> A), and that
  // third observation is a real, distinct revision, not a duplicate — a
  // blanket DB-level constraint can't tell "same content as an old
  // revision" apart from "same content as a concurrent retry of the
  // current fetch." Retry idempotency (§6.2) is instead enforced by the
  // Phase 1A ingestion logic, which only compares a freshly fetched
  // meaningfulContentHash against sourceListings.currentRevisionId's hash
  // (the one value a DB constraint can't see) before deciding whether to
  // insert a new revision.
  () => [],
);

export type SourceListingRow = typeof sourceListings.$inferSelect;
export type NewSourceListingRow = typeof sourceListings.$inferInsert;
export type SourceListingRevisionRow = typeof sourceListingRevisions.$inferSelect;
export type NewSourceListingRevisionRow = typeof sourceListingRevisions.$inferInsert;
