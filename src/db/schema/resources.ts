import { integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sources } from './sources.js';

export const resourceRoleEnum = pgEnum('resource_role', [
  'INDEX',
  'OPPORTUNITY',
  'ORGANIZATION',
  'APPLICATION',
  'ATTACHMENT',
]);
export const resourceStatusEnum = pgEnum('resource_status', [
  'pending',
  'fetched',
  'quarantined',
  'failed',
]);
export const resourceRelationshipEnum = pgEnum('resource_relationship', [
  'attachment',
  'application_link',
  'organization_link',
  'pagination',
]);

/** Mirrors ResourceSchema. originalUrl may be relative — stored as-is, no URL format constraint. */
export const resources = pgTable(
  'resources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id),
    role: resourceRoleEnum('role').notNull(),
    originalUrl: text('original_url').notNull(),
    canonicalUrl: text('canonical_url').notNull(),
    finalUrl: text('final_url'),
    status: resourceStatusEnum('status').notNull(),
    fetchedAt: timestamp('fetched_at', { mode: 'string', withTimezone: true }),
    contentHash: text('content_hash'),
    byteSize: integer('byte_size'),
    mimeType: text('mime_type'),
  },
  (table) => [
    // §11's request identity: canonical URL plus role. Without this, the
    // same URL discovered through several links (or re-discovered on a
    // later run) creates duplicate rows, which defeats request-level
    // deduplication and leaves no key to upsert against.
    //
    // §11 also mentions "any relevant processing version" as part of
    // identity. There is no such field on a resource today — parserVersion
    // lives on SourceListingRevision, since it's extraction that's
    // versioned, not fetching. If resource processing ever gets its own
    // version, it joins this index at that point rather than being
    // speculatively modelled now.
    uniqueIndex('resources_canonical_url_role_idx').on(
      table.sourceId,
      table.canonicalUrl,
      table.role,
    ),
  ],
);

/** Mirrors ResourceLinkSchema. */
export const resourceLinks = pgTable('resource_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  parentResourceId: uuid('parent_resource_id')
    .notNull()
    .references(() => resources.id),
  childResourceId: uuid('child_resource_id')
    .notNull()
    .references(() => resources.id),
  relationship: resourceRelationshipEnum('relationship').notNull(),
});

export type ResourceRow = typeof resources.$inferSelect;
export type NewResourceRow = typeof resources.$inferInsert;
export type ResourceLinkRow = typeof resourceLinks.$inferSelect;
export type NewResourceLinkRow = typeof resourceLinks.$inferInsert;
