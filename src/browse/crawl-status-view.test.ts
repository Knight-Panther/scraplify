import { describe, expect, it } from 'vitest';
import { type CrawlStatusSnapshot, describeCrawlStatus } from './crawl-status-view.js';

const DAILY = { hourUtc: 16, minuteUtc: 10 };
const at = (iso: string): number => Date.parse(iso);

function snapshot(overrides: Partial<CrawlStatusSnapshot> = {}): CrawlStatusSnapshot {
  return {
    sourceSlug: 'jobs-ge',
    lastRunStartedAt: '2026-09-27T16:10:00Z',
    lastRunStatus: 'completed',
    lastCompletedAt: '2026-09-27T16:14:00Z',
    ...overrides,
  };
}

describe('describeCrawlStatus', () => {
  it('after a run on time: scheduled, last update and the next slot', () => {
    const view = describeCrawlStatus(snapshot(), at('2026-09-27T20:00:00Z'), DAILY);
    expect(view).toEqual({
      sourceSlug: 'jobs-ge',
      lastUpdatedAt: '2026-09-27T16:14:00Z',
      lastAttemptIncomplete: false,
      state: { kind: 'scheduled' },
      nextUpdateAt: '2026-09-28T16:10:00.000Z',
    });
  });

  it('while a run is in flight: updating', () => {
    const view = describeCrawlStatus(
      snapshot({ lastRunStartedAt: '2026-09-28T16:10:05Z', lastRunStatus: 'running' }),
      at('2026-09-28T16:12:00Z'),
      DAILY,
    );
    expect(view?.state).toEqual({ kind: 'updating', since: '2026-09-28T16:10:05.000Z' });
    expect(view?.lastUpdatedAt).toBe('2026-09-27T16:14:00Z');
  });

  it('within 30 minutes of a slot with no run yet: still scheduled, not late', () => {
    const view = describeCrawlStatus(snapshot(), at('2026-09-28T16:39:59Z'), DAILY);
    expect(view?.state).toEqual({ kind: 'scheduled' });
  });

  it('30 minutes after a slot with no run: late, naming the missed slot', () => {
    const view = describeCrawlStatus(snapshot(), at('2026-09-28T16:40:00Z'), DAILY);
    expect(view?.state).toEqual({ kind: 'late', expectedAt: '2026-09-28T16:10:00.000Z' });
  });

  it('a run started by hand after the slot counts for it', () => {
    const view = describeCrawlStatus(
      snapshot({
        lastRunStartedAt: '2026-09-28T19:14:00Z',
        lastCompletedAt: '2026-09-28T19:20:00Z',
      }),
      at('2026-09-28T21:00:00Z'),
      DAILY,
    );
    expect(view?.state).toEqual({ kind: 'scheduled' });
  });

  it('a run left "running" for over 3 hours is a dead process: late, not updating', () => {
    const view = describeCrawlStatus(
      snapshot({ lastRunStartedAt: '2026-09-27T16:10:00Z', lastRunStatus: 'running' }),
      at('2026-09-28T17:00:00Z'),
      DAILY,
    );
    expect(view?.state).toEqual({ kind: 'late', expectedAt: '2026-09-28T16:10:00.000Z' });
  });

  it('a newest run that ended partial or failed is flagged, the last full update kept', () => {
    for (const status of ['partial', 'failed', 'quarantined'] as const) {
      const view = describeCrawlStatus(
        snapshot({ lastRunStartedAt: '2026-09-28T16:10:00Z', lastRunStatus: status }),
        at('2026-09-28T17:00:00Z'),
        DAILY,
      );
      expect(view?.lastAttemptIncomplete).toBe(true);
      expect(view?.lastUpdatedAt).toBe('2026-09-27T16:14:00Z');
      expect(view?.state).toEqual({ kind: 'scheduled' });
    }
  });

  it('a source that has never run: no update yet, and late once its first slot passes', () => {
    const view = describeCrawlStatus(
      snapshot({ lastRunStartedAt: null, lastRunStatus: null, lastCompletedAt: null }),
      at('2026-09-28T17:00:00Z'),
      DAILY,
    );
    expect(view?.lastUpdatedAt).toBeNull();
    expect(view?.lastAttemptIncomplete).toBe(false);
    expect(view?.state.kind).toBe('late');
  });

  it('a source with no declared schedule is not shown', () => {
    expect(
      describeCrawlStatus(snapshot({ sourceSlug: 'unknown' }), at('2026-09-28T17:00:00Z')),
    ).toBeNull();
  });
});
