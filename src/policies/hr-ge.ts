import { SourcePolicySchema, SourceSchema } from '../domain/index.js';

export const hrGeSource = SourceSchema.parse({
  id: '0c0495e8-0c3c-47a3-9f82-f8509aedf507',
  slug: 'hr-ge',
  displayName: 'hr.ge',
  baseUrl: 'https://www.hr.ge/',
});

export const hrGePolicy = SourcePolicySchema.parse({
  id: 'f1a2b3c4-d5e6-4f78-9a0b-c1d2e3f4a5b6',
  sourceId: hrGeSource.id,
  policyVersion: 'v1',
  // §10.2: do not lock production ingestion to the undocumented JSON API
  // until the bounded acquisition-decision spike verifies it. 'api' is
  // deliberately absent here until that spike lands.
  allowedAcquisitionModes: ['http', 'browser'],
  // Confirmed 2026-09-02: '/' (homepage/live feed), '/search-posting'
  // (primary discovery view, 100 unique announcement links found there),
  // '/announcement/' (detail pages, e.g. /announcement/491744/slug),
  // '/customer/' (employer/organization pages, needed for the
  // ORGANIZATION resource role). Deliberately excludes everything under
  // auth/account paths seen in the nav (/jobseeker/register,
  // /jobseeker/sign-in, /subscriber/subscription, /cvbox,
  // /announcement/favorites) — those require a session and are out of
  // §4.1's public-unauthenticated-listings scope regardless.
  allowedPathPatterns: [
    { pattern: '/', match: 'exact' },
    { pattern: '/search-posting', match: 'exact' },
    { pattern: '/announcement/', match: 'prefix' },
    { pattern: '/customer/', match: 'prefix' },
  ],
  // robots.txt itself declares no disallowed paths ("Allow: /"), but
  // '/announcement/favorites' textually starts with the '/announcement/'
  // prefix allowed above despite being a signed-in user's saved-listings
  // page, not a detail page — disallow always wins over allow (see
  // isPathAllowed), so this carves it back out. Prefix match, not exact:
  // an exact match would leave descendants like '/announcement/favorites/x'
  // still authorized by the '/announcement/' allow rule above.
  disallowedPathPatterns: [{ pattern: '/announcement/favorites', match: 'prefix' }],
  disallowedHosts: [],
  authenticationScope: 'none',
  rateLimit: {
    // robots.txt declares no explicit crawl-delay for hr.ge.
    crawlDelaySeconds: null,
    maxConcurrency: 1,
    notes:
      'robots.txt declares no explicit crawl-delay; defaulting to 1 concurrent request until observed response times and WAF behavior justify more.',
  },
  termsUrl: null,
  robotsUrl: 'https://www.hr.ge/robots.txt',
  retention: {
    rawHtmlRetentionDays: null,
    notes: 'Retention period is an open decision (concept §27); not yet set.',
  },
  display: {
    mayRepublishFullContent: false,
    notes:
      "Terms of service not yet reviewed (termsUrl is null above). Defaulting to §23.3's baseline: link to the original hr.ge listing rather than republishing full source content, until terms are reviewed and this is revisited.",
  },
  linkedResources: {
    allowedDestinationHosts: [],
    allowedRelationshipTypes: [],
    maxTraversalDepth: 0,
    maxResourcesPerOpportunity: 0,
    mayFetchExternalApplicationPages: false,
    retention: 'none',
    notes:
      'Disabled by default (§16): no attachments/external pages fetched yet. Revisit once Phase 4 observes what hr.ge listings actually attach, if anything.',
  },
  reviewDate: '2026-09-03T00:00:00Z',
  evidence: [
    'docs/scraplify-concept.md §5.2 (site reconnaissance confirmed 2026-09-02)',
    'https://www.hr.ge/robots.txt (fetched 2026-09-02)',
    'public sitemap: https://api.p.hr.ge/public-portal/tenant/1/api/v3/seo/sitemap',
  ],
  notes:
    'AWS WAF challenge infrastructure is present — detect and never bypass (§5.2, §23.1). The acquisition-decision spike (§10.2) comparing sitemap/HTML/API coverage is required before adding "api" to allowedAcquisitionModes; current default is public sitemap plus server-rendered index/detail HTML. Note: allowedPathPatterns above covers www.hr.ge only — the public sitemap lives on a different host (api.p.hr.ge), which this record does not yet authorize; host-level authorization for that endpoint is a follow-up decision for the hr.ge adapter (Phase 1B), not yet modeled here.',
  decisionOwner: 'project owner',
});
