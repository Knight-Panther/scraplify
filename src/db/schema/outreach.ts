import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { candidateProfiles } from './candidate.js';
import { opportunities, opportunityRevisions } from './opportunities.js';
import { sourceListingRevisions, sourceListings } from './source-listings.js';

export const outreachDraftKindEnum = pgEnum('outreach_draft_kind', ['email', 'cover_letter']);

export const outreachApprovalInvalidationEnum = pgEnum('outreach_approval_invalidation', [
  'edited',
  'deleted',
]);

export const auditActionEnum = pgEnum('audit_action', [
  'draft_generated',
  'draft_edited',
  'draft_approved',
  'approval_invalidated',
  'draft_deleted',
]);

/**
 * An outreach draft (concept §18, Phase 6A) — a cover letter, or an email to
 * the address a listing itself states.
 *
 * Every input the text was written from is pinned: the profile version, the
 * opportunity revision, and the source listing revision the recipient came
 * from. An approval binds all of them (see outreachApprovals), so a changed
 * listing or a revised profile cannot silently inherit an approval given to
 * different facts.
 *
 * `recipient` is never typed by a person or inferred: it is copied from the
 * pinned listing revision's own application method, and null for a cover
 * letter. It is not editable after creation.
 *
 * Holds CV-derived text. Purged with its profile (deleteCandidateProfile) and
 * never logged.
 */
export const outreachDrafts = pgTable(
  'outreach_drafts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => candidateProfiles.id),
    profileVersion: integer('profile_version').notNull(),
    opportunityId: uuid('opportunity_id')
      .notNull()
      .references(() => opportunities.id),
    opportunityRevisionId: uuid('opportunity_revision_id')
      .notNull()
      .references(() => opportunityRevisions.id),
    sourceListingId: uuid('source_listing_id')
      .notNull()
      .references(() => sourceListings.id),
    sourceListingRevisionId: uuid('source_listing_revision_id')
      .notNull()
      .references(() => sourceListingRevisions.id),
    kind: outreachDraftKindEnum('kind').notNull(),
    recipient: text('recipient'),
    /** Null for a cover letter, which has no subject line. */
    subject: text('subject'),
    body: text('body').notNull(),
    /** `ka` or `en`. */
    language: text('language').notNull(),
    /** Model and prompt version that produced the first text, e.g. `claude-opus-5/outreach-v1`. */
    generator: text('generator').notNull(),
    /** Ids of the profile claims the generated text relies on, validated at creation. */
    claimIds: jsonb('claim_ids').notNull(),
    createdAt: timestamp('created_at', { mode: 'string', withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { mode: 'string', withTimezone: true }).notNull(),
    deletedAt: timestamp('deleted_at', { mode: 'string', withTimezone: true }),
  },
  (table) => [
    index('outreach_drafts_profile_idx').on(table.profileId),
    index('outreach_drafts_opportunity_idx').on(table.opportunityId),
  ],
);

/**
 * An approval of one draft's exact content (concept §18: "approval is tied to
 * exact recipients, subject/body, attachments, listing, and version").
 *
 * `contentHash` covers every one of those; an approval is current only while
 * it is not invalidated AND the hash recomputed from the draft right now still
 * equals it AND the opportunity and listing revisions it bound are still the
 * current ones. Invalidation is written explicitly on edit or delete; the
 * recompute is the defense in depth for any write path that forgets.
 *
 * Rows are never deleted when invalidated — the history of what was approved,
 * and when it stopped counting, is the audit trail.
 */
export const outreachApprovals = pgTable(
  'outreach_approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    draftId: uuid('draft_id')
      .notNull()
      .references(() => outreachDrafts.id),
    contentHash: text('content_hash').notNull(),
    approvedAt: timestamp('approved_at', { mode: 'string', withTimezone: true }).notNull(),
    invalidatedAt: timestamp('invalidated_at', { mode: 'string', withTimezone: true }),
    invalidationReason: outreachApprovalInvalidationEnum('invalidation_reason'),
  },
  (table) => [
    // At most one approval per draft that has not been invalidated.
    uniqueIndex('outreach_approvals_one_live_per_draft_idx')
      .on(table.draftId)
      .where(sql`${table.invalidatedAt} is null`),
  ],
);

/**
 * Append-only record of every outreach mutation (concept §18: "audit every
 * approval, mutation, send, and failure").
 *
 * `details` carries ids and hashes ONLY — never draft, profile or CV text —
 * so the audit trail can be kept, exported or shown without becoming a second
 * copy of personal data that deletion would also have to find. No foreign key
 * on `entityId`: an audit row must outlive the draft it describes.
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    action: auditActionEnum('action').notNull(),
    occurredAt: timestamp('occurred_at', { mode: 'string', withTimezone: true }).notNull(),
    details: jsonb('details').notNull(),
  },
  (table) => [index('audit_events_entity_idx').on(table.entityType, table.entityId)],
);

export type OutreachDraftRow = typeof outreachDrafts.$inferSelect;
export type OutreachApprovalRow = typeof outreachApprovals.$inferSelect;
export type AuditEventRow = typeof auditEvents.$inferSelect;
