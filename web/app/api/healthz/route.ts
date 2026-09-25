export const dynamic = 'force-dynamic';

/**
 * `GET /api/healthz` — liveness (Phase 8E). Answers from the process alone,
 * touching no database, so a restart policy acting on it never restarts a
 * healthy web process because Postgres is briefly away. Served on every
 * surface; says nothing beyond "this process is up".
 */
export function GET(): Response {
  return Response.json({ status: 'ok' }, { headers: { 'Cache-Control': 'no-store' } });
}
