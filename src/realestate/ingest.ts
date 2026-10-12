import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { realEstateListings, realEstatePriceChanges } from '../db/schema/index.js';
import type { DatabaseOrTransaction } from '../db/types.js';

/**
 * One listing as a source's results page shows it, already normalised by the
 * source's parser. Carries no phone number, name or user id: the parser is
 * where those are dropped.
 */
export interface ListingCard {
  sourceListingKey: string;
  canonicalUrl: string;
  dealType: 'sale' | 'rent';
  propertyType: 'flat' | 'house' | 'cottage';
  rooms: number | null;
  bedrooms: number | null;
  areaM2: number | null;
  floor: number | null;
  totalFloors: number | null;
  priceGel: number | null;
  priceUsd: number | null;
  pricePerM2Usd: number | null;
  currencyPosted: 'gel' | 'usd' | null;
  cityRef: number | null;
  cityName: string | null;
  districtRef: number | null;
  districtName: string | null;
  subdistrictRef: number | null;
  subdistrictName: string | null;
  streetName: string | null;
  streetNumber: string | null;
  posterType: 'owner' | 'agent' | 'developer' | 'unknown';
  promoted: boolean;
  description: string | null;
  similarityGroup: string | null;
  /** ISO instants, already converted from the source's local time. */
  sourceUpdatedAt: string;
  sourceCreatedAt: string | null;
  expectedEndAt: string | null;
}

/**
 * - `new`: first sighting.
 * - `changed`: a field that matters differs (a price change is also recorded).
 * - `bumped`: only the source's own order time moved forward (a renewal).
 * - `unchanged`: identical; nothing but "last seen" is written.
 * - `reopened`: it had been marked gone and the source shows it again.
 */
export type UpsertOutcome = 'new' | 'changed' | 'bumped' | 'unchanged' | 'reopened';

export interface UpsertListingInput {
  sourceId: string;
  card: ListingCard;
  /** When this run read the page the card came from. */
  seenAt: string;
}

function money(value: number | null): string | null {
  return value === null ? null : value.toFixed(2);
}

function sameAmount(stored: string | null, incoming: number | null): boolean {
  if (stored === null || incoming === null) return stored === null && incoming === null;
  return Number(stored) === Number(incoming.toFixed(2));
}

/**
 * What "the listing changed" means. Promotion and the source's own
 * timestamps are left out on purpose: promoted listings are re-ordered many
 * times a day, and counting that as a change would rewrite the same rows on
 * every run.
 */
export function listingContentHash(card: ListingCard): string {
  const meaningful = [
    card.dealType,
    card.propertyType,
    card.rooms,
    card.bedrooms,
    money(card.areaM2),
    card.floor,
    card.totalFloors,
    money(card.priceGel),
    money(card.priceUsd),
    money(card.pricePerM2Usd),
    card.currencyPosted,
    card.cityRef,
    card.cityName,
    card.districtRef,
    card.districtName,
    card.subdistrictRef,
    card.subdistrictName,
    card.streetName,
    card.streetNumber,
    card.posterType,
    card.description,
    card.similarityGroup,
  ];
  return createHash('sha256').update(JSON.stringify(meaningful)).digest('hex');
}

function columnsOf(card: ListingCard, contentHash: string) {
  return {
    canonicalUrl: card.canonicalUrl,
    dealType: card.dealType,
    propertyType: card.propertyType,
    rooms: card.rooms,
    bedrooms: card.bedrooms,
    areaM2: money(card.areaM2),
    floor: card.floor,
    totalFloors: card.totalFloors,
    priceGel: money(card.priceGel),
    priceUsd: money(card.priceUsd),
    pricePerM2Usd: money(card.pricePerM2Usd),
    currencyPosted: card.currencyPosted,
    cityRef: card.cityRef,
    cityName: card.cityName,
    districtRef: card.districtRef,
    districtName: card.districtName,
    subdistrictRef: card.subdistrictRef,
    subdistrictName: card.subdistrictName,
    streetName: card.streetName,
    streetNumber: card.streetNumber,
    posterType: card.posterType,
    promoted: card.promoted,
    description: card.description,
    similarityGroup: card.similarityGroup,
    contentHash,
  };
}

/**
 * Writes one sighting of a listing. An identical listing costs one small
 * update ("last seen"); only a real difference rewrites the row.
 *
 * One crawl process per source holds that source's lock, so two writers never
 * race on the same listing.
 */
export async function upsertListing(
  db: DatabaseOrTransaction,
  input: UpsertListingInput,
): Promise<UpsertOutcome> {
  const { sourceId, card, seenAt } = input;
  const contentHash = listingContentHash(card);

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({
        id: realEstateListings.id,
        status: realEstateListings.status,
        contentHash: realEstateListings.contentHash,
        priceGel: realEstateListings.priceGel,
        priceUsd: realEstateListings.priceUsd,
        sourceUpdatedAt: realEstateListings.sourceUpdatedAt,
        expectedEndAt: realEstateListings.expectedEndAt,
      })
      .from(realEstateListings)
      .where(
        and(
          eq(realEstateListings.sourceId, sourceId),
          eq(realEstateListings.sourceListingKey, card.sourceListingKey),
        ),
      )
      .for('update');

    if (existing === undefined) {
      await tx.insert(realEstateListings).values({
        sourceId,
        sourceListingKey: card.sourceListingKey,
        ...columnsOf(card, contentHash),
        sourceUpdatedAt: card.sourceUpdatedAt,
        sourceCreatedAt: card.sourceCreatedAt,
        expectedEndAt: card.expectedEndAt,
        firstSeenAt: seenAt,
        lastSeenAt: seenAt,
      });
      return 'new';
    }

    const reopened = existing.status === 'gone';
    const contentChanged = existing.contentHash !== contentHash;
    const bumped = Date.parse(card.sourceUpdatedAt) > Date.parse(existing.sourceUpdatedAt);

    if (!reopened && !contentChanged && !bumped) {
      await tx
        .update(realEstateListings)
        .set({ lastSeenAt: seenAt, promoted: card.promoted })
        .where(eq(realEstateListings.id, existing.id));
      return 'unchanged';
    }

    if (
      contentChanged &&
      !(
        sameAmount(existing.priceGel, card.priceGel) && sameAmount(existing.priceUsd, card.priceUsd)
      )
    ) {
      await tx.insert(realEstatePriceChanges).values({
        listingId: existing.id,
        observedAt: seenAt,
        oldPriceGel: existing.priceGel,
        newPriceGel: money(card.priceGel),
        oldPriceUsd: existing.priceUsd,
        newPriceUsd: money(card.priceUsd),
      });
    }

    await tx
      .update(realEstateListings)
      .set({
        ...columnsOf(card, contentHash),
        // A page read out of order must not move the listing back in time.
        sourceUpdatedAt: bumped ? card.sourceUpdatedAt : existing.sourceUpdatedAt,
        expectedEndAt: bumped ? card.expectedEndAt : existing.expectedEndAt,
        ...(card.sourceCreatedAt === null ? {} : { sourceCreatedAt: card.sourceCreatedAt }),
        lastSeenAt: seenAt,
        status: 'active',
        goneAt: null,
        goneReason: null,
      })
      .where(eq(realEstateListings.id, existing.id));

    if (reopened) return 'reopened';
    return contentChanged ? 'changed' : 'bumped';
  });
}
