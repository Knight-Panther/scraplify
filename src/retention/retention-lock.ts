import type { Pool } from 'pg';
import { ADVISORY_LOCKS, withAdvisoryLock } from '../db/advisory-lock.js';
import { acquireCrawlProcessLock, type CrawlProcessLock } from '../db/crawl-process-lock.js';

export type WithRetentionLocksResult<T> =
  | { outcome: 'ran'; result: T }
  | { outcome: 'skipped'; reason: string };

/**
 * Every lock a retention pass needs, acquired in the order Phase 7C's
 * concurrency plan requires (docs, retention plan §5):
 *
 *  1. The retention lock itself, TRIED rather than waited for. Unlike
 *     `withDedupeLock` ("a second crawl's new listings still need it"), a
 *     second retention pass queued behind a running one serves no purpose —
 *     it would just re-derive the same eligibility a moment later. If
 *     another pass already holds it, this one skips outright rather than
 *     waiting.
 *  2. `acquireCrawlProcessLock` (src/db/crawl-process-lock.ts) for EVERY
 *     source. A pass must never delete rows a crawl in flight is about to
 *     write to — a fresh fetch reopening a listing tier 2 is mid-trim on, or
 *     a listing tier 3 is about to purge. If ANY source is busy, every lock
 *     already taken is released and the WHOLE pass is skipped, not run only
 *     against the sources that were free: tier 3's cluster closure can span
 *     listings from either source (a dedupe merge does not respect source
 *     boundaries), so a partial pass could delete half of a cluster the
 *     other half's crawl is still relying on.
 *  3. Everything else retention reads or touches indirectly: the dedupe lock
 *     (`opportunity_source_memberships`), the taxonomy backfill lock
 *     (`listing_classifications`), and the matching bundle lock (built from
 *     the same public views retention's own eligibility queries touch).
 *     These are WAITED for, same as any other caller.
 *
 * Nobody ever waits on a crawl lock — every wait in step 3 is for a lock a
 * crawl process itself never takes — so this ordering cannot deadlock
 * against the scheduled pipeline (crawl -> dedupe -> taxonomy -> bundle ->
 * retention).
 */
export async function withRetentionLocks<T>(
  pool: Pool,
  sourceIds: readonly string[],
  fn: () => Promise<T>,
): Promise<WithRetentionLocksResult<T>> {
  const client = await pool.connect();
  let holdsRetentionLock = false;
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      'select pg_try_advisory_lock($1) as locked',
      [ADVISORY_LOCKS.retention.key.toString()],
    );
    holdsRetentionLock = rows[0]?.locked === true;
    if (!holdsRetentionLock) {
      return { outcome: 'skipped', reason: 'skipped: another retention pass is already running' };
    }

    const crawlLocks: CrawlProcessLock[] = [];
    try {
      for (const sourceId of sourceIds) {
        const lock = await acquireCrawlProcessLock(pool, sourceId);
        if (lock === null) {
          return { outcome: 'skipped', reason: `skipped: crawl in flight for source ${sourceId}` };
        }
        crawlLocks.push(lock);
      }

      const result = await withAdvisoryLock(pool, ADVISORY_LOCKS.dedupe, () =>
        withAdvisoryLock(pool, ADVISORY_LOCKS.taxonomyBackfill, () =>
          withAdvisoryLock(pool, ADVISORY_LOCKS.matchingBundle, fn),
        ),
      );
      return { outcome: 'ran', result };
    } finally {
      for (const lock of crawlLocks) await lock.release();
    }
  } finally {
    if (holdsRetentionLock) {
      try {
        await client.query('select pg_advisory_unlock($1)', [
          ADVISORY_LOCKS.retention.key.toString(),
        ]);
      } finally {
        client.release();
      }
    } else {
      client.release();
    }
  }
}
