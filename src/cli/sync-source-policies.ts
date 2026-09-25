import { sql } from 'drizzle-orm';
import { ensureHrGeSourceSeeded } from '../adapters/hr-ge/crawl.js';
import { ensureJobsGeSourceSeeded } from '../adapters/jobs-ge/crawl.js';
import { db } from '../db/client.js';
import { logger } from '../logger.js';

/**
 * Activates a policy edit immediately, without waiting for the next
 * scheduled crawl (round 6 of the adversarial review, 2026-09-24). Every
 * crawl already calls `ensureXSourceSeeded()`, which itself calls
 * `syncSourcePolicy()` (`src/db/source-policies.ts`) — this script calls
 * the exact same functions standalone, so an operator who just edited
 * `src/policies/jobs-ge.ts`/`hr-ge.ts` and deployed it can run
 * `npm run sync-policies` and know the database reflects it right away,
 * rather than trusting a scheduled crawl to get to it — which, per this
 * project's own incident history (`docs/STATUS.md`), has silently stopped
 * running for a week before. Read-only with respect to everything except
 * `sources`/`source_policies`: no crawl, no fetch, no listing writes.
 *
 * Reports the REAL outcome per source, and exits non-zero on
 * `'refused-stale'` (round 7 of the same review, 2026-09-25): logging
 * "synced" unconditionally, regardless of what `syncSourcePolicy()`
 * actually did, would have told an operator their edit landed when
 * `syncSourcePolicy()` silently refused it (an unbumped or backdated
 * `reviewDate` is an easy mistake to make) — a false success signal on
 * exactly the command this project's own operator runs specifically to
 * confirm a policy change took effect.
 */
async function main(): Promise<void> {
  try {
    await db.execute(sql`select 1`);
  } catch (err) {
    logger.error({ err }, 'sync-policies: database preflight check failed');
    throw err;
  }

  let anyRefused = false;
  for (const [source, ensure] of [
    ['jobs-ge', ensureJobsGeSourceSeeded],
    ['hr-ge', ensureHrGeSourceSeeded],
  ] as const) {
    const { outcome } = await ensure(db);
    if (outcome === 'refused-stale') {
      anyRefused = true;
      logger.error(
        { source, outcome },
        'sync-policies: REFUSED -- the policy file was not applied (not strictly newer than what is already current; check reviewDate)',
      );
    } else {
      logger.info({ source, outcome }, 'sync-policies: synced');
    }
  }

  if (anyRefused) {
    throw new Error(
      'sync-policies: at least one source was refused -- see the error(s) above. The database was NOT updated for that source.',
    );
  }
}

main()
  .catch((err: unknown) => {
    logger.error({ err }, 'sync-policies: run failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$client.end();
  });
