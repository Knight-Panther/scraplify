import { afterEach, describe, expect, it } from 'vitest';
import { db } from './client.js';
import { finishCrawlRun, recordFetchAttempt, startCrawlRun, upsertResource } from './ingest.js';
import { cleanupTestSource, createTestSource } from './test-support.js';

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

    const run = await startCrawlRun(db, { sourceId, startedAt: '2026-09-04T12:00:00Z' });
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
});
