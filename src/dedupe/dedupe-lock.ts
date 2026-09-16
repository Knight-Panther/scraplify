import type { Pool } from 'pg';

/**
 * Arbitrary but fixed advisory-lock key for "a dedupe pass is running". Any
 * 64-bit value works; it only has to be unique among this app's advisory locks
 * (there are no others yet).
 */
export const DEDUPE_ADVISORY_LOCK_KEY = 7_417_001n;

/** Long enough to outlast a real pass (35.5s over the whole corpus, 2026-09-15) many times over. */
const DEFAULT_WAIT_TIMEOUT_MS = 30 * 60 * 1000;

export class DedupeLockTimeoutError extends Error {
  constructor(waitTimeoutMs: number) {
    super(
      `dedupe: another dedupe pass still held the lock after ${waitTimeoutMs}ms — giving up rather than waiting forever`,
    );
    this.name = 'DedupeLockTimeoutError';
  }
}

export interface DedupeLockOptions {
  waitTimeoutMs?: number;
}

/**
 * Runs `fn` while holding a Postgres session advisory lock, so at most one
 * dedupe pass runs at a time across every process on this database (Phase 7A,
 * stage 7-1).
 *
 * Needed once more than one source runs on a schedule: each scheduled crawl
 * chains `run-dedupe --auto-link`, and two passes overlapping could each see
 * the same listing without a live membership and canonicalize it twice.
 *
 * Waits rather than skips: a dedupe queued behind another is still wanted (the
 * second crawl's new listings need it), and a pass takes seconds, not hours.
 * The wait is bounded by `lock_timeout` so a hung pass cannot pin every later
 * scheduled run indefinitely.
 *
 * The lock lives on one dedicated connection held for the whole of `fn`, since
 * a session advisory lock belongs to the connection that took it. That
 * connection is destroyed rather than returned to the pool if unlocking fails,
 * because closing the session is what guarantees the lock is released.
 */
export async function withDedupeLock<T>(
  pool: Pool,
  fn: () => Promise<T>,
  options: DedupeLockOptions = {},
): Promise<T> {
  const waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  if (!Number.isInteger(waitTimeoutMs) || waitTimeoutMs < 1) {
    throw new Error(
      `withDedupeLock: waitTimeoutMs must be a positive integer, got ${waitTimeoutMs}`,
    );
  }

  const client = await pool.connect();
  let acquired = false;
  try {
    await client.query(`set lock_timeout = ${waitTimeoutMs}`);
    try {
      await client.query('select pg_advisory_lock($1)', [DEDUPE_ADVISORY_LOCK_KEY.toString()]);
    } catch (err) {
      // 55P03 lock_not_available is how lock_timeout expiring surfaces.
      if ((err as { code?: string }).code === '55P03')
        throw new DedupeLockTimeoutError(waitTimeoutMs);
      throw err;
    }
    acquired = true;
    await client.query('reset lock_timeout');
    return await fn();
  } finally {
    let destroy = false;
    if (acquired) {
      try {
        await client.query('select pg_advisory_unlock($1)', [DEDUPE_ADVISORY_LOCK_KEY.toString()]);
      } catch {
        destroy = true;
      }
    }
    client.release(destroy);
  }
}
