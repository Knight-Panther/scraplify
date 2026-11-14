import { db } from '../../../../../src/db/client.js';
import {
  FACET_KEYS,
  type FacetKey,
  type FacetResult,
  facetCounts,
} from '../../../../../src/realestate/facets.js';
import { withinTimeout } from '../../../../../src/realestate/queries.js';
import { cachedByKey } from '../../../../lib/cached.js';
import { countCacheKey, parseRealEstateQuery } from '../../../../lib/real-estate-params.js';
import type { RawSearchParams } from '../../../../lib/search-params.js';

export const dynamic = 'force-dynamic';

/**
 * `GET /real-estate/facets?<the page's own query>&facet=rooms&facet=amenities`:
 * the option counts the filter panels show (`src/realestate/facets.ts`), for
 * the filters in the address. Reads only `public_listings` and `public_places`,
 * so it is served on every surface. Each facet is asked once per filter set
 * every ten minutes in this process, like the page's own counts; one that
 * outlasts its time limit is `null`, and the panel shows no numbers. A null is
 * kept one minute, so a slow facet costs the host once a minute rather than
 * on every change while a panel is open, and a miss on a cold start (the
 * first minutes after a deploy, 2026-11-14) does not blank a panel for ten.
 */
const TTL_MS = 10 * 60_000;
const MAX_KEYS = 2_000;
const FACET_TIMEOUT_MS = 2_500;
const MAX_FACETS = 16;
const MISS_TTL_MS = 60_000;
const answered = cachedByKey<FacetResult | null>(TTL_MS, MAX_KEYS, (result) => result !== null);
const recent = cachedByKey<FacetResult | null>(MISS_TTL_MS, MAX_KEYS, () => true);

/** The address's pairs as the pages get theirs: one string, or a list for a repeated name. */
function rawParams(params: URLSearchParams): RawSearchParams {
  const raw: RawSearchParams = {};
  for (const name of new Set(params.keys())) {
    const values = params.getAll(name);
    raw[name] = values.length === 1 ? values[0] : values;
  }
  return raw;
}

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const wanted = [...new Set(params.getAll('facet'))]
    .filter((name): name is FacetKey => (FACET_KEYS as readonly string[]).includes(name))
    .slice(0, MAX_FACETS);
  const nowMs = Date.now();
  const { filters } = parseRealEstateQuery(rawParams(params), nowMs);
  const now = new Date(nowMs).toISOString();
  const key = countCacheKey(filters, TTL_MS);
  try {
    const results = await Promise.all(
      wanted.map((facet) =>
        answered(`${facet}|${key}`, () =>
          recent(`${facet}|${key}`, () =>
            withinTimeout(db, FACET_TIMEOUT_MS, (tx) => facetCounts(tx, filters, now, facet)),
          ),
        ),
      ),
    );
    return Response.json(
      { facets: Object.fromEntries(wanted.map((facet, at) => [facet, results[at] ?? null])) },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    console.error('real-estate facets: failed to load', err);
    return Response.json(
      { error: 'unavailable' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
