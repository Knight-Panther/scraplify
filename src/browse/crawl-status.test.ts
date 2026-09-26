import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { db } from '../db/client.js';
import { crawlRuns, sources } from '../db/schema/index.js';
import { cleanupTestSource, createTestSource } from '../db/test-support.js';
import { getCrawlStatus } from './crawl-status.js';

describe('getCrawlStatus', () => {
  const sourceIds: string[] = [];

  afterEach(async () => {
    for (const id of sourceIds.splice(0)) await cleanupTestSource(id);
  });

  async function source(): Promise<{ id: string; slug: string }> {
    const id = await createTestSource();
    sourceIds.push(id);
    const [row] = await db.select({ slug: sources.slug }).from(sources).where(eq(sources.id, id));
    return { id, slug: row?.slug ?? '' };
  }

  async function run(
    sourceId: string,
    startedAt: string,
    status: 'running' | 'completed' | 'failed' | 'partial',
    finishedAt: string | null,
  ): Promise<void> {
    await db.insert(crawlRuns).values({
      id: randomUUID(),
      sourceId,
      startedAt,
      finishedAt,
      reconciledAt: status === 'running' ? null : finishedAt,
      status,
      fullCoverage: true,
    });
  }

  it("returns the newest run's start and status, and the newest completed run's finish", async () => {
    const { id, slug } = await source();
    await run(id, '2026-09-25T16:10:00Z', 'completed', '2026-09-25T16:20:00Z');
    await run(id, '2026-09-26T16:10:00Z', 'completed', '2026-09-26T16:15:00Z');
    await run(id, '2026-09-27T16:10:00Z', 'failed', '2026-09-27T16:11:00Z');

    const [status] = await getCrawlStatus(db, [slug]);
    expect(status?.sourceSlug).toBe(slug);
    // ISO 8601, not Postgres's own text: the browser parses these.
    expect(status?.lastRunStartedAt).toBe('2026-09-27T16:10:00.000Z');
    expect(status?.lastRunStatus).toBe('failed');
    expect(status?.lastCompletedAt).toBe('2026-09-26T16:15:00.000Z');
  });

  it('reports a run in flight', async () => {
    const { id, slug } = await source();
    await run(id, '2026-09-26T16:10:00Z', 'completed', '2026-09-26T16:15:00Z');
    await run(id, '2026-09-27T16:10:00Z', 'running', null);

    const [status] = await getCrawlStatus(db, [slug]);
    expect(status?.lastRunStatus).toBe('running');
    expect(Date.parse(status?.lastCompletedAt ?? '')).toBe(Date.parse('2026-09-26T16:15:00Z'));
  });

  it('keeps the requested order, and lists a source with no runs, or none at all, as empty', async () => {
    const withRuns = await source();
    const withoutRuns = await source();
    await run(withRuns.id, '2026-09-26T16:10:00Z', 'completed', '2026-09-26T16:15:00Z');

    const statuses = await getCrawlStatus(db, [withoutRuns.slug, 'no-such-source', withRuns.slug]);
    expect(statuses.map((status) => status.sourceSlug)).toEqual([
      withoutRuns.slug,
      'no-such-source',
      withRuns.slug,
    ]);
    for (const empty of statuses.slice(0, 2)) {
      expect(empty).toMatchObject({
        lastRunStartedAt: null,
        lastRunStatus: null,
        lastCompletedAt: null,
      });
    }
    expect(statuses[2]?.lastRunStatus).toBe('completed');
  });
});
