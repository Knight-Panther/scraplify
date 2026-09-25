import { eq } from 'drizzle-orm';
import { sources } from '../db/schema/index.js';
import type { Database } from '../db/types.js';
import type { HttpFetcher, HttpFetchResult } from '../net/http-fetcher.js';

/**
 * Thrown by `assertPolicyRevisionActive` / the fetcher wrapper below when the
 * source's authorized policy has moved on since this crawl started.
 */
export class PolicyRevisionSupersededError extends Error {
  constructor(sourceId: string) {
    super(
      `policy revalidation: source ${sourceId}'s current policy revision has changed or been ` +
        'flagged conflicted since this crawl started -- aborting rather than continuing to fetch ' +
        "under a revision the database no longer considers this deployment's own to run under.",
    );
    this.name = 'PolicyRevisionSupersededError';
  }
}

/**
 * Throws unless `sourceId`'s CURRENT policy revision is still exactly
 * `expectedRevisionId`, with no standing same-date conflict flagged
 * (`src/db/source-policies.ts`'s `policyConflictAt`). A plain, unlocked
 * SELECT -- this is a defensive re-check during an already-running crawl,
 * not a decision that writes anything, so it needs no row lock; a false
 * negative (aborting on a read that's a few milliseconds stale) only ever
 * makes this MORE conservative, never less.
 *
 * Codex-caught P1, round 10, 2026-09-25: `ensureXSourceSeeded()`'s
 * abort (round 8) only ever runs ONCE, before `startCrawlRun`. A full jobs.ge
 * walk is ~5,666 requests at a mandatory 5s crawl delay (~7.9 hours) --
 * `npm run sync-policies` or a fresher worker activating a stricter revision,
 * or a same-date conflict being flagged, minutes into that walk would leave
 * the already-running crawl fetching under a policy the database no longer
 * considers current for the ENTIRE remaining multi-hour duration, since
 * nothing re-checked. `withPolicyRevalidation` below re-runs this check
 * before every single fetch (discovery AND detail pages both funnel through
 * one `httpFetcher.fetch()` call site in each adapter's `fetchAndRecord`),
 * bounding the exposure window to this crawl's own request cadence rather
 * than its total duration.
 */
export async function assertPolicyRevisionActive(
  db: Database,
  sourceId: string,
  expectedRevisionId: string | null,
): Promise<void> {
  const [source] = await db
    .select({
      currentPolicyRevisionId: sources.currentPolicyRevisionId,
      policyConflictAt: sources.policyConflictAt,
    })
    .from(sources)
    .where(eq(sources.id, sourceId));
  if (
    source === undefined ||
    source.currentPolicyRevisionId !== expectedRevisionId ||
    source.policyConflictAt !== null
  ) {
    throw new PolicyRevisionSupersededError(sourceId);
  }
}

/**
 * Wraps `fetcher` so every `fetch()` call re-validates `sourceId`'s policy
 * revision first (see `assertPolicyRevisionActive` above) — the fix for
 * Codex's "revalidate the active revision before fetching" finding. `close`
 * delegates unchanged; only `fetch` needs the guard.
 */
export function withPolicyRevalidation(
  fetcher: HttpFetcher,
  db: Database,
  sourceId: string,
  expectedRevisionId: string | null,
): HttpFetcher {
  return {
    async fetch(url: string): Promise<HttpFetchResult> {
      await assertPolicyRevisionActive(db, sourceId, expectedRevisionId);
      return fetcher.fetch(url);
    },
    close(): Promise<void> {
      return fetcher.close();
    },
  };
}
