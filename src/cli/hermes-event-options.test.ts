import { describe, expect, it } from 'vitest';
import { parseHermesEventOptions } from './hermes-event-options.js';

/** The arguments `deploy/run-pipeline.sh` passes after an ordinary run. */
function args(overrides: Record<string, string | null> = {}): string[] {
  const values: Record<string, string | null> = {
    source: 'jobs-ge',
    'started-at': '2026-10-13T16:10:04Z',
    crawl: '0',
    dedupe: '0',
    taxonomy: '0',
    bundle: '0',
    retention: '0',
    'exit-code': '0',
    ...overrides,
  };
  return Object.entries(values)
    .filter(([, value]) => value !== null)
    .map(([name, value]) => `--${name}=${value}`);
}

describe('parseHermesEventOptions', () => {
  it('reads a finished run', () => {
    expect(parseHermesEventOptions(args())).toEqual({
      kind: 'pipeline',
      run: {
        sourceSlug: 'jobs-ge',
        startedAt: '2026-10-13T16:10:04.000Z',
        steps: { crawl: 0, dedupe: 0, taxonomy: 0, bundle: 0, retention: 0 },
        exitCode: 0,
        interrupted: false,
      },
    });
  });

  it('reads "-" as a step that did not run', () => {
    const options = parseHermesEventOptions([
      ...args({ crawl: '1', retention: '-', 'exit-code': '1' }),
    ]);
    expect(options).toMatchObject({
      run: { steps: { crawl: 1, retention: null }, exitCode: 1 },
    });
  });

  it('reads an interrupted run, with no step finished', () => {
    const options = parseHermesEventOptions([
      ...args({
        crawl: '-',
        dedupe: '-',
        taxonomy: '-',
        bundle: '-',
        retention: '-',
        'exit-code': '143',
      }),
      '--interrupted',
    ]);
    expect(options).toMatchObject({
      run: {
        steps: { crawl: null, dedupe: null, taxonomy: null, bundle: null, retention: null },
        exitCode: 143,
        interrupted: true,
      },
    });
  });

  it('takes every source the pipeline runs, and no other', () => {
    for (const source of ['jobs-ge', 'hr-ge', 'etenders-ge']) {
      expect(parseHermesEventOptions(args({ source }))).toMatchObject({
        run: { sourceSlug: source },
      });
    }
    expect(() => parseHermesEventOptions(args({ source: 'myhome-ge' }))).toThrow(/--source/);
    expect(() => parseHermesEventOptions(args({ source: null }))).toThrow(/--source/);
  });

  it('refuses what the script would never pass', () => {
    expect(() => parseHermesEventOptions(args({ 'started-at': 'yesterday' }))).toThrow(
      /--started-at/,
    );
    expect(() => parseHermesEventOptions(args({ 'started-at': null }))).toThrow(/--started-at/);
    expect(() => parseHermesEventOptions(args({ 'exit-code': null }))).toThrow(/--exit-code/);
    expect(() => parseHermesEventOptions(args({ 'exit-code': '-' }))).toThrow(/--exit-code/);
    expect(() => parseHermesEventOptions(args({ crawl: 'ok' }))).toThrow(/--crawl/);
    expect(() => parseHermesEventOptions(args({ dedupe: '256' }))).toThrow(/--dedupe/);
    expect(() => parseHermesEventOptions([...args(), '--verbose'])).toThrow();
  });

  describe('a real-estate run, which has the crawl only', () => {
    /** The arguments `deploy/run-realestate.sh` passes. */
    const realEstate = (overrides: Record<string, string | null> = {}) =>
      args({
        source: 'ss-ge',
        dedupe: null,
        taxonomy: null,
        bundle: null,
        retention: null,
        ...overrides,
      });

    it('reads it as a real-estate run', () => {
      expect(parseHermesEventOptions(realEstate({ crawl: '1', 'exit-code': '1' }))).toEqual({
        kind: 'realestate',
        run: {
          sourceSlug: 'ss-ge',
          startedAt: '2026-10-13T16:10:04.000Z',
          crawl: 1,
          exitCode: 1,
          interrupted: false,
        },
      });
    });

    it('reads an interrupted one, its crawl unfinished', () => {
      expect(
        parseHermesEventOptions([
          ...realEstate({ crawl: '-', 'exit-code': '143' }),
          '--interrupted',
        ]),
      ).toMatchObject({
        kind: 'realestate',
        run: { crawl: null, exitCode: 143, interrupted: true },
      });
    });

    it('refuses a job-board step on it', () => {
      expect(() => parseHermesEventOptions(realEstate({ dedupe: '0' }))).toThrow(/crawl step only/);
      expect(() => parseHermesEventOptions(args({ source: 'ss-ge' }))).toThrow(/crawl step only/);
    });
  });

  it('needs nothing else for a test event', () => {
    expect(parseHermesEventOptions(['--test'])).toEqual({ kind: 'test' });
  });
});
