import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { db } from './client.js';
import {
  crawlRuns,
  fetchAttempts,
  resources,
  sourceListingRevisions,
  sourceListings,
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
  await db.delete(sources).where(eq(sources.id, sourceId));
}
