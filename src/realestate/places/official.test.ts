import { beforeAll, describe, expect, it } from 'vitest';
import {
  BORDER_METERS,
  loadOfficialMap,
  type OfficialMap,
  officialDistrictAt,
} from './official.js';

let map: OfficialMap;
beforeAll(async () => {
  map = await loadOfficialMap();
});

/**
 * Each expected district is Nominatim's own answer for the point, on OSM's
 * full-detail borders (reverse geocoding, 2026-11-07), not this code's. The
 * stations are OSM's nodes; a neighbourhood's point is the middle of
 * production's pins in that ss.ge sub-district (2026-11-07).
 */
const KNOWN: ReadonlyArray<readonly [string, number, number, string]> = [
  ['Liberty Square metro', 41.694525, 44.800563, 'mtatsminda'],
  ['Avlabari metro', 41.692259, 44.815841, 'isani'],
  ['Isani metro', 41.686625, 44.839963, 'isani'],
  ['Varketili metro', 41.691897, 44.870885, 'samgori'],
  ['Akhmeteli metro', 41.791056, 44.814998, 'gldani'],
  // The station named Didube is officially in Nadzaladevi.
  ['Didube metro', 41.749452, 44.779994, 'nadzaladevi'],
  ['Delisi metro', 41.725487, 44.745341, 'saburtalo'],
  ['State University metro', 41.722825, 44.718511, 'vake'],
  ['Marjanishvili metro', 41.709594, 44.796875, 'chughureti'],
  ['Station Square metro', 41.722561, 44.797105, 'chughureti'],
  ['Medical University metro', 41.727279, 44.76384, 'saburtalo'],
  ['Samgori metro', 41.685518, 44.854483, 'isani'],
  ['Didube', 41.73929, 44.77885, 'didube'],
  ['Saburtalo', 41.72386, 44.76181, 'saburtalo'],
  ['Varketili', 41.69617, 44.87119, 'samgori'],
  ['Isani', 41.68165, 44.84056, 'isani'],
  // ss.ge lists these under Old Tbilisi, Old Tbilisi, Old Tbilisi, Gldani-Nadzaladevi and Didube-Chughureti.
  ['Ortachala', 41.67632, 44.82299, 'krtsanisi'],
  ['Avlabari', 41.68996, 44.82332, 'isani'],
  ['Elia', 41.69851, 44.8251, 'isani'],
  ['Temqa', 41.77852, 44.80875, 'nadzaladevi'],
  ['Ivertubani', 41.72737, 44.8358, 'chughureti'],
  ['Vera', 41.7046, 44.78469, 'mtatsminda'],
  ['Chughureti', 41.70974, 44.79952, 'chughureti'],
  ['Gldani', 41.80269, 44.81025, 'gldani'],
  ['Nadzaladevi', 41.74318, 44.78983, 'nadzaladevi'],
  ['Bagebi', 41.70918, 44.73414, 'vake'],
  ['Vake', 41.70972, 44.7655, 'vake'],
  ['Mtatsminda', 41.69772, 44.79558, 'mtatsminda'],
];

describe('the official map file', () => {
  it('has the 10 districts, each named, and the 22 stations ss.ge names', () => {
    expect(map.districts.map((d) => d.code).sort()).toEqual([
      'chughureti',
      'didube',
      'gldani',
      'isani',
      'krtsanisi',
      'mtatsminda',
      'nadzaladevi',
      'saburtalo',
      'samgori',
      'vake',
    ]);
    expect(map.stations).toHaveLength(22);
    // Every station code ss.ge sent in the 14A trial (2026-11-07).
    expect(map.stations.map((s) => s.code).sort()).toEqual([
      'akhmeteli',
      'avlabari',
      'delisi',
      'didube',
      'gotsiridze',
      'grmagele',
      'guramishvili',
      'isani',
      'marjanishvili',
      'medical_uni',
      'nadzaladevi',
      'rustaveli',
      'samasi_aragveli',
      'samgori',
      'sarajishvili',
      'state_uni',
      'station_square',
      'tavisuplebis_moedani',
      'tech_uni',
      'tsereteli',
      'varketili',
      'vazha_pshavela',
    ]);
    expect(new Set(map.stations.map((s) => s.ref)).size).toBe(22);
  });
});

/** Degrees for a distance in metres at 41.7°N. */
const north = (meters: number) => meters / 111_195;
const east = (meters: number) => meters / (111_195 * Math.cos((41.7 * Math.PI) / 180));

/**
 * Two adjoining square districts, 0.01° a side (about 1.1 km by 0.8 km): A
 * from 44.70°E, with a hole in its middle, and B east of it.
 */
function syntheticMap(): OfficialMap {
  const square = (west: number, south: number, size: number): [number, number][] => [
    [west, south],
    [west + size, south],
    [west + size, south + size],
    [west, south + size],
    [west, south],
  ];
  const district = (ref: number, code: string, rings: [number, number][][]) => ({
    ref,
    code,
    nameKa: code,
    nameEn: code,
    rings,
  });
  return {
    fetchedAt: 'test',
    districts: [
      district(1, 'a', [square(44.7, 41.7, 0.01), square(44.704, 41.704, 0.002)]),
      district(2, 'b', [square(44.71, 41.7, 0.01)]),
    ],
    stations: [],
  };
}

describe('officialDistrictAt, on exact squares', () => {
  const squares = syntheticMap();
  const at = (lat: number, lng: number) => {
    const place = officialDistrictAt(squares, lat, lng);
    return place && { code: place.district.code, basis: place.basis, meters: place.borderMeters };
  };

  it('is inside, away from every border', () => {
    expect(at(41.702, 44.702)).toEqual({ code: 'a', basis: 'inside', meters: 166 });
  });

  it('is on the border within 50 m of it, on either side', () => {
    expect(at(41.702, 44.7 + east(20))).toEqual({ code: 'a', basis: 'border', meters: 20 });
    expect(at(41.702, 44.7 - east(30))).toEqual({ code: 'a', basis: 'border', meters: 30 });
    expect(at(41.702, 44.71 + east(10))).toEqual({ code: 'b', basis: 'border', meters: 10 });
  });

  it('is nowhere further out, or deep in a hole', () => {
    expect(at(41.702, 44.7 - east(80))).toBeNull();
    expect(at(41.7 - north(60), 44.702)).toBeNull();
    expect(at(41.705, 44.705)).toBeNull();
    // Near the hole's edge, the district around it.
    expect(at(41.705, 44.704 + east(15))).toEqual({ code: 'a', basis: 'border', meters: 15 });
  });
});

describe('officialDistrictAt', () => {
  it.each(KNOWN)('%s is in the right district', (_label, lat, lng, code) => {
    const place = officialDistrictAt(map, lat, lng);
    expect(place?.district.code).toBe(code);
  });

  it('marks a point near a border, and says how near', () => {
    // A corner of Vake's border, then 20 m north of it.
    const [lng, lat] = map.districts.find((d) => d.code === 'vake')?.rings[0]?.[0] ?? [0, 0];
    const near = officialDistrictAt(map, lat + 20 / 111_195, lng);
    expect(near?.basis).toBe('border');
    expect(near?.borderMeters).toBeLessThanOrEqual(BORDER_METERS);
    const deep = officialDistrictAt(map, 41.70972, 44.7655);
    expect(deep?.basis).toBe('inside');
    expect(deep?.borderMeters).toBeGreaterThan(BORDER_METERS);
  });

  it('places nothing outside the city', () => {
    expect(officialDistrictAt(map, 41.8456, 44.7206)).toBeNull(); // Mtskheta
    expect(officialDistrictAt(map, 41.6168, 41.6367)).toBeNull(); // Batumi
    expect(officialDistrictAt(map, 0, 0)).toBeNull();
  });
});
