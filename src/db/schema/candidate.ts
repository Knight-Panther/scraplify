import {
  boolean,
  doublePrecision,
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
import { opportunities, opportunityRevisions } from './opportunities.js';

export const candidateClaimKindEnum = pgEnum('candidate_claim_kind', [
  'role',
  'skill',
  'education',
  'certification',
  'language',
  'location_preference',
  'work_mode_preference',
  'salary_constraint',
  'schedule_constraint',
  'preferred_profession',
  'excluded_profession',
]);

export const candidateClaimOriginEnum = pgEnum('candidate_claim_origin', [
  'parsed',
  'confirmed',
  'manual',
]);

/**
 * Mirrors CandidateProfileSchema (§17.1).
 *
 * `version` increments on every accepted correction instead of the row being
 * edited in place: §17.2 requires each ranking to name the profile version it
 * used and forbids overwriting prior assessments when an input changes. An
 * in-place edit would silently invalidate every cached ranking pointing at
 * this profile while leaving those rankings claiming to be current.
 *
 * `deletedAt` is a soft delete for the PROFILE ROW ONLY, and is deliberately
 * not the whole deletion story: §6.2 requires real deletion of the raw CV,
 * derived profile, embeddings and cached assessments, which is a purge
 * operation over several tables (see deleteCandidateProfile). This column
 * exists so a profile can be withdrawn from ranking immediately, ahead of
 * that purge, not as a substitute for it.
 */
export const candidateProfiles = pgTable('candidate_profiles', {
  id: uuid('id').primaryKey().defaultRandom(),
  label: text('label').notNull(),
  version: integer('version').notNull().default(1),
  deletedAt: timestamp('deleted_at', { mode: 'string', withTimezone: true }),
  createdAt: timestamp('created_at', { mode: 'string', withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { mode: 'string', withTimezone: true }).notNull(),
});

/**
 * Mirrors CandidateProfileClaimSchema. `evidence` is §17.1's "pointer to
 * supporting CV content" — the actual quoted span, so a human reviewing the
 * profile can see what a claim was drawn from without re-opening the CV.
 *
 * Claims are versioned with their profile rather than independently: a claim
 * belongs to one immutable profile version, so correcting anything produces a
 * new profile version with a fresh claim set. That keeps "which claims did
 * this ranking actually see?" answerable from the profile version alone.
 *
 * This table holds CV-derived personal data. It is covered by the purge in
 * deleteCandidateProfile and must never be logged (§21.1 redacts CV contents).
 */
export const candidateProfileClaims = pgTable(
  'candidate_profile_claims',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => candidateProfiles.id),
    /** The profile version this claim belongs to — claims are never mutated across versions. */
    profileVersion: integer('profile_version').notNull(),
    kind: candidateClaimKindEnum('kind').notNull(),
    value: text('value').notNull(),
    /** Normalized form of `value`, for matching. Never displayed. */
    valueNormalized: text('value_normalized').notNull(),
    evidence: text('evidence'),
    origin: candidateClaimOriginEnum('origin').notNull(),
    confidence: doublePrecision('confidence').notNull(),
    years: doublePrecision('years'),
  },
  (table) => [
    index('candidate_profile_claims_profile_idx').on(table.profileId, table.profileVersion),
    index('candidate_profile_claims_kind_idx').on(table.kind, table.valueNormalized),
  ],
);

/**
 * Mirrors RankingSchema (§17.2) — a cached, self-explaining assessment of one
 * opportunity for one profile version.
 *
 * The unique index is the cache key §17.2 specifies: opportunity revision,
 * profile, profile version, and evaluation version. All four are required
 * because a ranking is only valid for the exact inputs that produced it —
 * change the listing content, the profile, or the scoring logic, and the old
 * result is a different answer to a different question. Because the key
 * includes every input, a changed input produces a NEW row rather than
 * overwriting the old one, which is what "never overwrite prior assessments"
 * means in practice.
 *
 * `opportunityRevisionId` is nullable: an opportunity whose canonical revision
 * has not been computed yet can still be ranked from its source listings, but
 * such a ranking pins no revision and must be recomputed once one exists.
 * NULLs are distinct in a Postgres unique index, so those rows do not collide
 * with each other — acceptable here, since an unpinned ranking is explicitly
 * provisional rather than cacheable.
 */
export const rankings = pgTable(
  'rankings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    opportunityId: uuid('opportunity_id')
      .notNull()
      .references(() => opportunities.id),
    opportunityRevisionId: uuid('opportunity_revision_id').references(
      () => opportunityRevisions.id,
    ),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => candidateProfiles.id),
    profileVersion: integer('profile_version').notNull(),
    evaluationVersion: text('evaluation_version').notNull(),
    /** Null when a hard filter excluded this opportunity — there is no score to give. */
    score: doublePrecision('score'),
    /** False when a hard filter rejected it outright (§17.2's first funnel stage). */
    eligible: boolean('eligible').notNull(),
    /**
     * §17.2 requires the result to explain itself, so the explanation is
     * stored WITH the score rather than recomputed on read: recomputing would
     * use today's ruleset against a ranking produced by an older one, and
     * silently show a rationale that never actually applied.
     */
    hardFilterReasons: jsonb('hard_filter_reasons').notNull(),
    componentScores: jsonb('component_scores').notNull(),
    createdAt: timestamp('created_at', { mode: 'string', withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('rankings_cache_key_idx').on(
      table.opportunityRevisionId,
      table.profileId,
      table.profileVersion,
      table.evaluationVersion,
    ),
    index('rankings_profile_score_idx').on(table.profileId, table.score),
  ],
);

export type CandidateProfileRow = typeof candidateProfiles.$inferSelect;
export type NewCandidateProfileRow = typeof candidateProfiles.$inferInsert;
export type CandidateProfileClaimRow = typeof candidateProfileClaims.$inferSelect;
export type NewCandidateProfileClaimRow = typeof candidateProfileClaims.$inferInsert;
export type RankingRow = typeof rankings.$inferSelect;
export type NewRankingRow = typeof rankings.$inferInsert;
