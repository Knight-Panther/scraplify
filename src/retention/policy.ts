/**
 * Retention policy constants (owner-approved, 2026-09-27): telemetry 60 days;
 * closed/expired listings dead more than 60 days are trimmed (current
 * revision kept, description blanked); dead more than 180 days, whole
 * clusters are purged unless user data or a human decision still references
 * them. See docs/archive/PHASE_7C_PLAN.md's Retention section and
 * docs/scraplify-concept.md §6.1 for the exception this carves out of
 * "retain immutable revisions".
 *
 * Numbers live here, not scattered across the tier queries, so a future
 * policy change (concept amendment, not a code review finding) is one edit.
 */
export const RETENTION_POLICY = {
  /** Tier 1: fetch_attempts, resolved parser_incidents, orphan resources. */
  telemetryRetentionDays: 60,
  /** Tier 2: closed/expired listings — keep the current revision, blank its description. */
  trimRetentionDays: 60,
  /** Tier 3: closed/expired listings — purge the whole cluster, if nothing user-facing references it. */
  purgeRetentionDays: 180,

  /** DELETE ... WHERE id IN (SELECT ... LIMIT n) loop size for fetch_attempts/parser_incidents. */
  tier1BatchSize: 5000,
  /** Smaller: an orphan resource's eligibility check joins three tables per row. */
  tier1ResourceBatchSize: 2000,
  /** Tier 2 listings considered per transaction. */
  tier2BatchSize: 500,
  /** Tier 3 listings considered per transaction — whole-cluster deletes touch more tables per row. */
  tier3BatchSize: 200,

  /**
   * How many batches (pages) a single call may look through before giving up
   * for this run, when a page's candidates turn out to have no actual work
   * left (every one blocked, or already done). Without a bound, a batch that
   * is ordered by id and never re-checks "did this page make progress" can
   * permanently starve a real backlog sitting behind a wall of blocked rows
   * — a P1 finding in adversarial review, 2026-09-28. Small: this is a
   * per-run exploration budget, not a drain-to-empty loop, and each page is
   * one more read pass over the batch.
   */
  tier2MaxPages: 10,
  tier3MaxPages: 10,
} as const;

export interface RetentionCutoffs {
  telemetryCutoff: string;
  trimCutoff: string;
  purgeCutoff: string;
}

function daysBefore(now: Date, days: number): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** The three cutoff instants for one retention pass, all derived from the same `now` so a pass is internally consistent. */
export function cutoffs(now: Date): RetentionCutoffs {
  return {
    telemetryCutoff: daysBefore(now, RETENTION_POLICY.telemetryRetentionDays),
    trimCutoff: daysBefore(now, RETENTION_POLICY.trimRetentionDays),
    purgeCutoff: daysBefore(now, RETENTION_POLICY.purgeRetentionDays),
  };
}
