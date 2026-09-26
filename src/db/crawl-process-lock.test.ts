import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { db, pool } from './client.js';
import { acquireCrawlProcessLock, type CrawlProcessLock } from './crawl-process-lock.js';
import { crawlRuns } from './schema/index.js';
import { cleanupTestSource, createTestSource } from './test-support.js';

describe('acquireCrawlProcessLock', () => {
  const sourceIds: string[] = [];
  const locks: CrawlProcessLock[] = [];

  afterEach(async () => {
    for (const lock of locks.splice(0)) await lock.release();
    for (const id of sourceIds.splice(0)) await cleanupTestSource(id);
  });

  async function source(): Promise<string> {
    const id = await createTestSource();
    sourceIds.push(id);
    return id;
  }

  async function acquire(sourceId: string): Promise<CrawlProcessLock | null> {
    const lock = await acquireCrawlProcessLock(pool, sourceId);
    if (lock !== null) locks.push(lock);
    return lock;
  }

  async function unsettledRun(sourceId: string): Promise<string> {
    const id = randomUUID();
    await db.insert(crawlRuns).values({
      id,
      sourceId,
      startedAt: '2026-09-26T08:12:23Z',
      status: 'running',
      fullCoverage: true,
    });
    return id;
  }

  it('settles a run orphaned by a dead process as failed, and nothing else', async () => {
    const sourceId = await source();
    const otherSourceId = await source();
    const orphan = await unsettledRun(sourceId);
    const otherRun = await unsettledRun(otherSourceId);

    const lock = await acquire(sourceId);
    expect(lock?.settledOrphanRunIds).toEqual([orphan]);

    const [settled] = await db.select().from(crawlRuns).where(eq(crawlRuns.id, orphan));
    expect(settled?.status).toBe('failed');
    expect(settled?.reconciledAt).not.toBeNull();
    expect(settled?.finishedAt).not.toBeNull();
    const [untouched] = await db.select().from(crawlRuns).where(eq(crawlRuns.id, otherRun));
    expect(untouched?.status).toBe('running');
    expect(untouched?.reconciledAt).toBeNull();
  });

  it('refuses while a live process holds the lock, leaving its run alone', async () => {
    const sourceId = await source();
    expect(await acquire(sourceId)).not.toBeNull();
    const live = await unsettledRun(sourceId);

    expect(await acquireCrawlProcessLock(pool, sourceId)).toBeNull();
    const [row] = await db.select().from(crawlRuns).where(eq(crawlRuns.id, live));
    expect(row?.status).toBe('running');
  });

  it('can be taken again once released', async () => {
    const sourceId = await source();
    const first = await acquireCrawlProcessLock(pool, sourceId);
    expect(first).not.toBeNull();
    await first?.release();
    expect(await acquire(sourceId)).not.toBeNull();
  });

  it('locks each source separately', async () => {
    expect(await acquire(await source())).not.toBeNull();
    expect(await acquire(await source())).not.toBeNull();
  });
});
