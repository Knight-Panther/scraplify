import type { RealEstateRow } from '../../src/realestate/queries.js';

/**
 * What a real-estate row says in words. Kept out of the page so each rule is
 * tested by itself, and so no database value (`cottage`, `unknown`) ever
 * reaches the screen as it is stored.
 */

export type Currency = 'usd' | 'gel';

export const KIND_LABELS: Readonly<Record<RealEstateRow['propertyType'], string>> = {
  flat: 'Flat',
  house: 'House',
  cottage: 'Summer cottage',
};

export const DEAL_LABELS: Readonly<Record<RealEstateRow['dealType'], string>> = {
  sale: 'for sale',
  rent: 'for rent',
};

export function listingLabel(row: RealEstateRow): string {
  return `${KIND_LABELS[row.propertyType]} ${DEAL_LABELS[row.dealType]}`;
}

/** "6 / 14" for a flat; "2 floors" for a house, which has storeys and no floor it is on. */
export function floorText(row: RealEstateRow): string | null {
  if (row.floor !== null) {
    return row.totalFloors === null ? String(row.floor) : `${row.floor} / ${row.totalFloors}`;
  }
  if (row.totalFloors === null) return null;
  return row.totalFloors === 1 ? '1 floor' : `${row.totalFloors} floors`;
}

/** The price as the source stated it in that currency; nothing is converted here. */
export function priceOf(row: RealEstateRow, currency: Currency): number | null {
  return currency === 'gel' ? row.priceGel : row.priceUsd;
}

const WHOLE = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });

export function money(amount: number, currency: Currency): string {
  return currency === 'gel' ? `${WHOLE.format(amount)} ₾` : `$${WHOLE.format(amount)}`;
}

/** Price per square metre in the currency shown, from that price and the area. */
export function perMetre(row: RealEstateRow, currency: Currency): number | null {
  const price = priceOf(row, currency);
  if (price === null || row.areaM2 === null || row.areaM2 <= 0) return null;
  return Math.round(price / row.areaM2);
}

export function placeText(row: RealEstateRow): string | null {
  const local = row.subdistrictName ?? row.districtName;
  if (local !== null && row.cityName !== null) return `${local}, ${row.cityName}`;
  return local ?? row.cityName;
}

export function streetText(row: RealEstateRow): string | null {
  if (row.streetName === null) return null;
  return row.streetNumber === null ? row.streetName : `${row.streetName} ${row.streetNumber}`;
}

/** Who posted it, when the source marks it. An unmarked listing is not thereby an owner's. */
export function posterText(row: RealEstateRow): string | null {
  switch (row.posterType) {
    case 'agent':
      return 'agency';
    case 'developer':
      return 'developer';
    case 'owner':
      return 'owner';
    default:
      return null;
  }
}
