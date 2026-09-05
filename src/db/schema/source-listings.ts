import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  foreignKey,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
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
 * Mirrors SourceListingRevisionSchema. provenance is split into real
 * columns rather than kept as one jsonb blob — specifically so
 * provenanceResourceId can be a genuine, enforced foreign key (§6.2:
 * every normalized claim must be traceable to a source resource), not a
 * value inside JSON that the database never checks actually points
 * anywhere.
 *
 * Declared before sourceListings (rather than after, where it reads more
 * naturally as "the child table") so that sourceListings's ownership FK
 * below can reference sourceListingId/id as already-initialized column
 * objects — foreignKey()'s columns/foreignColumns arrays aren't lazy the
 * way a single-column .references(() => ...) callback is, so the
 * referenced table has to exist first.
 *
 * Deliberately no lifetime-unique index on (sourceListingId,
 * meaningfulContentHash). A revision's content can legitimately revert to
 * a hash it already had (listing edited A -> B -> A), and that third
 * observation is a real, distinct revision, not a duplicate — a blanket
 * DB-level constraint can't tell "same content as an old revision" apart
 * from "same content as a concurrent retry of the current fetch." Full
 * retry-safe idempotency (§6.2) needs a locking write protocol
 * (SELECT ... FOR UPDATE the listing row, re-check, then insert+repoint
 * in one transaction) that only exists once there's ingestion code to
 * hold it — tracked as a Phase 1A requirement in docs/STATUS.md, not
 * implemented here.
 */
export const sourceListingRevisions = pgTable(
  'source_listing_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceListingId: uuid('source_listing_id')
      .notNull()
      .references((): AnyPgColumn => sourceListings.id),
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
  (table) => [
    // Composite-unique, not just id's existing primary key, so
    // sourceListings's ownership FK below can require both "this revision
    // exists" and "this revision belongs to the listing pointing at it" in
    // one constraint — a plain FK on id alone can't express the second
    // half.
    unique('source_listing_revisions_listing_id_id_unique').on(table.sourceListingId, table.id),
  ],
);

/**
 * Mirrors SourceListingSchema. currentRevisionId is enforced by a
 * composite ownership FK below: (id, current_revision_id) must match some
 * revision's (source_listing_id, id), so a failed transaction or repair
 * script can no longer point a listing at a nonexistent revision or at
 * another listing's revision — the database now verifies the relationship
 * between the two IDs, not just that current_revision_id happens to be a
 * valid UUID. NULL is still allowed (MATCH SIMPLE, Postgres's default):
 * a listing is inserted with a null pointer, its first revision is
 * inserted referencing it by sourceListingId, and only then is the
 * pointer updated — the three-step order this table's declaration order
 * exists to support.
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
    /** Mirrors SourceListingSchema.lastReconciledAt — see its comment there. */
    lastReconciledAt: timestamp('last_reconciled_at', { mode: 'string', withTimezone: true }),
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
    foreignKey({
      name: 'source_listings_current_revision_ownership_fk',
      columns: [table.id, table.currentRevisionId],
      foreignColumns: [sourceListingRevisions.sourceListingId, sourceListingRevisions.id],
    }),
  ],
);

export type SourceListingRow = typeof sourceListings.$inferSelect;
export type NewSourceListingRow = typeof sourceListings.$inferInsert;
export type SourceListingRevisionRow = typeof sourceListingRevisions.$inferSelect;
export type NewSourceListingRevisionRow = typeof sourceListingRevisions.$inferInsert;
