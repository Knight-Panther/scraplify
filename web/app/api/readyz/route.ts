import { readiness } from '../../../lib/readiness.js';

export const dynamic = 'force-dynamic';

/**
 * `GET /api/readyz` — readiness (Phase 8E): 200 when this process can serve
 * its surface, 503 when its database is unreachable. See `lib/readiness.ts`
 * for why a stale matching bundle is reported but does not fail it.
 */
export async function GET(): Promise<Response> {
  const result = await readiness();
  return Response.json(result, {
    status: result.status === 'ready' ? 200 : 503,
    headers: { 'Cache-Control': 'no-store' },
  });
}
