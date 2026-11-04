import { parseArgs } from 'node:util';
import type { RunSsGeCrawlOptions } from '../adapters/ss-ge/crawl.js';

/** As many as a run's request ceiling allows (`MAX_REQUESTS_PER_RUN`). */
const MAX_DETAIL_CHECKS = 20_000;
const HOUR_MS = 60 * 60 * 1000;

function wholeNumber(name: string, value: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be a whole number between ${min} and ${max}`);
  }
  return parsed;
}

/**
 * `--mode=nightly` (the default) reads each list back to the last completed
 * run, and as many lists as fit 4,000 pages, those read whole longest ago, to
 * their end; `--mode=sweep` reads every list to
 * its end, which takes most of a day. Either resumes where an interrupted run
 * of its mode stopped unless `--fresh` is given. `--max-pages=N` stops after
 * N results pages, for a trial or a sweep in instalments.
 * `--max-detail-checks=N` sets how many listing pages are asked for, checks
 * first and then pages wanted for their details (no cap by default; 0 for
 * none). `--stop-after-hours=N` ends the run's requests after N hours, 1 to
 * 20 (16 by default): a trial asks for 1.
 */
export function parseSsGeOptions(args: string[]): RunSsGeCrawlOptions {
  const { values } = parseArgs({
    args,
    options: {
      mode: { type: 'string', default: 'nightly' },
      'max-pages': { type: 'string' },
      'max-detail-checks': { type: 'string' },
      'stop-after-hours': { type: 'string' },
      fresh: { type: 'boolean' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.mode !== 'nightly' && values.mode !== 'sweep') {
    throw new Error('mode must be nightly or sweep');
  }
  const options: RunSsGeCrawlOptions = { mode: values.mode };
  if (values['max-pages'] !== undefined) {
    options.maxPages = wholeNumber('max-pages', values['max-pages'], 1, 9_999);
  }
  if (values['max-detail-checks'] !== undefined) {
    options.maxDetailChecks = wholeNumber(
      'max-detail-checks',
      values['max-detail-checks'],
      0,
      MAX_DETAIL_CHECKS,
    );
  }
  if (values['stop-after-hours'] !== undefined) {
    options.stopAfterMs =
      wholeNumber('stop-after-hours', values['stop-after-hours'], 1, 20) * HOUR_MS;
  }
  if (values.fresh === true) {
    options.fresh = true;
  }
  return options;
}
