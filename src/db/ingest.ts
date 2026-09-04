import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { ParserIncidentKind, ParserIncidentSeverity } from '../domain/incident.js';
import type { ResourceRole, ResourceStatus } from '../domain/resource.js';
import type { CrawlRunStatus, FetchOutcome } from '../domain/run.js';
import {
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
    .where(and(eq(crawlRuns.sourceId, sourceId), eq(crawlRuns.status, 'completed')))
    .orderBy(desc(crawlRuns.startedAt))
    .limit(1);
  return row ?? null;
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
