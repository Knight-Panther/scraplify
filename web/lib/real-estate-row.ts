import type { DealType } from '../../src/realestate/kinds.js';
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
  commercial: 'Commercial space',
  land: 'Land',
  hotel: 'Hotel',
};

export const DEAL_LABELS: Readonly<Record<RealEstateRow['dealType'], string>> = {
  sale: 'for sale',
  rent: 'for rent',
  daily: 'for daily rent',
  pledge: 'for pledge',
};

/** ss.ge's commercial space types (`COMMERCIAL_TYPE_CODES`), in its own English where it has one. */
export const COMMERCIAL_TYPE_LABELS: Readonly<Record<number, string>> = {
  6: 'Warehouse / production',
  7: 'Office',
  13: 'Catering',
  14: 'Garage',
  21: 'Basement',
  22: 'Retail',
  31: 'Commercial space',
};

/** ss.ge's land types (`LAND_TYPE_CODES`). */
export const LAND_TYPE_LABELS: Readonly<Record<number, string>> = {
  1: 'Agricultural',
  2: 'Non-agricultural',
  3: 'Commercial',
  4: 'Special purpose',
  5: 'Investment',
  6: 'Farm',
};

/**
 * A commercial space's or a plot's type in words; `Other` for a code ss.ge
 * added after this list was made, null where the kind has no sub-type or the
 * listing gives none.
 */
export function subTypeLabel(row: RealEstateRow): string | null {
  if (row.propertyType === 'commercial' && row.commercialType !== null) {
    return COMMERCIAL_TYPE_LABELS[row.commercialType] ?? 'Other';
  }
  if (row.propertyType === 'land' && row.landType !== null) {
    return LAND_TYPE_LABELS[row.landType] ?? 'Other';
  }
  return null;
}

/** "Office for rent", "Agricultural land for sale"; the kind alone where the sub-type is not known. */
export function listingLabel(row: RealEstateRow): string {
  const deal = DEAL_LABELS[row.dealType];
  const sub = subTypeLabel(row);
  if (sub === null || sub === 'Other') return `${KIND_LABELS[row.propertyType]} ${deal}`;
  return row.propertyType === 'land' ? `${sub} land ${deal}` : `${sub} ${deal}`;
}

/** What a price is for, where it is not the whole deal: daily rent is priced by the night. */
const PRICE_UNIT: Partial<Record<DealType, string>> = { daily: 'a night' };

/** The price as stated, with what it is for where that is not plain: "$31 a night". */
export function priceText(row: RealEstateRow, currency: Currency): string | null {
  const price = priceOf(row, currency);
  if (price === null) return null;
  const unit = PRICE_UNIT[row.dealType];
  return unit === undefined ? money(price, currency) : `${money(price, currency)} ${unit}`;
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
