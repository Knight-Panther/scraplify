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
  policyVersion: 'v2',
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
      "One request at a time, at least 3 s after the previous answer, never lowered: the host's traffic leaves through the owner's own connection. robots.txt declares no Crawl-delay, and no rate-limit header, challenge or 429 was seen across about 150 requests on 2026-10-12 nor in the live recon of 2026-11-03. Owner decision 2026-11-03 (\"as many as safe\"): no request-count cap; safety is the spacing, stopping at once on any refusal or back-off, and a bound on each run's time (the unit's own limit; from Phase 12B also a 16-hour time box and a 20,000-request runaway ceiling). The 60 s request timeout the CLI sets dates from October, when results pages took a median 6.8 s.",
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
      'Disabled (§16). No photo is fetched, stored, linked or shown (owner, 2026-11-03); only the photo count a results row states is kept.',
  },
  reviewDate: '2026-11-03T00:00:00Z',
  evidence: [
    'docs/real-estate-implementation-guideline.md (live read-only study, 2026-10-12: address and filter map, row and detail fields, paging behaviour, traps)',
    'https://home.ss.ge/robots.txt (fetched 2026-10-12: Disallow /ka/user, /en/user, /ru/user; no Crawl-delay)',
    'https://ss.ge/ka/home/help?index=13 (posting rules, read 2026-10-12: no clause on automated access or reuse)',
    'Reachability from the production server, 2026-10-12 13:30 UTC: results and detail pages answered 200 with the project User-Agent',
    "docs/RIGHTS.md (the owner's verbal OK from ss.ge, recorded 2026-10-12)",
    "Live recon from the owner's PC, 2026-11-03 (src/adapters/ss-ge/RECON_NOTES.md): the 24 lists of six kinds and four deals; results pages answered in 0.3–1.0 s and listing pages in 0.1–0.6 s; no refusal, challenge or 429",
  ],
  notes:
    'Real-estate classifieds on home.ss.ge. Scope (owner, 2026-11-03, widening the flats, houses and summer cottages for sale and rent of 2026-10-12): all six kinds (flats, houses, summer cottages, commercial spaces, land, hotels) for all four deals (sale, rent, daily rent, pledge), all of Georgia. Rows are stored in the realestate schema, not in source_listings, and the source is excluded from job-board health, retention and matching (src/source-traits.ts, REAL_ESTATE_SOURCES).',
  decisionOwner: 'project owner',
});

/** Every kind and deal (Phase 12A): the kind and the deal are both always named. */
const RESULTS_PATH_RE =
  /^\/ka\/udzravi-qoneba\/l\/(bina|kerdzo-saxli|agaraki|komerciuli|mitsis-nakveti|sastumro)\/(iyideba|qiravdeba|qiravdeba-dghiurad|giravdeba)$/;
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
 *   - a results page for one kind and one deal, with exactly `order=1` and
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
