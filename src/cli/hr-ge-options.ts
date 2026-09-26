import { parseArgs } from 'node:util';
import {
  DEFAULT_MISSING_STREAK_THRESHOLD,
  type RunHrGeCrawlOptions,
} from '../adapters/hr-ge/crawl.js';

export function parseHrGeOptions(args: string[]): RunHrGeCrawlOptions {
  const { values } = parseArgs({
    args,
    options: {
      mode: { type: 'string', default: 'full' },
      pages: { type: 'string' },
      'allow-mass-closure': { type: 'boolean', default: false },
      refetch: { type: 'string', default: 'changed' },
    },
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
  // Phase 7C: `changed` (default, and what the schedules run) skips detail
  // pages whose list-page fingerprint is unchanged; `all` fetches every one,
  // for use after a parser change.
  if (values.refetch !== 'changed' && values.refetch !== 'all')
    throw new Error('refetch must be changed or all');
  return {
    missingStreakThreshold: DEFAULT_MISSING_STREAK_THRESHOLD,
    refetch: values.refetch,
    mode: values.mode,
    ...(values.mode === 'incremental' ? { incrementalPages: pages } : {}),
    ...(values['allow-mass-closure'] ? { allowMassClosure: true } : {}),
  };
}
