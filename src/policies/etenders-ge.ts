import { isHostAllowed, isPathAllowed, SourcePolicySchema, SourceSchema } from '../domain/index.js';

export const etendersGeSource = SourceSchema.parse({
  id: 'a09513f5-1d92-4c4f-bbc0-12f3e15f96df',
  slug: 'etenders-ge',
  displayName: 'etenders.ge',
  baseUrl: 'https://etenders.ge/',
});

export const etendersGePolicy = SourcePolicySchema.parse({
  id: 'c91bb2f0-6da2-4b52-9842-349679476077',
  sourceId: etendersGeSource.id,
  policyVersion: 'v1',
  // Everything is server-rendered ASP.NET WebForms HTML; there is no API of
  // any kind (docs/addEtender.md §3). The one JSON endpoint, the CPV
  // dictionary, is an ordinary GET as well.
  allowedAcquisitionModes: ['http'],
  // '/search/' is the only list view this adapter reads: its status filter
  // (`ts=_1_2_3_`) returns exactly the live tenders, and its date filter
  // (`st=`) the recently announced ones, so no whole-archive walk is needed.
  // '/view/' covers tender detail pages, always requested as
  // `/view/<id>/x` (the slug is ignored by the site). The exact query
  // shapes are pinned by isEtendersGeUrlAllowed below, not here.
  allowedPathPatterns: [
    { pattern: '/search/', match: 'exact' },
    { pattern: '/view/', match: 'prefix' },
    { pattern: '/Pages/Tender/getTenderCPVSelection.aspx', match: 'exact' },
  ],
  // Belt and braces next to the allow-list: these paths change state
  // through plain GETs (DeleteComment, ToggleFav), need a session (login,
  // register), are out of v1 scope (asset sales, documents, logos) or are a
  // session keep-alive. None is reachable through the allow-list above, and
  // disallow always wins over allow besides.
  disallowedPathPatterns: [
    { pattern: '/Pages/Tender/TenderDetails/', match: 'prefix' },
    { pattern: '/Pages/Tender/TenderSearch/', match: 'prefix' },
    { pattern: '/Pages/Tender/FileHandler/', match: 'prefix' },
    { pattern: '/Pages/Profile/', match: 'prefix' },
    { pattern: '/Pages/HeartBeat.aspx', match: 'exact' },
    { pattern: '/viewsale/', match: 'prefix' },
    { pattern: '/login', match: 'prefix' },
    { pattern: '/Register', match: 'prefix' },
  ],
  // The apex only: www.etenders.ge answers with a 301 to it.
  allowedHosts: ['etenders.ge'],
  disallowedHosts: [],
  authenticationScope: 'none',
  rateLimit: {
    crawlDelaySeconds: 3,
    maxConcurrency: 1,
    notes:
      "No robots.txt (404), so no declared Crawl-delay, and no rate-limit headers or WAF were seen across ~100 requests (2026-10-05). 3 s and one request at a time match hr.ge as this project's politeness floor. The server is a slow IIS 8.5 host (most pages 0.2–1.5 s, outliers of 8 s and 34 s, one 90 s connect timeout), hence the 60 s request timeout the CLI sets, and every page is a full uncompressed download (no gzip, no ETag), hence a crawl that reads only the live set and a recent-arrivals window.",
  },
  termsUrl:
    'https://etenders.ge/Pages/GeneralHelpViewer/GeneralHelpDisplay.aspx?key=Registration_Contract',
  robotsUrl: 'https://etenders.ge/robots.txt',
  retention: {
    rawHtmlRetentionDays: null,
    notes: 'Retention period is an open decision (concept §27); not yet set.',
  },
  display: {
    mayRepublishFullContent: false,
    notes:
      "The owner has etenders.ge's permission (2026-10-07, docs/RIGHTS.md), but descriptions stay unpublished on the public surface, as for jobs.ge and hr.ge, until the owner decides to publish full content for all sources: tender descriptions routinely carry named contacts with mobile numbers and email addresses. Structured fields and a link to the etenders.ge page are shown instead.",
  },
  linkedResources: {
    allowedDestinationHosts: [],
    allowedRelationshipTypes: [],
    maxTraversalDepth: 0,
    maxResourcesPerOpportunity: 0,
    mayFetchExternalApplicationPages: false,
    retention: 'none',
    notes:
      'Disabled (§16). Tender documents download anonymously from stable GUID links, but they belong to the buyers and are shown only as a count and file types, with a link to the etenders.ge page.',
  },
  reviewDate: '2026-10-07T00:00:00Z',
  evidence: [
    'docs/addEtender.md (live read-only study, 2026-10-05: URL and parameter map, statuses and procurement methods, card and detail anatomy, traps, corpus numbers)',
    'https://etenders.ge/robots.txt (fetched 2026-10-05: HTTP 404; no sitemap.xml either)',
    'https://etenders.ge/Pages/GeneralHelpViewer/GeneralHelpDisplay.aspx?key=Registration_Contract (terms of use, read 2026-10-05: no clause on automated access; posted information is open to all users except bids, restricted procedures and anonymous buyers)',
    'docs/RIGHTS.md (owner permission from etenders.ge, recorded 2026-10-07)',
    'src/adapters/etenders-ge/RECON_NOTES.md (fixture capture 2026-10-07)',
  ],
  notes:
    'Private B2B tender board (LLC "Electronic Procurement System", 405075047), not the state procurement system. v1 scope (owner, 2026-10-07): public purchase tenders only. Asset sales (/viewsale), restricted (invite-only) tenders and anonymous buyers\' tenders are skipped: their cards carry a lock icon and no detail link, and their details are closed to the public by the site\'s own terms (§2.7, §2.8), so the adapter never builds a detail URL for them. Closure comes from the status the detail page states (completed, terminated, failed), not from absence; runs are never full coverage, so no missing streak ever advances.',
  decisionOwner: 'project owner',
});

const SEARCH_PATH = '/search/';
const CPV_PATH = '/Pages/Tender/getTenderCPVSelection.aspx';
/** Detail pages are always requested with the literal slug `x`; the site ignores the slug. */
const DETAIL_PATH_RE = /^\/view\/[1-9][0-9]{0,8}\/x$/;

/** The exact parameter set the site's own search form emits, in any order. */
const SEARCH_KEYS = ['ss', 'ts', 'kw', 'tn', 'br', 'cpv', 'st', 'end', 'stamm', 'endamm'] as const;
/** Parameters this adapter always sends empty. */
const EMPTY_SEARCH_KEYS = ['kw', 'tn', 'br', 'cpv', 'stamm', 'endamm'] as const;
/** Procurement method: -1 for all, 1–5 for one method. Anything else is a server error (`int.Parse`). */
const METHOD_RE = /^(-1|[1-5])$/;
/**
 * Status set: `__` for all, or underscore-wrapped codes. A bare `2` is not an
 * error but silently returns zero results, which is exactly the shape a
 * broken crawl would take, so only the wrapped form is accepted.
 */
const STATUS_SET_RE = /^(__|_(?:(?:1|2|3|4|5|99)_)+)$/;
const DATE_RE = /^(0[1-9]|[12][0-9]|3[01])-(0[1-9]|1[0-2])-20[0-9]{2}$/;
const PAGE_RE = /^[1-9][0-9]{0,3}$/;

/**
 * etenders.ge-specific authorization: the host and path checks alone cannot
 * pin query shapes, and on this source a wrong shape is not harmless. A
 * malformed method value makes the server throw (HTTP 500, an ASP.NET error
 * page), and a malformed status value returns an empty result with HTTP 200,
 * indistinguishable from "no tenders". So every search URL must carry exactly
 * the form's parameter set with values in known-good shapes.
 *
 * Authorized:
 *   - '/search/' with exactly the form's ten parameters (plus an optional
 *     `pg`): `ss` a method, `ts` a status set, `st`/`end` empty or
 *     DD-MM-YYYY, every other parameter empty.
 *   - '/view/<digits>/x' with no query.
 *   - the CPV dictionary with exactly `TenderId=-1` and `lng` 1 or 2.
 * Everything else is rejected, including any other host, scheme or port.
 */
export function isEtendersGeUrlAllowed(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url, etendersGeSource.baseUrl);
  } catch {
    return false;
  }

  if (!isHostAllowed(etendersGePolicy, parsed)) return false;
  if (!isPathAllowed(etendersGePolicy, parsed.pathname)) return false;
  if (parsed.hash !== '') return false;

  const keys = [...parsed.searchParams.keys()];
  if (new Set(keys).size !== keys.length) return false; // duplicate parameter
  const params = parsed.searchParams;

  if (parsed.pathname === SEARCH_PATH) {
    const allowed = new Set<string>([...SEARCH_KEYS, 'pg']);
    if (keys.some((key) => !allowed.has(key))) return false;
    if (SEARCH_KEYS.some((key) => !params.has(key))) return false;
    if (!METHOD_RE.test(params.get('ss') ?? '')) return false;
    if (!STATUS_SET_RE.test(params.get('ts') ?? '')) return false;
    if (EMPTY_SEARCH_KEYS.some((key) => params.get(key) !== '')) return false;
    for (const key of ['st', 'end'] as const) {
      const value = params.get(key) ?? '';
      if (value !== '' && !DATE_RE.test(value)) return false;
    }
    if (params.has('pg') && !PAGE_RE.test(params.get('pg') ?? '')) return false;
    return true;
  }

  if (DETAIL_PATH_RE.test(parsed.pathname)) {
    return keys.length === 0;
  }

  if (parsed.pathname === CPV_PATH) {
    return (
      keys.length === 2 &&
      params.get('TenderId') === '-1' &&
      (params.get('lng') === '1' || params.get('lng') === '2')
    );
  }

  return false;
}
