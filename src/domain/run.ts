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
  status: CrawlRunStatus,
  discoveredCount: z.int().nonnegative(),
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
