import { isPathAllowed, SourcePolicySchema, SourceSchema } from '../domain/index.js';

export const jobsGeSource = SourceSchema.parse({
  id: '8c3b7cbf-159a-4e13-9d9f-1b50597e4ae9',
  slug: 'jobs-ge',
  displayName: 'jobs.ge',
  baseUrl: 'https://www.jobs.ge/',
});

export const jobsGePolicy = SourcePolicySchema.parse({
  id: 'e3f8b6a2-7a9d-4c1b-9e6c-1a2b3c4d5e6f',
  sourceId: jobsGeSource.id,
  policyVersion: 'v1',
  // Server-rendered HTML; browser is a recorded escalation only (§10.1).
  allowedAcquisitionModes: ['http', 'browser'],
  // jobs.ge keeps index and detail views both at root with query strings
  // (confirmed 2026-09-02: listing identity is `?view=jobs&id=<id>`; the
  // homepage itself is the index) — there is no separate confirmed path
  // segment to restrict to more narrowly than root. isPathAllowed alone
  // therefore authorizes *any* query on '/', since it only ever evaluates
  // the path — isJobsGeUrlAllowed below (found necessary by adversarial
  // review, 2026-09-03) is the actual enforced boundary; callers must use
  // that, not isPathAllowed directly, for jobs.ge URLs.
  allowedPathPatterns: [{ pattern: '/', match: 'exact' }],
  // robots.txt: "Disallow: /data/clients/" (confirmed 2026-09-02). Prefix
  // match, per the Robots Exclusion Protocol's own semantics for Disallow.
  disallowedPathPatterns: [{ pattern: '/data/clients/', match: 'prefix' }],
  disallowedHosts: [],
  authenticationScope: 'none',
  rateLimit: {
    // robots.txt: "Crawl-delay: 5" (confirmed 2026-09-02).
    crawlDelaySeconds: 5,
    maxConcurrency: 1,
    notes:
      'Site declares Crawl-delay: 5 in robots.txt but no explicit concurrency limit; defaulting to 1 concurrent request until observed response times justify more.',
  },
  // Not yet reviewed — an explicit unknown, not a guess.
  termsUrl: null,
  robotsUrl: 'https://www.jobs.ge/robots.txt',
  retention: {
    rawHtmlRetentionDays: null,
    notes: 'Retention period is an open decision (concept §27); not yet set.',
  },
  display: {
    mayRepublishFullContent: false,
    notes:
      "Terms of service not yet reviewed (termsUrl is null above). Defaulting to §23.3's baseline: link to the original jobs.ge listing rather than republishing full source content, until terms are reviewed and this is revisited.",
  },
  linkedResources: {
    allowedDestinationHosts: [],
    allowedRelationshipTypes: [],
    maxTraversalDepth: 0,
    maxResourcesPerOpportunity: 0,
    mayFetchExternalApplicationPages: false,
    retention: 'none',
    notes:
      'Disabled by default (§16): no attachments/external pages fetched yet. Revisit once Phase 4 observes what jobs.ge listings actually attach, if anything.',
  },
  reviewDate: '2026-09-03T00:00:00Z',
  evidence: [
    'docs/scraplify-concept.md §5.1 (site reconnaissance confirmed 2026-09-02)',
    'https://www.jobs.ge/robots.txt (fetched 2026-09-02)',
  ],
  notes:
    'Homepage mixes VIP/promoted and standard sections; VIP is not date-sorted. Treat them as separate discovery partitions (§10.1) and verify whether a date-sorted non-VIP browse view exists before relying on homepage-only discovery for completeness (open question, concept §27).',
  decisionOwner: 'project owner',
});

const JOBS_GE_ORIGIN = new URL(jobsGeSource.baseUrl).origin;

/**
 * jobs.ge-specific authorization, since its listing identity lives entirely
 * in query parameters — isPathAllowed only evaluates the path (always '/'
 * here), so it cannot express this boundary alone. Uses URL/URLSearchParams
 * for parsing rather than hand-rolled string matching, since the standard
 * library already handles percent-decoding correctly (unlike the bespoke
 * decode loop isPathAllowed needed, this doesn't need one: query values are
 * compared as whole decoded strings, not used to build further path
 * prefixes, so there's no equivalent double-encoding surface here).
 *
 * Authorized:
 *   - the bare homepage/index (no query at all)
 *   - exactly `?view=jobs&id=<digits>`, no extra, missing, or duplicate params
 * Everything else — including a same-path URL on a different host, scheme,
 * or port, which isPathAllowed alone would never catch since it never looks
 * at the origin at all — is rejected. Comparing `.origin` rather than
 * `.hostname` matters here specifically: `.hostname` alone would still
 * accept `file://www.jobs.ge/...` (a scheme bypass) or
 * `https://www.jobs.ge:4444/...` (a port bypass), since neither scheme nor
 * port is part of `.hostname` — confirmed empirically before writing this,
 * not assumed.
 */
export function isJobsGeUrlAllowed(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url, jobsGeSource.baseUrl);
  } catch {
    return false;
  }

  if (parsed.origin !== JOBS_GE_ORIGIN) {
    return false;
  }
  if (!isPathAllowed(jobsGePolicy, parsed.pathname)) {
    return false;
  }

  const keys = [...parsed.searchParams.keys()];
  if (keys.length === 0) {
    return true;
  }

  const uniqueKeys = new Set(keys);
  if (uniqueKeys.size !== keys.length) {
    return false; // duplicate parameter
  }
  if (uniqueKeys.size !== 2 || !uniqueKeys.has('view') || !uniqueKeys.has('id')) {
    return false;
  }
  if (parsed.searchParams.get('view') !== 'jobs') {
    return false;
  }
  const id = parsed.searchParams.get('id');
  return id !== null && /^[0-9]+$/.test(id);
}
