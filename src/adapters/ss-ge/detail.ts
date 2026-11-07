import type { ListingDetails } from '../../realestate/details.js';
import type { ListingPrice } from '../../realestate/ingest.js';
import {
  AMENITY_FIELDS,
  type AmenityKey,
  BUILDING_STATUSES,
  CONDITIONS,
  FLOOR_TYPES,
  POSTER_ENTITIES,
  PROJECTS,
  vocabularyKey,
} from '../../realestate/kinds.js';
import type { StreetPoint } from '../../realestate/places.js';
import { addressText, floorRange, readListingPrice, readMetro, reference, text } from './list.js';
import { isRecord, readPageProps, SsGePageShapeError, tbilisiWallClockToIso } from './page.js';

/**
 * What a detail page says about whether its listing is still live, its
 * price (a listing a nightly run no longer reads may still have had it
 * edited) and, since Phase 12B, its details. The phone numbers, names and
 * user ids on a detail page are never touched.
 */
export type DetailResult =
  | { status: 'active'; endAt: string | null; price: ListingPrice; details: ListingDetails }
  | { status: 'gone'; reason: 'expired' | 'inactive' | 'missing' };

const SMALLINT_MAX = 32_767;
/** Below the largest value each area column holds (src/db/schema/real-estate.ts). */
const KITCHEN_AREA_LIMIT = 1e6;
const HOUSE_AREA_LIMIT = 1e8;
const YARD_AREA_LIMIT = 1e10;
/** Georgia's bounding box, with a margin: a point outside it is a fault, not a place. */
const LATITUDE = { min: 41, max: 43.6 };
const LONGITUDE = { min: 40, max: 46.8 };
/** "Has none", as ss.ge writes it for bathrooms and balconies. */
const NONE = 'არ აქვს';

/** A count ss.ge writes as text: "2", "5+" (read as 5), "არ აქვს" or "0" (none). */
function count(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 0 && value <= SMALLINT_MAX ? value : null;
  }
  if (typeof value !== 'string') return null;
  const plain = value.trim();
  if (plain === NONE) return 0;
  const match = /^(\d{1,4})\+?$/.exec(plain);
  if (match?.[1] === undefined) return null;
  const amount = Number(match[1]);
  return amount <= SMALLINT_MAX ? amount : null;
}

/**
 * An area ss.ge writes as text or a number, to the cent its column keeps; 0,
 * empty or past its column once rounded is unknown (999,999.999 rounds to a
 * million, which `numeric(8,2)` refuses).
 */
function area(value: unknown, limit: number): number | null {
  const amount =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN;
  if (!Number.isFinite(amount)) return null;
  const cents = Math.round(amount * 100) / 100;
  return cents > 0 && cents < limit ? cents : null;
}

function coordinate(value: unknown, range: { min: number; max: number }): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < range.min || value > range.max) return null;
  return Math.round(value * 1e6) / 1e6;
}

/**
 * ss.ge's own point for the page's street (Phase 14A), the same on every
 * listing of that street. It sends 0/0 for a street it has no point for
 * (every Batumi street sampled on 2026-11-06), which `coordinate` would only
 * call missing; here it means "none", so the street is not asked about again
 * for a while. A point outside Georgia, or half of one, is nothing.
 */
function streetPoint(listing: Record<string, unknown>): StreetPoint | null {
  const { streetLocationLatitude: lat, streetLocationLongitude: lng } = listing;
  if (lat === 0 && lng === 0) return { status: 'none' };
  const latitude = coordinate(lat, LATITUDE);
  const longitude = coordinate(lng, LONGITUDE);
  return latitude === null || longitude === null ? null : { status: 'known', latitude, longitude };
}

/** A Georgian cadastral code's shape: "01.17.13.026.105", "20.48.11.084". */
const CADASTRAL_CODE_RE = /^\d{2}(?:\.\d{2,3}){3,6}$/;

/**
 * A developer's name as its account gives it, unless it names a person: an
 * individual entrepreneur ("ი/მ …", "ინდ. მეწარმე …") trades under their own
 * name, and no person's name is stored.
 */
const PERSON_TRADER_RE = /^(?:ი\s*\/\s*მ|ი\.\s*მ\.?|ინდ(?:ივიდუალური)?\.?\s*მეწარმე)/u;

function developerName(value: unknown): string | null {
  const name = addressText(value);
  return name === null || PERSON_TRADER_RE.test(name) ? null : name;
}

function readDetails(listing: Record<string, unknown>): ListingDetails {
  const address = isRecord(listing.address) ? listing.address : {};
  const latitude = coordinate(listing.locationLatitude, LATITUDE);
  const longitude = coordinate(listing.locationLongitude, LONGITUDE);
  const cadastral = text(listing.cadastralCode);
  const amenities: AmenityKey[] = [];
  for (const [field, key] of Object.entries(AMENITY_FIELDS)) {
    if (listing[field] === true) amenities.push(key);
  }
  return {
    buildingStatus: vocabularyKey(BUILDING_STATUSES, listing.realEstateStatus),
    condition: vocabularyKey(CONDITIONS, listing.state),
    project: vocabularyKey(PROJECTS, listing.project),
    floorType: vocabularyKey(FLOOR_TYPES, listing.floorTypeText),
    bathrooms: count(listing.toilet),
    balconies: count(listing.balcony_Loggia),
    kitchenAreaM2: area(listing.kitchenArea, KITCHEN_AREA_LIMIT),
    houseAreaM2: area(listing.areaOfHouse, HOUSE_AREA_LIMIT),
    yardAreaM2: area(listing.areaOfYard, YARD_AREA_LIMIT),
    posterEntity: vocabularyKey(POSTER_ENTITIES, listing.userEntityType),
    amenities,
    // A point needs both halves.
    latitude: latitude === null || longitude === null ? null : latitude,
    longitude: latitude === null || longitude === null ? null : longitude,
    municipalityRef: reference(address.municipalityId),
    municipalityName: text(address.municipalityTitle),
    pinManual: typeof listing.isManualPin === 'boolean' ? listing.isManualPin : null,
    cadastralCode: cadastral !== null && CADASTRAL_CODE_RE.test(cadastral) ? cadastral : null,
    complexRef: reference(listing.projectId),
    complexName: addressText(listing.projectName),
    developerRef: reference(listing.companyId),
    developerName: developerName(listing.companyName),
    streetRef: reference(address.streetId),
    ssMetro: readMetro(listing.nearbySubwayStations),
    ...floorRange(listing.floor),
    street: {
      point: streetPoint(listing),
      name: addressText(address.streetTitle),
      subdistrictRef: reference(address.subdistrictId),
      cityRef: reference(address.cityId),
    },
  };
}

/**
 * The site answers HTTP 200 for every id: an expired listing still renders,
 * marked `Expired`, and an id that does not exist renders a page with no
 * listing record at all (guideline §4.7). A live listing's page can also
 * render with no record for a moment (two of eight on 2026-11-04, live again
 * on the next request); `recordListingCheck` decides what that means.
 *
 * A page showing another listing than the one asked for is refused: read as
 * it stands, it would mark the wrong listing live or gone.
 */
export function parseDetailPage(html: string, sourceListingKey: string): DetailResult {
  const listing = readPageProps(html).applicationData;
  if (!isRecord(listing)) return { status: 'gone', reason: 'missing' };
  if (String(listing.applicationId) !== sourceListingKey) {
    throw new SsGePageShapeError('ss.ge listing page is not for the listing asked for');
  }

  if (listing.status === 'Active' && listing.isInactiveApplication !== true) {
    return {
      status: 'active',
      endAt: tbilisiWallClockToIso(listing.endDate),
      price: readListingPrice(listing.price),
      details: readDetails(listing),
    };
  }
  return { status: 'gone', reason: listing.status === 'Expired' ? 'expired' : 'inactive' };
}
