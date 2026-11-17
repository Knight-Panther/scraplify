import { and, asc, eq, gt, isNotNull } from 'drizzle-orm';
import { realEstateListings } from '../db/schema/index.js';
import type { DatabaseOrTransaction } from '../db/types.js';
import { extractContacts } from './contacts.js';
import { type PosterSighting, recordPosterSightings } from './posters.js';

/** Listings read and written per transaction. */
const BATCH = 1_000;

export interface DescriptionBackfillResult {
  listingsRead: number;
  /** Listings whose description names at least one phone or email. */
  listingsWithContacts: number;
  contactsWritten: number;
  listingContactsWritten: number;
}

/**
 * Fills the private directory with the phones and emails typed into the
 * descriptions of a source's live listings (Phase 17B), at once rather than
 * as each listing's row is next read: the description is already stored, so
 * this makes no request. Each link carries the listing's own first and last
 * sightings. Idempotent: a second run writes nothing. The link to an
 * account comes with the nightly poster step, once the listing's row has
 * named its account.
 */
export async function backfillDescriptionContacts(
  db: DatabaseOrTransaction,
  input: { sourceId: string; batchSize?: number },
): Promise<DescriptionBackfillResult> {
  const batchSize = input.batchSize ?? BATCH;
  const result: DescriptionBackfillResult = {
    listingsRead: 0,
    listingsWithContacts: 0,
    contactsWritten: 0,
    listingContactsWritten: 0,
  };
  let after: string | null = null;
  for (;;) {
    const rows = await db
      .select({
        id: realEstateListings.id,
        key: realEstateListings.sourceListingKey,
        description: realEstateListings.description,
        firstSeenAt: realEstateListings.firstSeenAt,
        lastSeenAt: realEstateListings.lastSeenAt,
      })
      .from(realEstateListings)
      .where(
        and(
          eq(realEstateListings.sourceId, input.sourceId),
          isNotNull(realEstateListings.description),
          after === null ? undefined : gt(realEstateListings.id, after),
        ),
      )
      .orderBy(asc(realEstateListings.id))
      .limit(batchSize);
    if (rows.length === 0) break;
    after = rows.at(-1)?.id ?? null;
    result.listingsRead += rows.length;

    const sightings: PosterSighting[] = [];
    for (const row of rows) {
      const found = extractContacts(row.description);
      if (found.length === 0) continue;
      sightings.push({
        sourceListingKey: row.key,
        account: null,
        contacts: found.map((contact) => ({ ...contact, contactName: '', seenIn: 'description' })),
        photos: null,
        firstSeenAt: new Date(row.firstSeenAt).toISOString(),
        lastSeenAt: new Date(row.lastSeenAt).toISOString(),
      });
    }
    result.listingsWithContacts += sightings.length;
    if (sightings.length > 0) {
      const counts = await recordPosterSightings(db, {
        sourceId: input.sourceId,
        seenAt: new Date().toISOString(),
        sightings,
      });
      result.contactsWritten += counts.contactsWritten;
      result.listingContactsWritten += counts.listingContactsWritten;
    }
    if (rows.length < batchSize) break;
  }
  return result;
}
