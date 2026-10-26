import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../../db/types.js';
import type { MatchingArtifactStore } from './artifact-store.js';
import { buildMatchingBundle } from './build.js';

// Records the order the build asks for its locks without taking any real
// one: the locks are database-wide, and holding them here would stall other
// test files running in parallel.
const taken = vi.hoisted(() => [] as string[]);
vi.mock('../../db/advisory-lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/advisory-lock.js')>();
  return {
    ...actual,
    withAdvisoryLock: async (_pool: unknown, lock: { name: string }, fn: () => unknown) => {
      taken.push(lock.name);
      return fn();
    },
  };
});

describe('matching bundle build locks', () => {
  // Retention takes dedupe, then taxonomy, then the bundle lock. A build that
  // took the bundle lock first and then waited for dedupe deadlocked against
  // it on the host (2026-10-24 and 25, both giving up after 30 minutes).
  it('takes the dedupe lock before the bundle lock, the order retention uses', async () => {
    taken.length = 0;
    // An empty database object: the build fails as soon as it reads, after
    // both locks are taken.
    await buildMatchingBundle({} as Database, {} as Pool, {} as MatchingArtifactStore, {
      channel: 'lock-order',
      activatedBy: 'test',
    }).catch(() => undefined);
    expect(taken).toEqual(['dedupe', 'matching bundle']);
  });
});
