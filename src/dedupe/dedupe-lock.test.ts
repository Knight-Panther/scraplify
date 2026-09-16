import { describe, expect, it } from 'vitest';
import { pool } from '../db/client.js';
import { DEDUPE_ADVISORY_LOCK_KEY, DedupeLockTimeoutError, withDedupeLock } from './dedupe-lock.js';

/**
 * Touches no table data — only a session advisory lock — so it is safe against
 * any database this suite runs on.
 */

/** Whether a DIFFERENT session could take the lock right now (and immediately gives it back). */
async function lockIsFree(): Promise<boolean> {
  const client = await pool.connect();
  try {
    const result = await client.query<{ got: boolean }>('select pg_try_advisory_lock($1) as got', [
      DEDUPE_ADVISORY_LOCK_KEY.toString(),
    ]);
    const got = result.rows[0]?.got === true;
    if (got) {
      await client.query('select pg_advisory_unlock($1)', [DEDUPE_ADVISORY_LOCK_KEY.toString()]);
    }
    return got;
  } finally {
    client.release();
  }
}

describe('withDedupeLock', () => {
  it('holds the lock for the duration of fn and releases it afterwards', async () => {
    const heldDuring = await withDedupeLock(pool, async () => !(await lockIsFree()));
    expect(heldDuring).toBe(true);
    expect(await lockIsFree()).toBe(true);
  });

  it('releases the lock when fn throws', async () => {
    await expect(
      withDedupeLock(pool, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await lockIsFree()).toBe(true);
  });

  it('serializes two concurrent passes instead of letting them overlap', async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted!: () => void;
    const firstHasLock = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });

    const first = withDedupeLock(pool, async () => {
      events.push('first:start');
      firstStarted();
      await firstMayFinish;
      events.push('first:end');
    });
    await firstHasLock;

    const second = withDedupeLock(pool, async () => {
      events.push('second:start');
    });

    // Give the second call ample time to (wrongly) start while the first still holds the lock.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(events).toEqual(['first:start']);

    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('gives up with a typed error once the wait exceeds its timeout', async () => {
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted!: () => void;
    const firstHasLock = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const first = withDedupeLock(pool, async () => {
      firstStarted();
      await firstMayFinish;
    });
    await firstHasLock;

    let secondRan = false;
    await expect(
      withDedupeLock(
        pool,
        async () => {
          secondRan = true;
        },
        { waitTimeoutMs: 200 },
      ),
    ).rejects.toBeInstanceOf(DedupeLockTimeoutError);
    expect(secondRan).toBe(false);

    releaseFirst();
    await first;
    expect(await lockIsFree()).toBe(true);
  });
});
