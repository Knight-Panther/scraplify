import { describe, expect, it } from 'vitest';
import { COMMERCIAL_TYPE_CODES, DEAL_TYPES, LAND_TYPE_CODES, PROPERTY_TYPES } from './kinds.js';

describe('kinds and deals', () => {
  it('keeps the stored kinds and deals first, in the database enum order', () => {
    // Postgres enum values can only be appended, so the ones already stored keep their places.
    expect(PROPERTY_TYPES.slice(0, 3)).toEqual(['flat', 'house', 'cottage']);
    expect(DEAL_TYPES.slice(0, 2)).toEqual(['sale', 'rent']);
  });

  it('names every kind and deal ss.ge offers', () => {
    expect(PROPERTY_TYPES).toEqual(['flat', 'house', 'cottage', 'commercial', 'land', 'hotel']);
    expect(DEAL_TYPES).toEqual(['sale', 'rent', 'daily', 'pledge']);
  });

  it("keys ss.ge's commercial space and land type codes", () => {
    expect(Object.keys(COMMERCIAL_TYPE_CODES).map(Number)).toEqual([6, 7, 13, 14, 21, 22, 31]);
    expect(Object.keys(LAND_TYPE_CODES).map(Number)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
