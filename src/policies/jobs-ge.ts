import { isHostAllowed, isPathAllowed, SourcePolicySchema, SourceSchema } from '../domain/index.js';

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
  // jobs.ge serves the same listing content at three locale-prefixed
  // paths (confirmed 2026-09-03, live recon — see
  // src/adapters/jobs-ge/RECON_NOTES.md): bare '/', explicit '/ge/', and
  // '/en/'. '/ge/' is the path this project actually crawls (deterministic
  // locale, not dependent on Accept-Language/cookie defaults the way bare
  // '/' plausibly could be) — '/en/' isn't authorized below since nothing
  // in this codebase requests it. '/ge/ads/' is the real discovery/browse
  // page (not just the homepage): it has the search form and responds to
  // `?page=N`. isPathAllowed alone only ever evaluates the path, so for
  // any of these it authorizes *any* query string — isJobsGeUrlAllowed
  // below (found necessary by adversarial review, 2026-09-03) is the
  // actual enforced boundary; callers must use that, not isPathAllowed
  // directly, for jobs.ge URLs.
  allowedPathPatterns: [
    { pattern: '/', match: 'exact' },
    { pattern: '/ge/', match: 'exact' },
    { pattern: '/ge/ads/', match: 'exact' },
  ],
  // robots.txt: "Disallow: /data/clients/" (confirmed 2026-09-02). Prefix
  // match, per the Robots Exclusion Protocol's own semantics for Disallow.
  disallowedPathPatterns: [{ pattern: '/data/clients/', match: 'prefix' }],
  // jobs.ge serves everything from one host. isJobsGeUrlAllowed enforces
  // this via isHostAllowed rather than the hand-rolled origin comparison it
  // used before allowedHosts existed on the schema (added for hr.ge's
  // second-host sitemap case; see src/policies/hr-ge.ts).
  allowedHosts: ['www.jobs.ge'],
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
    'src/adapters/jobs-ge/RECON_NOTES.md (live read-only recon, 2026-09-03: URL space, pagination depth, VIP/standard partition structure, filter semantics, detail-page variability)',
  ],
  notes:
    'VIP and standard listings are a clean, structurally disjoint partition on /ge/ads/ (a .vipEntries block versus #job_list_table), confirmed 2026-09-03 — zero ID overlap observed. The standard section is itself date/ID-descending and VIP-independent, resolving the open question from concept §27: yes, a VIP-independent date-ordered view exists (walk #job_list_table across ?page=N; VIP is small enough, ~10 items, to fully recheck every run rather than needing incremental logic of its own). Category (cid) and location (lid) filters are redundant for discovery — the unfiltered page already covers all of both. Announcement-type filter (jid) is real: the unfiltered feed mixes vacancies with scholarships/trainings/tenders/other, and the project decision (2026-09-03) is to aggregate all of them, so jid is deliberately not used. Full details in src/adapters/jobs-ge/RECON_NOTES.md.',
  decisionOwner: 'project owner',
});

// '/' and '/ge/' are equivalent locale-wise (confirmed 2026-09-03) and
// share the same allowed query shape; '/ge/ads/' is a distinct page (the
// discovery/browse view) with its own shape. Kept as a Set/const rather
// than folded into isPathAllowed's own patterns, since the two paths need
// *different* permitted query shapes below, not just "path allowed."
const HOMEPAGE_PATHS = new Set(['/', '/ge/']);
const ADS_PATH = '/ge/ads/';

/**
 * jobs.ge-specific authorization, since its listing identity and discovery
 * pagination both live entirely in query parameters — isPathAllowed only
 * evaluates the path, so it cannot express either boundary alone. Uses
 * URL/URLSearchParams for parsing rather than hand-rolled string matching,
 * since the standard library already handles percent-decoding correctly
 * (unlike the bespoke decode loop isPathAllowed needed, this doesn't need
 * one: query values are compared as whole decoded strings, not used to
 * build further path prefixes, so there's no equivalent double-encoding
 * surface here).
 *
 * Authorized, per path (confirmed 2026-09-03 — see
 * src/adapters/jobs-ge/RECON_NOTES.md):
 *   - '/' or '/ge/': no query (bare homepage), or exactly
 *     `?view=jobs&id=<digits>` — no extra, missing, or duplicate params.
 *   - '/ge/ads/': no query (page 1), or exactly `?page=<positive digits>`.
 * Everything else — including a same-path URL on a different host, scheme,
 * or port, which isPathAllowed alone would never catch since it never looks
 * at the origin at all — is rejected by isHostAllowed below.
 */
export function isJobsGeUrlAllowed(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url, jobsGeSource.baseUrl);
  } catch {
    return false;
  }

  if (!isHostAllowed(jobsGePolicy, parsed)) {
    return false;
  }
  if (!isPathAllowed(jobsGePolicy, parsed.pathname)) {
    return false;
  }

  const keys = [...parsed.searchParams.keys()];
  const uniqueKeys = new Set(keys);
  if (uniqueKeys.size !== keys.length) {
    return false; // duplicate parameter
  }
  if (keys.length === 0) {
    return true; // bare homepage, or '/ge/ads/' page 1
  }

  if (HOMEPAGE_PATHS.has(parsed.pathname)) {
    if (uniqueKeys.size !== 2 || !uniqueKeys.has('view') || !uniqueKeys.has('id')) {
      return false;
    }
    if (parsed.searchParams.get('view') !== 'jobs') {
      return false;
    }
    const id = parsed.searchParams.get('id');
    return id !== null && /^[0-9]+$/.test(id);
  }

  if (parsed.pathname === ADS_PATH) {
    if (uniqueKeys.size !== 1 || !uniqueKeys.has('page')) {
      return false;
    }
    const page = parsed.searchParams.get('page');
    return page !== null && /^[1-9][0-9]*$/.test(page);
  }

  return false;
}
