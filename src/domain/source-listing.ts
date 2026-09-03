import { z } from 'zod';
import {
  HttpUrl,
  IsoDateTime,
  ResourceId,
  Sha256Hex,
  SourceId,
  SourceListingId,
  SourceListingRevisionId,
} from './ids.js';

/**
 * Lifecycle states from scraplify-concept.md §13:
 *   discovered -> active -> missing_suspected -> closed
 *                       \-> expired
 *   closed/expired -> active (reopened or republished)
 *   any state -> quarantined (evidence unreliable)
 */
export const SourceListingStatus = z.enum([
  'discovered',
  'active',
  'missing_suspected',
  'closed',
  'expired',
  'quarantined',
]);
export type SourceListingStatus = z.infer<typeof SourceListingStatus>;

/** What one source says about one listing (§12.1). Not the canonical opportunity. */
export const SourceListingSchema = z.object({
  id: SourceListingId,
  sourceId: SourceId,
  /**
   * Stable external ID from the source, when one exists — uniqueness key
   * with sourceId per §12.1. Null for a source with no such ID; adapters
   * for those sources must derive identity from canonicalSourceUrl instead.
   */
  sourceRecordId: z.string().min(1).nullable(),
  canonicalSourceUrl: HttpUrl,
  /** Null until the first revision has been fetched and parsed. */
  currentRevisionId: SourceListingRevisionId.nullable(),
  firstSeenAt: IsoDateTime,
  lastSeenAt: IsoDateTime,
  status: SourceListingStatus,
  /** Consecutive complete reconciliation runs where this listing was missing. Resets on reappearance. */
  missingStreak: z.int().nonnegative(),
  sourcePublishedAt: IsoDateTime.nullable(),
  sourceDeadlineAt: IsoDateTime.nullable(),
});
export type SourceListing = z.infer<typeof SourceListingSchema>;

const DateFieldSchema = z.object({
  /** Exactly as it appeared on the source, before locale/timezone/year-inference parsing. */
  raw: z.string().nullable(),
  parsed: IsoDateTime.nullable(),
});

const ApplicationMethodSchema = z.object({
  type: z.enum(['email', 'url', 'form', 'unspecified']),
  value: z.string().nullable(),
});

/**
 * An immutable normalized snapshot of one source listing (§12.2). Created only
 * when meaningful normalized content changes — not on every raw-byte change
 * (ads, timestamps, tracking markup vary independently of the vacancy).
 */
export const SourceListingRevisionSchema = z.object({
  id: SourceListingRevisionId,
  sourceListingId: SourceListingId,
  parserVersion: z.string().min(1),
  extractionMethod: z.enum(['http', 'browser']),
  rawResourceHash: Sha256Hex,
  meaningfulContentHash: Sha256Hex,
  titleRaw: z.string().min(1),
  titleNormalized: z.string().min(1),
  organizationRaw: z.string().nullable(),
  description: z.string(),
  locations: z.array(z.string()),
  salaryRaw: z.string().nullable(),
  publishedDate: DateFieldSchema,
  deadlineDate: DateFieldSchema,
  applicationMethod: ApplicationMethodSchema.nullable(),
  /** Category IDs/labels exactly as the source presented them, pre-taxonomy-mapping. */
  sourceCategories: z.array(z.string()),
  /** Fields with no dedicated column yet; a deliberate escape hatch, not a dumping ground. */
  structuredAttributes: z.record(z.string(), z.unknown()),
  createdAt: IsoDateTime,
  /**
   * §6.2: every normalized claim must be traceable to a source resource and
   * parser version. resourceId is deliberately non-nullable — a revision
   * with no traceable fetch has no recoverable crawl evidence, which is
   * exactly what that requirement rules out. There's no legitimate case in
   * this codebase for an untraceable revision to exist.
   */
  provenance: z.object({
    fetchedAt: IsoDateTime,
    resourceId: ResourceId,
    notes: z.string().nullable(),
  }),
});
export type SourceListingRevision = z.infer<typeof SourceListingRevisionSchema>;
