import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { CrawlRunStatus, FetchOutcome } from '../domain/run.js';
import type { ResourceRole, ResourceStatus } from '../domain/resource.js';
import {
  crawlRuns,
  type CrawlRunRow,
  fetchAttempts,
  type FetchAttemptRow,
  resources,
  type ResourceRow,
} from './schema/index.js';
import type { DatabaseOrTransaction } from './types.js';

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

export async function startCrawlRun(
  db: DatabaseOrTransaction,
  input: { sourceId: string; startedAt: string },
): Promise<CrawlRunRow> {
  const [row] = await db
    .insert(crawlRuns)
    .values({
      id: randomUUID(),
      sourceId: input.sourceId,
      startedAt: input.startedAt,
      status: 'running',
    })
    .returning();
  if (!row) throw new Error('startCrawlRun: insert returned no row');
  return row;
}

export interface CrawlRunCounts {
  discoveredCount: number;
  newCount: number;
  changedCount: number;
  unchangedCount: number;
  missingCount: number;
  expiredCount: number;
  reopenedCount: number;
  quarantinedCount: number;
  failedCount: number;
}

export async function finishCrawlRun(
  db: DatabaseOrTransaction,
  crawlRunId: string,
  input: { finishedAt: string; status: CrawlRunStatus; counts: CrawlRunCounts },
): Promise<CrawlRunRow> {
  const [row] = await db
    .update(crawlRuns)
    .set({ finishedAt: input.finishedAt, status: input.status, ...input.counts })
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
