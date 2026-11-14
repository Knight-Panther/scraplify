import { db } from '../../../../../src/db/client.js';
import { suggestPlaces } from '../../../../../src/realestate/place-suggest.js';
import { parseRealEstateQuery } from '../../../../lib/real-estate-params.js';
import { capGraphemes } from '../../../../lib/search-params.js';

export const dynamic = 'force-dynamic';

/** The most characters of the box's text that are read. */
const MAX_PLACE_TEXT = 80;

/**
 * `GET /real-estate/places?<the page's own query>&text=vak`: the place box's
 * suggestions (`src/realestate/place-suggest.ts`), each with how many
 * listings it would show given the other filters. Reads only
 * `public_listings` and `public_places`, so it is served on every surface.
 */
export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const nowMs = Date.now();
  const raw: Record<string, string | string[]> = {};
  for (const name of new Set(params.keys())) {
    const values = params.getAll(name);
    raw[name] = values.length === 1 ? (values[0] as string) : values;
  }
  const { filters } = parseRealEstateQuery(raw, nowMs);
  const text = capGraphemes((params.get('text') ?? '').trim(), MAX_PLACE_TEXT);
  try {
    return Response.json(await suggestPlaces(db, text, filters, new Date(nowMs).toISOString()), {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    console.error('real-estate places: failed to load', err);
    return Response.json(
      { error: 'unavailable' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
