import { describe, expect, it } from 'vitest';
import {
  AMENITY_FIELDS,
  type AmenityKey,
  BUILDING_STATUSES,
  COMMERCIAL_TYPE_CODES,
  CONDITIONS,
  DEAL_TYPES,
  FLOOR_TYPES,
  LAND_TYPE_CODES,
  POSTER_ENTITIES,
  PROJECTS,
  PROPERTY_TYPES,
  vocabularyKey,
} from './kinds.js';

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

describe('listing-page vocabularies', () => {
  it('has a key for every value in the 2026-11-03 filter panels', () => {
    // The panels' own Georgian labels, as ss.ge showed them on 2026-11-03.
    const statuses = ['ახალი აშენებული', 'მშენებარე', 'ძველი აშენებული'];
    const conditions = [
      'სარემონტო',
      'მიმდინარე რემონტი',
      'ძველი რემონტით',
      'გარემონტებული',
      'ახალი რემონტით',
      'მწვანე კარკასი',
      'შავი კარკასი',
      'თეთრი კარკასი',
    ];
    const projects = [
      'არასტანდარტული',
      'ლენინგრადის',
      'ლვოვის',
      'კიევი',
      'თბილისური ეზო',
      'მოსკოვის',
      'ქალაქური',
      'ჩეხური',
      'ხრუშჩოვის',
      'თუხარელის',
      'ვეძისი',
      'იუგოსლავიის',
      'მეტრომშენის',
      'ყავლაშვილის',
    ];
    const floorTypes = ['დუპლექსი', 'ტრიპლექსი', 'სხვენი'];
    for (const label of statuses)
      expect(vocabularyKey(BUILDING_STATUSES, label), label).not.toBeNull();
    for (const label of conditions) expect(vocabularyKey(CONDITIONS, label), label).not.toBeNull();
    for (const label of projects) expect(vocabularyKey(PROJECTS, label), label).not.toBeNull();
    for (const label of floorTypes) expect(vocabularyKey(FLOOR_TYPES, label), label).not.toBeNull();
    // Every key distinct, so no two labels collapse into one filter value.
    for (const map of [BUILDING_STATUSES, CONDITIONS, PROJECTS, FLOOR_TYPES]) {
      const keys = Object.values(map);
      expect(new Set(keys).size).toBe(keys.length);
    }
    expect(BUILDING_STATUSES['მშენებარე']).toBe('under-construction');
    expect(CONDITIONS['ახალი რემონტით']).toBe('newly-renovated');
    // Text it does not hold is unknown, and so is anything inherited from Object.
    expect(vocabularyKey(CONDITIONS, 'კარგი')).toBeNull();
    expect(vocabularyKey(CONDITIONS, 'toString')).toBeNull();
    expect(vocabularyKey(CONDITIONS, 7)).toBeNull();
    expect(vocabularyKey(CONDITIONS, ' ახალი რემონტით ')).toBe('newly-renovated');
  });

  it("maps the poster's type and every amenity field ss.ge marks", () => {
    // A construction company's page says "Construction" (listing 3671991, 2026-11-04).
    expect(POSTER_ENTITIES).toEqual({
      Individual: 'individual',
      Broker: 'broker',
      Agency: 'agency',
      Construction: 'developer',
    });
    expect(Object.keys(AMENITY_FIELDS)).toHaveLength(33);
    expect(AMENITY_FIELDS.heating).toBe('central-heating');
    expect(AMENITY_FIELDS.hasRemoteViewing).toBe('video-viewing');
    expect(AMENITY_FIELDS.isPetFriendly).toBe('pets-allowed');
    const keys: AmenityKey[] = Object.values(AMENITY_FIELDS);
    expect(new Set(keys).size).toBe(33);
  });
});
