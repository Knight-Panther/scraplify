import { jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const acquisitionModeEnum = pgEnum('acquisition_mode', ['feed', 'api', 'http', 'browser']);
export const authenticationScopeEnum = pgEnum('authentication_scope', ['none', 'required']);

/** Mirrors src/domain/source.ts's SourceSchema. */
export const sources = pgTable('sources', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  displayName: text('display_name').notNull(),
  baseUrl: text('base_url').notNull(),
});

/**
 * Mirrors SourcePolicySchema. Nested structured fields (rateLimit,
 * retention, display, linkedResources, and the path-pattern lists) are
 * stored as jsonb rather than normalized into their own tables — they're
 * read/written as whole objects, validated by the Zod schema on the
 * application side, and don't need independent relational queries.
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
});

export type SourceRow = typeof sources.$inferSelect;
export type NewSourceRow = typeof sources.$inferInsert;
export type SourcePolicyRow = typeof sourcePolicies.$inferSelect;
export type NewSourcePolicyRow = typeof sourcePolicies.$inferInsert;
