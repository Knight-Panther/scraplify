import { isHostAllowed, isPathAllowed, SourcePolicySchema, SourceSchema } from '../domain/index.js';

/**
 * summerschoolsineurope.eu, a directory of short academic courses across
 * Europe (Phase 15A, `docs/PHASE_15_PLAN.md`). The first programme source:
 * its listings are courses, never vacancies, so they stay out of CV Ranked
 * (`NON_VACANCY_SOURCES`) and are typed by source (`src/dedupe/programme-kind.ts`).
 */
export const summerSchoolsEuSource = SourceSchema.parse({
  id: 'ac655fa5-f16b-432e-9a07-00570c9d2351',
  slug: 'summerschoolsineurope-eu',
  displayName: 'summerschoolsineurope.eu',
  baseUrl: 'https://www.summerschoolsineurope.eu/',
});

export const summerSchoolsEuPolicy = SourcePolicySchema.parse({
  id: 'cea41ef2-1f2c-4fbf-986c-071b864ab44f',
  sourceId: summerSchoolsEuSource.id,
  policyVersion: 'v1',
  // WordPress pages rendered on the server. The REST API answers 401 and is
  // not used (2026-11-09).
  allowedAcquisitionModes: ['http'],
  // The exact query shapes are pinned by isSummerSchoolsEuUrlAllowed below.
  allowedPathPatterns: [
    { pattern: '/courses/', match: 'exact' },
    { pattern: '/course/', match: 'prefix' },
    { pattern: '/sitemap_index.xml', match: 'exact' },
    { pattern: '/course-sitemap', match: 'prefix' },
  ],
  // Belt and braces next to the allow-list: none of these is reachable
  // through it, and disallow always wins.
  disallowedPathPatterns: [
    { pattern: '/wp-json/', match: 'prefix' },
    { pattern: '/wp-admin/', match: 'prefix' },
    { pattern: '/wp-login.php', match: 'exact' },
    { pattern: '/login/', match: 'prefix' },
    { pattern: '/my-account/', match: 'prefix' },
  ],
  // www only: the apex answers every path with a 301 to www (2026-11-13).
  allowedHosts: ['www.summerschoolsineurope.eu'],
  disallowedHosts: [],
  authenticationScope: 'none',
  rateLimit: {
    crawlDelaySeconds: 15,
    maxConcurrency: 1,
    notes:
      'robots.txt asks every agent for `Crawl-delay: 15` (read 2026-11-09 and 2026-11-13), and this crawler keeps to it, one request at a time. Pages are served through Cloudflare and Kinsta, whose page cache keeps each URL up to 2 h (`s-maxage=7200`).',
  },
  termsUrl: null,
  robotsUrl: 'https://www.summerschoolsineurope.eu/robots.txt',
  retention: {
    rawHtmlRetentionDays: null,
    notes: 'Retention period is an open decision (concept §27); not yet set.',
  },
  display: {
    mayRepublishFullContent: false,
    notes:
      'Owner decision 2026-11-09 (docs/PHASE_15_PLAN.md, decision 2): public pages show the facts, a short excerpt and links to the course page and the organiser. The full text is stored and not shown.',
  },
  linkedResources: {
    allowedDestinationHosts: [],
    allowedRelationshipTypes: [],
    maxTraversalDepth: 0,
    maxResourcesPerOpportunity: 0,
    mayFetchExternalApplicationPages: false,
    retention: 'none',
    notes:
      "Disabled (§16). The organiser's registration link is stored as published and shown as a link; it is never fetched.",
  },
  reviewDate: '2026-11-13T12:00:00Z',
  evidence: [
    'https://www.summerschoolsineurope.eu/robots.txt (read 2026-11-09 and again 2026-11-13: `User-agent: *` with an empty Disallow and `Crawl-delay: 15`; GPTBot, ChatGPT-User, Google-Extended, ClaudeBot, PerplexityBot and CCBot are turned away by name, all AI-training or AI-assistant crawlers; this crawler is neither)',
    'https://www.summerschoolsineurope.eu/wp-json/wp/v2/course (2026-11-09: HTTP 401; not used)',
    "From the production host (2026-11-09): /courses/ answered 200 with 12 courses and no Cloudflare challenge, with this crawler's own User-Agent",
    'src/adapters/summerschoolsineurope-eu/RECON_NOTES.md (recon and fixture capture, 2026-11-13)',
  ],
  notes:
    'Terms not reviewed: the terms and disclaimer pages render their text in the browser (2026-11-09). No permission is needed from the site (owner, 2026-11-13; docs/RIGHTS.md). Only upcoming courses are taken (owner, 2026-11-09). Membership comes from the course listing, change detection from the course sitemaps; a course closes when it starts, when its registration deadline passes, or when it is missing from three complete walks in a row.',
  decisionOwner: 'project owner',
});

const LISTING_PATH = '/courses/';
/**
 * A course page, `/course/<slug>/`, its slug as WordPress makes one: lower
 * case letters, digits, `-` and `_`, and percent-encoded bytes for a letter
 * it cannot spell in ASCII. The sitemap reader keeps to the same shape.
 */
export const COURSE_PAGE_PATH_RE = /^\/course\/(?:[a-z0-9_-]|%[0-9a-fA-F]{2})+\/$/;
const SITEMAP_INDEX_PATH = '/sitemap_index.xml';
const COURSE_SITEMAP_RE = /^\/course-sitemap(?:[1-9][0-9]?)?\.xml$/;

/** The listing's own "upcoming" filter, always sent, so its default cannot change underneath. */
export const LISTING_STATUS_PARAM = '_course_status';
export const LISTING_STATUS_VALUE = 'future';
/**
 * The facets the covering walk may split a result set by (RECON_NOTES,
 * "Membership"), as FacetWP names them; the URL parameter is the name with
 * a leading underscore.
 */
export const LISTING_SPLIT_FACETS = [
  'course_country',
  'course_city',
  'course_starting',
  'course_duration',
  'course_discipline',
] as const;
export type ListingSplitFacet = (typeof LISTING_SPLIT_FACETS)[number];
/**
 * A FacetWP choice value as the site makes them (`italy`, `01_january`,
 * `short-0-1-week`): FacetWP lower-cases a value and keeps letters, digits,
 * `.`, `-` and `_`, and stores anything else as an MD5 hex digest, so a
 * value never holds the comma that separates OR-ed values.
 */
const FACET_VALUE_RE = /^[a-z0-9._-]+$/;
const MAX_FACET_VALUES = 100;

/** Whether the covering walk may ask for this facet value (one value, not a list). */
export function isListingFacetValueAllowed(value: string): boolean {
  return FACET_VALUE_RE.test(value);
}

function facetValuesAllowed(raw: string): boolean {
  const values = raw.split(',');
  return (
    values.length >= 1 &&
    values.length <= MAX_FACET_VALUES &&
    values.every(isListingFacetValueAllowed)
  );
}

/**
 * summerschoolsineurope.eu authorization. Allowed:
 *   - '/courses/' with `_course_status=future` and, each at most once, any
 *     of the split facets (`_course_country`, `_course_city`,
 *     `_course_starting`, `_course_duration`, `_course_discipline`) holding a
 *     comma-separated list of slug values;
 *   - '/course/<slug>/' with no query (a WordPress slug, `COURSE_PAGE_PATH_RE`);
 *   - '/sitemap_index.xml' and '/course-sitemap<n>.xml' with no query.
 * Everything else is rejected: other hosts, schemes and ports, the REST API,
 * the admin and login, paging, other facets and search, fragments.
 */
export function isSummerSchoolsEuUrlAllowed(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url, summerSchoolsEuSource.baseUrl);
  } catch {
    return false;
  }
  if (!isHostAllowed(summerSchoolsEuPolicy, parsed)) return false;
  if (!isPathAllowed(summerSchoolsEuPolicy, parsed.pathname)) return false;
  if (parsed.hash !== '') return false;

  const keys = [...parsed.searchParams.keys()];
  if (parsed.pathname === LISTING_PATH) {
    if (new Set(keys).size !== keys.length) return false;
    if (parsed.searchParams.get(LISTING_STATUS_PARAM) !== LISTING_STATUS_VALUE) return false;
    const facetParams = new Set<string>(LISTING_SPLIT_FACETS.map((facet) => `_${facet}`));
    return keys.every(
      (key) =>
        key === LISTING_STATUS_PARAM ||
        (facetParams.has(key) && facetValuesAllowed(parsed.searchParams.get(key) ?? '')),
    );
  }
  if (parsed.search !== '') return false;
  return (
    COURSE_PAGE_PATH_RE.test(parsed.pathname) ||
    parsed.pathname === SITEMAP_INDEX_PATH ||
    COURSE_SITEMAP_RE.test(parsed.pathname)
  );
}
