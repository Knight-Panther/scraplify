import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { db } from './client.js';
import {
  crawlCursors,
  type CrawlRunRow,
  crawlRuns,
  fetchAttempts,
  type NewCrawlRunRow,
  type NewSourceListingRow,
  parserIncidents,
  resources,
  sourceListingRevisions,
  type SourceListingRow,
  sourceListings,
  sourcePolicies,
  sources,
} from './schema/index.js';

/** A throwaway `sources` row for one test, with a random slug so parallel test runs never collide. */
export async function createTestSource(): Promise<string> {
  const id = randomUUID();
  await db.insert(sources).values({
    id,
    slug: `test-source-${id}`,
    displayName: 'Test source',
    baseUrl: 'https://example.invalid/',
  });
  return id;
}

/** A throwaway `resources` row (e.g. to satisfy a revision's provenanceResourceId FK). */
export async function createTestResource(sourceId: string): Promise<string> {
  const id = randomUUID();
  await db.insert(resources).values({
    id,
    sourceId,
    role: 'OPPORTUNITY',
    originalUrl: `/listing/${id}`,
    canonicalUrl: `https://example.invalid/listing/${id}`,
    finalUrl: null,
    status: 'fetched',
    fetchedAt: new Date().toISOString(),
    contentHash: 'c'.repeat(64),
    byteSize: 1024,
    mimeType: 'text/html',
  });
  return id;
}

/**
 * A throwaway `source_listings` row for one test, inserted directly (not via
 * writeSourceListingRevision) so reconciliation tests can set up a listing's
 * status/lastSeenAt/missingStreak/sourceDeadlineAt exactly, without coupling
 * to that function's own behavior.
 */
export async function createTestSourceListing(
  sourceId: string,
  overrides: Partial<NewSourceListingRow> = {},
): Promise<SourceListingRow> {
  const id = randomUUID();
  const [row] = await db
    .insert(sourceListings)
    .values({
      id,
      sourceId,
      sourceRecordId: id,
      canonicalSourceUrl: `https://example.invalid/listing/${id}`,
      currentRevisionId: null,
      firstSeenAt: '2026-01-01T00:00:00Z',
      lastSeenAt: '2026-01-01T00:00:00Z',
      status: 'active',
      missingStreak: 0,
      sourcePublishedAt: null,
      sourceDeadlineAt: null,
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('createTestSourceListing: insert returned no row');
  return row;
}

/**
 * A throwaway `crawl_runs` row for one test, inserted directly so
 * reconciliation tests can set up a run's status/fullCoverage/startedAt
 * exactly, without running an actual crawl.
 */
export async function createTestCrawlRun(
  sourceId: string,
  overrides: Partial<NewCrawlRunRow> = {},
): Promise<CrawlRunRow> {
  const id = randomUUID();
  const [row] = await db
    .insert(crawlRuns)
    .values({
      id,
      sourceId,
      startedAt: '2026-01-05T00:00:00Z',
      finishedAt: '2026-01-05T01:00:00Z',
      // Settled by default (not the DB's own null default) — the partial
      // unique index allows only one row per source with reconciledAt
      // still null, so a test creating several runs for the same source
      // (e.g. to compare across them) would collide on the second insert
      // otherwise.
      reconciledAt: '2026-01-05T01:00:00Z',
      status: 'completed',
      fullCoverage: true,
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('createTestCrawlRun: insert returned no row');
  return row;
}

/**
 * Deletes everything this test may have written under one source, in FK
 * dependency order — no ON DELETE CASCADE is declared on any of these
 * tables (deliberately: see src/db/schema/source-listings.ts), so cleanup
 * has to unwind the same references the write path builds up.
 */
export async function cleanupTestSource(sourceId: string): Promise<void> {
  const listingRows = await db
    .select({ id: sourceListings.id })
    .from(sourceListings)
    .where(eq(sourceListings.sourceId, sourceId));
  const listingIds = listingRows.map((row) => row.id);

  const runRows = await db
    .select({ id: crawlRuns.id })
    .from(crawlRuns)
    .where(eq(crawlRuns.sourceId, sourceId));
  const runIds = runRows.map((row) => row.id);

  // parser_incidents references both sources and crawl_runs — must go
  // before either is deleted below, regardless of whether this source ever
  // had any runs (its own FK to sources.id is independent of crawlRunId).
  await db.delete(parserIncidents).where(eq(parserIncidents.sourceId, sourceId));

  if (runIds.length > 0) {
    await db.delete(fetchAttempts).where(inArray(fetchAttempts.crawlRunId, runIds));
  }

  if (listingIds.length > 0) {
    // Null out currentRevisionId first — the ownership FK forbids deleting
    // a revision a listing still points at.
    await db
      .update(sourceListings)
      .set({ currentRevisionId: null })
      .where(inArray(sourceListings.id, listingIds));
    await db
      .delete(sourceListingRevisions)
      .where(inArray(sourceListingRevisions.sourceListingId, listingIds));
  }

  await db.delete(crawlRuns).where(eq(crawlRuns.sourceId, sourceId));
  await db.delete(sourceListings).where(eq(sourceListings.sourceId, sourceId));
  await db.delete(resources).where(eq(resources.sourceId, sourceId));
  // Only ever populated for a fixed, real source id (e.g. jobsGeSource.id in
  // crawl.test.ts) — a throwaway createTestSource() id never has one, so
  // this delete is a routine no-op for every other test using this helper.
  await db.delete(sourcePolicies).where(eq(sourcePolicies.sourceId, sourceId));
  // crawl_cursors.source_id FKs into sources.id — only ever populated for
  // an adapter that uses cursor-based resumption (hr.ge), a no-op delete
  // for every other test using this helper.
  await db.delete(crawlCursors).where(eq(crawlCursors.sourceId, sourceId));
  await db.delete(sources).where(eq(sources.id, sourceId));
}

/**
 * Everything the database records about one source, ordered deterministically
 * so two snapshots can be compared directly with `toEqual`.
 *
 * This is the concrete form of Phase 1C's "a failing source cannot affect the
 * other source's state": the claim is only as strong as the set of tables it
 * covers, so this deliberately captures every table that carries per-source
 * state rather than only the listing rows a reader might first think of.
 * `fetch_attempts` is keyed by crawl run rather than by source, so it is
 * gathered through this source's runs; `source_listing_revisions` likewise
 * through its listings.
 *
 * Not included: `sources` and `source_policies`. Both are seeded configuration
 * rather than crawl-produced state, and a crawl for another source has no code
 * path that writes them — except the seeding collision that broke 20 hr-ge
 * tests on 2026-09-06 (docs/STATUS.md), which is a test-isolation concern
 * covered where the adapters mock their own policy modules.
 */
export interface SourceStateSnapshot {
  listings: SourceListingRow[];
  revisions: Array<typeof sourceListingRevisions.$inferSelect>;
  runs: CrawlRunRow[];
  cursors: Array<typeof crawlCursors.$inferSelect>;
  resources: Array<typeof resources.$inferSelect>;
  incidents: Array<typeof parserIncidents.$inferSelect>;
  fetchAttempts: Array<typeof fetchAttempts.$inferSelect>;
}

export async function snapshotSourceState(sourceId: string): Promise<SourceStateSnapshot> {
  const listings = await db
    .select()
    .from(sourceListings)
    .where(eq(sourceListings.sourceId, sourceId))
    .orderBy(sourceListings.id);
  const listingIds = listings.map((row) => row.id);

  const runs = await db
    .select()
    .from(crawlRuns)
    .where(eq(crawlRuns.sourceId, sourceId))
    .orderBy(crawlRuns.id);
  const runIds = runs.map((row) => row.id);

  return {
    listings,
    revisions:
      listingIds.length === 0
        ? []
        : await db
            .select()
            .from(sourceListingRevisions)
            .where(inArray(sourceListingRevisions.sourceListingId, listingIds))
            .orderBy(sourceListingRevisions.id),
    runs,
    cursors: await db
      .select()
      .from(crawlCursors)
      .where(eq(crawlCursors.sourceId, sourceId))
      .orderBy(crawlCursors.sourceId),
    resources: await db
      .select()
      .from(resources)
      .where(eq(resources.sourceId, sourceId))
      .orderBy(resources.id),
    incidents: await db
      .select()
      .from(parserIncidents)
      .where(eq(parserIncidents.sourceId, sourceId))
      .orderBy(parserIncidents.id),
    fetchAttempts:
      runIds.length === 0
        ? []
        : await db
            .select()
            .from(fetchAttempts)
            .where(inArray(fetchAttempts.crawlRunId, runIds))
            .orderBy(fetchAttempts.id),
  };
}
