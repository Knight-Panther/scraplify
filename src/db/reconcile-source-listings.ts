import { and, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { crawlRuns, sourceListings } from './schema/index.js';
import type { Database, DatabaseOrTransaction } from './types.js';

/** Statuses a listing must be in to be eligible for either closure below (§13's diagram: expired/closed only ever branch off active or missing_suspected). */
const OPEN_STATUSES = ['active', 'missing_suspected'] as const;

/** concept §13: the first miss must become 'missing_suspected', never 'closed' — a threshold below this would close on one miss. */
const MIN_MISSING_STREAK_THRESHOLD = 2;

export interface CloseMissingListingsInput {
  /** The completed crawl run this reconciliation pass belongs to — its persisted row, not caller state, decides eligibility (see below). */
  crawlRunId: string;
  /** concept §13: "missing across the configured number of complete successful reconciliations." Must be >= 2. */
  missingStreakThreshold: number;
}

export interface CloseMissingListingsResult {
  /** True when the run wasn't eligible (not completed, or not full coverage) — no rows were touched. */
  skipped: boolean;
  /** Listings that went active -> missing_suspected, or had their streak incremented but stayed missing_suspected. */
  missingSuspectedCount: number;
  /** Listings whose missing streak crossed the threshold this pass. */
  closedCount: number;
}

/**
 * Advances missing streaks and closes listings absent across enough
 * consecutive complete reconciliations (§13). Call this AFTER
 * expireOverdueListings for the same run — a listing expireOverdueListings
 * already moved out of 'active'/'missing_suspected' is correctly excluded
 * here for free, since both WHERE clauses re-check status against its
 * current state at execution time.
 *
 * Eligibility (run status 'completed', and full discovery coverage) is read
 * from the crawl run's own persisted row inside this function's transaction,
 * not accepted as caller-supplied fields — a caller passing a stale or
 * mistaken claim must never be able to trigger mass closure; only the
 * database's own record of what the run actually did can (adversarial
 * review, 2026-09-04). Concept §10.1 distinguishes incremental discovery (a
 * rolling overlap window that may stop early) from periodic complete
 * reconciliation — only the latter may drive closure, since a listing
 * outside an incremental run's scope was never given a chance to be seen.
 *
 * Idempotent per run: `lastReconciledAt < run.startedAt` (or never set)
 * gates every row this touches, and every row it touches gets
 * lastReconciledAt bumped to run.startedAt. Without this, retrying or
 * double-invoking this function for the SAME completed run would
 * re-increment missingStreak each time — lastSeenAt alone doesn't guard
 * against that, since a truly missing listing's lastSeenAt never changes
 * between repeat calls for one run (also caught by adversarial review,
 * 2026-09-04, before this reached `main`).
 *
 * Runs as two plain UPDATEs (not the SELECT-FOR-UPDATE protocol
 * write-source-listing-revision.ts needs): each UPDATE's WHERE is
 * re-evaluated against the row's currently-committed state, so a listing a
 * concurrent writeSourceListingRevision call is actively touching is simply
 * excluded once that write commits its newer lastSeenAt — there is no
 * "decide based on a value read earlier" step to protect with a row lock.
 */
export async function closeMissingListings(
  db: Database,
  input: CloseMissingListingsInput,
): Promise<CloseMissingListingsResult> {
  if (
    !Number.isInteger(input.missingStreakThreshold) ||
    input.missingStreakThreshold < MIN_MISSING_STREAK_THRESHOLD
  ) {
    throw new Error(
      `closeMissingListings: missingStreakThreshold must be an integer >= ${MIN_MISSING_STREAK_THRESHOLD}, got ${input.missingStreakThreshold}`,
    );
  }

  return db.transaction(async (tx) => {
    const [run] = await tx.select().from(crawlRuns).where(eq(crawlRuns.id, input.crawlRunId));
    if (!run) {
      throw new Error(`closeMissingListings: no crawl run found with id ${input.crawlRunId}`);
    }

    if (run.status !== 'completed' || !run.fullCoverage) {
      return { skipped: true, missingSuspectedCount: 0, closedCount: 0 };
    }

    const baseWhere = and(
      eq(sourceListings.sourceId, run.sourceId),
      inArray(sourceListings.status, OPEN_STATUSES),
      lt(sourceListings.lastSeenAt, run.startedAt),
      or(
        isNull(sourceListings.lastReconciledAt),
        lt(sourceListings.lastReconciledAt, run.startedAt),
      ),
    );

    const closed = await tx
      .update(sourceListings)
      .set({
        missingStreak: sql`${sourceListings.missingStreak} + 1`,
        status: 'closed',
        lastReconciledAt: run.startedAt,
      })
      .where(
        and(baseWhere, sql`${sourceListings.missingStreak} + 1 >= ${input.missingStreakThreshold}`),
      )
      .returning({ id: sourceListings.id });

    const missingSuspected = await tx
      .update(sourceListings)
      .set({
        missingStreak: sql`${sourceListings.missingStreak} + 1`,
        status: 'missing_suspected',
        lastReconciledAt: run.startedAt,
      })
      .where(
        and(baseWhere, sql`${sourceListings.missingStreak} + 1 < ${input.missingStreakThreshold}`),
      )
      .returning({ id: sourceListings.id });

    return {
      skipped: false,
      missingSuspectedCount: missingSuspected.length,
      closedCount: closed.length,
    };
  });
}

export interface ExpireOverdueListingsInput {
  sourceId: string;
  /** Usually "now" — compared against each listing's sourceDeadlineAt, already an absolute instant (source timezone/locale parsing happened upstream, at extraction time). */
  asOf: string;
}

export interface ExpireOverdueListingsResult {
  expiredCount: number;
}

/**
 * Marks past-deadline listings expired (§13: "passed deadline: mark expired
 * ... "). Unlike closeMissingListings, this is unconditional — a deadline
 * having passed is a definitive, source-stated fact, not an absence
 * inferred from crawl coverage, so it applies regardless of run status or
 * coverage and doesn't need a crawl run in scope at all.
 */
export async function expireOverdueListings(
  db: DatabaseOrTransaction,
  input: ExpireOverdueListingsInput,
): Promise<ExpireOverdueListingsResult> {
  const rows = await db
    .update(sourceListings)
    .set({ status: 'expired' })
    .where(
      and(
        eq(sourceListings.sourceId, input.sourceId),
        inArray(sourceListings.status, OPEN_STATUSES),
        isNotNull(sourceListings.sourceDeadlineAt),
        lt(sourceListings.sourceDeadlineAt, input.asOf),
      ),
    )
    .returning({ id: sourceListings.id });

  return { expiredCount: rows.length };
}
