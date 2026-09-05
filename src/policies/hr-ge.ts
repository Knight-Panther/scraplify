import { isHostAllowed, isPathAllowed, SourcePolicySchema, SourceSchema } from '../domain/index.js';

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
  // the origin at all — isHrGeUrlAllowed below is the actual enforced
  // boundary, pinning the query shape to ?pg=<digits> and scoping each
  // host to only the paths it actually serves.
  allowedPathPatterns: [
    { pattern: '/', match: 'exact' },
    { pattern: '/search-posting', match: 'exact' },
    { pattern: '/announcement/', match: 'prefix' },
    { pattern: '/customer/', match: 'prefix' },
    // The public sitemap, on the separate api.p.hr.ge host (see
    // allowedHosts below) — confirmed 2026-09-05, a single flat <urlset>,
    // no child sitemaps to authorize separately.
    { pattern: '/public-portal/tenant/1/api/v3/seo/sitemap', match: 'exact' },
  ],
  // robots.txt itself declares no disallowed paths ("Allow: /"), but
  // '/announcement/favorites' textually starts with the '/announcement/'
  // prefix allowed above despite being a signed-in user's saved-listings
  // page, not a detail page — disallow always wins over allow (see
  // isPathAllowed), so this carves it back out. Prefix match, not exact:
  // an exact match would leave descendants like '/announcement/favorites/x'
  // still authorized by the '/announcement/' allow rule above.
  disallowedPathPatterns: [{ pattern: '/announcement/favorites', match: 'prefix' }],
  // Two hosts, confirmed 2026-09-05 (src/adapters/hr-ge/RECON_NOTES.md):
  // the site itself, and the separate host the public sitemap lives on.
  // isHrGeUrlAllowed scopes api.p.hr.ge to *only* the sitemap path — the
  // path-level allow rule above is necessary but not sufficient, since
  // isPathAllowed alone doesn't know which host a path was matched for.
  allowedHosts: ['www.hr.ge', 'api.p.hr.ge'],
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
    'Acquisition decision (2026-09-05, §10.2 spike complete — full evidence in src/adapters/hr-ge/RECON_NOTES.md): http for discovery, reconciliation, sitemap cross-check and detail fetch; browser for canary/fallback only; api rejected (see the allowedAcquisitionModes comment above). Everything is server-rendered — a plain cookieless GET of /search-posting returns all 100 announcement links with no JS executed, and every page embeds the upstream API JSON verbatim in an Angular ng-state island. Discovery is ordinary ?pg=N pagination (Phase 0 recorded "no ordinary pagination links"; that is OVERTURNED — the links were in the raw HTML all along under the pg= parameter): 100 per page, 33 pages, 3,265 announcements, and an out-of-range page returns a real HTTP 404 rather than clamping. IMPORTANT CORRECTION to §5.2/§10.2: the public sitemap is NOT a usable reconciliation oracle for this source. Measured 2026-09-05, it contains exactly the 1,075 paid/priority announcements and zero free ones (isPriority=true correlates with sitemap membership perfectly in both directions across all 3,263 IDs recovered by a full index walk) — about 33% of the live corpus. Reconciling against it would make 2,190 free listings look absent on every healthy run and mass-close them, exactly the outcome §10.2 warns about. It also carries no lastmod, so it offers no change signal. Use it only as an additive cross-check that can introduce candidate IDs, never as evidence of absence. AWS WAF challenge infrastructure is present and confirmed enabled (wafConfig.isEnabled), but no challenge, CAPTCHA, or block was encountered across 46 read-only requests and nothing was bypassed (§5.2, §23.1); note the awswaf challenge.js tag is embedded in EVERY healthy page, so a detector must key on status/x-amzn-waf-action and on the absence of ng-server-context="ssr"/ng-state, never on the string "awswaf". Privacy finding requiring parser enforcement: detail pages set hideContactPerson=true and omit the recruiter name/personal email/mobile from the rendered page, yet those values are still present in the ng-state island — the parser must honor hideContactPerson and the show* flags and must not persist suppressed fields; the committed fixtures have those values redacted. RESOLVED (implementation pass, 2026-09-05): SourcePolicySchema (src/domain/source.ts) previously modeled a single host implicitly via Source.baseUrl with only a disallowedHosts deny-list and no positive host allow-list, so the public sitemap\'s separate host (api.p.hr.ge) could not be authorized. Added allowedHosts (a required, default-deny host allow-list, mirroring allowedPathPatterns) plus isHostAllowed to enforce it; jobs.ge\'s already-merged policy was updated to declare allowedHosts: [\'www.jobs.ge\'] as part of the same schema change. isHrGeUrlAllowed below scopes api.p.hr.ge to the sitemap path only.',
  decisionOwner: 'project owner',
});

const SEARCH_POSTING_PATH = '/search-posting';
const SITEMAP_PATH = '/public-portal/tenant/1/api/v3/seo/sitemap';
const ANNOUNCEMENT_PATH_RE = /^\/announcement\/[0-9]+\/[^/]+$/;

/**
 * hr.ge-specific authorization. Needed for the same reason
 * isJobsGeUrlAllowed is: discovery pagination lives entirely in a query
 * parameter (`?pg=N`), which isPathAllowed alone cannot express, and
 * isPathAllowed never looks at the origin at all.
 *
 * A second concern unique to this policy (confirmed 2026-09-05, see
 * src/adapters/hr-ge/RECON_NOTES.md): hr.ge is the first source whose
 * allowedPathPatterns spans two different hosts (www.hr.ge and the
 * sitemap's api.p.hr.ge). isPathAllowed matches a path string regardless
 * of which host it came from, so checking host and path independently
 * would wrongly authorize, say, `https://api.p.hr.ge/search-posting` — a
 * path that only ever exists on www.hr.ge. This function switches on
 * hostname first and scopes api.p.hr.ge to *only* the exact sitemap path,
 * rather than falling through to the www.hr.ge path-shape rules below.
 *
 * Authorized:
 *   - api.p.hr.ge: exactly the sitemap path, no query.
 *   - www.hr.ge '/search-posting': no query (page 1), or exactly
 *     `?pg=<positive digits>`.
 *   - www.hr.ge '/announcement/<digits>/<slug>': no query. The numeric ID
 *     is the identity (RECON_NOTES.md: the slug is decorative and would
 *     change if a title were edited), but the shape is still checked as a
 *     defense-in-depth structural assertion, the same role jobs.ge's
 *     `?id=<digits>` check plays.
 *   - www.hr.ge '/' and '/customer/<slug>': no query.
 * Everything else — including a same-path URL on a different host,
 * scheme, or port — is rejected by isHostAllowed.
 */
export function isHrGeUrlAllowed(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url, hrGeSource.baseUrl);
  } catch {
    return false;
  }

  if (!isHostAllowed(hrGePolicy, parsed)) {
    return false;
  }

  const keys = [...parsed.searchParams.keys()];
  const uniqueKeys = new Set(keys);
  if (uniqueKeys.size !== keys.length) {
    return false; // duplicate parameter
  }

  if (parsed.hostname === 'api.p.hr.ge') {
    return parsed.pathname === SITEMAP_PATH && keys.length === 0;
  }

  // www.hr.ge from here on.
  if (!isPathAllowed(hrGePolicy, parsed.pathname)) {
    return false;
  }

  if (parsed.pathname === SEARCH_POSTING_PATH) {
    if (keys.length === 0) {
      return true;
    }
    if (uniqueKeys.size !== 1 || !uniqueKeys.has('pg')) {
      return false;
    }
    const pg = parsed.searchParams.get('pg');
    return pg !== null && /^[1-9][0-9]*$/.test(pg);
  }

  if (ANNOUNCEMENT_PATH_RE.test(parsed.pathname)) {
    return keys.length === 0;
  }

  // '/' and '/customer/<slug>' remain authorized bare (no query). This is
  // an explicit enumeration, not a catch-all fallthrough for anything
  // isPathAllowed already accepted — that would wrongly re-admit
  // '/announcement/<digits>' with no slug (matches the '/announcement/'
  // prefix rule but not ANNOUNCEMENT_PATH_RE above) and the sitemap path
  // requested from www.hr.ge instead of its own host (matches the
  // sitemap's own allowedPathPatterns entry, since isPathAllowed never
  // looks at which host a path was matched for) — both caught by this
  // function's own test suite before this fix.
  return keys.length === 0 && (parsed.pathname === '/' || parsed.pathname.startsWith('/customer/'));
}
