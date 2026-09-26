import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../db/types.js';
import { sourceListingRevisions, sourceListings } from '../db/schema/index.js';

/**
 * Phase 7C incremental crawling (docs/PHASE_7C_PLAN.md), shared by both
 * adapters. Discovery still walks every list page, so closure and the
 * whole-corpus guards are unchanged; only detail fetches are skipped, for
 * listings whose list-page fingerprint is the one we last fetched.
 */

/** `changed` (scheduled default) skips unchanged listings; `all` fetches every one, as before 7C. */
export type RefetchMode = 'changed' | 'all';

/** Random skipped listings re-fetched each `changed` run: parser health and a measured blind spot. */
export const DEFAULT_CANARY_SAMPLE_SIZE = 20;
/** A revision fetched this recently may adopt its first fingerprint without a fetch (bootstrap). */
const BOOTSTRAP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface KnownListing {
  status: string;
  currentRevisionId: string | null;
  discoveryFingerprint: string | null;
  revisionFetchedAt: string | null;
}

/**
 * `fetch`: new, never fetched, reappeared after quarantine or closure, a
 * sitemap-only candidate (no fingerprint), or the fingerprint changed.
 * `adopt`: bootstrap, an active listing fetched within 7 days that has no
 * fingerprint yet takes this run's without a fetch.
 * `skip`: unchanged; the caller only marks it seen.
 */
export function needsDetailFetch(
  known: KnownListing | undefined,
  fingerprint: string | null,
  now: string,
): 'fetch' | 'adopt' | 'skip' {
  if (known === undefined || known.currentRevisionId === null || fingerprint === null) {
    return 'fetch';
  }
  if (known.status === 'quarantined' || known.status === 'closed') return 'fetch';
  if (known.discoveryFingerprint === null) {
    const recent =
      known.status === 'active' &&
      known.revisionFetchedAt !== null &&
      Date.parse(now) - Date.parse(known.revisionFetchedAt) <= BOOTSTRAP_MAX_AGE_MS;
    return recent ? 'adopt' : 'fetch';
  }
  return known.discoveryFingerprint === fingerprint ? 'skip' : 'fetch';
}

/** One query for every discovered id's stored state. */
export async function loadKnownListings(
  db: Database,
  sourceId: string,
  sourceRecordIds: readonly string[],
): Promise<Map<string, KnownListing>> {
  const known = new Map<string, KnownListing>();
  if (sourceRecordIds.length === 0) return known;
  const rows = await db
    .select({
      sourceRecordId: sourceListings.sourceRecordId,
      status: sourceListings.status,
      currentRevisionId: sourceListings.currentRevisionId,
      discoveryFingerprint: sourceListings.discoveryFingerprint,
      revisionFetchedAt: sourceListingRevisions.provenanceFetchedAt,
    })
    .from(sourceListings)
    .leftJoin(
      sourceListingRevisions,
      eq(sourceListingRevisions.id, sourceListings.currentRevisionId),
    )
    .where(
      and(
        eq(sourceListings.sourceId, sourceId),
        inArray(sourceListings.sourceRecordId, [...sourceRecordIds]),
      ),
    );
  for (const row of rows) {
    if (row.sourceRecordId === null) continue;
    known.set(row.sourceRecordId, {
      status: row.status,
      currentRevisionId: row.currentRevisionId,
      discoveryFingerprint: row.discoveryFingerprint,
      revisionFetchedAt: row.revisionFetchedAt,
    });
  }
  return known;
}

/**
 * Recorded only after a successful fetch and write (or a bootstrap
 * adoption), so a failed or quarantined fetch keeps the old value and the
 * next run tries again.
 */
export async function setDiscoveryFingerprint(
  db: Database,
  sourceId: string,
  sourceRecordId: string,
  fingerprint: string,
): Promise<void> {
  await db
    .update(sourceListings)
    .set({ discoveryFingerprint: fingerprint })
    .where(
      and(
        eq(sourceListings.sourceId, sourceId),
        eq(sourceListings.sourceRecordId, sourceRecordId),
        sql`${sourceListings.currentRevisionId} is not null`,
      ),
    );
}

/** `size` distinct ids from `skipped`, uniformly at random. */
export function pickCanaries(
  skipped: readonly string[],
  size: number,
  random: () => number = Math.random,
): Set<string> {
  const pool = [...skipped];
  const picked = new Set<string>();
  while (picked.size < size && pool.length > 0) {
    const index = Math.floor(random() * pool.length);
    const [id] = pool.splice(index, 1);
    if (id !== undefined) picked.add(id);
  }
  return picked;
}

/**
 * A per-fetch failure guard over detail pages actually fetched, not
 * listings discovered: with most listings skipped, dividing by discovered
 * would let a parser break on every fetched page pass as a few percent.
 * A plain rate, with no small-sample allowance: the canaries keep a real
 * run above 20 fetches, and an allowance let "every fetch failed" pass on
 * a small run.
 */
export function rateGuardOk(bad: number, fetched: number, maxRate: number): boolean {
  return fetched === 0 || bad / fetched <= maxRate;
}

export interface RefetchStats {
  mode: RefetchMode;
  /** Detail pages fetched this run. */
  fetched: number;
  skipped: number;
  adopted: number;
  canaries: number;
  /** Canaries whose content had changed although their fingerprint had not: the blind spot. */
  canaryChanged: number;
}
