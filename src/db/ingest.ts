import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import type { ParserIncidentKind, ParserIncidentSeverity } from '../domain/incident.js';
import type { ResourceRole, ResourceStatus } from '../domain/resource.js';
import type { CrawlRunStatus, FetchOutcome } from '../domain/run.js';
import {
  crawlCursors,
  crawlRuns,
  type CrawlRunRow,
  fetchAttempts,
  type FetchAttemptRow,
  type ParserIncidentRow,
  parserIncidents,
  resources,
  type ResourceRow,
} from './schema/index.js';
import type { DatabaseOrTransaction } from './types.js';

/** At most one 'running' crawl per source — see the partial unique index on crawl_runs (src/db/schema/runs.ts). */
export class CrawlAlreadyRunningError extends Error {
  readonly code = 'ERR_CRAWL_ALREADY_RUNNING';
  readonly sourceId: string;

  constructor(sourceId: string) {
    super(`A crawl is already running for source ${sourceId}`);
    this.name = 'CrawlAlreadyRunningError';
    this.sourceId = sourceId;
  }
}

const POSTGRES_UNIQUE_VIOLATION = '23505';
const RUNNING_CRAWL_CONSTRAINT_NAME = 'crawl_runs_one_unsettled_per_source_idx';

/**
 * True only for the specific unique-violation this constraint raises — not
 * unique violations in general — so an unrelated conflict (a bug, a
 * genuinely different constraint) still surfaces as itself rather than
 * being misreported as "already running." Checks both `err` and `err.cause`
 * since drizzle's node-postgres driver wraps the raw `pg` DatabaseError
 * (which carries `.code`/`.constraint`) inside a `DrizzleQueryError`,
 * rather than throwing it directly — confirmed empirically, not assumed.
 */
function isRunningCrawlConflict(err: unknown): boolean {
  const matches = (candidate: unknown): boolean => {
    if (typeof candidate !== 'object' || candidate === null) return false;
    const record = candidate as Record<string, unknown>;
    return (
      record.code === POSTGRES_UNIQUE_VIOLATION &&
      record.constraint === RUNNING_CRAWL_CONSTRAINT_NAME
    );
  };
  if (matches(err)) return true;
  if (err instanceof Error && err.cause !== undefined) return matches(err.cause);
  return false;
}

export interface ResourceObservation {
  sourceId: string;
  role: ResourceRole;
  originalUrl: string;
  canonicalUrl: string;
  finalUrl: string | null;
  status: ResourceStatus;
  fetchedAt: string | null;
  contentHash: string | null;
  byteSize: number | null;
  mimeType: string | null;
}

/**
 * Upserts a resource by its identity (§11: source + canonical URL + role,
 * `resources_canonical_url_role_idx`). Unlike a source listing, a resource
 * has no revision history of its own — each fetch overwrites what's known
 * about the same URL+role in place, which is exactly why the overwrite is
 * conditional: two overlapping fetches of the same URL (a retry racing a
 * fresh crawl) can complete out of order, and an older one landing last
 * must not stomp a newer one's data. Only applied when the incoming
 * observation actually carries a fetch (fetchedAt not null) that's at
 * least as new as what's already stored — a null-fetchedAt observation
 * (e.g. a pre-fetch "pending" placeholder) never overwrites an existing
 * row on conflict, though it still creates one when none exists yet.
 */
export async function upsertResource(
  db: DatabaseOrTransaction,
  observation: ResourceObservation,
): Promise<ResourceRow> {
  const [row] = await db
    .insert(resources)
    .values({ id: randomUUID(), ...observation })
    .onConflictDoUpdate({
      target: [resources.sourceId, resources.canonicalUrl, resources.role],
      set: {
        originalUrl: observation.originalUrl,
        finalUrl: observation.finalUrl,
        status: observation.status,
        fetchedAt: observation.fetchedAt,
        contentHash: observation.contentHash,
        byteSize: observation.byteSize,
        mimeType: observation.mimeType,
      },
      setWhere:
        observation.fetchedAt === null
          ? sql`false`
          : sql`${resources.fetchedAt} is null or ${observation.fetchedAt} >= ${resources.fetchedAt}`,
    })
    .returning();
  if (row) return row;

  // A skipped conflict update (setWhere false, i.e. this observation was
  // stale) returns no row at all — RETURNING only reports rows an INSERT
  // or an applied UPDATE actually touched — so the untouched existing row
  // has to be fetched separately rather than treated as a failure.
  const [existing] = await db
    .select()
    .from(resources)
    .where(
      and(
        eq(resources.sourceId, observation.sourceId),
        eq(resources.canonicalUrl, observation.canonicalUrl),
        eq(resources.role, observation.role),
      ),
    );
  if (!existing) throw new Error('upsertResource: no row found after insert-or-skip');
  return existing;
}

/**
 * Throws CrawlAlreadyRunningError instead of inserting when another
 * 'running' crawl already exists for this source (adversarial review,
 * 2026-09-05: without this, two overlapping runs could each independently
 * reconcile the same absent listing against their own later startedAt,
 * advancing missingStreak off of overlapping observations rather than
 * genuinely consecutive ones). Callers should treat this as "skip this
 * invocation," not a run failure — no crawl_runs row was created, so
 * there's nothing to mark failed.
 */
export async function startCrawlRun(
  db: DatabaseOrTransaction,
  input: { sourceId: string; startedAt: string; fullCoverage: boolean },
): Promise<CrawlRunRow> {
  try {
    const [row] = await db
      .insert(crawlRuns)
      .values({
        id: randomUUID(),
        sourceId: input.sourceId,
        startedAt: input.startedAt,
        status: 'running',
        fullCoverage: input.fullCoverage,
      })
      .returning();
    if (!row) throw new Error('startCrawlRun: insert returned no row');
    return row;
  } catch (err) {
    if (isRunningCrawlConflict(err)) {
      throw new CrawlAlreadyRunningError(input.sourceId);
    }
    throw err;
  }
}

/**
 * The most recent 'completed' crawl run for a source, or null if none
 * exists yet — a baseline for detecting a relative count collapse (concept
 * §21.3: "sudden listing-count collapse"). A single page returning the same
 * content at both the walk's normal stride and its distant confirmation
 * probe (reconcile-source-listings.ts's neighbor, src/adapters/jobs-ge/crawl.ts)
 * still can't rule out a systemic pagination/caching regression that serves
 * identical content at EVERY page number queried, including the probe —
 * only comparing against a source's own history can catch that (adversarial
 * review, 2026-09-05, round 4). The current run is excluded implicitly:
 * its own status is still 'running' at the point this is called.
 */
export async function getLastCompletedCrawlRun(
  db: DatabaseOrTransaction,
  sourceId: string,
): Promise<CrawlRunRow | null> {
  const [row] = await db
    .select()
    .from(crawlRuns)
    .where(
      and(
        eq(crawlRuns.sourceId, sourceId),
        eq(crawlRuns.status, 'completed'),
        eq(crawlRuns.fullCoverage, true),
      ),
    )
    .orderBy(desc(crawlRuns.startedAt))
    .limit(1);
  return row ?? null;
}

/**
 * Reads an adapter's cross-run resumption cursor (see
 * src/db/schema/crawl-cursors.ts's own comment for why this is a
 * dedicated table rather than a crawl_runs column) — null if no row
 * exists yet (a source that has never used cursor-based resumption, or
 * hasn't run yet) or if the row's own value is null (the last sweep
 * completed fully). Callers needing single-writer safety should call this
 * AFTER acquiring their own exclusivity lock (e.g. after startCrawlRun
 * succeeds), not before — reading a shared cross-run value before holding
 * any lock risks a handoff race with another invocation that starts and
 * settles in between (adversarial review, 2026-09-05, round 6).
 */
export async function getCrawlCursor(
  db: DatabaseOrTransaction,
  sourceId: string,
): Promise<string | null> {
  const [row] = await db.select().from(crawlCursors).where(eq(crawlCursors.sourceId, sourceId));
  return row?.nextSourceRecordId ?? null;
}

/**
 * Write a known next detail item, or clear after a healthy full sweep.
 * Incomplete discovery alone must not clear prior progress. This update
 * preserves the independently persisted source cooldown.
 */
export async function setCrawlCursor(
  db: DatabaseOrTransaction,
  sourceId: string,
  nextSourceRecordId: string | null,
  updatedAt: string,
): Promise<void> {
  await db
    .insert(crawlCursors)
    .values({ sourceId, nextSourceRecordId, updatedAt })
    .onConflictDoUpdate({
      target: crawlCursors.sourceId,
      set: { nextSourceRecordId, updatedAt },
    });
}

/**
 * Reads the discovery walk's own resumption point — the index page a
 * previous, interrupted walk stopped short of. Null means "start at page 1."
 * Same locking requirement as `getCrawlCursor`.
 */
export async function getCrawlDiscoveryPage(
  db: DatabaseOrTransaction,
  sourceId: string,
): Promise<number | null> {
  const [row] = await db
    .select({ nextDiscoveryPage: crawlCursors.nextDiscoveryPage })
    .from(crawlCursors)
    .where(eq(crawlCursors.sourceId, sourceId));
  return row?.nextDiscoveryPage ?? null;
}

/**
 * Write the first index page an interrupted walk did not cover, or clear
 * after a walk reaches the source's terminator. Like `setCrawlCursor`, this
 * preserves the independently persisted cooldown and detail cursor, and
 * callers must not call it at all for outcomes that carry no progress
 * information — not calling it is what preserves an earlier walk's real
 * position.
 */
export async function setCrawlDiscoveryPage(
  db: DatabaseOrTransaction,
  sourceId: string,
  nextDiscoveryPage: number | null,
  updatedAt: string,
): Promise<void> {
  await db
    .insert(crawlCursors)
    .values({ sourceId, nextDiscoveryPage, updatedAt })
    .onConflictDoUpdate({
      target: crawlCursors.sourceId,
      set: { nextDiscoveryPage, updatedAt },
    });
}

/**
 * A walk that resumed at a saved page saw only a suffix of the index, so its
 * run row must not claim full coverage — `closeMissingListings` and
 * `getMaxDiscoveredCountForSource` both read that flag as evidence about the
 * whole corpus. The run's status guard alone would already block closure
 * (a resumed walk can never be 'completed'), but leaving a true flag on a
 * partial sweep would be a false statement in the data for any future reader.
 */
export async function markCrawlRunPartialCoverage(
  db: DatabaseOrTransaction,
  crawlRunId: string,
): Promise<void> {
  await db.update(crawlRuns).set({ fullCoverage: false }).where(eq(crawlRuns.id, crawlRunId));
}

/** Read under the source's crawl lock, before making any requests. */
export async function getSourceBackoffUntil(
  db: DatabaseOrTransaction,
  sourceId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ nextFetchAt: crawlCursors.nextFetchAt })
    .from(crawlCursors)
    .where(eq(crawlCursors.sourceId, sourceId));
  return row?.nextFetchAt ?? null;
}

/** A cooldown must never overwrite the detail cursor or shorten an existing cooldown. */
export async function extendSourceBackoff(
  db: DatabaseOrTransaction,
  sourceId: string,
  nextFetchAt: string,
  updatedAt: string,
): Promise<void> {
  await db
    .insert(crawlCursors)
    .values({ sourceId, nextFetchAt, updatedAt })
    .onConflictDoUpdate({
      target: crawlCursors.sourceId,
      set: {
        nextFetchAt: sql`greatest(${crawlCursors.nextFetchAt}, ${nextFetchAt}::timestamptz)`,
        updatedAt,
      },
    });
}

/**
 * The largest `discoveredCount` any full-coverage run for this source has
 * ever persisted, regardless of that run's own status — a fallback baseline
 * for when `getLastCompletedCrawlRun` returns null (adversarial review,
 * 2026-09-05, round 10). `null` there means "no run has ever earned
 * 'completed' status," NOT "no history exists": a source can have prior
 * `partial` runs (e.g. discovery succeeded fully but a detail-fetch storm
 * made the run partial) that already observed the real corpus size. Without
 * this, a severely truncated crawl — a pagination/caching fault serving one
 * small page everywhere, satisfying `complete` and the fixed floor — would
 * be certified as this source's first 'completed' run, becoming the
 * baseline for every subsequent relative-coverage check and letting a few
 * repetitions mass-close real listings, exactly the failure mode the
 * relative-coverage guard (round 4) exists to prevent.
 *
 * `fullCoverage: true` only: `closeMissingListings` itself only ever trusts
 * full-coverage runs, so a baseline drawn from a future §10.1 incremental
 * slice would compare against a different, smaller kind of walk. No status
 * filter otherwise — a `partial` or even `failed` run's `discoveredCount` is
 * a genuinely observed set of real IDs (0 if it died before discovery even
 * ran, which is harmless here) and is a valid lower bound on corpus size
 * regardless of why that run didn't fully succeed.
 *
 * Uses `orderBy` + `limit(1)` rather than `max()`: avoids drizzle/pg
 * returning an aggregate as a string, matching this file's own
 * getLastCompletedCrawlRun just above.
 */
export async function getMaxDiscoveredCountForSource(
  db: DatabaseOrTransaction,
  sourceId: string,
  excludeCrawlRunId: string,
): Promise<number> {
  const [row] = await db
    .select({ discoveredCount: crawlRuns.discoveredCount })
    .from(crawlRuns)
    .where(
      and(
        eq(crawlRuns.sourceId, sourceId),
        eq(crawlRuns.fullCoverage, true),
        ne(crawlRuns.id, excludeCrawlRunId),
      ),
    )
    .orderBy(desc(crawlRuns.discoveredCount))
    .limit(1);
  return row?.discoveredCount ?? 0;
}

export interface CrawlRunCounts {
  discoveredCount: number;
  vipCount: number;
  standardCount: number;
  newCount: number;
  changedCount: number;
  unchangedCount: number;
  missingCount: number;
  expiredCount: number;
  reopenedCount: number;
  quarantinedCount: number;
  failedCount: number;
}

/**
 * `reconciledAt` is deliberately omitted, not just left undefined-but-typed:
 * a caller finalizing terminal `status` before reconciliation has run
 * (so closeMissingListings can read that persisted status — see
 * reconcile-source-listings.ts) must leave reconciledAt untouched, keeping
 * the row's exclusivity lock held (src/db/schema/runs.ts) until a LATER
 * call explicitly sets it once reconciliation has actually committed.
 */
export async function finishCrawlRun(
  db: DatabaseOrTransaction,
  crawlRunId: string,
  input: {
    finishedAt: string;
    status: CrawlRunStatus;
    counts: CrawlRunCounts;
    reconciledAt?: string;
  },
): Promise<CrawlRunRow> {
  const [row] = await db
    .update(crawlRuns)
    .set({
      finishedAt: input.finishedAt,
      status: input.status,
      ...input.counts,
      ...(input.reconciledAt !== undefined ? { reconciledAt: input.reconciledAt } : {}),
    })
    .where(eq(crawlRuns.id, crawlRunId))
    .returning();
  if (!row) throw new Error(`finishCrawlRun: no crawl run found with id ${crawlRunId}`);
  return row;
}

/**
 * Marks a run 'failed' ONLY if it hasn't already settled — unlike
 * finishCrawlRun (an unconditional update), this is specifically for the
 * crawl orchestrator's outer catch block, which cannot tell an ordinary
 * mid-run failure apart from an ambiguous-COMMIT failure: PostgreSQL can
 * actually commit the settlement transaction (expiry, closure, counts,
 * reconciledAt all persisted) while the client never receives the COMMIT
 * acknowledgment, so `db.transaction(...)` still throws on the client side
 * (adversarial review, 2026-09-05, round 10). An unconditional overwrite
 * there would relabel an already-genuinely-settled, already-reconciled run
 * 'failed' with stale (pre-settlement) counts — recreating, in miniature,
 * the exact "row says X, listings say Y" contradiction round 9's atomic
 * settlement transaction was built to eliminate. This is a PRE-EXISTING gap
 * from round 6's two-phase finishCrawlRun pattern (round 9 collapsed four
 * ambiguous-commit windows into this one, smaller one, not introduced it).
 *
 * `WHERE reconciled_at IS NULL` is the only correct guard: reconciledAt for
 * a given run id is only ever written by that run's own settlement or by
 * this same function, so a zero-row result here means the settlement
 * transaction's COMMIT genuinely landed — the row is already authoritative
 * and reconciled, and is deliberately left untouched rather than
 * "resurrected" into a returned success (that would flip the CLI's exit
 * code for a connection failure that genuinely occurred, and could
 * overwrite a row an operator already settled by hand via the documented
 * recovery query — docs/STATUS.md).
 *
 * A separate function rather than reusing finishCrawlRun with a WHERE
 * clause: finishCrawlRun throws when its update returns no row, which here
 * would destroy the original mid-run error and report the wrong cause.
 */
export async function failUnsettledCrawlRun(
  db: DatabaseOrTransaction,
  crawlRunId: string,
  input: { finishedAt: string; counts: CrawlRunCounts; reconciledAt: string },
): Promise<CrawlRunRow | null> {
  const [row] = await db
    .update(crawlRuns)
    .set({
      finishedAt: input.finishedAt,
      status: 'failed',
      ...input.counts,
      reconciledAt: input.reconciledAt,
    })
    .where(and(eq(crawlRuns.id, crawlRunId), isNull(crawlRuns.reconciledAt)))
    .returning();
  return row ?? null;
}

export interface FetchAttemptObservation {
  crawlRunId: string;
  resourceId: string;
  attemptedAt: string;
  statusCode: number | null;
  durationMs: number | null;
  outcome: FetchOutcome;
  errorKind: string | null;
}

export async function recordFetchAttempt(
  db: DatabaseOrTransaction,
  input: FetchAttemptObservation,
): Promise<FetchAttemptRow> {
  const [row] = await db
    .insert(fetchAttempts)
    .values({ id: randomUUID(), ...input })
    .returning();
  if (!row) throw new Error('recordFetchAttempt: insert returned no row');
  return row;
}

export interface ParserIncidentObservation {
  sourceId: string;
  crawlRunId: string | null;
  detectedAt: string;
  kind: ParserIncidentKind;
  severity: ParserIncidentSeverity;
  evidence: Record<string, unknown>;
}

/** concept §21.3/§22, and §26's acceptance criterion "parse failures are typed and quarantined" — the durable record a human or later supervised-repair process consults. */
export async function recordParserIncident(
  db: DatabaseOrTransaction,
  input: ParserIncidentObservation,
): Promise<ParserIncidentRow> {
  const [row] = await db
    .insert(parserIncidents)
    .values({
      id: randomUUID(),
      sourceId: input.sourceId,
      crawlRunId: input.crawlRunId,
      detectedAt: input.detectedAt,
      kind: input.kind,
      severity: input.severity,
      evidence: input.evidence,
      resolved: false,
      resolvedAt: null,
    })
    .returning();
  if (!row) throw new Error('recordParserIncident: insert returned no row');
  return row;
}
