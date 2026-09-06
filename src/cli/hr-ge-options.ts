import { parseArgs } from 'node:util';
import {
  DEFAULT_MISSING_STREAK_THRESHOLD,
  type RunHrGeCrawlOptions,
} from '../adapters/hr-ge/crawl.js';

export function parseHrGeOptions(args: string[]): RunHrGeCrawlOptions {
  const { values } = parseArgs({
    args,
    options: { mode: { type: 'string', default: 'full' }, pages: { type: 'string' } },
    strict: true,
    allowPositionals: false,
  });
  if (values.mode !== 'full' && values.mode !== 'incremental')
    throw new Error('mode must be full or incremental');
  if (values.pages !== undefined && values.mode !== 'incremental')
    throw new Error('--pages requires --mode=incremental');
  const pages = values.pages === undefined ? 2 : Number(values.pages);
  if (!Number.isInteger(pages) || pages < 1 || pages > 200)
    throw new Error('pages must be an integer between 1 and 200');
  return {
    missingStreakThreshold: DEFAULT_MISSING_STREAK_THRESHOLD,
    mode: values.mode,
    ...(values.mode === 'incremental' ? { incrementalPages: pages } : {}),
  };
}
