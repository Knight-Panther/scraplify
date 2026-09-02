import { z } from 'zod';
import { HttpUrl, IsoDateTime, SourceId } from './ids.js';
import { ResourceRelationship } from './resource.js';

/** A source site scraplify ingests from (§9, §12.6). */
export const SourceSchema = z.object({
  id: SourceId,
  /** Stable, human-readable key — e.g. 'jobs-ge'. Used in code, not just the DB. */
  slug: z.string().min(1),
  displayName: z.string().min(1),
  baseUrl: HttpUrl,
});
export type Source = z.infer<typeof SourceSchema>;

/** Acquisition modes an adapter may use (§9's capabilities.acquisitionModes). */
export const AcquisitionMode = z.enum(['feed', 'api', 'http', 'browser']);
export type AcquisitionMode = z.infer<typeof AcquisitionMode>;

/**
 * A versioned source policy record (§5.3). Every field listed there is
 * represented explicitly — including the ones we don't have an answer for
 * yet (termsUrl, retention days), which are nullable rather than guessed,
 * per §6.2's correctness principle: prefer an explicit unknown state over
 * an unsupported conclusion.
 */
export const SourcePolicySchema = z.object({
  id: z.string().uuid(),
  sourceId: SourceId,
  policyVersion: z.string().min(1),
  allowedAcquisitionModes: z.array(AcquisitionMode).min(1),
  /**
   * Default-deny: empty means nothing is authorized. Must enumerate the
   * actual known index/detail/search paths intended for fetching — not
   * left empty as a stand-in for "everything except disallowedPathPatterns"
   * (that would make the boundary broader than the listing-only initial
   * scope in §4.1, and defeat the point of an allow-list).
   */
  allowedPathPatterns: z.array(z.string()).min(1),
  disallowedPathPatterns: z.array(z.string()),
  disallowedHosts: z.array(z.string()),
  authenticationScope: z.enum(['none', 'required']),
  rateLimit: z.object({
    /** Null when the source declares no explicit crawl-delay. */
    crawlDelaySeconds: z.number().nonnegative().nullable(),
    maxConcurrency: z.int().positive(),
    notes: z.string().nullable(),
  }),
  /** Null until the site's terms of service have been reviewed. */
  termsUrl: HttpUrl.nullable(),
  robotsUrl: HttpUrl,
  retention: z.object({
    /** Null: retention periods are an open decision (§27), not yet set. */
    rawHtmlRetentionDays: z.int().nonnegative().nullable(),
    notes: z.string(),
  }),
  /**
   * §5.3 requires retention AND display rules as distinct dimensions —
   * retention is "how long we keep it," display is "may we show/republish
   * it." §23.3's default: link to the original listing, avoid unnecessary
   * republication of full source content.
   */
  display: z.object({
    mayRepublishFullContent: z.boolean(),
    notes: z.string(),
  }),
  /**
   * §16's mandatory linked-resource controls (attachments, external
   * application pages). Phase 0 default is fully disabled — empty
   * allow-lists, zero depth/count, no external fetching, no retention —
   * since §16 itself says full recursive processing is enabled only after
   * observed examples justify it. This is an explicit "off" state, not an
   * omission: Phase 1/4 work turns these on deliberately, per source.
   */
  linkedResources: z.object({
    allowedDestinationHosts: z.array(z.string()),
    allowedRelationshipTypes: z.array(ResourceRelationship),
    maxTraversalDepth: z.int().nonnegative(),
    maxResourcesPerOpportunity: z.int().nonnegative(),
    mayFetchExternalApplicationPages: z.boolean(),
    retention: z.enum(['none', 'metadata_only', 'full_content']),
    notes: z.string(),
  }),
  reviewDate: IsoDateTime,
  /** What was actually checked to produce this policy — URLs fetched, docs read. */
  evidence: z.array(z.string()).min(1),
  notes: z.string(),
  decisionOwner: z.string().min(1),
});
export type SourcePolicy = z.infer<typeof SourcePolicySchema>;
