import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { db } from '../db/client.js';
import { recordParserIncident } from '../db/ingest.js';
import { parserIncidents } from '../db/schema/index.js';
import { cleanupTestSource, createTestSource } from '../db/test-support.js';
import {
  detectRunAnomalies,
  MIN_SURGE_BASELINE,
  type RunAnomalyInput,
  recordRunAnomalies,
} from './run-anomalies.js';

function input(overrides: Partial<RunAnomalyInput> = {}): RunAnomalyInput {
  return {
    sourceId: 'source',
    crawlRunId: 'run',
    detectedAt: '2026-09-16T12:00:00Z',
    guards: [
      { name: 'baseline', ok: true, countGuard: true },
      { name: 'quarantineRate', ok: true, countGuard: false },
    ],
    discoveredCount: 3354,
    baselineDiscoveredCount: 3373,
    measurements: {},
    ...overrides,
  };
}

describe('detectRunAnomalies', () => {
  it('finds nothing in a healthy run close to its baseline', () => {
    expect(detectRunAnomalies(input())).toEqual([]);
  });

  it('reports a count guard failure as a critical count collapse, naming every failed guard', () => {
    const [anomaly, ...rest] = detectRunAnomalies(
      input({
        guards: [
          { name: 'baseline', ok: false, countGuard: true },
          { name: 'quarantineRate', ok: false, countGuard: false },
        ],
        discoveredCount: 40,
        measurements: { quarantineRate: 0.4 },
      }),
    );
    expect(rest).toEqual([]);
    expect(anomaly).toMatchObject({ kind: 'count_collapse', severity: 'critical' });
    expect(anomaly?.evidence).toMatchObject({
      origin: 'run_guard',
      failedGuards: ['baseline', 'quarantineRate'],
      discoveredCount: 40,
      quarantineRate: 0.4,
    });
  });

  it('reports a failure of only non-count guards as a critical other incident', () => {
    const [anomaly] = detectRunAnomalies(
      input({ guards: [{ name: 'fetchFailureRate', ok: false, countGuard: false }] }),
    );
    expect(anomaly).toMatchObject({ kind: 'other', severity: 'critical' });
  });

  it('flags a surge beyond twice the baseline as a non-critical warning', () => {
    expect(
      detectRunAnomalies(input({ discoveredCount: 6746, baselineDiscoveredCount: 3373 })),
    ).toEqual([]);
    const [anomaly] = detectRunAnomalies(
      input({ discoveredCount: 6747, baselineDiscoveredCount: 3373 }),
    );
    expect(anomaly).toMatchObject({ kind: 'count_surge', severity: 'warning' });
  });

  it('never calls growth from a small or missing baseline a surge', () => {
    // hr.ge really did go from 100 bounded listings to 3,373 on its first full run.
    expect(
      detectRunAnomalies(
        input({ discoveredCount: 3373, baselineDiscoveredCount: MIN_SURGE_BASELINE - 1 }),
      ),
    ).toEqual([]);
    expect(
      detectRunAnomalies(input({ discoveredCount: 3373, baselineDiscoveredCount: null })),
    ).toEqual([]);
  });
});

describe('recordRunAnomalies', () => {
  const sourceIds: string[] = [];

  afterEach(async () => {
    for (const sourceId of sourceIds.splice(0)) await cleanupTestSource(sourceId);
  });

  it('records one incident per open problem, not a new one on every run that repeats it', async () => {
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);
    const collapse = input({
      sourceId,
      crawlRunId: null,
      guards: [{ name: 'baseline', ok: false, countGuard: true }],
    });

    expect(await recordRunAnomalies(db, collapse)).toHaveLength(1);
    // The next scheduled run hits the same broken state: still one open incident.
    expect(await recordRunAnomalies(db, collapse)).toHaveLength(0);

    const rows = () =>
      db.select().from(parserIncidents).where(eq(parserIncidents.sourceId, sourceId));
    expect(await rows()).toHaveLength(1);

    // Once a person resolves it, a recurrence is recorded afresh.
    await db
      .update(parserIncidents)
      .set({ resolved: true, resolvedAt: '2026-09-16T13:00:00Z' })
      .where(eq(parserIncidents.sourceId, sourceId));
    expect(await recordRunAnomalies(db, collapse)).toHaveLength(1);
    expect(await rows()).toHaveLength(2);
  });

  it('resolves the open guard incidents once a later run passes every guard', async () => {
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);
    await recordRunAnomalies(
      db,
      input({
        sourceId,
        crawlRunId: null,
        guards: [{ name: 'baseline', ok: false, countGuard: true }],
      }),
    );
    await recordRunAnomalies(
      db,
      input({
        sourceId,
        crawlRunId: null,
        guards: [{ name: 'fetchFailureRate', ok: false, countGuard: false }],
      }),
    );
    // Neither a person's own incident nor a surge warning is the guards' to clear.
    await recordParserIncident(db, {
      sourceId,
      crawlRunId: null,
      detectedAt: '2026-09-16T12:00:00Z',
      kind: 'field_missing',
      severity: 'critical',
      evidence: { field: 'title' },
    });
    await recordParserIncident(db, {
      sourceId,
      crawlRunId: null,
      detectedAt: '2026-09-16T12:00:00Z',
      kind: 'count_surge',
      severity: 'warning',
      evidence: { origin: 'run_guard' },
    });

    const open = async () =>
      (
        await db
          .select({ kind: parserIncidents.kind, resolvedAt: parserIncidents.resolvedAt })
          .from(parserIncidents)
          .where(and(eq(parserIncidents.sourceId, sourceId), eq(parserIncidents.resolved, false)))
      )
        .map((row) => row.kind)
        .sort();

    // A run that still fails one guard leaves both open.
    await recordRunAnomalies(
      db,
      input({
        sourceId,
        crawlRunId: null,
        guards: [
          { name: 'baseline', ok: true, countGuard: true },
          { name: 'fetchFailureRate', ok: false, countGuard: false },
        ],
      }),
    );
    expect(await open()).toEqual(['count_collapse', 'count_surge', 'field_missing', 'other']);

    await recordRunAnomalies(
      db,
      input({ sourceId, crawlRunId: null, detectedAt: '2026-09-17T12:00:00Z' }),
    );
    expect(await open()).toEqual(['count_surge', 'field_missing']);
    const cleared = await db
      .select({ resolvedAt: parserIncidents.resolvedAt })
      .from(parserIncidents)
      .where(and(eq(parserIncidents.sourceId, sourceId), eq(parserIncidents.resolved, true)));
    expect(cleared.map((row) => new Date(row.resolvedAt ?? '').toISOString())).toEqual([
      '2026-09-17T12:00:00.000Z',
      '2026-09-17T12:00:00.000Z',
    ]);
  });

  it('leaves another source’s guard incident open', async () => {
    const broken = await createTestSource();
    const healthy = await createTestSource();
    sourceIds.push(broken, healthy);
    await recordRunAnomalies(
      db,
      input({
        sourceId: broken,
        crawlRunId: null,
        guards: [{ name: 'baseline', ok: false, countGuard: true }],
      }),
    );
    await recordRunAnomalies(db, input({ sourceId: healthy, crawlRunId: null }));
    const [row] = await db
      .select({ resolved: parserIncidents.resolved })
      .from(parserIncidents)
      .where(eq(parserIncidents.sourceId, broken));
    expect(row?.resolved).toBe(false);
  });
});
