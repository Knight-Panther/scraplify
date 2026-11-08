import { and, eq, sql } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../db/client.js';
import { type NewRealEstateListingRow, realEstateListings } from '../db/schema/index.js';
import { cleanupTestSource, createTestSource } from '../db/test-support.js';
import { refreshListingLocations } from './location.js';
import { LOCATION_RULES_VERSION } from './location-rules.js';
import { recordStreetPoint, syncPlaces } from './places.js';
import { refreshPlaceCatalogue } from './places/catalogue.js';
import { type CuratedPlaces, loadCuratedPlaces } from './places/curated.js';
import { loadOfficialMap, type OfficialMap, officialDistrictAt } from './places/official.js';

const NOW = '2026-11-08T14:00:00.000Z';
const LATER = '2026-11-09T14:00:00.000Z';

/** OSM relation ids of the official districts the tests use. */
const VAKE = 11300449;
const SABURTALO = 11300446;

let map: OfficialMap;
let curated: CuratedPlaces;
beforeAll(async () => {
  map = await loadOfficialMap();
  curated = await loadCuratedPlaces();
});

describe('refreshListingLocations (Phase 14C)', () => {
  const sourceIds: string[] = [];

  async function newSource(): Promise<string> {
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);
    return sourceId;
  }

  afterEach(async () => {
    for (const sourceId of sourceIds.splice(0)) await cleanupTestSource(sourceId);
  });

  /** Streets and sub-districts the fixtures use, as ss.ge names them. */
  const CHAVCHAVADZE = {
    subdistrictRef: 47,
    subdistrictName: 'ვაკე',
    streetRef: 501,
    streetName: 'ჭავჭავაძის გამზ.',
  };
  const VAZHA = {
    subdistrictRef: 3,
    subdistrictName: 'საბურთალო',
    streetRef: 507,
    streetName: 'ვაჟა-ფშაველას გამზ.',
  };
  const KAVTARADZE = {
    subdistrictRef: 3,
    subdistrictName: 'საბურთალო',
    streetRef: 503,
    streetName: 'ქავთარაძის ქ.',
  };
  const NO_STREET = { streetRef: null, streetName: null };

  /** A Tbilisi flat for sale, keyed by `key`, on no particular street unless told. */
  async function listing(
    sourceId: string,
    key: string,
    overrides: Partial<NewRealEstateListingRow> = {},
  ) {
    await db.insert(realEstateListings).values({
      sourceId,
      sourceListingKey: key,
      canonicalUrl: `https://example.invalid/${key}`,
      dealType: 'sale',
      propertyType: 'flat',
      cityRef: 95,
      cityName: 'თბილისი',
      districtRef: 3,
      districtName: 'ვაკე-საბურთალო',
      ...CHAVCHAVADZE,
      sourceUpdatedAt: NOW,
      expectedEndAt: LATER,
      firstSeenAt: NOW,
      lastSeenAt: NOW,
      contentHash: 'h',
      ...overrides,
    });
  }

  /** A pin the poster placed, unless told it was ss.ge's. */
  const pin = (latitude: number, longitude: number, pinManual = true) => ({
    latitude: latitude.toFixed(6),
    longitude: longitude.toFixed(6),
    pinManual,
  });

  async function located(sourceId: string, key: string) {
    const [row] = await db
      .select({
        officialDistrictRef: realEstateListings.officialDistrictRef,
        officialDistrictBasis: realEstateListings.officialDistrictBasis,
        locationPrecision: realEstateListings.locationPrecision,
        locationUncertain: realEstateListings.locationUncertain,
        locationFlags: realEstateListings.locationFlags,
        metroStation: realEstateListings.metroStation,
        metroMinutes: realEstateListings.metroMinutes,
        metroBasis: realEstateListings.metroBasis,
        metroNearby: realEstateListings.metroNearby,
        metroDistanceM: realEstateListings.metroDistanceM,
        buildingKey: realEstateListings.buildingKey,
        locationRules: realEstateListings.locationRules,
        pinTrusted: realEstateListings.pinTrusted,
        pinStreetM: realEstateListings.pinStreetM,
        pinOfficialDistrictRef: realEstateListings.pinOfficialDistrictRef,
      })
      .from(realEstateListings)
      .where(
        and(
          eq(realEstateListings.sourceId, sourceId),
          eq(realEstateListings.sourceListingKey, key),
        ),
      );
    return row;
  }

  async function refresh(sourceId: string) {
    await syncPlaces(db, { sourceId, at: NOW });
    const point = (streetRef: number, at: { latitude: number; longitude: number } | 'none') =>
      recordStreetPoint(db, {
        sourceId,
        streetRef,
        streetName: null,
        subdistrictRef: null,
        cityRef: null,
        point: at === 'none' ? { status: 'none' } : { status: 'known', ...at },
        readAt: NOW,
      });
    await point(501, { latitude: 41.70972, longitude: 44.7655 });
    await point(507, { latitude: 41.72386, longitude: 44.76181 });
    await point(503, 'none');
    await point(601, { latitude: 41.6459, longitude: 41.6347 });
    await refreshPlaceCatalogue(db, { sourceId, at: NOW, map, curated });
    return refreshListingLocations(db, { sourceId, map });
  }

  /**
   * Chavchavadze 501: three pins near ss.ge's point and one 2.6 km off, so
   * the street is located by their median, in Vake, 2 km from any station.
   * Vazha-Pshavela 507: one poster's pin, 376 m from ss.ge's point and 50 m
   * from Medical University, so located by that pin. Kavtaradze 503: no
   * point and two pins 7.9 km apart, so not located; Saburtalo's pins judge
   * them instead. Gorgiladze 601 in Batumi: no pin, so ss.ge's point.
   */
  async function city(sourceId: string) {
    await listing(sourceId, 'a1', { ...pin(41.71, 44.766), houseNumber: 12, streetNumber: '12' });
    await listing(sourceId, 'a2', pin(41.7095, 44.765));
    await listing(sourceId, 'a3', pin(41.7098, 44.7655));
    await listing(sourceId, 'a4-far', pin(41.725, 44.79));
    await listing(sourceId, 'b1-house', { ...VAZHA, houseNumber: 12, streetNumber: '12' });
    await listing(sourceId, 'b2-pin', {
      ...VAZHA,
      ...pin(41.727, 44.7635),
      houseNumber: 30,
      streetNumber: '30',
    });
    await listing(sourceId, 'b3-building', { ...VAZHA, houseNumber: 30, streetNumber: '30' });
    await listing(sourceId, 'b4-default', {
      ...VAZHA,
      ...pin(41.6938, 44.8015),
      ssMetro: { tavisuplebis_moedani: 5 },
    });
    await listing(sourceId, 'b5-broken', { ...VAZHA, ...pin(41.7882, 41.7882) });
    await listing(sourceId, 'b6-ssge-pin', { ...VAZHA, ...pin(41.75, 44.8, false) });
    await listing(sourceId, 'c1', { ...KAVTARADZE, ...pin(41.729, 44.745) });
    await listing(sourceId, 'c3-far', { ...KAVTARADZE, ...pin(41.8, 44.745) });
    await listing(sourceId, 'c4-house', { ...KAVTARADZE, houseNumber: 7, streetNumber: '7' });
    await listing(sourceId, 'd1', { ...KAVTARADZE, ...NO_STREET, ...pin(41.7295, 44.7455) });
    await listing(sourceId, 'e1-junk', { ...VAZHA, streetNumber: 'ოთახი25' });
    await listing(sourceId, 'e2-zero', { ...VAZHA, streetNumber: '0' });
    await listing(sourceId, 'e3-inferred', { ...VAZHA, districtInferred: true });
    await listing(sourceId, 'e4-complex', {
      ...VAZHA,
      complexRef: 77,
      houseNumber: 5,
      streetNumber: '5',
    });
    await listing(sourceId, 'f1-district', {
      ...NO_STREET,
      subdistrictRef: null,
      subdistrictName: null,
    });
    await listing(sourceId, 'f2-city', {
      ...NO_STREET,
      subdistrictRef: null,
      subdistrictName: null,
      districtRef: null,
      districtName: null,
    });
    await listing(sourceId, 'f3-nothing', {
      ...NO_STREET,
      subdistrictRef: null,
      subdistrictName: null,
      districtRef: null,
      districtName: null,
      cityRef: null,
      cityName: null,
    });
    await listing(sourceId, 'g1-batumi', {
      cityRef: 96,
      cityName: 'ბათუმი',
      districtRef: 8,
      districtName: 'ბათუმის უბნები',
      subdistrictRef: 64,
      subdistrictName: 'ძველი ბათუმის უბანი',
      streetRef: 601,
      streetName: 'გორგილაძის ქ.',
    });
    await listing(sourceId, 'h1-gone', { status: 'gone', goneAt: NOW });
  }

  it('trusts a poster’s pin near its street, and places the listing by it', async () => {
    const sourceId = await newSource();
    await city(sourceId);
    await refresh(sourceId);

    expect(await located(sourceId, 'b2-pin')).toMatchObject({
      officialDistrictRef: officialDistrictAt(map, 41.727, 44.7635)?.district.ref,
      officialDistrictBasis: 'pin',
      locationPrecision: 'pin',
      locationUncertain: false,
      locationFlags: [],
      metroStation: 'medical_uni',
      metroMinutes: 5,
      metroBasis: 'pin',
      metroNearby: ['medical_uni', 'tech_uni'],
      metroDistanceM: 50,
      buildingKey: 's507-30',
      locationRules: LOCATION_RULES_VERSION,
      pinTrusted: true,
      // Vazha-Pshavela's one pin locates the street itself.
      pinStreetM: 0,
    });
    // On a street located by its pins: a1 is 24 m from their median.
    expect(await located(sourceId, 'a1')).toMatchObject({
      officialDistrictRef: VAKE,
      officialDistrictBasis: 'pin',
      locationPrecision: 'pin',
      pinTrusted: true,
      // No station within 20 minutes of the middle of Vake: checked, and none.
      metroBasis: 'pin',
      metroStation: null,
      metroNearby: [],
    });
  });

  it('places a listing by its street when its pin is far from it, and says the location is uncertain', async () => {
    const sourceId = await newSource();
    await city(sourceId);
    await refresh(sourceId);

    const far = await located(sourceId, 'a4-far');
    expect(far).toMatchObject({
      officialDistrictRef: VAKE,
      officialDistrictBasis: 'street',
      locationPrecision: 'street',
      locationUncertain: true,
      locationFlags: ['pin_far_from_street'],
      metroBasis: 'street',
      metroStation: null,
      pinTrusted: false,
    });
    expect(far?.pinStreetM).toBeGreaterThan(2_500);
    // The pin's own district is kept, privately, so a new threshold can judge it again.
    expect(far?.pinOfficialDistrictRef).toBe(officialDistrictAt(map, 41.725, 44.79)?.district.ref);
  });

  it('trusts a pin far from a long street’s middle when another of the street’s pins is near it', async () => {
    const sourceId = await newSource();
    // Seven positions 250 m apart along Chavchavadze: 1.5 km of avenue.
    for (let i = 0; i < 7; i++) {
      await listing(sourceId, `line${i}`, pin(41.71, 44.75 + i * 0.003));
    }
    // 3 km east of the middle: two positions 65 m apart, each the other's neighbour.
    await listing(sourceId, 'pair0', pin(41.71, 44.8));
    await listing(sourceId, 'pair1', pin(41.7105, 44.8003));
    // 2.8 km off: one flat posted twice is one position, and its copies do not vouch for each other.
    await listing(sourceId, 'repost0', pin(41.725, 44.79));
    await listing(sourceId, 'repost1', pin(41.725, 44.79));
    await refresh(sourceId);

    const end = await located(sourceId, 'line0');
    expect(end).toMatchObject({ pinTrusted: true, locationFlags: [], locationPrecision: 'pin' });
    expect(end?.pinStreetM).toBeGreaterThan(800);
    for (const key of ['pair0', 'pair1']) {
      const paired = await located(sourceId, key);
      expect(paired).toMatchObject({ pinTrusted: true, locationFlags: [] });
      expect(paired?.pinStreetM).toBeGreaterThan(2_500);
    }
    for (const key of ['repost0', 'repost1']) {
      expect(await located(sourceId, key)).toMatchObject({
        pinTrusted: false,
        locationFlags: ['pin_far_from_street'],
        locationUncertain: true,
      });
    }
  });

  it('never judges a pin by ss.ge’s point: on a street its pins do not locate, by its sub-district’s pins', async () => {
    const sourceId = await newSource();
    // Vazha-Pshavela 507 (ss.ge's point 41.72386, 44.76181): one pin 70 m from the
    // point and one 2.3 km east of it disagree, so ss.ge's point locates the street.
    await listing(sourceId, 'near', { ...VAZHA, ...pin(41.7245, 44.762) });
    await listing(sourceId, 'east', { ...VAZHA, ...pin(41.7245, 44.79) });
    // More Saburtalo positions on no street, so the sub-district has a pin median
    // (41.7248, 44.763); 'north' is 3.9 km from it.
    await listing(sourceId, 'third', { ...VAZHA, ...NO_STREET, ...pin(41.725, 44.763) });
    await listing(sourceId, 'fourth', { ...VAZHA, ...NO_STREET, ...pin(41.7248, 44.7625) });
    await listing(sourceId, 'north', { ...VAZHA, ...NO_STREET, ...pin(41.76, 44.763) });
    await refresh(sourceId);

    // Only a gross error is caught by the sub-district: 3.9 km is within its 5 km.
    expect(await located(sourceId, 'north')).toMatchObject({ pinTrusted: true, locationFlags: [] });

    // 2.3 km from ss.ge's point, but well within Saburtalo's pins: trusted.
    const east = await located(sourceId, 'east');
    expect(east).toMatchObject({
      pinTrusted: true,
      locationFlags: [],
      locationUncertain: false,
      locationPrecision: 'pin',
      officialDistrictBasis: 'pin',
    });
    expect(east?.pinStreetM).toBeGreaterThan(2_000);
    expect(await located(sourceId, 'near')).toMatchObject({ pinTrusted: true, locationFlags: [] });
  });

  it('flags the map’s default and a broken pin, and ss.ge’s metro claim worked out from the default', async () => {
    const sourceId = await newSource();
    await city(sourceId);
    await refresh(sourceId);

    expect(await located(sourceId, 'b4-default')).toMatchObject({
      officialDistrictRef: SABURTALO,
      officialDistrictBasis: 'street',
      locationPrecision: 'street',
      locationUncertain: true,
      locationFlags: ['pin_placeholder', 'metro_from_untrusted_pin'],
      // From the street, which b2-pin locates, 50 m from Medical University.
      metroBasis: 'street',
      metroStation: 'medical_uni',
      metroMinutes: 5,
      pinTrusted: false,
      pinOfficialDistrictRef: null,
    });
    // Broken, with no metro claim: ignored, and nothing about the listing is in doubt.
    expect(await located(sourceId, 'b5-broken')).toMatchObject({
      locationUncertain: false,
      locationFlags: ['pin_broken'],
      locationPrecision: 'street',
      pinTrusted: false,
    });
    // A pin ss.ge set itself is not judged at all.
    expect(await located(sourceId, 'b6-ssge-pin')).toMatchObject({
      locationFlags: [],
      locationUncertain: false,
      pinTrusted: false,
      pinStreetM: null,
    });
  });

  it('judges a pin on a street with no location by its sub-district’s pins', async () => {
    const sourceId = await newSource();
    await city(sourceId);
    await refresh(sourceId);

    expect(await located(sourceId, 'c1')).toMatchObject({
      officialDistrictBasis: 'pin',
      locationPrecision: 'pin',
      pinTrusted: true,
      pinStreetM: null,
    });
    expect(await located(sourceId, 'd1')).toMatchObject({
      locationPrecision: 'pin',
      pinTrusted: true,
    });
    // 7.9 km from Saburtalo's pins, on an unlocated street, in a sub-district too thin to place it.
    expect(await located(sourceId, 'c3-far')).toMatchObject({
      officialDistrictRef: null,
      officialDistrictBasis: null,
      locationPrecision: 'subdistrict',
      locationUncertain: true,
      locationFlags: ['pin_far_from_area'],
      metroBasis: null,
      metroStation: null,
      metroNearby: null,
      pinTrusted: false,
    });
  });

  it('takes the metro from a trusted pin in the same building when the listing has none', async () => {
    const sourceId = await newSource();
    await city(sourceId);
    await refresh(sourceId);

    expect(await located(sourceId, 'b3-building')).toMatchObject({
      officialDistrictRef: SABURTALO,
      officialDistrictBasis: 'street',
      locationPrecision: 'house',
      metroBasis: 'building',
      metroStation: 'medical_uni',
      metroMinutes: 5,
      buildingKey: 's507-30',
      pinTrusted: null,
    });
    // Another house on the street: its metro is the street's, which b2-pin locates.
    expect(await located(sourceId, 'b1-house')).toMatchObject({
      officialDistrictRef: SABURTALO,
      officialDistrictBasis: 'street',
      locationPrecision: 'house',
      metroBasis: 'street',
      metroStation: 'medical_uni',
      metroMinutes: 5,
      metroNearby: ['medical_uni', 'tech_uni'],
      metroDistanceM: 50,
      buildingKey: 's507-12',
    });
    expect((await located(sourceId, 'e4-complex'))?.buildingKey).toBe('c77');
  });

  it('says how precisely each listing is placed, down to none, and flags a house number it could not read', async () => {
    const sourceId = await newSource();
    await city(sourceId);
    await refresh(sourceId);

    expect(await located(sourceId, 'e1-junk')).toMatchObject({
      locationPrecision: 'street',
      locationFlags: ['house_number_junk'],
      locationUncertain: false,
      buildingKey: null,
    });
    expect((await located(sourceId, 'e2-zero'))?.locationFlags).toEqual([]);
    expect((await located(sourceId, 'e3-inferred'))?.locationFlags).toEqual(['district_inferred']);
    // A house number on a street with no location places it no better than its sub-district.
    expect(await located(sourceId, 'c4-house')).toMatchObject({
      locationPrecision: 'subdistrict',
      buildingKey: 's503-7',
    });
    expect((await located(sourceId, 'f1-district'))?.locationPrecision).toBe('district');
    expect((await located(sourceId, 'f2-city'))?.locationPrecision).toBe('city');
    expect(await located(sourceId, 'f3-nothing')).toMatchObject({
      locationPrecision: 'none',
      officialDistrictRef: null,
      metroBasis: null,
    });
    // Batumi: on a located street, outside Tbilisi's map, with no metro near.
    expect(await located(sourceId, 'g1-batumi')).toMatchObject({
      locationPrecision: 'street',
      officialDistrictRef: null,
      officialDistrictBasis: null,
      metroBasis: 'street',
      metroStation: null,
      metroNearby: [],
    });
    // A gone listing keeps what it had.
    expect(await located(sourceId, 'h1-gone')).toMatchObject({
      locationPrecision: null,
      locationRules: null,
    });
  });

  it('places a sub-district’s other listings when its trusted pins lie almost all in one official district', async () => {
    const sourceId = await newSource();
    // Ten positions, the fewest that place a sub-district, all in Vake.
    const vakeArea = { ...NO_STREET, subdistrictRef: 36, subdistrictName: 'ზემო ვაკე' };
    for (let i = 0; i < 10; i++) {
      await listing(sourceId, `v${i}`, { ...vakeArea, ...pin(41.708 + i * 0.0001, 44.762) });
    }
    await listing(sourceId, 'v-unpinned', vakeArea);
    // Saburtalo's three trusted pins are too few to place its other listings.
    await listing(sourceId, 's1', { ...VAZHA, ...NO_STREET, ...pin(41.727, 44.7635) });
    await listing(sourceId, 's2', { ...VAZHA, ...NO_STREET, ...pin(41.7272, 44.7637) });
    await listing(sourceId, 's3', { ...VAZHA, ...pin(41.7271, 44.7636) });
    await listing(sourceId, 's-unpinned', { ...VAZHA, ...NO_STREET });

    const result = await refresh(sourceId);
    expect(result).toMatchObject({ pins: 13, trusted: 13, flagged: 0, areas: 1 });
    expect(await located(sourceId, 'v-unpinned')).toMatchObject({
      officialDistrictRef: VAKE,
      officialDistrictBasis: 'area',
      locationPrecision: 'subdistrict',
      metroBasis: null,
    });
    expect(await located(sourceId, 's-unpinned')).toMatchObject({
      officialDistrictRef: null,
      officialDistrictBasis: null,
    });
  });

  it('writes nothing the second time, and judges a listing again under new rules', async () => {
    const sourceId = await newSource();
    await city(sourceId);
    const first = await refresh(sourceId);
    expect(first.written).toBe(22);
    const second = await refreshListingLocations(db, { sourceId, map });
    expect(second.written).toBe(0);

    await db.execute(sql`
      update realestate.listings set location_rules = 0
       where source_id = ${sourceId} and source_listing_key = 'b2-pin'
    `);
    expect((await refreshListingLocations(db, { sourceId, map })).written).toBe(1);
    expect((await located(sourceId, 'b2-pin'))?.locationRules).toBe(LOCATION_RULES_VERSION);
  });
});
