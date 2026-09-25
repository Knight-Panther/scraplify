import {
  type AnyPgColumn,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

export const acquisitionModeEnum = pgEnum('acquisition_mode', ['feed', 'api', 'http', 'browser']);
export const authenticationScopeEnum = pgEnum('authentication_scope', ['none', 'required']);

/**
 * Mirrors src/domain/source.ts's SourceSchema, plus `currentPolicyRevisionId`
 * (round 6 of the adversarial review, 2026-09-24): a nullable pointer to the
 * ONE `source_policies` row currently in effect for this source. Nullable
 * because a freshly-seeded source (before its first policy sync ever runs)
 * genuinely has no current revision yet — there is no legitimate "default"
 * revision to point at, and the view/query layer's own "no policy row ->
 * default closed" posture already handles that gap correctly.
 *
 * `policyConflictAt` (round 9, 2026-09-25): set by `syncSourcePolicy()`
 * (`src/db/source-policies.ts`) the moment it sees an incoming policy whose
 * `reviewDate` exactly TIES a current revision's own `reviewDate` while its
 * content differs — an unresolvable ambiguity (two genuinely different
 * policy edits sharing a calendar day), not ordinary staleness. Without this
 * flag, whichever of two concurrently-syncing deployments happened to reach
 * the database first would silently become `currentPolicyRevisionId`, and
 * every OTHER deployment sharing that same (correct or stale) content would
 * see a plain 'no-op' from then on with no signal anything was ever
 * ambiguous — a first-writer-wins race that could leave a stale, more
 * permissive policy silently governing every future crawl if it happened to
 * win. Once set, EVERY sync for this source — including one whose content
 * already matches whatever's current — is refused until an operator
 * resolves the conflict with a genuinely later `reviewDate` (`syncSourcePolicy`
 * clears it back to null only on that outcome), and every crawl adapter's
 * `ensureXSourceSeeded()` treats a non-null value the same as a stale
 * refusal: abort before any network request.
 */
export const sources = pgTable('sources', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  displayName: text('display_name').notNull(),
  baseUrl: text('base_url').notNull(),
  currentPolicyRevisionId: uuid('current_policy_revision_id').references(
    (): AnyPgColumn => sourcePolicies.id,
  ),
  policyConflictAt: timestamp('policy_conflict_at', { mode: 'string', withTimezone: true }),
});

/**
 * An APPEND-ONLY revision log, mirroring `SourcePolicySchema` — round 6 of
 * the adversarial review (2026-09-24) restored this after round 5's
 * `.unique()` constraint (see git history on this column) turned out to be
 * an overcorrection: `docs/scraplify-concept.md` §5.3 explicitly requires
 * "a versioned policy record" with exactly the audit fields below
 * (`evidence`, `reviewDate`, `decisionOwner`), and round 5's overwrite-in-
 * place upsert silently destroyed a prior revision's evidence/rationale the
 * moment a new one was seeded — a real regression against a stated project
 * requirement, not just a style question. Nested structured fields
 * (rateLimit, retention, display, linkedResources, the path-pattern lists)
 * stay jsonb, read/written as whole objects, validated by the Zod schema on
 * the application side.
 *
 * Multiple rows per `sourceId` are legitimate and expected — this is a
 * history, not a lookup table. `sources.currentPolicyRevisionId` is the
 * ONLY thing that says which one is "current"; nothing about ordering,
 * recency, or a tiebreak column decides that anymore (rounds 2-4's entire
 * `LEFT JOIN LATERAL`/`ORDER BY`/`revisionSeq` apparatus, built to answer
 * exactly that question against this table directly, is gone for good —
 * the question now belongs to `sources.currentPolicyRevisionId`, an
 * explicit FK, not something a query has to infer).
 *
 * Rows are written by `src/db/source-policies.ts`'s `syncSourcePolicy()`
 * ONLY — never a bare insert/upsert in a crawl adapter directly — which is
 * also what actually answers round 6's first finding (activation
 * decoupled from crawl scheduling): it is called both by each adapter's
 * `ensureXSourceSeeded()` AND standalone via `npm run sync-policies`
 * (`src/cli/sync-source-policies.ts`), so an operator can activate a policy
 * edit immediately after deploying it rather than waiting for the next
 * scheduled crawl — which, per this file's own incident history, has
 * silently stopped running for a week before.
 */
export const sourcePolicies = pgTable('source_policies', {
  id: uuid('id').primaryKey().defaultRandom(),
  sourceId: uuid('source_id')
    .notNull()
    .references(() => sources.id),
  policyVersion: text('policy_version').notNull(),
  allowedAcquisitionModes: jsonb('allowed_acquisition_modes').notNull(),
  allowedPathPatterns: jsonb('allowed_path_patterns').notNull(),
  disallowedPathPatterns: jsonb('disallowed_path_patterns').notNull(),
  disallowedHosts: jsonb('disallowed_hosts').notNull(),
  allowedHosts: jsonb('allowed_hosts').$type<string[]>().notNull().default([]),
  authenticationScope: authenticationScopeEnum('authentication_scope').notNull(),
  rateLimit: jsonb('rate_limit').notNull(),
  termsUrl: text('terms_url'),
  robotsUrl: text('robots_url').notNull(),
  retention: jsonb('retention').notNull(),
  display: jsonb('display').notNull(),
  linkedResources: jsonb('linked_resources').notNull(),
  reviewDate: timestamp('review_date', { mode: 'string', withTimezone: true }).notNull(),
  evidence: jsonb('evidence').notNull(),
  notes: text('notes').notNull(),
  decisionOwner: text('decision_owner').notNull(),
  /** When this REVISION was created — real, immutable, never updated once written. */
  createdAt: timestamp('created_at', { mode: 'string', withTimezone: true }).notNull().defaultNow(),
});

export type SourceRow = typeof sources.$inferSelect;
export type NewSourceRow = typeof sources.$inferInsert;
export type SourcePolicyRow = typeof sourcePolicies.$inferSelect;
export type NewSourcePolicyRow = typeof sourcePolicies.$inferInsert;
