import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { realEstateListings, realEstatePriceChanges } from '../db/schema/index.js';
import type { DatabaseOrTransaction } from '../db/types.js';
import { parseHouseNumber } from './address.js';
import type { DealType, PropertyType } from './kinds.js';
import { type DistrictParents, inferDistrict } from './places.js';

/**
 * One listing as a source's results page shows it, already normalised by the
 * source's parser. Carries no phone number, name or user id: the parser is
 * where those are dropped.
 */
export interface ListingCard {
  sourceListingKey: string;
  canonicalUrl: string;
  dealType: DealType;
  propertyType: PropertyType;
  rooms: number | null;
  bedrooms: number | null;
  areaM2: number | null;
  floor: number | null;
  totalFloors: number | null;
  priceGel: number | null;
  priceUsd: number | null;
  pricePerM2Usd: number | null;
  pricePerM2Gel: number | null;
  currencyPosted: 'gel' | 'usd' | null;
  cityRef: number | null;
  cityName: string | null;
  districtRef: number | null;
  districtName: string | null;
  subdistrictRef: number | null;
  subdistrictName: string | null;
  /** The source's own street id (Phase 14A): one street, where names repeat. */
  streetRef: number | null;
  streetName: string | null;
  streetNumber: string | null;
  /** The metro stations the source lists near it, station → walking minutes, as it worked them out from its pin. */
  ssMetro: Record<string, number> | null;
  /** The lowest and highest floor it names; a developer's list or range too. */
  floorLow: number | null;
  floorHigh: number | null;
  posterType: 'owner' | 'agent' | 'developer' | 'unknown';
  promoted: boolean;
  /** ss.ge's code for a commercial space's type (`COMMERCIAL_TYPE_CODES`), or null. */
  commercialType: number | null;
  /** ss.ge's code for a plot's land type (`LAND_TYPE_CODES`), or null. */
  landType: number | null;
  /** How many photos it has; 0 is a real answer. No photo is ever fetched. */
  imageCount: number | null;
  /** Null when the source does not say. */
  hasFurniture: boolean | null;
  hasBuiltInKitchen: boolean | null;
  exclusive: boolean;
  /** The poster offers a viewing by video call. */
  videoViewing: boolean;
  description: string | null;
  similarityGroup: string | null;
  /** ISO instants, already converted from the source's local time. */
  sourceUpdatedAt: string;
  sourceCreatedAt: string | null;
  expectedEndAt: string | null;
  /**
   * The latest the source ends it unless it is renewed, where the parser can
   * say (ss.ge: an owner's 45 days, for a row naming no business). It bounds
   * how long a sighting past `expectedEndAt` keeps the listing on show
   * (`endAfterSighting`). Null where nothing is known.
   */
  latestEndAt: string | null;
}

const HOUR_MS = 60 * 60 * 1000;
/**
 * How long a listing stays on show after a list showed it past its expected
 * end: two and a half days, so a nightly read renews it and one night that
 * fails does not hide it (the hour a list is reached moves by some hours from
 * night to night). Gone from its list, it leaves the tab that much later at
 * the latest.
 */
export const SEEN_PAST_END_HOURS = 60;

/**
 * The expected end to keep after one sighting on a list.
 *
 * Within its expected life (`card.expectedEndAt`) a sighting says nothing new
 * and `stored` stands. Past it, the source still listing it is the evidence
 * that it runs longer (an owner's 45 days where a broker's are 30, a business
 * listing kept for years), and the only one a results row gives: it stays on
 * show for `SEEN_PAST_END_HOURS` from the sighting, and never past
 * `card.latestEndAt` while that is ahead. An end the listing's own page gave
 * since it was last ordered is believed over that for as long as it is ahead.
 * No sighting moves an end back.
 */
function endAfterSighting(input: {
  card: Pick<ListingCard, 'sourceUpdatedAt' | 'expectedEndAt' | 'latestEndAt'>;
  seenAt: string;
  /** The end the row would keep otherwise. */
  stored: string | null;
  /** When the listing's own page last confirmed it live, if ever. */
  verifiedAt: string | null;
}): string | null {
  const { card, seenAt, stored, verifiedAt } = input;
  const seenMs = Date.parse(seenAt);
  if (card.expectedEndAt === null || Date.parse(card.expectedEndAt) > seenMs) return stored;

  const storedMs = stored === null ? Number.NEGATIVE_INFINITY : Date.parse(stored);
  const confirmed =
    verifiedAt !== null && Date.parse(verifiedAt) > Date.parse(card.sourceUpdatedAt);
  if (confirmed && storedMs > seenMs) return stored;

  let endMs = seenMs + SEEN_PAST_END_HOURS * HOUR_MS;
  const latestMs = card.latestEndAt === null ? Number.NaN : Date.parse(card.latestEndAt);
  if (latestMs > seenMs) endMs = Math.min(endMs, latestMs);
  return endMs > storedMs ? new Date(endMs).toISOString() : stored;
}

/** A listing's price as a source states it, in both currencies and the one it was posted in. */
export type ListingPrice = Pick<
  ListingCard,
  'priceGel' | 'priceUsd' | 'pricePerM2Usd' | 'pricePerM2Gel' | 'currencyPosted'
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
  /**
   * Each sub-district's district (`loadDistrictParents`): a district the row
   * leaves out is filled from it, and marked so. Without it nothing is filled.
   */
  parents?: DistrictParents;
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
  | 'pricePerM2Gel'
  | 'commercialType'
  | 'landType'
  | 'imageCount'
  | 'hasFurniture'
  | 'hasBuiltInKitchen'
  | 'exclusive'
  | 'videoViewing'
  | 'sourceUpdatedAt'
  | 'sourceCreatedAt'
  | 'expectedEndAt'
  | 'latestEndAt'
  // Phase 14A: kept current on every sighting, never a change (`rowExtrasOf`).
  | 'streetRef'
  | 'ssMetro'
  | 'floorLow'
  | 'floorHigh'
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

function columnsOf(card: ListingCard, contentHash: string, districtInferred: boolean) {
  return {
    districtInferred,
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
    pricePerM2Gel: money(card.pricePerM2Gel),
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
    ...rowExtrasOf(card),
    description: card.description,
    similarityGroup: card.similarityGroup,
    contentHash,
  };
}

/**
 * What a results row says beside the fields that matter for a change: kept
 * current on every sighting, a change in them never called a change. Leaving
 * them out of `listingContentHash` also means rows stored before Phase 12A
 * are not all taken for changed once.
 */
function rowExtrasOf(card: ListingCard) {
  return {
    promoted: card.promoted,
    commercialType: card.commercialType,
    landType: card.landType,
    imageCount: card.imageCount,
    hasFurniture: card.hasFurniture,
    hasBuiltInKitchen: card.hasBuiltInKitchen,
    exclusive: card.exclusive,
    videoViewing: card.videoViewing,
    // Phase 14A: the rows stored before it gain these on their next sighting,
    // and none of them is taken for changed.
    streetRef: card.streetRef,
    ssMetro: card.ssMetro,
    floorLow: card.floorLow,
    floorHigh: card.floorHigh,
    ...parseHouseNumber(card.streetNumber),
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
  const { sourceId, seenAt, parents } = input;
  // The district filled in, if the row left it out, before anything is
  // judged or written: the hash, every write and the stored row's comparison
  // all see the same card.
  const filled =
    parents === undefined
      ? { fields: input.card, inferred: false }
      : inferDistrict(input.card, parents);
  const card = filled.fields;
  const contentHash = listingContentHash(card);

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({
        id: realEstateListings.id,
        status: realEstateListings.status,
        sourceUpdatedAt: realEstateListings.sourceUpdatedAt,
        expectedEndAt: realEstateListings.expectedEndAt,
        verifiedAt: realEstateListings.verifiedAt,
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
        detailsReadAt: realEstateListings.detailsReadAt,
        districtInferred: realEstateListings.districtInferred,
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
        ...columnsOf(card, contentHash, filled.inferred),
        sourceUpdatedAt: card.sourceUpdatedAt,
        sourceCreatedAt: card.sourceCreatedAt,
        expectedEndAt: endAfterSighting({
          card,
          seenAt,
          stored: card.expectedEndAt,
          verifiedAt: null,
        }),
        firstSeenAt: seenAt,
        lastSeenAt: seenAt,
        // Its own page is read once, from Phase 12B on (src/realestate/details.ts).
        detailsWantedAt: seenAt,
      });
      return 'new';
    }

    const { detailsReadAt, districtInferred, verifiedAt, ...comparable } = existing;
    // The stored row filled by tonight's tree exactly as the row was, a
    // district filled in before taken out first: a sub-district moved to
    // another district, the source stating the district itself, or a legacy
    // row stored before the fill existed is never a change.
    const asStored =
      parents === undefined
        ? comparable
        : inferDistrict(
            districtInferred
              ? { ...comparable, districtRef: null, districtName: null }
              : comparable,
            parents,
          ).fields;
    const stored: MeaningfulFields = {
      ...asStored,
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
    // A page read out of order must not move the listing back in time.
    const sourceUpdatedAt = bumped ? card.sourceUpdatedAt : existing.sourceUpdatedAt;
    const expectedEndAt = endAfterSighting({
      card: { ...card, sourceUpdatedAt },
      seenAt,
      stored: bumped ? card.expectedEndAt : existing.expectedEndAt,
      verifiedAt,
    });

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
          expectedEndAt,
          ...rowExtrasOf(card),
          // The district as tonight's tree fills it, which compared the same.
          ...(parents === undefined
            ? {}
            : {
                districtRef: card.districtRef,
                districtName: card.districtName,
                districtInferred: filled.inferred,
              }),
          pricePerM2Gel: money(card.pricePerM2Gel),
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
        ...columnsOf(card, contentHash, filled.inferred),
        sourceUpdatedAt,
        expectedEndAt,
        ...(card.sourceCreatedAt === null ? {} : { sourceCreatedAt: card.sourceCreatedAt }),
        lastSeenAt: seenAt,
        missedAt: null,
        status: 'active',
        goneAt: null,
        goneReason: null,
        // Changed, renewed or back: worth reading its page, unless it has been
        // read already. A listing only seen unchanged is never wanted, so the
        // rows stored before Phase 12B wait for a reason (no backlog).
        ...(detailsReadAt === null ? { detailsWantedAt: seenAt } : {}),
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
        pricePerM2Gel: money(price.pricePerM2Gel),
        currencyPosted: price.currencyPosted,
      })
      .where(eq(realEstateListings.id, listingId));
    return changed ? 'changed' : 'unchanged';
  });
}
