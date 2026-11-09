#!/usr/bin/env node
/**
 * Asks ss.ge what it says about a few listings, to measure how much of the
 * Real estate tab is dead. Reads only: nothing is written anywhere.
 *
 *   npm run build
 *   node scripts/ss-ge-ask-listings.mjs suspect=36821556,36842435 control=28632033
 *
 * Each argument is a label and the listings' ss.ge ids. Every listing's own
 * page is fetched through the crawler's fetcher, policy and spacing (about
 * 4 s a page) and read by its parser, so the answer is the one a nightly
 * check would write: live until a date, or gone and why. Run it from a
 * Georgian connection; ss.ge challenges others.
 *
 * The samples to feed it, and what they found on 2026-11-09, are in
 * src/adapters/ss-ge/RECON_NOTES.md, "Measuring dead listings on the tab".
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const load = (file) => import(pathToFileURL(path.join(dist, file)).href);

const groups = process.argv.slice(2).map((arg) => {
  const [label, ids = ''] = arg.split('=');
  return { label, ids: ids.split(',').filter((id) => /^[1-9][0-9]{0,9}$/.test(id)) };
});
if (groups.length === 0 || groups.some((group) => group.ids.length === 0)) {
  console.error('usage: node scripts/ss-ge-ask-listings.mjs <label>=<id>,<id>,... [...]');
  process.exit(2);
}

const { createHttpFetcher } = await load('net/http-fetcher.js');
const { createRateLimiter } = await load('net/rate-limiter.js');
const { resolveUserAgent } = await load('net/user-agent.js');
const { isSsGeUrlAllowed, ssGePolicy, ssGeSource } = await load('policies/ss-ge.js');
const { parseDetailPage } = await load('adapters/ss-ge/detail.js');

const fetcher = createHttpFetcher({
  isUrlAllowed: isSsGeUrlAllowed,
  rateLimiter: createRateLimiter(ssGePolicy.rateLimit),
  userAgent: resolveUserAgent(),
  requestTimeoutMs: 60_000,
});

const tally = {};
try {
  for (const { label, ids } of groups) {
    tally[label] = {};
    for (const id of ids) {
      const url = new URL(`/ka/udzravi-qoneba/${id}`, ssGeSource.baseUrl).toString();
      let said;
      try {
        const response = await fetcher.fetch(url);
        if (response.status !== 200) said = `http ${response.status}`;
        else {
          const page = parseDetailPage(response.body, id);
          said = page.status === 'active' ? `live until ${page.endAt}` : `gone (${page.reason})`;
        }
      } catch (err) {
        said = `error: ${String(err?.message ?? err).slice(0, 120)}`;
      }
      const outcome = said.startsWith('live') ? 'live' : said;
      tally[label][outcome] = (tally[label][outcome] ?? 0) + 1;
      console.log(`${label} | ${id} | ${said}`);
    }
  }
} finally {
  await fetcher.close();
}
console.log(JSON.stringify(tally));
