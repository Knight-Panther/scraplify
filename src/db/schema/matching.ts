import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  pgView,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * The matching bundle (Phase 8C, change.md §8/§13, concept §30).
 *
 * A bundle is an immutable, versioned set of public-safe artifact files the
 * browser matcher (Phase 8D) downloads. These two tables record every build
 * attempt and which verified build is currently live; the files themselves
 * live in a `MatchingArtifactStore` (`src/matching/bundle/artifact-store.ts`).
 *
 * change.md §8 also sketches `embedding_models`/`opportunity_embeddings`.
 * They are deliberately NOT created here: Phase 8A closed lexical-first (its
 * one candidate model is ~118MB and fails the browser load gate), so there is
 * no approved model contract to key vectors on yet. Each bundle row still
 * carries a `semanticInputHash`, so the embedding step can be added later as
 * incremental work keyed on it without changing this schema.
 */

export const matchingBundleBuildStateEnum = pgEnum('matching_bundle_build_state', [
  'building',
  'verified',
  'failed',
]);

export const matchingBundlePublicationReasonEnum = pgEnum('matching_bundle_publication_reason', [
  'build',
  'rollback',
]);

export const matchingBundleBuilds = pgTable(
  'matching_bundle_builds',
  {
    id: uuid('id').primaryKey(),
    /** Publication channel: `public` for the real site; tests use their own so they never touch it. */
    channel: text('channel').notNull(),
    schemaVersion: integer('schema_version').notNull(),
    /** What the rows carry, e.g. `lexical-v1`. A future vector contract names its model here. */
    featureContract: text('feature_contract').notNull(),
    state: matchingBundleBuildStateEnum('state').notNull(),
    startedAt: timestamp('started_at', { mode: 'string', withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { mode: 'string', withTimezone: true }),
    /** Latest source-listing `last_seen_at` the snapshot covered. */
    corpusWatermark: timestamp('corpus_watermark', { mode: 'string', withTimezone: true }),
    opportunityCount: integer('opportunity_count'),
    /** Why candidate opportunities were left out, by reason code — counts only. */
    exclusions: jsonb('exclusions'),
    /** `{ [fileName]: { sha256, bytes } }` for every artifact file, manifest included. */
    artifacts: jsonb('artifacts'),
    manifestSha256: text('manifest_sha256'),
    /** Bounded code only (`MatchingBuildErrorCode`) — never a raw message that could echo content. */
    errorCode: text('error_code'),
    /** Set when the operator explicitly built past a failing upstream health gate. */
    healthGateOverridden: boolean('health_gate_overridden').notNull().default(false),
    /** Set when garbage collection removed this build's files from the store. */
    artifactsRemovedAt: timestamp('artifacts_removed_at', { mode: 'string', withTimezone: true }),
  },
  (table) => [
    index('matching_bundle_builds_channel_started_idx').on(table.channel, table.startedAt),
  ],
);

export const matchingBundlePublications = pgTable(
  'matching_bundle_publications',
  {
    id: uuid('id').primaryKey(),
    channel: text('channel').notNull(),
    buildId: uuid('build_id')
      .notNull()
      .references(() => matchingBundleBuilds.id),
    reason: matchingBundlePublicationReasonEnum('reason').notNull(),
    /** The publication this one replaced, if any — the rollback relation. */
    previousPublicationId: uuid('previous_publication_id').references(
      (): AnyPgColumn => matchingBundlePublications.id,
    ),
    /** Who activated it: a fixed worker/CLI identifier, never free text from a request. */
    activatedBy: text('activated_by').notNull(),
    activatedAt: timestamp('activated_at', { mode: 'string', withTimezone: true }).notNull(),
    retiredAt: timestamp('retired_at', { mode: 'string', withTimezone: true }),
  },
  (table) => [
    // The atomic active pointer: at most one live publication per channel,
    // enforced by the database rather than by the activation code alone.
    uniqueIndex('matching_bundle_publications_one_active_idx')
      .on(table.channel)
      .where(sql`${table.retiredAt} is null`),
    index('matching_bundle_publications_build_idx').on(table.buildId),
  ],
);

/**
 * The only matching-bundle data the public role can read: the one active
 * publication on the `public` channel and the checksums the manifest
 * endpoint needs. No build history, error codes or other channels.
 */
export const publicActiveMatchingBundle = pgView('public_active_matching_bundle', {
  buildId: uuid('build_id').notNull(),
  schemaVersion: integer('schema_version').notNull(),
  featureContract: text('feature_contract').notNull(),
  manifestSha256: text('manifest_sha256').notNull(),
  activatedAt: timestamp('activated_at', { mode: 'string', withTimezone: true }).notNull(),
}).as(sql`
  select
    ${matchingBundleBuilds.id} as build_id,
    ${matchingBundleBuilds.schemaVersion} as schema_version,
    ${matchingBundleBuilds.featureContract} as feature_contract,
    ${matchingBundleBuilds.manifestSha256} as manifest_sha256,
    ${matchingBundlePublications.activatedAt} as activated_at
  from ${matchingBundlePublications}
  inner join ${matchingBundleBuilds} on ${matchingBundleBuilds.id} = ${matchingBundlePublications.buildId}
  where ${matchingBundlePublications.channel} = 'public'
    and ${matchingBundlePublications.retiredAt} is null
    and ${matchingBundleBuilds.state} = 'verified'
`);

export type MatchingBundleBuildRow = typeof matchingBundleBuilds.$inferSelect;
export type MatchingBundlePublicationRow = typeof matchingBundlePublications.$inferSelect;
