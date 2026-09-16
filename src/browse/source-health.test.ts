import { describe, expect, it } from 'vitest';
import type { SourceHealthView } from './queries.js';
import { assessSourceHealth, hasCriticalAlert } from './source-health.js';

const NOW = '2026-09-16T12:00:00Z';

function hoursAgo(hours: number): string {
  return new Date(Date.parse(NOW) - hours * 60 * 60 * 1000).toISOString();
}

function view(overrides: Partial<SourceHealthView> = {}): SourceHealthView {
  return {
    sourceSlug: 'hr-ge',
    listingsByStatus: { active: 3354 },
    lastRunAt: hoursAgo(10),
    lastRunStatus: 'completed',
    lastFullCoverageRunAt: hoursAgo(10),
    unresolvedIncidents: 0,
    unlinkedActiveListings: 0,
    staleUnlinkedActiveListings: 0,
    ...overrides,
  };
}

function codes(source: SourceHealthView): string[] {
  return assessSourceHealth(source, NOW).map((alert) => `${alert.level}:${alert.code}`);
}

describe('assessSourceHealth', () => {
  it('raises nothing for a source crawled recently, completely, and fully deduped', () => {
    expect(assessSourceHealth(view(), NOW)).toEqual([]);
  });

  it('is critical for a source that has never been crawled, without piling on coverage noise', () => {
    expect(
      codes(view({ lastRunAt: null, lastRunStatus: null, lastFullCoverageRunAt: null })),
    ).toEqual(['critical:never_crawled']);
  });

  it('is critical once no crawl has started within the overdue window', () => {
    // jobs.ge on 2026-09-16: last crawled 2026-09-06, ten days earlier.
    expect(codes(view({ lastRunAt: hoursAgo(49), lastFullCoverageRunAt: hoursAgo(49) }))).toEqual([
      'critical:run_overdue',
    ]);
    expect(codes(view({ lastRunAt: hoursAgo(47), lastFullCoverageRunAt: hoursAgo(47) }))).toEqual(
      [],
    );
  });

  it('is critical for a failed last run and a warning for a degraded one', () => {
    expect(codes(view({ lastRunStatus: 'failed' }))).toEqual(['critical:last_run_failed']);
    expect(codes(view({ lastRunStatus: 'partial' }))).toEqual(['warning:last_run_degraded']);
    expect(codes(view({ lastRunStatus: 'quarantined' }))).toEqual(['warning:last_run_degraded']);
  });

  it('only suspects a stuck run once it has been running far longer than any real crawl', () => {
    expect(codes(view({ lastRunStatus: 'running', lastRunAt: hoursAgo(9) }))).toEqual([]);
    expect(codes(view({ lastRunStatus: 'running', lastRunAt: hoursAgo(25) }))).toEqual([
      'warning:run_possibly_stuck',
    ]);
  });

  it('warns when full coverage never happened or has gone stale, even if bounded runs are recent', () => {
    expect(codes(view({ lastFullCoverageRunAt: null }))).toEqual(['warning:full_coverage_stale']);
    expect(codes(view({ lastFullCoverageRunAt: hoursAgo(8 * 24) }))).toEqual([
      'warning:full_coverage_stale',
    ]);
    expect(codes(view({ lastFullCoverageRunAt: hoursAgo(6 * 24) }))).toEqual([]);
  });

  it('warns about unresolved incidents', () => {
    const [alert] = assessSourceHealth(view({ unresolvedIncidents: 2 }), NOW);
    expect(alert?.code).toBe('open_incidents');
    expect(alert?.message).toBe('2 unresolved parser incidents.');
  });

  it('is critical only for unlinked listings too old to still be waiting on dedupe', () => {
    // Fresh ones are the normal state mid-crawl, before the chained dedupe pass.
    expect(codes(view({ unlinkedActiveListings: 40, staleUnlinkedActiveListings: 0 }))).toEqual([]);
    // The 2026-09-15 incident: 3,277 active hr.ge listings with no opportunity.
    const alerts = assessSourceHealth(
      view({ unlinkedActiveListings: 3277, staleUnlinkedActiveListings: 3277 }),
      NOW,
    );
    expect(alerts.map((alert) => alert.code)).toEqual(['unlinked_active_listings']);
    expect(alerts[0]?.level).toBe('critical');
    expect(alerts[0]?.message).toContain('3,277 active listings have');
  });

  it('reports several problems at once rather than only the first', () => {
    expect(
      codes(
        view({
          lastRunAt: hoursAgo(240),
          lastRunStatus: 'partial',
          lastFullCoverageRunAt: null,
          unresolvedIncidents: 1,
        }),
      ),
    ).toEqual([
      'critical:run_overdue',
      'warning:last_run_degraded',
      'warning:full_coverage_stale',
      'warning:open_incidents',
    ]);
  });
});

describe('hasCriticalAlert', () => {
  it('is true only when some alert is critical', () => {
    expect(hasCriticalAlert([])).toBe(false);
    expect(hasCriticalAlert(assessSourceHealth(view({ lastRunStatus: 'partial' }), NOW))).toBe(
      false,
    );
    expect(hasCriticalAlert(assessSourceHealth(view({ lastRunStatus: 'failed' }), NOW))).toBe(true);
  });
});
