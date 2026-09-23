import type { Pool } from 'pg';
import {
  ADVISORY_LOCKS,
  type AdvisoryLockOptions,
  AdvisoryLockTimeoutError,
  withAdvisoryLock,
} from '../db/advisory-lock.js';

/**
 * At most one dedupe pass at a time across every process on this database
 * (Phase 7A, stage 7-1).
 *
 * Needed once more than one source runs on a schedule: each scheduled crawl
 * chains `run-dedupe --auto-link`, and two passes overlapping could each see
 * the same listing without a live membership and canonicalize it twice. The
 * locking itself lives in src/db/advisory-lock.ts, shared with the taxonomy
 * backfill.
 */

export const DEDUPE_ADVISORY_LOCK_KEY = ADVISORY_LOCKS.dedupe.key;

export { AdvisoryLockTimeoutError as DedupeLockTimeoutError };

export type DedupeLockOptions = AdvisoryLockOptions;

export function withDedupeLock<T>(
  pool: Pool,
  fn: () => Promise<T>,
  options: DedupeLockOptions = {},
): Promise<T> {
  return withAdvisoryLock(pool, ADVISORY_LOCKS.dedupe, fn, options);
}
