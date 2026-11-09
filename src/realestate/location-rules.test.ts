import { describe, expect, it } from 'vitest';
import { buildingKey, median, metroMinutes, metroNear } from './location-rules.js';

describe('metroMinutes', () => {
  it('reads ss.ge’s bands from straight-line metres, and nothing past the last', () => {
    expect([0, 325, 326, 625, 626, 1_000, 1_001, 1_325, 1_326].map(metroMinutes)).toEqual([
      5,
      5,
      10,
      10,
      15,
      15,
      20,
      20,
      null,
    ]);
  });
});

describe('metroNear', () => {
  const stations = [
    { code: 'medical_uni', lat: 41.727279, lng: 44.76384 },
    { code: 'tech_uni', lat: 41.720349, lng: 44.776643 },
    { code: 'delisi', lat: 41.725487, lng: 44.745341 },
  ];

  it('gives the nearest station, its band, its distance to 50 m, and every station in the bands, nearest first', () => {
    expect(metroNear(stations, 41.72386, 44.76181)).toEqual({
      station: 'medical_uni',
      minutes: 10,
      distanceM: 400,
      nearby: ['medical_uni', 'tech_uni'],
    });
  });

  it('gives no station where none is within the bands, as in the middle of Vake', () => {
    expect(metroNear(stations, 41.70972, 44.7655)).toEqual({
      station: null,
      minutes: null,
      distanceM: null,
      nearby: [],
    });
  });
});

describe('median', () => {
  it('interpolates an even count, as percentile_cont(0.5) does', () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([7])).toBe(7);
  });
});

describe('buildingKey', () => {
  const none = { complexRef: null, streetRef: null, houseNumber: null, houseSuffix: null };

  it('keys a complex by itself, else a street and house number with its letter', () => {
    expect(buildingKey({ ...none, complexRef: 77, streetRef: 501, houseNumber: 12 })).toBe('c77');
    expect(buildingKey({ ...none, streetRef: 501, houseNumber: 117, houseSuffix: 'დ' })).toBe(
      's501-117დ',
    );
    expect(buildingKey({ ...none, streetRef: 501, houseNumber: 12 })).toBe('s501-12');
  });

  it('keys nothing without a house number or without a street', () => {
    expect(buildingKey({ ...none, streetRef: 501 })).toBeNull();
    expect(buildingKey({ ...none, houseNumber: 12 })).toBeNull();
  });
});
