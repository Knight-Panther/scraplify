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
  // §10.2's bounded acquisition-decision spike LANDED 2026-09-05 (see
  // src/adapters/hr-ge/RECON_NOTES.md). Outcome: 'http' for every purpose
  // (discovery, reconciliation, sitemap cross-check, detail fetch),
  // 'browser' retained for canary/fallback only. 'api' is deliberately
  // still absent — not for want of finding an endpoint, but because the
  // one that exists fails §10.2's own adoption bar and buys nothing:
  //   - POST-only (a plain GET to .../api/v3/announcement-search returns
  //     405) with an undocumented request-body schema, so it was left
  //     unprobed rather than guessed at;
  //   - CORS is Access-Control-Allow-Origin: https://www.hr.ge with
  //     credentials — a first-party SPA backend, not a public API;
  //   - it is multi-tenant infrastructure shared with cv.ge/doctor.ge/etc,
  //     versioned only by a 'v3' path segment with no published contract;
  //   - decisively, its own JSON response bodies are already embedded
  //     verbatim in the server-rendered HTML (Angular's ng-state transfer
  //     island), so plain HTTP already yields identical structured data
  //     through the robots-allowed path.
  allowedAcquisitionModes: ['http', 'browser'],
  // Confirmed 2026-09-02, re-confirmed 2026-09-05: '/' (homepage/live
  // feed), '/search-posting' (the discovery view — 'exact' still holds,
  // since pagination lives in the query string as ?pg=N and leaves the
  // path unchanged), '/announcement/' (detail pages, e.g.
  // /announcement/491744/slug), '/customer/' (employer/organization
  // pages, needed for the ORGANIZATION resource role). Deliberately
  // excludes everything under auth/account paths seen in the nav
  // (/jobseeker/register, /jobseeker/sign-in, /subscriber/subscription,
  // /cvbox, /announcement/favorites) — those require a session and are
  // out of §4.1's public-unauthenticated-listings scope regardless.
  // NOTE: isPathAllowed only ever evaluates the path, so these rules
  // authorize *any* query string on '/search-posting' and never look at
  // the origin at all. An isHrGeUrlAllowed guard (mirroring
  // isJobsGeUrlAllowed) is required before any fetcher runs, to pin the
  // query shape to ?pg=<digits> and to reject same-path URLs on another
  // origin — see RECON_NOTES.md's implementation plan. Not written here:
  // this phase's spike is reconnaissance only.
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
    // robots.txt still declares no Crawl-delay, but hr.ge publishes a
    // quantitative limit in response headers instead (new evidence,
    // 2026-09-05): 'Ratelimit-Limit: 20' / 'Ratelimit-Policy: 20;w=60'
    // — 20 requests per 60s window, i.e. one every 3 seconds. Recorded
    // here as the binding limit rather than left null.
    crawlDelaySeconds: 3,
    maxConcurrency: 1,
    notes:
      "robots.txt declares no Crawl-delay, but the site advertises 'Ratelimit-Policy: 20;w=60' (20 requests / 60s = one per 3s) in response headers; crawlDelaySeconds reflects that. Caveat: those headers were observed on the robots.txt response (served by the Express edge layer) and NOT on the SSR page responses, so it is unconfirmed that the same bucket governs page fetches — 3s is the conservative reading, not a measured page-fetch ceiling. Concurrency stays at 1 until observed response times and WAF behavior justify more; a 429 or 'Ratelimit-Remaining: 0' must be treated as a first-class backoff signal.",
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
  reviewDate: '2026-09-05T00:00:00Z',
  evidence: [
    'docs/scraplify-concept.md §5.2 (site reconnaissance confirmed 2026-09-02)',
    'https://www.hr.ge/robots.txt (fetched 2026-09-02; re-fetched 2026-09-05 — unchanged content, plus Ratelimit-* response headers)',
    'https://api.p.hr.ge/robots.txt (fetched 2026-09-05: HTTP 404, zero-byte body — the sitemap host publishes no robots rules of its own)',
    'public sitemap: https://api.p.hr.ge/public-portal/tenant/1/api/v3/seo/sitemap (fetched 2026-09-05: flat urlset, 39,268 URLs, 1,075 of them announcements, no lastmod)',
    'src/adapters/hr-ge/RECON_NOTES.md (bounded read-only acquisition-decision spike, 2026-09-05: API-vs-HTML decision, ?pg=N pagination, sitemap coverage measurement, detail field inventory, WAF signature)',
    'src/adapters/hr-ge/fixtures/ (8 raw HTML fixtures captured 2026-09-05: index pages 1 and 33, an out-of-range 404, and 5 structurally distinct detail pages)',
  ],
  notes:
    'Acquisition decision (2026-09-05, §10.2 spike complete — full evidence in src/adapters/hr-ge/RECON_NOTES.md): http for discovery, reconciliation, sitemap cross-check and detail fetch; browser for canary/fallback only; api rejected (see the allowedAcquisitionModes comment above). Everything is server-rendered — a plain cookieless GET of /search-posting returns all 100 announcement links with no JS executed, and every page embeds the upstream API JSON verbatim in an Angular ng-state island. Discovery is ordinary ?pg=N pagination (Phase 0 recorded "no ordinary pagination links"; that is OVERTURNED — the links were in the raw HTML all along under the pg= parameter): 100 per page, 33 pages, 3,265 announcements, and an out-of-range page returns a real HTTP 404 rather than clamping. IMPORTANT CORRECTION to §5.2/§10.2: the public sitemap is NOT a usable reconciliation oracle for this source. Measured 2026-09-05, it contains exactly the 1,075 paid/priority announcements and zero free ones (isPriority=true correlates with sitemap membership perfectly in both directions across all 3,263 IDs recovered by a full index walk) — about 33% of the live corpus. Reconciling against it would make 2,190 free listings look absent on every healthy run and mass-close them, exactly the outcome §10.2 warns about. It also carries no lastmod, so it offers no change signal. Use it only as an additive cross-check that can introduce candidate IDs, never as evidence of absence. AWS WAF challenge infrastructure is present and confirmed enabled (wafConfig.isEnabled), but no challenge, CAPTCHA, or block was encountered across 46 read-only requests and nothing was bypassed (§5.2, §23.1); note the awswaf challenge.js tag is embedded in EVERY healthy page, so a detector must key on status/x-amzn-waf-action and on the absence of ng-server-context="ssr"/ng-state, never on the string "awswaf". Privacy finding requiring parser enforcement: detail pages set hideContactPerson=true and omit the recruiter name/personal email/mobile from the rendered page, yet those values are still present in the ng-state island — the parser must honor hideContactPerson and the show* flags and must not persist suppressed fields; the committed fixtures have those values redacted. Unchanged and still open: allowedPathPatterns above covers www.hr.ge only, and the public sitemap lives on a different host (api.p.hr.ge) that this record still cannot authorize — SourcePolicySchema (src/domain/source.ts) models a single host implicitly via Source.baseUrl and offers only a disallowedHosts deny-list, with no positive host allow-list to put api.p.hr.ge in. RECON_NOTES.md recommends adding an allowedHosts field; that schema change is deliberately left to the implementation pass, since it also touches jobs.ge\'s already-merged policy record.',
  decisionOwner: 'project owner',
});
