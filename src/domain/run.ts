import { z } from 'zod';
import { CrawlRunId, FetchAttemptId, IsoDateTime, ResourceId, SourceId } from './ids.js';

export const CrawlRunStatus = z.enum(['running', 'completed', 'failed', 'partial', 'quarantined']);
export type CrawlRunStatus = z.infer<typeof CrawlRunStatus>;

/**
 * One scheduled or manual crawl run (§19, §21.2, §26). Counts here are what
 * "run reports show discovered, new, changed, unchanged, suspected missing,
 * expired, reopened, quarantined, and failed" (§26) is built from. The
 * `quarantined` status is the run itself being flagged anomalous (§21.3,
 * §24.3) — distinct from `quarantinedCount`, which counts individual
 * listings quarantined during an otherwise-healthy run. A partial, failed,
 * or quarantined run must not advance closure state for any source listing.
 */
export const CrawlRunSchema = z.object({
  id: CrawlRunId,
  sourceId: SourceId,
  startedAt: IsoDateTime,
  finishedAt: IsoDateTime.nullable(),
  /**
   * Set only once this run is fully settled — reconciliation genuinely ran
   * (or, for a 'failed' run, definitely never will) — separately from
   * `status`, which reaches its terminal value earlier, before
   * reconciliation runs. Exclusivity (src/db/schema/runs.ts's partial
   * unique index) is keyed on this being null, not on `status`, so the
   * lock survives the gap between "status set" and "reconciliation
   * committed" (adversarial review, 2026-09-05, round 6).
   */
  reconciledAt: IsoDateTime.nullable(),
  status: CrawlRunStatus,
  /**
   * True only if this run's discovery walked the entire listing space for
   * its source, not an incremental slice (§10.1 distinguishes incremental
   * discovery, a rolling overlap window that may stop early, from periodic
   * complete reconciliation). Set once at the run's start, when its own
   * scope is decided — src/db/reconcile-source-listings.ts's
   * closeMissingListings reads this persisted value rather than trusting a
   * caller-supplied claim, so mass closure can never be triggered by
   * mistaken caller state alone.
   */
  fullCoverage: z.boolean(),
  discoveredCount: z.int().nonnegative(),
  /** Per-partition breakdown of discoveredCount (§26: "VIP and standard sections are measured separately"). vipCount + standardCount should equal discoveredCount for a source with that partition structure. */
  vipCount: z.int().nonnegative(),
  standardCount: z.int().nonnegative(),
  newCount: z.int().nonnegative(),
  changedCount: z.int().nonnegative(),
  unchangedCount: z.int().nonnegative(),
  missingCount: z.int().nonnegative(),
  expiredCount: z.int().nonnegative(),
  reopenedCount: z.int().nonnegative(),
  quarantinedCount: z.int().nonnegative(),
  failedCount: z.int().nonnegative(),
});
export type CrawlRun = z.infer<typeof CrawlRunSchema>;

export const FetchOutcome = z.enum(['success', 'retry', 'failure', 'blocked']);
export type FetchOutcome = z.infer<typeof FetchOutcome>;

/** One HTTP/browser fetch attempt within a run (§21.1, §24.3). */
export const FetchAttemptSchema = z.object({
  id: FetchAttemptId,
  crawlRunId: CrawlRunId,
  resourceId: ResourceId,
  attemptedAt: IsoDateTime,
  statusCode: z.int().nullable(),
  durationMs: z.int().nonnegative().nullable(),
  outcome: FetchOutcome,
  errorKind: z.string().nullable(),
});
export type FetchAttempt = z.infer<typeof FetchAttemptSchema>;
