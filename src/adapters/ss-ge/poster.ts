import { extractContacts, normalisePhone } from '../../realestate/contacts.js';
import type { PhotoSetSighting, PosterSighting } from '../../realestate/posters.js';
import { isRecord } from './page.js';

/**
 * Who posted a listing and which photos it shows (Phases 17B and 17G,
 * docs/PHASE_17_PLAN.md; field names from src/adapters/ss-ge/RECON_NOTES.md,
 * "Posters and photos"). Read from pages the crawler reads anyway: a results
 * row and a listing's own page. Nothing here makes a request, and no image
 * is ever fetched: a photo is kept as its path only.
 *
 * Everything read here is private (`realestate_contacts`,
 * `realestate_media`): never on the public site, never in a fixture. A value
 * of an unknown shape is skipped, never thrown on.
 */

/** One photo as the page lists it; `ref` is its canonical path (`canonicalPhotoRef`). */
export interface PhotoRef {
  ref: string;
  orderNo: number | null;
  isMain: boolean;
  is360: boolean;
  imageType: number | null;
}

/** A listing's photos as one page shows them, in the site's order. */
export interface PhotoSet {
  /** Canonical paths, distinct, ordered by `orderNo` (unnumbered last, as listed). */
  refs: string[];
  /** The cover the site marks, when it marks one. */
  mainRef: string | null;
  /** How many the listing has (a results row shows a few of them); null when the page does not say. */
  imageCount: number | null;
  photos: PhotoRef[];
}

/** The poster as a results row names them. */
export interface RowPoster {
  /** ss.ge's account id, a GUID, lower-cased. */
  userId: string;
  /** `userInfo.name`: only on a business's rows. */
  displayName: string | null;
  /** `userInfo.userType`, ss.ge's own code. */
  userType: number | null;
}

/** What one results row says about who posted it and what it shows. */
export interface RowSighting {
  sourceListingKey: string;
  poster: RowPoster | null;
  photos: PhotoSet | null;
}

/** What a listing's own page says about who posted it and what it shows. */
export interface ListingPageSighting {
  sourceListingKey: string;
  /** Null when the page names no account. */
  userId: string | null;
  /** `contactPerson`, or the agent's name beside it. */
  contactName: string | null;
  /** `applicationPhones`, in +995 form, distinct. */
  phones: string[];
  /** `userEntityType` as ss.ge writes it ("Broker"). */
  entityType: string | null;
  /** `userApplicationCount`: the account's listings. */
  listingCount: number | null;
  agencyRef: number | null;
  agencyName: string | null;
  companyRef: number | null;
  companyName: string | null;
  /** `initialAgentInfoData.companyType` and `.infoType`, ss.ge's own codes. */
  companyType: number | null;
  agentInfoType: number | null;
  photos: PhotoSet | null;
}

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INTEGER_MAX = 2_147_483_647;
const SMALLINT_MAX = 32_767;
/** Long enough for any real name; past it, the value is not a name. */
const NAME_MAX = 200;

/** ss.ge's account id, lower-cased; null for anything that is not a GUID. */
export function readUserId(value: unknown): string | null {
  return typeof value === 'string' && GUID_RE.test(value.trim())
    ? value.trim().toLowerCase()
    : null;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
const CONTROL_RE = /[\u0000-\u001f\u007f]/g;

function name(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const plain = value.replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
  return plain === '' || plain.length > NAME_MAX ? null : plain;
}

function code(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && Math.abs(value) <= SMALLINT_MAX
    ? value
    : null;
}

function ref(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= INTEGER_MAX
    ? value
    : null;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= INTEGER_MAX
    ? value
    : null;
}

/**
 * A photo's path without its host and size: `<8 digits>/<n>_<guid>.<ext>`.
 * A results row names the photo with a size suffix
 * (`static.ss.ge/<8 digits>/<n>_<guid>_<word>.jpg`), a listing page without
 * one (`fileName`) and with one (`fileNameThumb`); all three read the same
 * here. Null for any other shape.
 */
const PHOTO_PATH_RE =
  /(?:^|\/)(\d{8})\/(\d{1,3})_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_[A-Za-z0-9]{1,20})?\.(jpe?g|png|webp|gif)(?:[?#].*)?$/i;

export function canonicalPhotoRef(fileName: unknown): string | null {
  if (typeof fileName !== 'string' || fileName.length > 500) return null;
  const match = PHOTO_PATH_RE.exec(fileName.trim());
  if (match === null) return null;
  const [, day, index, guid, extension] = match;
  return `${day}/${Number(index)}_${(guid as string).toLowerCase()}.${(extension as string).toLowerCase()}`;
}

/**
 * The day a photo was uploaded, when its path's 8 digits are a real date
 * (yyyymmdd, 2000 to 2099), as `YYYY-MM-DD`; else null. Unconfirmed by the
 * recon, which masks digits, so it is kept as a reading, never as a fact.
 */
export function photoUploadDay(canonicalRef: string): string | null {
  const match = /^(\d{4})(\d{2})(\d{2})\//.exec(canonicalRef);
  if (match === null) return null;
  const [, year, month, day] = match.map(Number) as [number, number, number, number];
  if (year < 2000 || year > 2099) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return null;
  return date.toISOString().slice(0, 10);
}

/** Reads `appImages`; photos of an unknown shape are skipped. Null when it names none. */
export function readPhotoSet(images: unknown, imageCount: unknown): PhotoSet | null {
  const total = count(imageCount);
  const photos: PhotoRef[] = [];
  const seen = new Set<string>();
  if (Array.isArray(images)) {
    for (const image of images) {
      if (!isRecord(image)) continue;
      const canonical =
        canonicalPhotoRef(image.fileName) ??
        canonicalPhotoRef(image.fileNameThumb) ??
        canonicalPhotoRef(image.fileNameLarge);
      if (canonical === null || seen.has(canonical)) continue;
      seen.add(canonical);
      photos.push({
        ref: canonical,
        orderNo: code(image.orderNo),
        isMain: image.isMain === true,
        is360: image.is360 === true,
        imageType: code(image.imageType),
      });
    }
  }
  if (photos.length === 0 && total === null) return null;
  // Stable: photos with the same number, or none, keep the page's order.
  const ordered = photos
    .map((photo, index) => ({ photo, index }))
    .sort(
      (a, b) =>
        (a.photo.orderNo ?? Number.MAX_SAFE_INTEGER) -
          (b.photo.orderNo ?? Number.MAX_SAFE_INTEGER) || a.index - b.index,
    )
    .map(({ photo }) => photo);
  return {
    refs: ordered.map((photo) => photo.ref),
    mainRef: ordered.find((photo) => photo.isMain)?.ref ?? null,
    imageCount: total,
    photos: ordered,
  };
}

/** The poster and photos of one results row (the row is already known to be a listing). */
export function readRowSighting(
  row: Record<string, unknown>,
  sourceListingKey: string,
): RowSighting {
  const userId = readUserId(row.userId);
  const info = isRecord(row.userInfo) ? row.userInfo : null;
  return {
    sourceListingKey,
    poster:
      userId === null
        ? null
        : {
            userId,
            displayName: info === null ? null : name(info.name),
            userType: info === null ? null : code(info.userType),
          },
    photos: readPhotoSet(row.appImages, row.imageCount),
  };
}

/**
 * The poster and photos on a listing's own page (`applicationData`, and the
 * agent block beside it, `initialAgentInfoData`). Null when the page holds
 * no listing record, or another listing's.
 */
export function readListingPageSighting(
  pageProps: Record<string, unknown>,
  sourceListingKey: string,
): ListingPageSighting | null {
  const listing = pageProps.applicationData;
  if (!isRecord(listing) || String(listing.applicationId) !== sourceListingKey) return null;
  const agent = isRecord(pageProps.initialAgentInfoData)
    ? pageProps.initialAgentInfoData
    : isRecord(listing.initialAgentInfoData)
      ? listing.initialAgentInfoData
      : {};
  const phones = new Set<string>();
  if (Array.isArray(listing.applicationPhones)) {
    for (const entry of listing.applicationPhones) {
      const phone = normalisePhone(isRecord(entry) ? entry.phoneNumber : entry);
      if (phone !== null) phones.add(phone);
    }
  }
  const entityType = name(listing.userEntityType);
  return {
    sourceListingKey,
    userId: readUserId(listing.userId) ?? readUserId(agent.userId),
    contactName: name(listing.contactPerson) ?? name(agent.agentContactName),
    phones: [...phones],
    entityType: entityType !== null && entityType.length <= 40 ? entityType : null,
    listingCount: count(listing.userApplicationCount),
    agencyRef: ref(listing.agencyId),
    agencyName: name(listing.agencyName),
    companyRef: ref(listing.companyId) ?? ref(agent.companyId),
    companyName: name(listing.companyName) ?? name(agent.companyName),
    companyType: code(agent.companyType),
    agentInfoType: code(agent.infoType),
    photos: readPhotoSet(listing.appImages, listing.imageCount),
  };
}

function photoSetSighting(set: PhotoSet | null, origin: PhotoSetSighting['origin']) {
  if (set === null) return null;
  return {
    origin,
    refs: set.refs,
    mainRef: set.mainRef,
    imageCount: set.imageCount,
    photos: set.photos.map((photo) => ({
      ref: photo.ref,
      uploadDay: photoUploadDay(photo.ref),
      is360: photo.is360,
      imageType: photo.imageType,
    })),
  } satisfies PhotoSetSighting;
}

/**
 * What the private directory keeps of one results row: its account, the
 * phones and emails typed into its description, and the photos it shows.
 */
export function rowPosterSighting(
  sighting: RowSighting,
  description: string | null,
): PosterSighting {
  return {
    sourceListingKey: sighting.sourceListingKey,
    account:
      sighting.poster === null
        ? null
        : {
            userId: sighting.poster.userId,
            displayName: sighting.poster.displayName,
            userType: sighting.poster.userType,
          },
    contacts: extractContacts(description).map((contact) => ({
      ...contact,
      contactName: '',
      seenIn: 'description' as const,
    })),
    photos: photoSetSighting(sighting.photos, 'row'),
  };
}

/** What the private directory keeps of a listing's own page. */
export function listingPagePosterSighting(sighting: ListingPageSighting): PosterSighting {
  return {
    sourceListingKey: sighting.sourceListingKey,
    account:
      sighting.userId === null
        ? null
        : {
            userId: sighting.userId,
            contactName: sighting.contactName,
            entityType: sighting.entityType,
            listingCount: sighting.listingCount,
            agencyRef: sighting.agencyRef,
            agencyName: sighting.agencyName,
            companyRef: sighting.companyRef,
            companyName: sighting.companyName,
            companyType: sighting.companyType,
            agentInfoType: sighting.agentInfoType,
          },
    contacts: sighting.phones.map((value) => ({
      kind: 'phone' as const,
      value,
      contactName: sighting.contactName ?? '',
      seenIn: 'listing_page' as const,
    })),
    photos: photoSetSighting(sighting.photos, 'listing_page'),
  };
}
