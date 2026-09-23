import { describe, expect, it } from 'vitest';
import { ADVISORY_LOCKS, withAdvisoryLock } from './advisory-lock.js';
import { pool } from './client.js';

/**
 * The shared mechanism's behaviour (serialization, timeout, release, no leaked
 * lock_timeout) is covered through its first user in
 * src/dedupe/dedupe-lock.test.ts. These cover what only matters once there is
 * more than one lock. Touches no table data.
 */
describe('withAdvisoryLock', () => {
  it('gives every lock its own key', () => {
    const keys = Object.values(ADVISORY_LOCKS).map((lock) => lock.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('does not make different locks wait on each other', async () => {
    const order: string[] = [];
    await withAdvisoryLock(pool, ADVISORY_LOCKS.dedupe, async () => {
      order.push('dedupe:held');
      // Would time out (and reject) if the taxonomy lock shared dedupe's key.
      await withAdvisoryLock(
        pool,
        ADVISORY_LOCKS.taxonomyBackfill,
        async () => {
          order.push('taxonomy:held');
        },
        { waitTimeoutMs: 500 },
      );
    });
    expect(order).toEqual(['dedupe:held', 'taxonomy:held']);
  });
});
