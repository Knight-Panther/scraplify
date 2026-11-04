import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { realEstateListings } from '../db/schema/index.js';
import type { DatabaseOrTransaction } from '../db/types.js';
import type { DueListing } from './expiry.js';
import type {
  AmenityKey,
  BuildingStatus,
  Condition,
  FloorType,
  PosterEntity,
  Project,
} from './kinds.js';

/**
 * What a listing's own page says beyond its results row (Phase 12B), as keys
 * of our own. Null is unknown, never "no": the page left it out or used
 * wording the vocabularies in `kinds.ts` do not hold.
 */
export interface ListingDetails {
  buildingStatus: BuildingStatus | null;
  condition: Condition | null;
  project: Project | null;
  floorType: FloorType | null;
  bathrooms: number | null;
  balconies: number | null;
  kitchenAreaM2: number | null;
  houseAreaM2: number | null;
  yardAreaM2: number | null;
  posterEntity: PosterEntity | null;
  /** The amenities the page marks true, in `AMENITY_FIELDS` order. */
  amenities: AmenityKey[];
  latitude: number | null;
  longitude: number | null;
  municipalityRef: number | null;
  municipalityName: string | null;
}

function decimal(value: number | null, scale: number): string | null {
  return value === null ? null : value.toFixed(scale);
}

/**
 * Writes what a listing's own page said, every field of it: a value a later
 * page no longer gives becomes unknown. Marks the page read and the listing
 * no longer wanted.
 */
export async function recordListingDetails(
  db: DatabaseOrTransaction,
  input: { listingId: string; details: ListingDetails; readAt: string },
): Promise<void> {
  const { details } = input;
  await db
    .update(realEstateListings)
    .set({
      buildingStatus: details.buildingStatus,
      condition: details.condition,
      project: details.project,
      floorType: details.floorType,
      bathrooms: details.bathrooms,
      balconies: details.balconies,
      kitchenArea: decimal(details.kitchenAreaM2, 2),
      houseArea: decimal(details.houseAreaM2, 2),
      yardArea: decimal(details.yardAreaM2, 2),
      posterEntity: details.posterEntity,
      amenities: details.amenities,
      latitude: decimal(details.latitude, 6),
      longitude: decimal(details.longitude, 6),
      municipalityRef: details.municipalityRef,
      municipalityName: details.municipalityName,
      detailsReadAt: input.readAt,
      detailsWantedAt: null,
    })
    .where(eq(realEstateListings.id, input.listingId));
}

/**
 * Active listings whose own page the crawl means to read and has not, the
 * newest listing first (its last order time on the site): a run that runs
 * out of time leaves the oldest for the next night, behind that night's newer
 * ones (Phase 12B). By want time instead, one night's walk would read its
 * lists' last pages first, since those are the rows it saw last.
 */
export async function loadListingsWantingDetails(
  db: DatabaseOrTransaction,
  input: { sourceId: string; limit: number },
): Promise<DueListing[]> {
  return db
    .select({ id: realEstateListings.id, sourceListingKey: realEstateListings.sourceListingKey })
    .from(realEstateListings)
    .where(
      and(
        eq(realEstateListings.sourceId, input.sourceId),
        eq(realEstateListings.status, 'active'),
        isNull(realEstateListings.detailsReadAt),
        isNotNull(realEstateListings.detailsWantedAt),
      ),
    )
    .orderBy(desc(realEstateListings.sourceUpdatedAt), desc(realEstateListings.id))
    .limit(input.limit);
}
