import { z } from 'zod';
import { TITLE_VECTORS_META_FILE, TITLE_VECTORS_TABLE_FILE } from '../semantic/title-vectors.js';

/**
 * The browser-safe half of the matching-bundle contract (Phase 8C,
 * change.md §8): constants and zod schemas only, with no Node import, so the
 * Phase 8D browser worker validates exactly the shapes the builder writes.
 * `contract.ts` re-exports everything here alongside its Node-only helpers.
 *
 * Two schemas; a client only ever combines files from one manifest.
 * - Schema 1, `lexical-v1`: what Phase 8A's lexical-first exit allowed.
 *   Public render metadata, taxonomy terms and provenance per canonical
 *   opportunity, and no vectors.
 * - Schema 2, `lexical-v1+title-vectors-v1`: the same rows, plus title
 *   vectors from one pinned model (`semantic/title-vectors.ts`), which the
 *   manifest names.
 */

/** The schema this build of the code writes when it has the title-vector model. */
export const MATCHING_BUNDLE_SCHEMA_VERSION = 2;
/**
 * The schema range this build of the code will activate and serve. During a
 * rolling deploy the server supports the current and the immediately
 * previous compatible schema (change.md §8), so a schema 1 bundle built by
 * the previous release stays servable until the next build replaces it.
 */
export const SUPPORTED_MATCHING_BUNDLE_SCHEMAS = { min: 1, max: 2 } as const;
/**
 * What each row carries. Also part of every row's semantic input hash
 * (`snapshot.ts`), so it names the rows alone and does not change when
 * files are added beside them.
 */
export const MATCHING_FEATURE_CONTRACT = 'lexical-v1';
export const TITLE_VECTORS_FEATURE_CONTRACT = `${MATCHING_FEATURE_CONTRACT}+title-vectors-v1`;

/** The public channel the real site reads; tests publish to their own. */
export const PUBLIC_MATCHING_CHANNEL = 'public';

export const MANIFEST_FILE = 'manifest.json';
export const OPPORTUNITIES_FILE = 'opportunities.json';
export { TITLE_VECTORS_META_FILE, TITLE_VECTORS_TABLE_FILE };
export const ARTIFACT_FILE_NAMES = [
  MANIFEST_FILE,
  OPPORTUNITIES_FILE,
  TITLE_VECTORS_META_FILE,
  TITLE_VECTORS_TABLE_FILE,
] as const;
export type ArtifactFileName = (typeof ARTIFACT_FILE_NAMES)[number];

/** Per supported schema: its feature contract and the files its manifest lists, sorted. */
export const SCHEMA_LAYOUT: Readonly<
  Record<number, { featureContract: string; files: readonly string[] }>
> = {
  1: { featureContract: MATCHING_FEATURE_CONTRACT, files: [OPPORTUNITIES_FILE] },
  2: {
    featureContract: TITLE_VECTORS_FEATURE_CONTRACT,
    files: [OPPORTUNITIES_FILE, TITLE_VECTORS_META_FILE, TITLE_VECTORS_TABLE_FILE].sort(),
  },
};

/**
 * Last-known-good is not "serve obsolete matches forever" (change.md §8).
 * Crawls are scheduled daily and the health check already calls a source
 * overdue after 48h, so a bundle built more than 72h ago means at least one
 * full day of crawls has not reached it: matching stops and says so.
 * Past 36h the health check warns first.
 */
export const MAX_BUNDLE_AGE_HOURS = 72;
export const BUNDLE_AGE_WARNING_HOURS = 36;

/** Refuse to activate a bundle that shrank below this fraction of the active one. */
export const MIN_COUNT_RATIO_VS_ACTIVE = 0.5;

/** Bounded failure codes recorded on a build — never free text. */
export type MatchingBuildErrorCode =
  | 'interrupted'
  | 'upstream_unhealthy'
  | 'empty_bundle'
  | 'count_anomaly'
  | 'incompatible_schema'
  | 'artifact_write_failed'
  | 'artifact_verify_failed'
  | 'provenance_drift'
  /** Schema 2 was asked for and the pinned title-vector model could not be verified or run. */
  | 'model_unavailable'
  | 'internal_error';

const isoDate = z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'not a timestamp');
const uuid = z.uuid();
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const bundleOpportunitySchema = z.strictObject({
  opportunityId: uuid,
  /** The opportunity's current canonical revision when the bundle was built. */
  canonicalRevisionId: uuid,
  /** SHA-256 of the semantic input (see `semanticInput`), for incremental embedding later. */
  semanticInputHash: sha256,
  type: z.string().min(1),
  title: z.string().min(1),
  organization: z.string().nullable(),
  /** Latest deadline among the publicly available members; null when none states one. */
  deadlineAt: isoDate.nullable(),
  locations: z.array(z.string()),
  taxonomy: z.array(z.strictObject({ axis: z.string(), code: z.string(), label: z.string() })),
  sources: z
    .array(
      z.strictObject({
        sourceSlug: z.string().min(1),
        sourceListingId: uuid,
        canonicalUrl: z.url(),
      }),
    )
    .min(1),
});
export type BundleOpportunity = z.infer<typeof bundleOpportunitySchema>;

export const opportunitiesFileSchema = z.strictObject({
  schemaVersion: z.number().int(),
  bundleId: uuid,
  opportunities: z.array(bundleOpportunitySchema),
});
export type OpportunitiesFile = z.infer<typeof opportunitiesFileSchema>;

export const manifestSchema = z.strictObject({
  schemaVersion: z.number().int(),
  bundleId: uuid,
  featureContract: z.string().min(1),
  /** Null for schema 1, which carries no vectors; else the pin every vector came from. */
  model: z.strictObject({ id: z.string().min(1), dims: z.number().int().positive() }).nullable(),
  generatedAt: isoDate,
  corpusWatermark: isoDate.nullable(),
  sourceFreshness: z.array(z.strictObject({ sourceSlug: z.string(), lastSeenAt: isoDate })),
  counts: z.strictObject({
    opportunities: z.number().int().nonnegative(),
    sources: z.number().int().nonnegative(),
  }),
  files: z.record(z.string(), z.strictObject({ sha256, bytes: z.number().int().nonnegative() })),
});
export type MatchingManifest = z.infer<typeof manifestSchema>;

export function isSupportedSchema(schemaVersion: number): boolean {
  return (
    schemaVersion >= SUPPORTED_MATCHING_BUNDLE_SCHEMAS.min &&
    schemaVersion <= SUPPORTED_MATCHING_BUNDLE_SCHEMAS.max
  );
}
