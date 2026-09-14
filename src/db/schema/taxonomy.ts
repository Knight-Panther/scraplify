import {
  type AnyPgColumn,
  doublePrecision,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { sourceListingRevisions } from './source-listings.js';
import { sources } from './sources.js';

/** §15.1 taxonomy axes — mirrors src/domain/taxonomy.ts's TaxonomyAxis exactly. */
export const taxonomyAxisEnum = pgEnum('taxonomy_axis', [
  'opportunity_type',
  'profession',
  'functional_area',
  'industry',
  'seniority',
  'employment_type',
  'schedule',
  'work_mode',
  'skill',
  'language',
  'education',
  'location',
]);

/** Mirrors src/domain/taxonomy.ts's ClassificationMethod exactly. */
export const classificationMethodEnum = pgEnum('classification_method', [
  'deterministic_rule',
  'keyword',
  'llm_classification',
  'human_review',
]);

/**
 * Mirrors TaxonomyTermSchema (§15.2) — one versioned term in the canonical,
 * source-independent taxonomy. `code` is a stable slug, independent of label
 * wording changes; `parentId` makes this a real tree.
 *
 * Phase 3C-2 seeds this entirely from hr.ge today, the only source with any
 * structured taxonomy input (`docs/STATUS.md`) — `code` is therefore
 * currently DERIVED from hr.ge's own stable node id rather than genuinely
 * source-independent in practice, even though the column itself carries no
 * source reference (that association lives on `sourceTaxonomyMappings`
 * below, per the domain contract's own separation). Documented here rather
 * than left implicit: a second source contributing the same concept would
 * need real matching logic to reuse a `code`, not create a duplicate term —
 * not attempted yet because nothing exercises that path today.
 */
export const taxonomyTerms = pgTable(
  'taxonomy_terms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    axis: taxonomyAxisEnum('axis').notNull(),
    code: text('code').notNull(),
    label: text('label').notNull(),
    taxonomyVersion: text('taxonomy_version').notNull(),
    parentId: uuid('parent_id').references((): AnyPgColumn => taxonomyTerms.id),
  },
  (table) => [
    // A stable slug is only stable if it is actually unique — otherwise two
    // terms could silently claim the same code and "look up by code" would
    // be ambiguous.
    unique('taxonomy_terms_code_unique').on(table.code),
    index('taxonomy_terms_parent_idx').on(table.parentId),
  ],
);

/**
 * Mirrors SourceTaxonomyMappingSchema (§15.2 steps 1-4) — one source's raw
 * category mapped to a canonical term. `sourceCategoryRaw` preserves the
 * source's own category id/label exactly, per §15.2 step 1; for hr.ge that
 * is its own stable node id (`specializationId`/`advancedIndustryId`), not a
 * display string, so the mapping survives a label being edited or corrected
 * without going stale.
 */
export const sourceTaxonomyMappings = pgTable(
  'source_taxonomy_mappings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id),
    sourceCategoryRaw: text('source_category_raw').notNull(),
    taxonomyTermId: uuid('taxonomy_term_id')
      .notNull()
      .references(() => taxonomyTerms.id),
    method: classificationMethodEnum('method').notNull(),
    /** Nullable per the domain contract: a deterministic structured-field mapping has nothing to be uncertain about. */
    confidence: doublePrecision('confidence'),
    taxonomyVersion: text('taxonomy_version').notNull(),
  },
  (table) => [
    // One mapping per raw category per source — re-running the seed script
    // against an unchanged source category must not create a duplicate row.
    unique('source_taxonomy_mappings_source_raw_unique').on(
      table.sourceId,
      table.sourceCategoryRaw,
    ),
    index('source_taxonomy_mappings_term_idx').on(table.taxonomyTermId),
  ],
);

/**
 * Mirrors ListingClassificationSchema (§15.2 steps 5-8) — a classification
 * applied to one listing REVISION, not the listing itself: content changes
 * over time, and a classification is only ever honest about the revision it
 * actually read (the same reasoning `opportunity_revisions.resolvedFields`
 * already applies).
 */
export const listingClassifications = pgTable(
  'listing_classifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceListingRevisionId: uuid('source_listing_revision_id')
      .notNull()
      .references(() => sourceListingRevisions.id),
    taxonomyTermId: uuid('taxonomy_term_id')
      .notNull()
      .references(() => taxonomyTerms.id),
    axis: taxonomyAxisEnum('axis').notNull(),
    method: classificationMethodEnum('method').notNull(),
    confidence: doublePrecision('confidence').notNull(),
    /** §15.2 step 7 — the signals behind this classification, as computed. */
    evidence: jsonb('evidence').notNull(),
    taxonomyVersion: text('taxonomy_version').notNull(),
    createdAt: timestamp('created_at', { mode: 'string', withTimezone: true }).notNull(),
  },
  (table) => [
    // One classification per revision per term — idempotent backfill re-runs
    // don't duplicate rows for a listing whose revision hasn't changed.
    unique('listing_classifications_revision_term_unique').on(
      table.sourceListingRevisionId,
      table.taxonomyTermId,
    ),
    index('listing_classifications_term_idx').on(table.taxonomyTermId),
    // §15.2 step 8's "queue low-confidence... for review" reads this table
    // filtered by confidence — no separate candidate table, see docs/STATUS.md.
    index('listing_classifications_confidence_idx').on(table.confidence),
  ],
);

export type TaxonomyTermRow = typeof taxonomyTerms.$inferSelect;
export type NewTaxonomyTermRow = typeof taxonomyTerms.$inferInsert;
export type SourceTaxonomyMappingRow = typeof sourceTaxonomyMappings.$inferSelect;
export type NewSourceTaxonomyMappingRow = typeof sourceTaxonomyMappings.$inferInsert;
export type ListingClassificationRow = typeof listingClassifications.$inferSelect;
export type NewListingClassificationRow = typeof listingClassifications.$inferInsert;
