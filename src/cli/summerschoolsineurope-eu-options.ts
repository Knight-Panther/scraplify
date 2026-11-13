import { parseArgs } from 'node:util';
import type { RunSummerSchoolsCrawlOptions } from '../adapters/summerschoolsineurope-eu/crawl.js';

/**
 * `--refetch=all` rereads every listed course page (after a parser change);
 * `--sitemaps=all` reads every course sitemap, not only those dated after
 * the last completed run; `--max-listing-requests=N` and
 * `--max-detail-fetches=N` bound a run (a smoke test uses small values, and a
 * walk cut short by them is partial, so it closes nothing);
 * `--allow-mass-closure` is the reviewed override of the closure cap.
 */
export function parseSummerSchoolsEuOptions(args: string[]): RunSummerSchoolsCrawlOptions {
  const { values } = parseArgs({
    args,
    options: {
      refetch: { type: 'string', default: 'changed' },
      sitemaps: { type: 'string', default: 'changed' },
      'max-listing-requests': { type: 'string' },
      'max-detail-fetches': { type: 'string' },
      'allow-mass-closure': { type: 'boolean' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.refetch !== 'changed' && values.refetch !== 'all') {
    throw new Error('refetch must be changed or all');
  }
  if (values.sitemaps !== 'changed' && values.sitemaps !== 'all') {
    throw new Error('sitemaps must be changed or all');
  }
  const options: RunSummerSchoolsCrawlOptions = {
    refetch: values.refetch,
    sitemaps: values.sitemaps,
  };
  const bounded = (raw: string | undefined, name: string, max: number): number | undefined => {
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > max) {
      throw new Error(`max-${name} must be an integer between 1 and ${max}`);
    }
    return value;
  };
  const listing = bounded(values['max-listing-requests'], 'listing-requests', 1000);
  const detail = bounded(values['max-detail-fetches'], 'detail-fetches', 2000);
  if (listing !== undefined) options.maxListingRequests = listing;
  if (detail !== undefined) options.maxDetailFetches = detail;
  if (values['allow-mass-closure'] === true) options.allowMassClosure = true;
  return options;
}
