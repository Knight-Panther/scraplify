import { sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { MAX_BUNDLE_AGE_HOURS } from '../../src/matching/bundle/contract.js';
import { loadActiveBundle } from './matching-delivery.js';
import { currentSurface, type Surface } from './surface.js';

/**
 * Readiness for the hosted probes (Phase 8E, change.md §10: "public synthetic
 * probes for landing, Browse, detail, manifest and artifact download").
 *
 * Only the database decides readiness. A missing or stale matching bundle is
 * reported but does not fail the probe: change.md §15 says a builder outage
 * must not take the last-known-good catalogue out of service, and Browse
 * works without a bundle. The response names states only (`ok`, `down`,
 * `stale`...), never an error message, host or query, since the public
 * process serves it to anyone.
 */

export type DatabaseState = 'ok' | 'down';
export type MatchingState = 'ok' | 'stale' | 'unavailable' | 'not_served';

export interface Readiness {
  status: 'ready' | 'not_ready';
  surface: Surface;
  database: DatabaseState;
  matching: MatchingState;
}

const DATABASE_TIMEOUT_MS = 2_000;

export function summarize(
  surface: Surface,
  database: DatabaseState,
  matching: MatchingState,
): Readiness {
  return { status: database === 'ok' ? 'ready' : 'not_ready', surface, database, matching };
}

export function matchingState(generatedAt: string | null, now: number): MatchingState {
  if (generatedAt === null) return 'unavailable';
  const ageHours = (now - Date.parse(generatedAt)) / 3_600_000;
  return ageHours > MAX_BUNDLE_AGE_HOURS ? 'stale' : 'ok';
}

async function checkDatabase(): Promise<DatabaseState> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'down'>((resolve) => {
    timer = setTimeout(() => resolve('down'), DATABASE_TIMEOUT_MS);
  });
  const ping = db.execute(sql`select 1`).then(
    () => 'ok' as const,
    () => 'down' as const,
  );
  try {
    return await Promise.race([ping, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function checkMatching(surface: Surface): Promise<MatchingState> {
  if (surface === 'admin') return 'not_served';
  try {
    const loaded = await loadActiveBundle();
    if ('status' in loaded) return 'unavailable';
    return matchingState(loaded.active.manifest.generatedAt, Date.now());
  } catch {
    return 'unavailable';
  }
}

export async function readiness(): Promise<Readiness> {
  const surface = currentSurface();
  const database = await checkDatabase();
  const matching = database === 'ok' ? await checkMatching(surface) : 'unavailable';
  return summarize(surface, database, matching);
}
