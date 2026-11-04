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
