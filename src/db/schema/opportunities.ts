import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  doublePrecision,
  foreignKey,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { organizations } from './organizations.js';
import { sourceListingStatusEnum, sourceListings } from './source-listings.js';

/** Initial opportunity types (§12.3). */
export const opportunityTypeEnum = pgEnum('opportunity_type', [
  'job',
  'summer_school',
  'scholarship',
  'grant',
  'event',
]);

/** Dedupe decision states (§14.1 stage 5). */
export const dedupeDecisionEnum = pgEnum('dedupe_decision', [
  'confirmed_same',
  'probable_same',
  'needs_review',
  'distinct',
]);

export const dedupeDecidedByEnum = pgEnum('dedupe_decided_by', ['ruleset', 'model', 'human']);

export const duplicateCandidateStatusEnum = pgEnum('duplicate_candidate_status', [
  'pending',
  'evaluated',
]);

export const duplicateGenerationMethodEnum = pgEnum('duplicate_generation_method', [
  'pg_trgm',
  'deterministic_match',
  'other',
]);

/**
 * Mirrors OpportunityRevisionSchema (§12.4). Declared before `opportunities`
 * so that table's ownership FK can reference already-initialized columns —
 * the same ordering constraint and three-step insert dance
 * source-listings.ts documents for its own revision pointer.
 */
export const opportunityRevisions = pgTable(
  'opportunity_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    opportunityId: uuid('opportunity_id')
      .notNull()
      .references((): AnyPgColumn => opportunities.id),
    canonicalTitle: text('canonical_title').notNull(),
    canonicalStatus: sourceListingStatusEnum('canonical_status').notNull(),
    organizationId: uuid('organization_id').references(() => organizations.id),
    /**
     * Field-level resolved values WITH provenance. §14.2 requires
     * disagreements to be surfaced rather than silently resolved, so this
     * holds each field's chosen value alongside which sources supported it
     * and which disagreed — not a flattened winner-takes-all object.
     */
    resolvedFields: jsonb('resolved_fields').notNull(),
    /**
     * Which SourceListingRevision each contributing source was at when this
     * canonical revision was computed. Without it there is no way to tell
     * whether a stale canonical view reflects old inputs or a changed
     * ruleset — both of which §12.4 requires to be distinguishable.
     */
    sourceMembershipVersions: jsonb('source_membership_versions').notNull(),
    resolutionRulesetVersion: text('resolution_ruleset_version').notNull(),
    meaningfulContentHash: text('meaningful_content_hash').notNull(),
    createdAt: timestamp('created_at', { mode: 'string', withTimezone: true }).notNull(),
  },
  (table) => [
    // Same reasoning as source_listing_revisions': lets the ownership FK
    // below require both "this revision exists" AND "it belongs to the
    // opportunity pointing at it".
    unique('opportunity_revisions_opportunity_id_id_unique').on(table.opportunityId, table.id),
  ],
);

/**
 * Mirrors OpportunitySchema (§12.3) — the probable real-world opportunity,
 * independent of any one source.
 *
 * `currentCanonicalRevisionId` carries the same composite ownership FK as
 * source_listings.currentRevisionId, so the database itself refuses to point
 * an opportunity at another opportunity's revision.
 */
export const opportunities = pgTable(
  'opportunities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: opportunityTypeEnum('type').notNull(),
    canonicalTitle: text('canonical_title').notNull(),
    organizationId: uuid('organization_id').references(() => organizations.id),
    canonicalStatus: sourceListingStatusEnum('canonical_status').notNull(),
    currentCanonicalRevisionId: uuid('current_canonical_revision_id'),
    createdAt: timestamp('created_at', { mode: 'string', withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { mode: 'string', withTimezone: true }).notNull(),
  },
  (table) => [
    foreignKey({
      name: 'opportunities_current_revision_ownership_fk',
      columns: [table.id, table.currentCanonicalRevisionId],
      foreignColumns: [opportunityRevisions.opportunityId, opportunityRevisions.id],
    }),
    index('opportunities_organization_idx').on(table.organizationId),
  ],
);

/**
 * Links a source listing to a canonical opportunity (§12.5).
 *
 * This is an append-only audit trail, NOT a mutable pointer: §12.5 requires
 * moving a listing between clusters to be reversible and audited, which a
 * single updated-in-place row cannot provide — the previous decision, its
 * evidence, and who made it would be destroyed by the very edit that most
 * needs explaining. `supersededAt` retires a row instead of deleting it, and
 * the partial unique index below enforces that a listing has at most ONE live
 * membership at a time while allowing any number of retired ones.
 */
export const opportunitySourceMemberships = pgTable(
  'opportunity_source_memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    opportunityId: uuid('opportunity_id')
      .notNull()
      .references(() => opportunities.id),
    sourceListingId: uuid('source_listing_id')
      .notNull()
      .references(() => sourceListings.id),
    decision: dedupeDecisionEnum('decision').notNull(),
    /** 0-1 confidence backing the decision. */
    confidence: doublePrecision('confidence').notNull(),
    /** The weighted signals that produced the decision (§14.1 stage 4). */
    evidence: jsonb('evidence').notNull(),
    decidedBy: dedupeDecidedByEnum('decided_by').notNull(),
    decidedAt: timestamp('decided_at', { mode: 'string', withTimezone: true }).notNull(),
    /** §14.2: recorded so decisions can be recomputed when the ruleset changes. */
    dedupeModelOrRulesetVersion: text('dedupe_model_or_ruleset_version').notNull(),
    /** Null while this is the live membership; set when a later decision replaces it. */
    supersededAt: timestamp('superseded_at', { mode: 'string', withTimezone: true }),
  },
  (table) => [
    uniqueIndex('opportunity_source_memberships_one_live_per_listing_idx')
      .on(table.sourceListingId)
      .where(sql`${table.supersededAt} is null`),
    index('opportunity_source_memberships_opportunity_idx').on(table.opportunityId),
  ],
);

/**
 * A candidate pair from index-based generation (§14.1 stage 3) — distinct
 * from a membership, which is the resolved link. Most candidates are never
 * evaluated; evaluation only happens once signals cross a review threshold.
 *
 * The pair is stored order-independently: callers must insert with
 * sourceListingIdA < sourceListingIdB, which the unique index then makes
 * genuinely one-row-per-pair rather than two mirrored rows.
 */
export const duplicateCandidates = pgTable(
  'duplicate_candidates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceListingIdA: uuid('source_listing_id_a')
      .notNull()
      .references(() => sourceListings.id),
    sourceListingIdB: uuid('source_listing_id_b')
      .notNull()
      .references(() => sourceListings.id),
    generatedAt: timestamp('generated_at', { mode: 'string', withTimezone: true }).notNull(),
    generationMethod: duplicateGenerationMethodEnum('generation_method').notNull(),
    /** Candidate-generation similarity, NOT the final weighted-evidence confidence. */
    similarityScore: doublePrecision('similarity_score').notNull(),
    status: duplicateCandidateStatusEnum('status').notNull(),
    /** Null while pending; set once evaluated (§14.1 stage 5). */
    resultingDecision: dedupeDecisionEnum('resulting_decision'),
    /**
     * Who produced `resultingDecision`. Null while pending.
     *
     * This exists to keep an operator's verdict authoritative: without it, the
     * next automated dedupe pass upserts its own result over a human's, so a
     * pair a reviewer settled as `distinct` reappears in the queue the moment
     * the ruleset still rates it `needs_review` — the correction is silently
     * discarded and the reviewer does the same work again (adversarial review,
     * 2026-09-06). The automated upsert refuses to overwrite a row decided by
     * a human.
     */
    decidedBy: dedupeDecidedByEnum('decided_by'),
  },
  (table) => [
    unique('duplicate_candidates_pair_unique').on(table.sourceListingIdA, table.sourceListingIdB),
    index('duplicate_candidates_status_idx').on(table.status),
  ],
);

export type OpportunityRow = typeof opportunities.$inferSelect;
export type NewOpportunityRow = typeof opportunities.$inferInsert;
export type OpportunityRevisionRow = typeof opportunityRevisions.$inferSelect;
export type NewOpportunityRevisionRow = typeof opportunityRevisions.$inferInsert;
export type OpportunitySourceMembershipRow = typeof opportunitySourceMemberships.$inferSelect;
export type NewOpportunitySourceMembershipRow = typeof opportunitySourceMemberships.$inferInsert;
export type DuplicateCandidateRow = typeof duplicateCandidates.$inferSelect;
export type NewDuplicateCandidateRow = typeof duplicateCandidates.$inferInsert;
