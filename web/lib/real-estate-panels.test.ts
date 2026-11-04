import { describe, expect, it } from 'vitest';
import {
  AMENITY_FIELDS,
  BUILDING_STATUSES,
  CONDITIONS,
  DEAL_TYPES,
  FLOOR_TYPES,
  PROJECTS,
  PROPERTY_TYPES,
} from '../../src/realestate/kinds.js';
import {
  AMENITY_LABELS,
  amenitiesFor,
  BUILDING_STATUS_LABELS,
  CONDITION_LABELS,
  COUNT_CHOICES,
  countLabel,
  FLOOR_TYPE_LABELS,
  GROUP_LABELS,
  LISTING_TYPE_LABELS,
  LISTING_TYPES,
  OTHER_INFO,
  PANELS,
  PROJECT_LABELS,
} from './real-estate-panels.js';

/*
 * Each panel as ss.ge's "მეტი ფილტრი" showed it on 2026-11-03 (add.md, "Recon
 * facts"); cottage for rent rechecked on 2026-11-04 and found the same as
 * house for rent.
 */

describe('what each kind’s "more filters" panel offers', () => {
  it.each([
    [
      'flat',
      [
        'status',
        'area',
        'rooms',
        'condition',
        'kitchen-area',
        'floor',
        'floor-type',
        'balconies',
        'bathrooms',
        'project',
        'other-info',
        'listing-type',
        'amenities',
      ],
    ],
    [
      'house',
      ['status', 'house-area', 'yard-area', 'rooms', 'condition', 'listing-type', 'amenities'],
    ],
    [
      'cottage',
      ['status', 'house-area', 'yard-area', 'rooms', 'condition', 'listing-type', 'amenities'],
    ],
    ['commercial', ['area', 'status', 'condition', 'listing-type', 'amenities']],
    ['land', ['area', 'listing-type', 'amenities']],
    ['hotel', ['status', 'area', 'rooms', 'condition', 'listing-type', 'amenities']],
  ] as const)('offers a %s the groups ss.ge does, in its order', (kind, groups) => {
    expect(PANELS[kind]).toEqual(groups);
  });

  it('offers flats for sale the 11 amenities ss.ge offered on 2026-11-03', () => {
    expect(amenitiesFor('flat', 'sale')).toEqual([
      'central-heating',
      'natural-gas',
      'balcony',
      'garage',
      'top-floor',
      'storage',
      'elevator',
      'basement',
      'furniture',
      'built-in-kitchen',
      'video-viewing',
    ]);
  });

  it('offers flats for rent, daily rent and pledge the 21 amenities of the rent panel', () => {
    const rent = [
      'central-heating',
      'natural-gas',
      'balcony',
      'garage',
      'storage',
      'elevator',
      'basement',
      'air-conditioning',
      'cable-tv',
      'fridge',
      'furniture',
      'double-glazing',
      'hot-water',
      'internet',
      'iron-door',
      'alarm',
      'telephone',
      'tv',
      'washing-machine',
      'video-viewing',
      'pets-allowed',
    ];
    expect(amenitiesFor('flat', 'rent')).toEqual(rent);
    expect(amenitiesFor('flat', 'daily')).toEqual(rent);
    expect(amenitiesFor('flat', 'pledge')).toEqual(rent);
  });

  it('offers houses and cottages for sale the 11 amenities ss.ge offered', () => {
    const sale = [
      'central-heating',
      'natural-gas',
      'balcony',
      'garage',
      'storage',
      'basement',
      'drinking-water',
      'furniture',
      'built-in-kitchen',
      'pool',
      'video-viewing',
    ];
    expect(amenitiesFor('house', 'sale')).toEqual(sale);
    expect(amenitiesFor('cottage', 'sale')).toEqual(sale);
  });

  it('offers houses and cottages for rent the 23 amenities ss.ge offered', () => {
    const rent = [
      'central-heating',
      'natural-gas',
      'balcony',
      'garage',
      'storage',
      'elevator',
      'basement',
      'air-conditioning',
      'cable-tv',
      'drinking-water',
      'fridge',
      'furniture',
      'double-glazing',
      'hot-water',
      'internet',
      'iron-door',
      'alarm',
      'telephone',
      'tv',
      'washing-machine',
      'pool',
      'video-viewing',
      'pets-allowed',
    ];
    expect(amenitiesFor('house', 'rent')).toEqual(rent);
    expect(amenitiesFor('cottage', 'rent')).toEqual(rent);
  });

  it('offers commercial space for sale 18 amenities, and for rent the same without a built-in kitchen and with pets', () => {
    const sale = [
      'central-heating',
      'natural-gas',
      'balcony',
      'garage',
      'storage',
      'basement',
      'air-conditioning',
      'cable-tv',
      'fridge',
      'furniture',
      'built-in-kitchen',
      'double-glazing',
      'internet',
      'iron-door',
      'alarm',
      'telephone',
      'tv',
      'video-viewing',
    ];
    expect(amenitiesFor('commercial', 'sale')).toEqual(sale);
    expect(amenitiesFor('commercial', 'rent')).toEqual([
      ...sale.filter((key) => key !== 'built-in-kitchen'),
      'pets-allowed',
    ]);
  });

  it('offers land and hotels the same amenities for every deal', () => {
    for (const deal of DEAL_TYPES) {
      expect(amenitiesFor('land', deal)).toEqual([
        'natural-gas',
        'electricity',
        'sewage',
        'water',
        'video-viewing',
      ]);
      expect(amenitiesFor('hotel', deal)).toEqual([
        'balcony',
        'air-conditioning',
        'fridge',
        'furniture',
        'built-in-kitchen',
        'hot-water',
        'tv',
        'wifi',
        'video-viewing',
      ]);
    }
  });

  it('offers every amenity of any deal when no deal is chosen, each once', () => {
    const any = amenitiesFor('flat', undefined);
    expect(new Set(any).size).toBe(any.length);
    expect([...any].sort()).toEqual(
      [...new Set([...amenitiesFor('flat', 'sale'), ...amenitiesFor('flat', 'rent')])].sort(),
    );
    expect(any).toContain('top-floor');
    expect(any).toContain('pets-allowed');
  });

  it('keeps "other information" (yard view, street view, bright, cozy) for flats, apart from the amenities', () => {
    expect(OTHER_INFO).toEqual(['yard-view', 'street-view', 'bright', 'cozy']);
    for (const kind of PROPERTY_TYPES) {
      expect(PANELS[kind].includes('other-info')).toBe(kind === 'flat');
      for (const deal of DEAL_TYPES) {
        for (const key of OTHER_INFO) expect(amenitiesFor(kind, deal)).not.toContain(key);
      }
    }
  });

  it('offers rooms 1 to 10+, bathrooms 1 to 5+ or none, balconies 1 to 5+ or none', () => {
    expect(COUNT_CHOICES.rooms.map((count) => countLabel('rooms', count))).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
      '10+',
    ]);
    expect(COUNT_CHOICES.bathrooms.map((count) => countLabel('bathrooms', count))).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5+',
      'None',
    ]);
    expect(COUNT_CHOICES.balconies.map((count) => countLabel('balconies', count))).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5+',
      'None',
    ]);
  });
});

describe('panel labels', () => {
  const labelled = (labels: Readonly<Record<string, string>>, keys: readonly string[]) => {
    for (const key of keys) {
      const label = labels[key];
      expect(label, key).toBeTypeOf('string');
      expect(label?.trim(), key).not.toBe('');
      // English only: a Georgian value never reaches the screen as stored.
      expect(label, key).not.toMatch(/[Ⴀ-ჿ]/);
    }
  };

  it('labels every group, value and listing type a panel can offer', () => {
    labelled(GROUP_LABELS, [...new Set(Object.values(PANELS).flat())]);
    labelled(BUILDING_STATUS_LABELS, Object.values(BUILDING_STATUSES));
    labelled(CONDITION_LABELS, Object.values(CONDITIONS));
    labelled(PROJECT_LABELS, Object.values(PROJECTS));
    labelled(FLOOR_TYPE_LABELS, Object.values(FLOOR_TYPES));
    labelled(AMENITY_LABELS, Object.values(AMENITY_FIELDS));
    labelled(LISTING_TYPE_LABELS, LISTING_TYPES);
  });

  it('uses ss.ge’s own English for conditions, and calls the group "Condition", not ss.ge’s "Status"', () => {
    expect(CONDITION_LABELS['needs-renovation']).toBe('Not renovated');
    expect(CONDITION_LABELS['old-renovation']).toBe('Old renovated');
    expect(CONDITION_LABELS['newly-renovated']).toBe('Newly renovated');
    expect(GROUP_LABELS.condition).toBe('Condition');
    expect(GROUP_LABELS.status).not.toBe(GROUP_LABELS.condition);
  });
});
