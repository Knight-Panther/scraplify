import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db/client.js';
import {
  matchingBundleBuilds,
  matchingBundlePublications,
  sourceListingRevisions,
} from '../db/schema/index.js';
import {
  cleanupTestSource,
  createTestCrawlRun,
  createTestResource,
  createTestSource,
  createTestSourceListing,
} from '../db/test-support.js';
import {
  buildPipelineEvent,
  buildTestEvent,
  type EventContext,
  type PipelineRun,
  readRunFacts,
  releaseFromDirectory,
  type StepCodes,
} from './event.js';
import { listOutbox, outboxFileName, writeOutboxEvent } from './outbox.js';

const CONTEXT: EventContext = {
  now: new Date('2026-10-13T17:02:11.000Z'),
  release: 'a'.repeat(40),
  host: 'xtelo-test-host',
};

/** Every step ran and succeeded: the ordinary nightly run. */
const ALL_OK: StepCodes = { crawl: 0, dedupe: 0, taxonomy: 0, bundle: 0, retention: 0 };

describe('the pipeline event', () => {
  let sourceId: string;
  let sourceSlug: string;
  let channel: string;
  const otherSourceIds: string[] = [];

  beforeEach(async () => {
    sourceId = await createTestSource();
    sourceSlug = `test-source-${sourceId}`;
    channel = `test-${randomUUID()}`;
  });

  afterEach(async () => {
    await db
      .delete(matchingBundlePublications)
      .where(eq(matchingBundlePublications.channel, channel));
    await db.delete(matchingBundleBuilds).where(eq(matchingBundleBuilds.channel, channel));
    await cleanupTestSource(sourceId);
    for (const id of otherSourceIds.splice(0)) await cleanupTestSource(id);
  });

  function run(overrides: Partial<PipelineRun> = {}): PipelineRun {
    return {
      sourceSlug,
      startedAt: '2026-10-13T16:10:04.000Z',
      steps: ALL_OK,
      exitCode: 0,
      interrupted: false,
      ...overrides,
    };
  }

  async function eventFor(pipelineRun: PipelineRun) {
    return buildPipelineEvent(pipelineRun, await readRunFacts(db, pipelineRun, channel), CONTEXT);
  }

  /** A verified build, live on this test's channel since `activatedAt`. */
  async function publishBundle(activatedAt: string, opportunityCount: number): Promise<string> {
    const buildId = randomUUID();
    await db.insert(matchingBundleBuilds).values({
      id: buildId,
      channel,
      schemaVersion: 2,
      featureContract: 'lexical-v1',
      state: 'verified',
      startedAt: activatedAt,
      finishedAt: activatedAt,
      opportunityCount,
    });
    await db.insert(matchingBundlePublications).values({
      id: randomUUID(),
      channel,
      buildId,
      reason: 'build',
      activatedBy: 'test',
      activatedAt,
    });
    return buildId;
  }

  it('reports a completed run with its counters, coverage and bundle', async () => {
    const crawlRun = await createTestCrawlRun(sourceId, {
      startedAt: '2026-10-13T16:10:05Z',
      finishedAt: '2026-10-13T16:58:40Z',
      reconciledAt: '2026-10-13T16:58:41Z',
      discoveredCount: 9021,
      newCount: 318,
      changedCount: 41,
      unchangedCount: 12,
      skippedCount: 8650,
      missingCount: 7,
      expiredCount: 12,
      reopenedCount: 1,
    });
    const buildId = await publishBundle('2026-10-13T17:01:30Z', 8669);

    expect(await eventFor(run())).toEqual({
      event_type: 'xtelo.pipeline.finished',
      schema: 1,
      event_id: `${sourceSlug}:${crawlRun.id}`,
      domain: 'opportunities',
      source: sourceSlug,
      status: 'succeeded',
      exit_code: 0,
      steps: ALL_OK,
      crawl_run: {
        id: crawlRun.id,
        status: 'completed',
        started_at: '2026-10-13T16:10:05.000Z',
        finished_at: '2026-10-13T16:58:40.000Z',
      },
      counts: {
        discovered: 9021,
        new: 318,
        changed: 41,
        unchanged: 12,
        skipped: 8650,
        missing: 7,
        expired: 12,
        reopened: 1,
        quarantined: 0,
        failed: 0,
      },
      full_coverage: true,
      bundle: { id: buildId, opportunities: 8669 },
      release: 'a'.repeat(40),
      host: 'xtelo-test-host',
      emitted_at: '2026-10-13T17:02:11.000Z',
    });
  });

  it('reports a failed run, with null for the steps that were skipped', async () => {
    await createTestCrawlRun(sourceId, { startedAt: '2026-10-13T16:10:05Z', status: 'failed' });
    const event = await eventFor(
      run({
        steps: { crawl: 1, dedupe: 0, taxonomy: 0, bundle: 0, retention: null },
        exitCode: 1,
      }),
    );
    expect(event.status).toBe('failed');
    expect(event.exit_code).toBe(1);
    expect(event.steps.retention).toBeNull();
    expect(event.crawl_run?.status).toBe('failed');
  });

  it('calls a run partial when the crawl ended partial and nothing else failed', async () => {
    await createTestCrawlRun(sourceId, {
      startedAt: '2026-10-13T16:10:05Z',
      status: 'partial',
      fullCoverage: false,
    });
    const steps: StepCodes = { crawl: 1, dedupe: 0, taxonomy: 0, bundle: 0, retention: null };
    const partial = await eventFor(run({ steps, exitCode: 1 }));
    expect(partial.status).toBe('partial');
    expect(partial.full_coverage).toBe(false);

    // A later step failing as well is a failure, not a partial crawl.
    const failed = await eventFor(
      run({ steps: { ...steps, dedupe: 1, bundle: null }, exitCode: 1 }),
    );
    expect(failed.status).toBe('failed');
  });

  it('reports an interrupted run with the crawl row it left unsettled', async () => {
    const crawlRun = await createTestCrawlRun(sourceId, {
      startedAt: '2026-10-13T16:10:05Z',
      finishedAt: null,
      reconciledAt: null,
      status: 'running',
      fullCoverage: false,
      discoveredCount: 400,
    });
    const event = await eventFor(
      run({
        steps: { crawl: null, dedupe: null, taxonomy: null, bundle: null, retention: null },
        exitCode: 143,
        interrupted: true,
      }),
    );
    expect(event.status).toBe('interrupted');
    expect(event.exit_code).toBe(143);
    expect(event.event_id).toBe(`${sourceSlug}:${crawlRun.id}`);
    expect(event.crawl_run).toMatchObject({ status: 'running', finished_at: null });
    expect(event.counts?.discovered).toBe(400);
  });

  it('does not borrow an earlier run when the crawl created none', async () => {
    // Yesterday's run: the source's latest row, but not this pipeline run's.
    await createTestCrawlRun(sourceId, {
      startedAt: '2026-10-12T16:10:05Z',
      finishedAt: '2026-10-12T16:58:40Z',
      discoveredCount: 9000,
    });
    // Another board's run, started inside this run's window: the three
    // pipelines start at the same hour.
    const otherSourceId = await createTestSource();
    otherSourceIds.push(otherSourceId);
    await createTestCrawlRun(otherSourceId, { startedAt: '2026-10-13T16:10:06Z' });
    const event = await eventFor(
      run({ steps: { crawl: 1, dedupe: 0, taxonomy: 0, bundle: 0, retention: null }, exitCode: 1 }),
    );
    expect(event.event_id).toBe(`${sourceSlug}:nocrawl:2026-10-13T17:02:11.000Z`);
    expect(event.status).toBe('failed');
    expect(event.crawl_run).toBeNull();
    expect(event.counts).toBeNull();
    expect(event.full_coverage).toBeNull();
  });

  it('leaves the bundle out unless the step ran and a build went live in this run', async () => {
    await createTestCrawlRun(sourceId, { startedAt: '2026-10-13T16:10:05Z' });

    // Live, but published by an earlier run.
    await publishBundle('2026-10-12T17:01:30Z', 8600);
    expect(await eventFor(run())).not.toHaveProperty('bundle');

    await db
      .delete(matchingBundlePublications)
      .where(eq(matchingBundlePublications.channel, channel));
    await publishBundle('2026-10-13T17:01:30Z', 8669);
    // The step was skipped, or failed.
    expect(await eventFor(run({ steps: { ...ALL_OK, bundle: null } }))).not.toHaveProperty(
      'bundle',
    );
    expect(
      await eventFor(run({ steps: { ...ALL_OK, bundle: 1 }, exitCode: 1 })),
    ).not.toHaveProperty('bundle');
    expect(await eventFor(run())).toHaveProperty('bundle.opportunities', 8669);

    // Rolled back since: it went live in this run, and is not live now.
    await db
      .update(matchingBundlePublications)
      .set({ retiredAt: '2026-10-13T17:02:00Z' })
      .where(eq(matchingBundlePublications.channel, channel));
    expect(await eventFor(run())).not.toHaveProperty('bundle');
  });

  it('carries nothing from a listing', async () => {
    await createTestCrawlRun(sourceId, { startedAt: '2026-10-13T16:10:05Z', newCount: 1 });
    const listing = await createTestSourceListing(sourceId, {
      canonicalSourceUrl: 'https://example.invalid/listing/4471',
    });
    await db.insert(sourceListingRevisions).values({
      id: randomUUID(),
      sourceListingId: listing.id,
      parserVersion: 'v3',
      extractionMethod: 'http',
      rawResourceHash: 'a'.repeat(64),
      meaningfulContentHash: 'b'.repeat(64),
      titleRaw: 'მთავარი ბუღალტერი',
      titleNormalized: 'მთავარი ბუღალტერი',
      organizationRaw: 'შპს მაგალითი',
      description: 'ხელფასი 2500 ლარი',
      locations: ['თბილისი'],
      publishedDate: { raw: '', parsed: '2026-10-13T00:00:00Z' },
      deadlineDate: { raw: '', parsed: null },
      applicationMethod: null,
      sourceCategories: [],
      structuredAttributes: {},
      createdAt: '2026-10-13T16:20:00Z',
      provenanceResourceId: await createTestResource(sourceId),
      provenanceFetchedAt: '2026-10-13T16:20:00Z',
      provenanceNotes: null,
    });

    const text = JSON.stringify(await eventFor(run()));
    for (const fragment of ['ბუღალტერი', 'მაგალითი', 'ხელფასი', 'თბილისი', 'example.invalid']) {
      expect(text).not.toContain(fragment);
    }
    // Every value is an id, a code, a count, a time or one of the event's own words.
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(
      [
        'counts',
        'crawl_run',
        'domain',
        'emitted_at',
        'event_id',
        'event_type',
        'exit_code',
        'full_coverage',
        'host',
        'release',
        'schema',
        'source',
        'status',
        'steps',
      ].sort(),
    );
  });
});

describe('the test event and the release name', () => {
  it('is a small event of its own type', () => {
    expect(buildTestEvent(CONTEXT)).toEqual({
      event_type: 'xtelo.test',
      schema: 1,
      event_id: 'test:2026-10-13T17:02:11.000Z',
      release: 'a'.repeat(40),
      host: 'xtelo-test-host',
      emitted_at: '2026-10-13T17:02:11.000Z',
    });
  });

  it('names the release only inside a release directory', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xtelo-release-'));
    try {
      const sha = '0cfbf86'.padEnd(40, '0');
      await fs.mkdir(path.join(root, sha));
      expect(releaseFromDirectory(path.join(root, sha))).toBe(sha);
      expect(releaseFromDirectory(root)).toBeNull();
      expect(releaseFromDirectory(path.join(root, 'missing'))).toBeNull();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('the outbox', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'xtelo-outbox-'));
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('writes the event whole, under a name any file system takes', async () => {
    const event = buildTestEvent(CONTEXT);
    const file = await writeOutboxEvent(directory, event);
    expect(path.basename(file)).toBe('test_2026-10-13T17_02_11.000Z.json');
    expect(outboxFileName('jobs-ge:8c3b7cbf-159a')).toBe('jobs-ge_8c3b7cbf-159a.json');
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(event);
    // No temporary file is left, and the listing shows finished files only.
    expect(await fs.readdir(directory)).toEqual([path.basename(file)]);
    await fs.writeFile(path.join(directory, '.half-written.json.1.tmp'), '{');
    await fs.writeFile(path.join(directory, 'notes.txt'), 'not an event');
    await fs.mkdir(path.join(directory, 'folder.json'));
    expect(await listOutbox(directory)).toEqual([path.basename(file)]);
  });

  it('fails without leaving anything when the outbox is missing', async () => {
    const missing = path.join(directory, 'not-there');
    await expect(writeOutboxEvent(missing, buildTestEvent(CONTEXT))).rejects.toThrow();
    expect(await fs.readdir(directory)).toEqual([]);
  });
});
