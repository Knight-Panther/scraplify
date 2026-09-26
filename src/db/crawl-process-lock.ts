import type { Pool, PoolClient } from 'pg';

/**
 * Self-healing for a crawl that died before settling (the machine shut
 * down, the process was killed). `crawl_runs_one_unsettled_per_source_idx`
 * alone cannot tell a crawl still in flight from a dead one, so every later
 * scheduled run refused to start until someone cleared the row by hand;
 * that happened three times (2026-09-16, 2026-09-25, 2026-09-26).
 *
 * A crawl process now holds a session-level advisory lock for its whole
 * life, on a connection of its own. Postgres releases it when that session
 * ends, however the process ends. So a new process that gets the lock knows
 * that no live crawl process holds it, and that any unsettled run for the
 * source is orphaned. It settles those runs as `failed`, the same fix an
 * operator used to apply by hand. A failed run never closes or expires
 * anything, so this settles nothing about the listings themselves.
 */

/** Keeps crawl locks apart from any other advisory lock user of the database. */
const LOCK_NAMESPACE = 'scraplify:crawl-process:';

export interface CrawlProcessLock {
  /** Ids of orphaned runs settled as failed while acquiring the lock. */
  readonly settledOrphanRunIds: readonly string[];
  release(): Promise<void>;
}

/**
 * Returns null when another live process holds this source's lock: a crawl
 * genuinely in flight, which the caller skips as before.
 */
export async function acquireCrawlProcessLock(
  pool: Pool,
  sourceId: string,
): Promise<CrawlProcessLock | null> {
  const client = await pool.connect();
  let held = false;
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      'select pg_try_advisory_lock(hashtextextended($1, 0)) as locked',
      [LOCK_NAMESPACE + sourceId],
    );
    held = rows[0]?.locked === true;
    if (!held) {
      client.release();
      return null;
    }
    const settled = await client.query<{ id: string }>(
      `update crawl_runs
          set status = 'failed',
              finished_at = coalesce(finished_at, now()),
              reconciled_at = now()
        where source_id = $1 and reconciled_at is null
        returning id`,
      [sourceId],
    );
    return {
      settledOrphanRunIds: settled.rows.map((row) => row.id),
      release: () => releaseLock(client, sourceId),
    };
  } catch (err) {
    // Destroy rather than return the session: a pooled session would keep
    // holding the lock if it was taken before the failure.
    client.release(held ? (err as Error) : undefined);
    throw err;
  }
}

async function releaseLock(client: PoolClient, sourceId: string): Promise<void> {
  try {
    await client.query('select pg_advisory_unlock(hashtextextended($1, 0))', [
      LOCK_NAMESPACE + sourceId,
    ]);
    client.release();
  } catch (err) {
    // Ending the session releases the lock anyway.
    client.release(err as Error);
  }
}
