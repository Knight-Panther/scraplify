import { index, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sourceListings } from './source-listings.js';

/** §15.3: keep staffing agencies and the employer they represent separately identifiable. */
export const organizationKindEnum = pgEnum('organization_kind', ['employer', 'staffing_agency']);

/** Mirrors OrganizationAliasSchema.evidenceType. */
export const organizationAliasEvidenceEnum = pgEnum('organization_alias_evidence', [
  'source_display_name',
  'domain_match',
  'contact_match',
  'reviewed',
]);

/**
 * Mirrors OrganizationSchema (src/domain/organization.ts).
 *
 * `normalizedName` is stored rather than computed on read: it is the join key
 * candidate generation uses (§14.1 stage 3), so it has to be indexable, and
 * it must stay stable even when the normalizer changes — recomputing it
 * implicitly on every read would silently re-cluster historical data the
 * moment a normalization rule was tweaked. `normalizerVersion` records which
 * ruleset produced it, so a change is a visible, re-runnable migration of
 * data rather than an invisible behavioural shift (§14.2's "record
 * ruleset/model versions so decisions can be recomputed").
 *
 * Deliberately NOT unique on `normalizedName`: two genuinely different
 * employers can normalize to the same key (a short trade name shared by
 * unrelated companies), and §14.2 forbids auto-linking on a name match alone.
 * A collision is a candidate to review, not a fact to enforce in the schema.
 */
export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The display form — the name a human should see. Never overwritten by a normalizer. */
    canonicalName: text('canonical_name').notNull(),
    /** Matching key produced by normalizeOrganizationName; see that function for the rules. */
    normalizedName: text('normalized_name').notNull(),
    normalizerVersion: text('normalizer_version').notNull(),
    kind: organizationKindEnum('kind').notNull(),
    /** Official domain, used as alias evidence — not necessarily where listings link to. */
    domain: text('domain'),
    createdAt: timestamp('created_at', { mode: 'string', withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { mode: 'string', withTimezone: true }).notNull(),
  },
  (table) => [
    // Not unique, just fast: candidate generation looks organizations up by
    // this key on every incoming listing. Uniqueness is deliberately absent
    // for the reason given above — a normalized-name collision between two
    // real employers is a review candidate, not a constraint violation.
    index('organizations_normalized_name_idx').on(table.normalizedName, table.normalizerVersion),
  ],
);

/**
 * A raw name variant observed for an organization (§15.3). Aliases are
 * stored, never used to overwrite historical revision values — a listing's
 * `organizationRaw` stays exactly as the source wrote it, and this table
 * records that the string was seen and what it was taken to mean.
 *
 * `sourceListingId` is nullable because an alias can also come from a
 * reviewed human decision or a domain match with no single listing behind it.
 */
export const organizationAliases = pgTable(
  'organization_aliases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    rawName: text('raw_name').notNull(),
    /** The normalized form of rawName at the time it was recorded. */
    normalizedName: text('normalized_name').notNull(),
    evidenceType: organizationAliasEvidenceEnum('evidence_type').notNull(),
    sourceListingId: uuid('source_listing_id').references(() => sourceListings.id),
    createdAt: timestamp('created_at', { mode: 'string', withTimezone: true }).notNull(),
  },
  (table) => [
    // One row per (organization, raw string): re-observing the same employer
    // name on a thousand listings must not create a thousand alias rows, and
    // this gives the ingest path a key to upsert against.
    uniqueIndex('organization_aliases_org_raw_name_idx').on(table.organizationId, table.rawName),
  ],
);

export type OrganizationRow = typeof organizations.$inferSelect;
export type NewOrganizationRow = typeof organizations.$inferInsert;
export type OrganizationAliasRow = typeof organizationAliases.$inferSelect;
export type NewOrganizationAliasRow = typeof organizationAliases.$inferInsert;
