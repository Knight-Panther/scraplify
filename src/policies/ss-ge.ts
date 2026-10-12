import { isHostAllowed, isPathAllowed, SourcePolicySchema, SourceSchema } from '../domain/index.js';

export const ssGeSource = SourceSchema.parse({
  id: 'ee0b0b42-571d-4316-a017-89de5e65179a',
  slug: 'ss-ge',
  displayName: 'ss.ge',
  baseUrl: 'https://home.ss.ge/',
});

export const ssGePolicy = SourcePolicySchema.parse({
  id: '44e70770-f5c3-4279-a32d-9cdd203915f5',
  sourceId: ssGeSource.id,
  policyVersion: 'v1',
  // Every page is server-rendered Next.js with its data embedded as JSON
  // (docs/real-estate-implementation-guideline.md §5), so plain HTTP reads
  // everything this adapter needs. The site's own frontend pages through a
  // JSON gateway with a site-issued token (§5.8); that is not 'api' access we
  // were given, so it is not a mode here.
  allowedAcquisitionModes: ['http'],
  // One prefix covers both things this adapter reads: results pages under
  // '/ka/udzravi-qoneba/l/' and detail pages at '/ka/udzravi-qoneba/<id>'.
  // The exact shapes are pinned by isSsGeUrlAllowed below, not here.
  allowedPathPatterns: [{ pattern: '/ka/udzravi-qoneba/', match: 'prefix' }],
  // The first three are robots.txt's own Disallow lines. The rest are hub
  // pages that sit under the allowed prefix and are never read (calculators,
  // the cadastral map, developers' projects): none is reachable through
  // isSsGeUrlAllowed, and disallow always wins over allow besides.
  disallowedPathPatterns: [
    { pattern: '/ka/user', match: 'prefix' },
    { pattern: '/en/user', match: 'prefix' },
    { pattern: '/ru/user', match: 'prefix' },
    { pattern: '/ka/udzravi-qoneba/calculator', match: 'prefix' },
    { pattern: '/ka/udzravi-qoneba/loan-calculator', match: 'prefix' },
    { pattern: '/ka/udzravi-qoneba/sakadastro-ruka', match: 'prefix' },
    { pattern: '/ka/udzravi-qoneba/mshenebare', match: 'prefix' },
  ],
  allowedHosts: ['home.ss.ge'],
  // Named so the refusal is on record: the gateway the site's frontend calls.
  disallowedHosts: ['api-gateway.ss.ge'],
  authenticationScope: 'none',
  rateLimit: {
    crawlDelaySeconds: 3,
    maxConcurrency: 1,
    notes:
      "robots.txt declares no Crawl-delay, and no rate-limit header, challenge or 429 was seen across about 150 requests on 2026-10-12, including from the production server. 3 s and one request at a time match this project's politeness floor (hr.ge, etenders.ge). Results pages are slow: median 6.8 s on broad queries, up to 20 s when a request passes the end of a list, hence the 60 s request timeout the CLI sets. No request budget has been agreed with the site yet (guideline §2.2); the nightly run is sized to stay under 2,000 requests.",
  },
  termsUrl: 'https://ss.ge/ka/home/help?index=13',
  robotsUrl: 'https://home.ss.ge/robots.txt',
  retention: {
    rawHtmlRetentionDays: 0,
    notes:
      'No page is stored. Parsed fields go to the realestate schema; phone numbers, names and user ids in the payload are dropped by the parser.',
  },
  display: {
    mayRepublishFullContent: false,
    notes:
      'Descriptions are stored and searched but not shown on the public surface, for the same reason as the job boards (owner decision, 2026-10-07): visitors should click through to the source. Every row links to the original listing.',
  },
  linkedResources: {
    allowedDestinationHosts: [],
    allowedRelationshipTypes: [],
    maxTraversalDepth: 0,
    maxResourcesPerOpportunity: 0,
    mayFetchExternalApplicationPages: false,
    retention: 'none',
    notes:
      'Disabled (§16). Photos are out of scope for version 1 and are neither fetched nor linked.',
  },
  reviewDate: '2026-10-12T00:00:00Z',
  evidence: [
    'docs/real-estate-implementation-guideline.md (live read-only study, 2026-10-12: address and filter map, row and detail fields, paging behaviour, traps)',
    'https://home.ss.ge/robots.txt (fetched 2026-10-12: Disallow /ka/user, /en/user, /ru/user; no Crawl-delay)',
    'https://ss.ge/ka/home/help?index=13 (posting rules, read 2026-10-12: no clause on automated access or reuse)',
    'Reachability from the production server, 2026-10-12 13:30 UTC: results and detail pages answered 200 with the project User-Agent',
    "docs/RIGHTS.md (the owner's verbal OK from ss.ge, recorded 2026-10-12)",
  ],
  notes:
    'Real-estate classifieds on home.ss.ge. Version 1 scope (owner, 2026-10-12): flats, houses and summer cottages, for sale and long-term rent, all of Georgia. Rows are stored in the realestate schema, not in source_listings, and the source is excluded from job-board health, retention and matching (src/source-traits.ts, REAL_ESTATE_SOURCES).',
  decisionOwner: 'project owner',
});

/** Kinds and deals in scope; daily rent, land, commercial and hotels are not. */
const RESULTS_PATH_RE =
  /^\/ka\/udzravi-qoneba\/l\/(bina|kerdzo-saxli|agaraki)\/(iyideba|qiravdeba)$/;
/** Detail pages are requested by id alone; the site ignores any slug. */
const DETAIL_PATH_RE = /^\/ka\/udzravi-qoneba\/[1-9][0-9]{0,9}$/;

const RESULTS_KEYS = new Set(['order', 'page', 'cityIdList', 'rooms']);
/** The deepest real page measured was 2,593 (flats for sale, 2026-10-12). */
const PAGE_RE = /^[1-9][0-9]{0,3}$/;
const CITY_RE = /^[1-9][0-9]{0,5}$/;
const ROOMS_RE = /^[1-9]$/;

/**
 * ss.ge-specific authorization: the host and path checks alone cannot pin
 * query shapes, and on this source the shape decides what comes back. Without
 * `order=1` a results list is promoted-first, not newest-first, and the crawl
 * stops at the wrong place.
 *
 * Authorized:
 *   - a results page for a kind and deal in scope, with exactly `order=1` and
 *     a `page`, plus optionally one `cityIdList` and one `rooms`;
 *   - a detail page at '/ka/udzravi-qoneba/<id>' with no query.
 * Everything else is rejected, including any other host, scheme or port.
 */
export function isSsGeUrlAllowed(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (!isHostAllowed(ssGePolicy, parsed)) return false;
  if (!isPathAllowed(ssGePolicy, parsed.pathname)) return false;
  if (parsed.hash !== '') return false;

  const keys = [...parsed.searchParams.keys()];
  if (new Set(keys).size !== keys.length) return false; // duplicate parameter
  const params = parsed.searchParams;

  if (DETAIL_PATH_RE.test(parsed.pathname)) return keys.length === 0;

  if (!RESULTS_PATH_RE.test(parsed.pathname)) return false;
  if (keys.some((key) => !RESULTS_KEYS.has(key))) return false;
  if (params.get('order') !== '1') return false;
  if (!PAGE_RE.test(params.get('page') ?? '')) return false;
  if (params.has('cityIdList') && !CITY_RE.test(params.get('cityIdList') ?? '')) return false;
  if (params.has('rooms') && !ROOMS_RE.test(params.get('rooms') ?? '')) return false;
  return true;
}
