import { type CrawlStatusSnapshot, getCrawlStatus } from '../../../../src/browse/crawl-status.js';
import { db } from '../../../../src/db/client.js';

export const dynamic = 'force-dynamic';

/**
 * `GET /api/crawl-status`: each source's crawl snapshot, which the landing
 * page's "last update / next update" line polls once a minute
 * (`components/crawl-status.tsx`). Reads only `public_crawl_status`, so it is
 * served on `public` as well as `local`. One query per 15 s per process
 * however many visitors poll; the browser works out late/next itself.
 */
const CACHE_MS = 15_000;
let cached: { atMs: number; sources: CrawlStatusSnapshot[] } | null = null;

export async function GET(): Promise<Response> {
  const nowMs = Date.now();
  if (cached === null || nowMs - cached.atMs >= CACHE_MS) {
    try {
      cached = { atMs: nowMs, sources: await getCrawlStatus(db) };
    } catch (err) {
      console.error('crawl-status: failed to load', err);
      return Response.json(
        { error: 'unavailable' },
        { status: 503, headers: { 'Cache-Control': 'no-store' } },
      );
    }
  }
  return Response.json(
    { sources: cached.sources },
    { headers: { 'Cache-Control': 'public, max-age=15' } },
  );
}
