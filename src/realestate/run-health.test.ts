import { describe, expect, it } from 'vitest';
import { assessRealEstateRuns, CRITICAL_AFTER_HOURS, WARN_AFTER_HOURS } from './run-health.js';

const NOW = '2026-10-27T08:00:00.000Z';
const hoursAgo = (hours: number) => new Date(Date.parse(NOW) - hours * 3_600_000).toISOString();

describe('assessRealEstateRuns', () => {
  it('is quiet while the last completed run is recent', () => {
    expect(
      assessRealEstateRuns(
        {
          lastCompletedAt: hoursAgo(5),
          latest: { status: 'completed', startedAt: hoursAgo(9), notes: null },
        },
        NOW,
      ),
    ).toEqual([]);
  });

  it('warns after a day and a half without a completed run, naming the latest run', () => {
    const alerts = assessRealEstateRuns(
      {
        lastCompletedAt: hoursAgo(WARN_AFTER_HOURS + 4),
        latest: {
          status: 'partial',
          startedAt: hoursAgo(10),
          notes: 'cottage-rent page 1: the site answered HTTP 403',
        },
      },
      NOW,
    );
    expect(alerts).toEqual([
      {
        level: 'warning',
        code: 'no_recent_completed_run',
        message:
          'The last completed run finished 40 h ago. The latest run is partial: cottage-rent page 1: the site answered HTTP 403.',
      },
    ]);
  });

  it('is critical after four days, as the 2026-10-22 outage was by its fifth', () => {
    const [alert] = assessRealEstateRuns(
      {
        lastCompletedAt: hoursAgo(CRITICAL_AFTER_HOURS + 1),
        latest: { status: 'partial', startedAt: hoursAgo(10), notes: null },
      },
      NOW,
    );
    expect(alert?.level).toBe('critical');
  });

  it('is critical when no run has ever completed', () => {
    expect(assessRealEstateRuns({ lastCompletedAt: null, latest: null }, NOW)).toEqual([
      { level: 'critical', code: 'never_completed', message: 'No run has ever completed.' },
    ]);
  });
});
