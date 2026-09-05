import { afterEach, describe, expect, it } from 'vitest';
import { db } from './client.js';
import {
  CrawlAlreadyRunningError,
  finishCrawlRun,
  getMaxDiscoveredCountForSource,
  recordFetchAttempt,
  startCrawlRun,
  upsertResource,
} from './ingest.js';
import { cleanupTestSource, createTestCrawlRun, createTestSource } from './test-support.js';

describe('upsertResource', () => {
  let sourceId: string;

  afterEach(async () => {
    if (sourceId) await cleanupTestSource(sourceId);
  });

  it('inserts a new resource', async () => {
    sourceId = await createTestSource();

    const row = await upsertResource(db, {
      sourceId,
      role: 'OPPORTUNITY',
      originalUrl: '/listing/1',
      canonicalUrl: 'https://example.invalid/listing/1',
      finalUrl: null,
      status: 'fetched',
      fetchedAt: '2026-09-04T12:00:00Z',
      contentHash: 'a'.repeat(64),
      byteSize: 512,
      mimeType: 'text/html',
    });

    expect(row.status).toBe('fetched');
    expect(row.contentHash).toBe('a'.repeat(64));
  });

  it('updates the same resource in place on a re-fetch, by (source, canonicalUrl, role)', async () => {
    sourceId = await createTestSource();
    const observation = {
      sourceId,
      role: 'OPPORTUNITY' as const,
      originalUrl: '/listing/1',
      canonicalUrl: 'https://example.invalid/listing/1',
      finalUrl: null,
      status: 'fetched' as const,
      fetchedAt: '2026-09-04T12:00:00Z',
      contentHash: 'a'.repeat(64),
      byteSize: 512,
      mimeType: 'text/html',
    };

    const first = await upsertResource(db, observation);
    const second = await upsertResource(db, {
      ...observation,
      status: 'failed',
      contentHash: null,
      fetchedAt: '2026-09-05T12:00:00Z',
    });

    expect(second.id).toBe(first.id);
    expect(second.status).toBe('failed');
    expect(second.contentHash).toBeNull();
  });

  it('does not let an older, out-of-order fetch overwrite a newer one already stored', async () => {
    sourceId = await createTestSource();
    const observation = {
      sourceId,
      role: 'OPPORTUNITY' as const,
      originalUrl: '/listing/1',
      canonicalUrl: 'https://example.invalid/listing/1',
      finalUrl: null,
      status: 'fetched' as const,
      fetchedAt: '2026-09-05T12:00:00Z',
      contentHash: 'a'.repeat(64),
      byteSize: 512,
      mimeType: 'text/html',
    };

    const newer = await upsertResource(db, observation);
    // A slower retry of an earlier fetch, completing after the newer one above.
    const stale = await upsertResource(db, {
      ...observation,
      status: 'failed',
      contentHash: null,
      fetchedAt: '2026-09-04T12:00:00Z',
    });

    expect(stale.id).toBe(newer.id);
    expect(stale.status).toBe('fetched');
    expect(stale.contentHash).toBe('a'.repeat(64));
    expect(stale.fetchedAt).toBe(newer.fetchedAt);
  });
});

describe('crawl runs and fetch attempts', () => {
  let sourceId: string;

  afterEach(async () => {
    if (sourceId) await cleanupTestSource(sourceId);
  });

  it('starts and finishes a crawl run, and records a fetch attempt against it', async () => {
    sourceId = await createTestSource();

    const run = await startCrawlRun(db, {
      sourceId,
      startedAt: '2026-09-04T12:00:00Z',
      fullCoverage: true,
    });
    expect(run.status).toBe('running');
    expect(run.finishedAt).toBeNull();

    const resource = await upsertResource(db, {
      sourceId,
      role: 'INDEX',
      originalUrl: '/ads/?page=1',
      canonicalUrl: 'https://example.invalid/ads/?page=1',
      finalUrl: null,
      status: 'fetched',
      fetchedAt: '2026-09-04T12:00:01Z',
      contentHash: 'a'.repeat(64),
      byteSize: 2048,
      mimeType: 'text/html',
    });

    const attempt = await recordFetchAttempt(db, {
      crawlRunId: run.id,
      resourceId: resource.id,
      attemptedAt: '2026-09-04T12:00:01Z',
      statusCode: 200,
      durationMs: 150,
      outcome: 'success',
      errorKind: null,
    });
    expect(attempt.outcome).toBe('success');

    const finished = await finishCrawlRun(db, run.id, {
      finishedAt: '2026-09-04T12:05:00Z',
      status: 'completed',
      counts: {
        discoveredCount: 1,
        vipCount: 0,
        standardCount: 1,
        newCount: 1,
        changedCount: 0,
        unchangedCount: 0,
        missingCount: 0,
        expiredCount: 0,
        reopenedCount: 0,
        quarantinedCount: 0,
        failedCount: 0,
      },
    });

    expect(finished.status).toBe('completed');
    expect(finished.newCount).toBe(1);
    expect(finished.finishedAt).not.toBeNull();
  });

  it('rejects starting a second crawl run while one is already running for the same source', async () => {
    sourceId = await createTestSource();
    await startCrawlRun(db, { sourceId, startedAt: '2026-09-04T12:00:00Z', fullCoverage: true });

    await expect(
      startCrawlRun(db, { sourceId, startedAt: '2026-09-04T12:05:00Z', fullCoverage: true }),
    ).rejects.toThrow(CrawlAlreadyRunningError);
  });

  it('still rejects a new crawl run after status is set to completed but before reconciliation has committed', async () => {
    // The exact overlap window round 6's adversarial review flagged: an
    // earlier design released the exclusivity lock the moment status left
    // 'running', which happens BEFORE reconciliation runs (see crawl.ts's
    // own comment on this). Proving the lock survives that gap here,
    // independent of the orchestrator itself.
    sourceId = await createTestSource();
    const first = await startCrawlRun(db, {
      sourceId,
      startedAt: '2026-09-04T12:00:00Z',
      fullCoverage: true,
    });
    await finishCrawlRun(db, first.id, {
      finishedAt: '2026-09-04T12:05:00Z',
      status: 'completed', // terminal status set...
      // ...but reconciledAt deliberately omitted, simulating "reconciliation hasn't committed yet."
      counts: {
        discoveredCount: 0,
        vipCount: 0,
        standardCount: 0,
        newCount: 0,
        changedCount: 0,
        unchangedCount: 0,
        missingCount: 0,
        expiredCount: 0,
        reopenedCount: 0,
        quarantinedCount: 0,
        failedCount: 0,
      },
    });

    await expect(
      startCrawlRun(db, { sourceId, startedAt: '2026-09-04T12:05:01Z', fullCoverage: true }),
    ).rejects.toThrow(CrawlAlreadyRunningError);
  });

  it('allows a new crawl run once the previous one has finished', async () => {
    sourceId = await createTestSource();
    const first = await startCrawlRun(db, {
      sourceId,
      startedAt: '2026-09-04T12:00:00Z',
      fullCoverage: true,
    });
    await finishCrawlRun(db, first.id, {
      finishedAt: '2026-09-04T12:05:00Z',
      status: 'completed',
      // reconciledAt: this run is fully settled (no reconciliation to run
      // in this test) — without it, the row stays "unsettled" and the
      // second startCrawlRun below would be rejected by the same-source
      // exclusivity index this test is otherwise trying to prove opens
      // back up once a run finishes.
      reconciledAt: '2026-09-04T12:05:00Z',
      counts: {
        discoveredCount: 0,
        vipCount: 0,
        standardCount: 0,
        newCount: 0,
        changedCount: 0,
        unchangedCount: 0,
        missingCount: 0,
        expiredCount: 0,
        reopenedCount: 0,
        quarantinedCount: 0,
        failedCount: 0,
      },
    });

    const second = await startCrawlRun(db, {
      sourceId,
      startedAt: '2026-09-04T13:00:00Z',
      fullCoverage: true,
    });
    expect(second.status).toBe('running');
  });

  it('allows concurrently running crawls for two different sources', async () => {
    const sourceA = await createTestSource();
    const sourceB = await createTestSource();
    try {
      const runA = await startCrawlRun(db, {
        sourceId: sourceA,
        startedAt: '2026-09-04T12:00:00Z',
        fullCoverage: true,
      });
      const runB = await startCrawlRun(db, {
        sourceId: sourceB,
        startedAt: '2026-09-04T12:00:00Z',
        fullCoverage: true,
      });
      expect(runA.status).toBe('running');
      expect(runB.status).toBe('running');
    } finally {
      await cleanupTestSource(sourceA);
      await cleanupTestSource(sourceB);
    }
  });
});

describe('getMaxDiscoveredCountForSource', () => {
  let sourceId: string;

  afterEach(async () => {
    if (sourceId) await cleanupTestSource(sourceId);
  });

  it('returns 0 when no other full-coverage run exists for this source', async () => {
    sourceId = await createTestSource();
    const excluded = await createTestCrawlRun(sourceId, { discoveredCount: 500 });

    const result = await getMaxDiscoveredCountForSource(db, sourceId, excluded.id);

    expect(result).toBe(0);
  });

  it('returns the max discoveredCount across any status, not just completed', async () => {
    sourceId = await createTestSource();
    await createTestCrawlRun(sourceId, { status: 'completed', discoveredCount: 300 });
    await createTestCrawlRun(sourceId, { status: 'partial', discoveredCount: 5000 });
    await createTestCrawlRun(sourceId, { status: 'failed', discoveredCount: 100 });
    const excluded = await createTestCrawlRun(sourceId, { discoveredCount: 0 });

    const result = await getMaxDiscoveredCountForSource(db, sourceId, excluded.id);

    expect(result).toBe(5000);
  });

  it('ignores a run with fullCoverage: false', async () => {
    sourceId = await createTestSource();
    await createTestCrawlRun(sourceId, { fullCoverage: false, discoveredCount: 9999 });
    await createTestCrawlRun(sourceId, { fullCoverage: true, discoveredCount: 42 });
    const excluded = await createTestCrawlRun(sourceId, { discoveredCount: 0 });

    const result = await getMaxDiscoveredCountForSource(db, sourceId, excluded.id);

    expect(result).toBe(42);
  });
});
