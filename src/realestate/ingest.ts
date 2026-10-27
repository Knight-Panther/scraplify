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

/** A listing's price as a source states it, in both currencies and the one it was posted in. */
export type ListingPrice = Pick<
  ListingCard,
  'priceGel' | 'priceUsd' | 'pricePerM2Usd' | 'currencyPosted'
>;

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

/** The fields `listingContentHash` reads, which a stored row also has. */
type MeaningfulFields = Omit<
  ListingCard,
  | 'sourceListingKey'
  | 'canonicalUrl'
  | 'promoted'
  | 'sourceUpdatedAt'
  | 'sourceCreatedAt'
  | 'expectedEndAt'
>;

/**
 * The price as the poster set it. The source converts it to the other
 * currency at each day's exchange rate, so the converted price, and a price
 * per m² worked out from it, move without anyone touching the listing: in
 * October 2026 that was 73% of the price changes recorded.
 */
function postedPrice(card: Pick<ListingCard, 'currencyPosted' | 'priceGel' | 'priceUsd'>) {
  if (card.currencyPosted === 'usd') return [card.currencyPosted, money(card.priceUsd)];
  if (card.currencyPosted === 'gel') return [card.currencyPosted, money(card.priceGel)];
  return [null, money(card.priceGel), money(card.priceUsd)];
}

/**
 * What "the listing changed" means. Promotion and the source's own
 * timestamps are left out on purpose: promoted listings are re-ordered many
 * times a day, and counting that as a change would rewrite the same rows on
 * every run. So is the converted price (`postedPrice`).
 */
export function listingContentHash(card: MeaningfulFields): string {
  const meaningful = [
    card.dealType,
    card.propertyType,
    card.rooms,
    card.bedrooms,
    money(card.areaM2),
    card.floor,
    card.totalFloors,
    postedPrice(card),
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

/** Numeric columns come back as text. */
function amountOf(value: string | null): number | null {
  return value === null ? null : Number(value);
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
        sourceUpdatedAt: realEstateListings.sourceUpdatedAt,
        expectedEndAt: realEstateListings.expectedEndAt,
        dealType: realEstateListings.dealType,
        propertyType: realEstateListings.propertyType,
        rooms: realEstateListings.rooms,
        bedrooms: realEstateListings.bedrooms,
        areaM2: realEstateListings.areaM2,
        floor: realEstateListings.floor,
        totalFloors: realEstateListings.totalFloors,
        priceGel: realEstateListings.priceGel,
        priceUsd: realEstateListings.priceUsd,
        pricePerM2Usd: realEstateListings.pricePerM2Usd,
        currencyPosted: realEstateListings.currencyPosted,
        cityRef: realEstateListings.cityRef,
        cityName: realEstateListings.cityName,
        districtRef: realEstateListings.districtRef,
        districtName: realEstateListings.districtName,
        subdistrictRef: realEstateListings.subdistrictRef,
        subdistrictName: realEstateListings.subdistrictName,
        streetName: realEstateListings.streetName,
        streetNumber: realEstateListings.streetNumber,
        posterType: realEstateListings.posterType,
        description: realEstateListings.description,
        similarityGroup: realEstateListings.similarityGroup,
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

    const stored: MeaningfulFields = {
      ...existing,
      areaM2: amountOf(existing.areaM2),
      priceGel: amountOf(existing.priceGel),
      priceUsd: amountOf(existing.priceUsd),
      pricePerM2Usd: amountOf(existing.pricePerM2Usd),
    };
    const reopened = existing.status === 'gone';
    // From the stored fields rather than the stored fingerprint, so rows
    // written under an older definition of it are judged the same way.
    const contentChanged = listingContentHash(stored) !== contentHash;
    const bumped = Date.parse(card.sourceUpdatedAt) > Date.parse(existing.sourceUpdatedAt);

    if (!reopened && !contentChanged && !bumped) {
      const converted =
        sameAmount(existing.priceGel, card.priceGel) &&
        sameAmount(existing.priceUsd, card.priceUsd) &&
        sameAmount(existing.pricePerM2Usd, card.pricePerM2Usd)
          ? {}
          : {
              priceGel: money(card.priceGel),
              priceUsd: money(card.priceUsd),
              pricePerM2Usd: money(card.pricePerM2Usd),
            };
      await tx
        .update(realEstateListings)
        .set({
          lastSeenAt: seenAt,
          missedAt: null,
          promoted: card.promoted,
          contentHash,
          ...converted,
        })
        .where(eq(realEstateListings.id, existing.id));
      return 'unchanged';
    }

    if (JSON.stringify(postedPrice(stored)) !== JSON.stringify(postedPrice(card))) {
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
        missedAt: null,
        status: 'active',
        goneAt: null,
        goneReason: null,
      })
      .where(eq(realEstateListings.id, existing.id));

    if (reopened) return 'reopened';
    return contentChanged ? 'changed' : 'bumped';
  });
}

/**
 * A price read from a listing's own page (src/realestate/expiry.ts), by the
 * same rule as `upsertListing`: a new price in the posted currency is
 * recorded as a price change, a converted price that moved is only kept
 * current. A page that states no price in its posted currency leaves the
 * stored one alone.
 */
export async function recordPriceSighting(
  db: DatabaseOrTransaction,
  input: { listingId: string; price: ListingPrice; seenAt: string },
): Promise<'changed' | 'unchanged'> {
  const { listingId, price, seenAt } = input;
  const posted = postedPrice(price);
  if (posted[0] === null || posted[1] === null) return 'unchanged';

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({
        priceGel: realEstateListings.priceGel,
        priceUsd: realEstateListings.priceUsd,
        pricePerM2Usd: realEstateListings.pricePerM2Usd,
        currencyPosted: realEstateListings.currencyPosted,
      })
      .from(realEstateListings)
      .where(eq(realEstateListings.id, listingId))
      .for('update');
    if (existing === undefined) return 'unchanged';

    const stored = {
      currencyPosted: existing.currencyPosted,
      priceGel: amountOf(existing.priceGel),
      priceUsd: amountOf(existing.priceUsd),
    };
    const changed = JSON.stringify(postedPrice(stored)) !== JSON.stringify(posted);
    const moved =
      !sameAmount(existing.priceGel, price.priceGel) ||
      !sameAmount(existing.priceUsd, price.priceUsd) ||
      !sameAmount(existing.pricePerM2Usd, price.pricePerM2Usd);
    if (!changed && !moved) return 'unchanged';

    if (changed) {
      await tx.insert(realEstatePriceChanges).values({
        listingId,
        observedAt: seenAt,
        oldPriceGel: existing.priceGel,
        newPriceGel: money(price.priceGel),
        oldPriceUsd: existing.priceUsd,
        newPriceUsd: money(price.priceUsd),
      });
    }
    await tx
      .update(realEstateListings)
      .set({
        priceGel: money(price.priceGel),
        priceUsd: money(price.priceUsd),
        pricePerM2Usd: money(price.pricePerM2Usd),
        currencyPosted: price.currencyPosted,
      })
      .where(eq(realEstateListings.id, listingId));
    return changed ? 'changed' : 'unchanged';
  });
}
