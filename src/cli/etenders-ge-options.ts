import { parseArgs } from 'node:util';
import type { RunEtendersGeCrawlOptions } from '../adapters/etenders-ge/crawl.js';

/**
 * `--window-days=N` overrides the recent-announcements window (default:
 * since the last completed run plus two days, or 60 days on a first run);
 * `--refetch=all` rereads every public tender found, after a parser change.
 */
export function parseEtendersGeOptions(args: string[]): RunEtendersGeCrawlOptions {
  const { values } = parseArgs({
    args,
    options: {
      'window-days': { type: 'string' },
      refetch: { type: 'string', default: 'changed' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.refetch !== 'changed' && values.refetch !== 'all') {
    throw new Error('refetch must be changed or all');
  }
  const options: RunEtendersGeCrawlOptions = { refetch: values.refetch };
  if (values['window-days'] !== undefined) {
    const days = Number(values['window-days']);
    if (!Number.isInteger(days) || days < 1 || days > 120) {
      throw new Error('window-days must be an integer between 1 and 120');
    }
    options.windowDays = days;
  }
  return options;
}
