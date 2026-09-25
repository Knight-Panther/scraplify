import type { Pool } from 'pg';

export interface AdvisoryLock {
  /** Any 64-bit value, unique among this app's advisory locks. */
  key: bigint;
  /** Human-readable, used in the timeout error. */
  name: string;
}

/**
 * Every Postgres advisory lock this app takes, in one place so two can never
 * share a key by accident.
 */
export const ADVISORY_LOCKS = {
  /** Phase 7A: two scheduled crawls' `--auto-link` passes must not overlap. */
  dedupe: { key: 7_417_001n, name: 'dedupe' },
  /**
   * Phase 7A follow-up: two overlapping backfills both seed the same new term
   * and collide on `taxonomy_terms_code_unique`, failing one of them.
   */
  taxonomyBackfill: { key: 7_417_002n, name: 'taxonomy backfill' },
  matchingBundle: { key: 7_417_003n, name: 'matching bundle' },
} as const satisfies Record<string, AdvisoryLock>;

/** Long enough to outlast any real pass (a whole-corpus dedupe took 35.5s, a taxonomy backfill 22.5s) many times over. */
const DEFAULT_WAIT_TIMEOUT_MS = 30 * 60 * 1000;

export class AdvisoryLockTimeoutError extends Error {
  constructor(lock: AdvisoryLock, waitTimeoutMs: number) {
    super(
      `${lock.name}: another ${lock.name} pass still held the lock after ${waitTimeoutMs}ms — giving up rather than waiting forever`,
    );
    this.name = 'AdvisoryLockTimeoutError';
  }
}

export interface AdvisoryLockOptions {
  waitTimeoutMs?: number;
}

/**
 * Runs `fn` while holding a Postgres session advisory lock, so at most one
 * holder of `lock` runs at a time across every process on this database.
 *
 * Waits rather than skips: a pass queued behind another is still wanted (a
 * second crawl's new listings need it). The wait is bounded by `lock_timeout`
 * so a hung holder cannot pin every later scheduled run indefinitely.
 *
 * The lock lives on one dedicated connection held for the whole of `fn`, since
 * a session advisory lock belongs to the connection that took it. That
 * connection is destroyed rather than returned to the pool if resetting or
 * unlocking fails, because closing the session is what guarantees the lock and
 * the session setting are both gone.
 */
export async function withAdvisoryLock<T>(
  pool: Pool,
  lock: AdvisoryLock,
  fn: () => Promise<T>,
  options: AdvisoryLockOptions = {},
): Promise<T> {
  const waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  if (!Number.isInteger(waitTimeoutMs) || waitTimeoutMs < 1) {
    throw new Error(
      `withAdvisoryLock: waitTimeoutMs must be a positive integer, got ${waitTimeoutMs}`,
    );
  }

  const client = await pool.connect();
  let acquired = false;
  try {
    await client.query(`set lock_timeout = ${waitTimeoutMs}`);
    try {
      await client.query('select pg_advisory_lock($1)', [lock.key.toString()]);
    } catch (err) {
      // 55P03 lock_not_available is how lock_timeout expiring surfaces.
      if ((err as { code?: string }).code === '55P03')
        throw new AdvisoryLockTimeoutError(lock, waitTimeoutMs);
      throw err;
    }
    acquired = true;
    return await fn();
  } finally {
    // Reset on EVERY path, the timed-out wait included: this is a pooled
    // connection, and a session-level lock_timeout left behind would make an
    // unrelated later query on it give up on ordinary row locks (found by the
    // Phase 7A branch review).
    let destroy = false;
    try {
      await client.query('reset lock_timeout');
    } catch {
      destroy = true;
    }
    if (acquired) {
      try {
        await client.query('select pg_advisory_unlock($1)', [lock.key.toString()]);
      } catch {
        destroy = true;
      }
    }
    client.release(destroy);
  }
}
