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
 * A path rule with an explicit match type — a bare string is ambiguous
 * between "this exact path" and "this path and everything under it," and
 * that ambiguity is exactly what let allowedPathPatterns silently mean
 * different things in different records. 'exact' for single pages (the
 * homepage, a fixed search route); 'prefix' for a path segment with
 * variable children (e.g. `/announcement/` covering every detail URL
 * beneath it, or a robots.txt Disallow line, which is prefix-matched by
 * the Robots Exclusion Protocol itself).
 */
export const PathMatchRule = z.object({
  pattern: z.string().min(1),
  match: z.enum(['exact', 'prefix']),
});
export type PathMatchRule = z.infer<typeof PathMatchRule>;

const MAX_DECODE_ROUNDS = 5;

/**
 * True if any '/'-delimited segment of `path` is exactly '.' or '..'.
 * Checked after decoding, not before: a value like `%252e%252e` isn't a
 * dot-segment to the URL parser (it decodes it once to `%2e%2e`, a
 * harmless-looking literal string) and only becomes one after this
 * module's own repeated decoding — so re-checking post-decode is required,
 * not redundant with what URL parsing already normalizes at one layer.
 */
function containsDotSegment(path: string): boolean {
  return path.split('/').some((segment) => segment === '.' || segment === '..');
}

/**
 * Fully percent-decodes `path`, including double-encoding (`%2566` ->
 * `%66` -> `f`), since source pages are untrusted input (§23.1) and a
 * single decode pass leaves that class of bypass open. Returns null — a
 * fail-closed signal, not a thrown error — if decoding is malformed,
 * doesn't stabilize within MAX_DECODE_ROUNDS, or produces a dot-segment
 * (e.g. `%252e%252e` decodes in two rounds to `..`, which no single-layer
 * URL-parsing normalization would have caught, since it never looked like
 * `..` until this function's own repeated decoding produced it). Callers
 * must treat null as "does not match," never as "matches everything."
 */
function decodePathSafely(path: string): string | null {
  let current = path;
  let stabilized = false;
  for (let round = 0; round < MAX_DECODE_ROUNDS; round++) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      return null;
    }
    if (next === current) {
      stabilized = true;
      break;
    }
    current = next;
  }
  // Not stabilizing within the round budget and containing a dot-segment
  // are two independent fail-closed conditions — neither should mask the
  // other into a false "safe" result.
  if (!stabilized) return null;
  return containsDotSegment(current) ? null : current;
}

/** True if `path` matches `rule` under its declared match type, after decoding. */
export function matchesPathRule(path: string, rule: PathMatchRule): boolean {
  const decoded = decodePathSafely(path);
  if (decoded === null) return false;
  return rule.match === 'exact' ? decoded === rule.pattern : decoded.startsWith(rule.pattern);
}

/**
 * Whether a path is authorized under a policy: allowed by at least one
 * allowedPathPatterns rule, and not excluded by any disallowedPathPatterns
 * rule. Disallow always wins over allow, matching robots.txt semantics. A
 * path that fails to decode cleanly matches no allow rule (matchesPathRule
 * returns false for every rule), so this returns false for it regardless —
 * fail-closed by construction, not by an extra check here.
 */
export function isPathAllowed(
  policy: Pick<SourcePolicy, 'allowedPathPatterns' | 'disallowedPathPatterns'>,
  path: string,
): boolean {
  if (policy.disallowedPathPatterns.some((rule) => matchesPathRule(path, rule))) {
    return false;
  }
  return policy.allowedPathPatterns.some((rule) => matchesPathRule(path, rule));
}

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
  allowedPathPatterns: z.array(PathMatchRule).min(1),
  disallowedPathPatterns: z.array(PathMatchRule),
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
