import { asc, eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db, pool } from '../../db/client.js';
import {
  type NewRealEstateListingRow,
  realEstateListings,
  realEstatePlaces,
} from '../../db/schema/index.js';
import { cleanupTestSource, createTestSource } from '../../db/test-support.js';
import { placeLookupSql, placeTextLookupSql, resolvePlaceText } from '../place-lookup.js';
import { recordStreetPoint, syncPlaces } from '../places.js';
import { matchKeys, refreshPlaceCatalogue } from './catalogue.js';
import { type CuratedPlaces, loadCuratedPlaces } from './curated.js';
import { loadOfficialMap, type OfficialMap, officialDistrictAt } from './official.js';

const NOW = '2026-11-08T14:00:00.000Z';
const LATER = '2026-11-09T14:00:00.000Z';

/** OSM relation ids of the official districts the tests use. */
const VAKE = 11300449;
const SABURTALO = 11300446;
const ISANI = 13438808;
const NADZALADEVI = 11300438;

let map: OfficialMap;
let curated: CuratedPlaces;
beforeAll(async () => {
  map = await loadOfficialMap();
  curated = await loadCuratedPlaces();
});

describe('matchKeys', () => {
  it("finds an official district by its name, without the district word, and with either language's word", () => {
    expect(matchKeys('official_district', ['ისნის რაიონი', 'Isani District'])).toEqual([
      'isan',
      'isan district',
      'isan raion',
      'isn',
      'isn district',
      'isn raion',
    ]);
  });

  it('gives any other place its names only, once each', () => {
    expect(matchKeys('subdistrict', ['ვაკე', 'Vake', 'vake'])).toEqual(['vak']);
    expect(matchKeys('street', ['ქ.', 'ჭავჭავაძის გამზ.'])).toEqual(['cavcavaz']);
  });
});

describe('the place catalogue (Phase 14B)', () => {
  const sourceIds: string[] = [];
  let nextKey = 1;

  async function newSource(): Promise<string> {
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);
    return sourceId;
  }

  afterEach(async () => {
    for (const sourceId of sourceIds.splice(0)) await cleanupTestSource(sourceId);
  });

  /** A Tbilisi flat in Vake on Chavchavadze Ave, unless told otherwise. */
  async function listing(sourceId: string, overrides: Partial<NewRealEstateListingRow> = {}) {
    const key = `c${nextKey++}`;
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
      subdistrictRef: 47,
      subdistrictName: 'ვაკე',
      streetRef: 501,
      streetName: 'ჭავჭავაძის გამზ.',
      sourceUpdatedAt: NOW,
      expectedEndAt: LATER,
      firstSeenAt: NOW,
      lastSeenAt: NOW,
      contentHash: 'h',
      ...overrides,
    });
  }

  async function point(
    sourceId: string,
    streetRef: number,
    at: { latitude: number; longitude: number } | 'none',
  ) {
    await recordStreetPoint(db, {
      sourceId,
      streetRef,
      streetName: null,
      subdistrictRef: null,
      cityRef: null,
      point: at === 'none' ? { status: 'none' } : { status: 'known', ...at },
      readAt: NOW,
    });
  }

  async function rows(sourceId: string) {
    return db
      .select()
      .from(realEstatePlaces)
      .where(eq(realEstatePlaces.sourceId, sourceId))
      .orderBy(asc(realEstatePlaces.level), asc(realEstatePlaces.ref));
  }

  async function row(sourceId: string, level: string, ref: number) {
    return (await rows(sourceId)).find((r) => r.level === level && r.ref === ref);
  }

  /** The last point north of Vake's middle that is still in Vake: within 10 m of its border. */
  function vakeBorderPoint() {
    const step = 10 / 111_195;
    let latitude = 41.70972;
    const longitude = 44.7655;
    while (officialDistrictAt(map, latitude + step, longitude)?.district.ref === VAKE) {
      latitude += step;
    }
    return { latitude, longitude };
  }

  /** Tbilisi and Batumi listings on streets placed inside, near a border, outside the city and not at all. */
  async function city(sourceId: string) {
    await listing(sourceId, { ssMetro: { medical_uni: 15, delisi: 20 } });
    await listing(sourceId, { ssMetro: { medical_uni: 10 } });
    await listing(sourceId, {
      subdistrictRef: 3,
      subdistrictName: 'საბურთალო',
      streetRef: 502,
      streetName: 'ჭავჭავაძის გამზ.',
    });
    await listing(sourceId, {
      subdistrictRef: 3,
      subdistrictName: 'საბურთალო',
      streetRef: 503,
      streetName: 'ქავთარაძის ქ.',
    });
    await listing(sourceId, {
      subdistrictRef: 3,
      subdistrictName: 'საბურთალო',
      streetRef: 507,
      streetName: 'ვაჟა-ფშაველას გამზ.',
    });
    await listing(sourceId, {
      districtRef: 5,
      districtName: 'ძველი თბილისი',
      subdistrictRef: 21,
      subdistrictName: 'ავლაბარი',
      streetRef: 504,
      streetName: 'მეტეხის ქ.',
    });
    await listing(sourceId, { streetRef: 506, streetName: 'აბაშიძის ქ.' });
    for (const [ref, name, district] of [
      [28, 'დიღმის მასივი', 1],
      [45, 'დიდი დიღომი', 3],
      [46, 'დიღომი 1-9', 3],
      [4, 'სოფ. დიღომი', 3],
    ] as const) {
      await listing(sourceId, {
        districtRef: district,
        districtName: district === 1 ? 'დიდუბე-ჩუღურეთი' : 'ვაკე-საბურთალო',
        subdistrictRef: ref,
        subdistrictName: name,
        streetRef: null,
        streetName: null,
      });
    }
    // ss.ge has renamed sub-district 52 since the owner's file named it.
    await listing(sourceId, {
      districtRef: 5,
      districtName: 'ძველი თბილისი',
      subdistrictRef: 52,
      subdistrictName: 'სოლოლაკი-ახალი',
      streetRef: null,
      streetName: null,
    });
    await listing(sourceId, {
      cityRef: 96,
      cityName: 'ბათუმი',
      districtRef: 8,
      districtName: 'ბათუმის უბნები',
      subdistrictRef: 64,
      subdistrictName: 'ძველი ბათუმის უბანი',
      streetRef: 601,
      streetName: 'გორგილაძის ქ.',
    });
    await syncPlaces(db, { sourceId, at: NOW });
    await point(sourceId, 501, { latitude: 41.70972, longitude: 44.7655 });
    await point(sourceId, 502, { latitude: 41.72386, longitude: 44.76181 });
    await point(sourceId, 503, 'none');
    await point(sourceId, 504, { latitude: 41.68996, longitude: 44.82332 });
    await point(sourceId, 506, vakeBorderPoint());
    await point(sourceId, 507, { latitude: 41.72386, longitude: 44.76181 });
    await point(sourceId, 601, { latitude: 41.6459, longitude: 41.6347 });
  }

  it('adds the official districts, the stations under theirs, and the owner’s neighbourhood', async () => {
    const sourceId = await newSource();
    await city(sourceId);
    const result = await refreshPlaceCatalogue(db, { sourceId, at: NOW, map, curated });
    expect(result).toMatchObject({ official: 10, stations: 22, neighbourhoods: 1 });

    expect(await row(sourceId, 'official_district', VAKE)).toMatchObject({
      origin: 'osm',
      code: 'vake',
      nameKa: 'ვაკის რაიონი',
      nameEn: 'Vake District',
      parentLevel: 'city',
      parentRef: 95,
    });
    const medical = (await rows(sourceId)).find((r) => r.code === 'medical_uni');
    expect(medical).toMatchObject({
      level: 'metro_station',
      origin: 'osm',
      nameEn: 'Medical University',
      parentLevel: 'official_district',
      parentRef: SABURTALO,
      officialDistrictRef: SABURTALO,
      officialBasis: 'inside',
      pointStatus: 'known',
      // ss.ge's claim, on two listings.
      activeListings: 2,
    });
    // The station called Didube is officially in Nadzaladevi.
    expect((await rows(sourceId)).find((r) => r.code === 'didube')?.parentRef).toBe(NADZALADEVI);
    expect((await rows(sourceId)).find((r) => r.code === 'zgvisubani')).toMatchObject({
      level: 'neighbourhood',
      origin: 'owner',
      parentLevel: 'subdistrict',
      parentRef: 36,
    });
  });

  it('names ss.ge’s places from the owner’s file, by id and the name ss.ge still gives', async () => {
    const sourceId = await newSource();
    await city(sourceId);
    const result = await refreshPlaceCatalogue(db, { sourceId, at: NOW, map, curated });
    expect((await row(sourceId, 'subdistrict', 21))?.nameEn).toBe('Avlabari');
    expect((await row(sourceId, 'district', 5))?.nameEn).toBe('Old Tbilisi');
    expect((await row(sourceId, 'city', 95))?.nameEn).toBe('Tbilisi');
    // Renamed by ss.ge: no English name until the file is checked, and the refresh says so.
    expect((await row(sourceId, 'subdistrict', 52))?.nameEn).toBeNull();
    expect(result.renamed).toEqual(['subdistrict 52 is now სოლოლაკი-ახალი']);
    // Streets have no English names.
    expect((await row(sourceId, 'street', 501))?.nameEn).toBeNull();
  });

  it('places each street by its point: inside, on a border, outside the city, or not at all', async () => {
    const sourceId = await newSource();
    await city(sourceId);
    await refreshPlaceCatalogue(db, { sourceId, at: NOW, map, curated });
    expect(await row(sourceId, 'street', 501)).toMatchObject({
      officialDistrictRef: VAKE,
      officialBasis: 'inside',
    });
    expect(await row(sourceId, 'street', 502)).toMatchObject({
      officialDistrictRef: SABURTALO,
      officialBasis: 'inside',
    });
    expect(await row(sourceId, 'street', 504)).toMatchObject({
      officialDistrictRef: ISANI,
      officialBasis: 'inside',
    });
    expect(await row(sourceId, 'street', 506)).toMatchObject({
      officialDistrictRef: VAKE,
      officialBasis: 'border',
    });
    for (const ref of [503, 601]) {
      expect(await row(sourceId, 'street', ref)).toMatchObject({
        officialDistrictRef: null,
        officialBasis: null,
      });
    }
  });

  it('gives no official district to a street whose own poster-placed pins contradict ss.ge’s point', async () => {
    const sourceId = await newSource();
    await city(sourceId);
    const pinned = (latitude: string, longitude: string, pinManual: boolean) => ({
      latitude,
      longitude,
      pinManual,
    });
    // Chavchavadze 501 (point in Vake): three poster pins agree on a spot 3.4 km away.
    for (let i = 0; i < 3; i++) await listing(sourceId, pinned('41.725000', '44.730000', true));
    // Vazha-Pshavela 507: three poster pins within 200 m of its point.
    for (let i = 0; i < 3; i++) {
      await listing(sourceId, {
        subdistrictRef: 3,
        subdistrictName: 'საბურთალო',
        streetRef: 507,
        streetName: 'ვაჟა-ფშაველას გამზ.',
        ...pinned('41.725000', '44.763000', true),
      });
    }
    // Chavchavadze 502: two far poster pins are too few to judge.
    for (let i = 0; i < 2; i++) {
      await listing(sourceId, {
        subdistrictRef: 3,
        subdistrictName: 'საბურთალო',
        streetRef: 502,
        ...pinned('41.700000', '44.800000', true),
      });
    }
    // Abashidze 506: far pins that ss.ge set itself are no evidence.
    for (let i = 0; i < 3; i++) {
      await listing(sourceId, {
        streetRef: 506,
        streetName: 'აბაშიძის ქ.',
        ...pinned('41.750000', '44.800000', false),
      });
    }

    const result = await refreshPlaceCatalogue(db, { sourceId, at: NOW, map, curated });
    expect(result.streetsDisputed).toBe(1);
    expect(await row(sourceId, 'street', 501)).toMatchObject({
      officialDistrictRef: null,
      officialBasis: null,
      pointStatus: 'known',
    });
    expect(await row(sourceId, 'street', 507)).toMatchObject({ officialDistrictRef: SABURTALO });
    expect(await row(sourceId, 'street', 502)).toMatchObject({ officialDistrictRef: SABURTALO });
    expect(await row(sourceId, 'street', 506)).toMatchObject({
      officialDistrictRef: VAKE,
      officialBasis: 'border',
    });
    // Vake: the five listings on 501 are not located; the four on 506 are.
    expect((await row(sourceId, 'subdistrict', 47))?.officialShares).toEqual({
      listings: 9,
      located: 4,
      by_district: { vake: 4 },
    });
  });

  it('counts how each ss.ge area overlaps the official districts, by its listings’ streets', async () => {
    const sourceId = await newSource();
    await city(sourceId);
    await refreshPlaceCatalogue(db, { sourceId, at: NOW, map, curated });
    // Avlabari: Old Tbilisi on ss.ge's map, officially Isani.
    expect(await row(sourceId, 'subdistrict', 21)).toMatchObject({
      parentLevel: 'district',
      parentRef: 5,
      officialShares: { listings: 1, located: 1, by_district: { isani: 1 } },
    });
    // Saburtalo: one listing's street has no point, so two of three are placed.
    expect((await row(sourceId, 'subdistrict', 3))?.officialShares).toEqual({
      listings: 3,
      located: 2,
      by_district: { saburtalo: 2 },
    });
    expect((await row(sourceId, 'district', 3))?.officialShares).toEqual({
      listings: 9,
      located: 5,
      by_district: { saburtalo: 2, vake: 3 },
    });
    // Outside Tbilisi there is no official map.
    expect((await row(sourceId, 'subdistrict', 64))?.officialShares).toBeNull();
    expect((await row(sourceId, 'official_district', VAKE))?.activeListings).toBe(3);
    expect((await row(sourceId, 'official_district', ISANI))?.activeListings).toBe(1);
  });

  it('keys every place by all its names, and the owner’s aliases', async () => {
    const sourceId = await newSource();
    await city(sourceId);
    await refreshPlaceCatalogue(db, { sourceId, at: NOW, map, curated });
    expect((await row(sourceId, 'street', 501))?.matchKeys).toEqual(['cavcavaz']);
    expect((await row(sourceId, 'subdistrict', 28))?.matchKeys).toEqual([
      'digm masiv',
      'digom',
      'digom masiv',
    ]);
    expect((await row(sourceId, 'official_district', VAKE))?.matchKeys).toEqual([
      'vak',
      'vak district',
      'vak raion',
    ]);
  });

  it('writes nothing when nothing changed', async () => {
    const sourceId = await newSource();
    await city(sourceId);
    await refreshPlaceCatalogue(db, { sourceId, at: NOW, map, curated });
    const before = await rows(sourceId);
    const second = await refreshPlaceCatalogue(db, { sourceId, at: LATER, map, curated });
    expect(second).toMatchObject({ named: 0, streetsPlaced: 0, sharesWritten: 0, keysWritten: 0 });
    expect(await rows(sourceId)).toEqual(before);
  });

  it('keeps the official map’s counts through the next night’s tree', async () => {
    const sourceId = await newSource();
    await city(sourceId);
    await refreshPlaceCatalogue(db, { sourceId, at: NOW, map, curated });
    await syncPlaces(db, { sourceId, at: LATER });
    expect((await row(sourceId, 'official_district', VAKE))?.activeListings).toBe(3);
  });

  describe('placeLookupSql', () => {
    async function lookup(sourceId: string, words: string) {
      const built = placeLookupSql(words, { limit: 500 });
      if (built === null) return [];
      const result = await pool.query(built.sql, built.params);
      return result.rows
        .filter((r) => r.source_id === sourceId)
        .map((r) => ({ level: r.level, ref: r.ref, match: r.match, parent: r.parent_name_en }));
    }

    it("reads a bare name as ss.ge's neighbourhood, with the official district beside it", async () => {
      const sourceId = await newSource();
      await city(sourceId);
      // A village called ვაკე with one listing, as production has (city 572,
      // 2026-11-08): the busier neighbourhood still comes first.
      await listing(sourceId, {
        cityRef: 572,
        cityName: 'ვაკე',
        districtRef: null,
        districtName: null,
        subdistrictRef: null,
        subdistrictName: null,
        streetRef: null,
        streetName: null,
      });
      await syncPlaces(db, { sourceId, at: NOW });
      await refreshPlaceCatalogue(db, { sourceId, at: NOW, map, curated });
      const vake = await lookup(sourceId, 'Vake');
      expect(vake).toContainEqual({ level: 'city', ref: 572, match: 'exact', parent: null });
      expect(vake[0]).toEqual({
        level: 'subdistrict',
        ref: 47,
        match: 'exact',
        parent: 'Vake-Saburtalo',
      });
      expect(vake).toContainEqual({
        level: 'official_district',
        ref: VAKE,
        match: 'exact',
        parent: 'Tbilisi',
      });
      expect(vake.findIndex((m) => m.level === 'official_district')).toBeGreaterThan(0);
    });

    it('reads "district" or რაიონი as the official map', async () => {
      const sourceId = await newSource();
      await city(sourceId);
      await refreshPlaceCatalogue(db, { sourceId, at: NOW, map, curated });
      for (const words of ['Vake district', 'ვაკის რაიონი', 'vakis raioni']) {
        expect((await lookup(sourceId, words))[0], words).toMatchObject({
          level: 'official_district',
          ref: VAKE,
          match: 'exact',
        });
      }
      // A name only the official map has.
      expect((await lookup(sourceId, 'Krtsanisi'))[0]).toMatchObject({
        level: 'official_district',
        match: 'exact',
      });
    });

    it('finds every street of one name, a group, and a station', async () => {
      const sourceId = await newSource();
      await city(sourceId);
      await refreshPlaceCatalogue(db, { sourceId, at: NOW, map, curated });
      const chavchavadze = await lookup(sourceId, 'Chavchavadze');
      expect(chavchavadze.map((m) => m.ref).sort()).toEqual([501, 502]);
      expect(chavchavadze.every((m) => m.level === 'street' && m.match === 'exact')).toBe(true);
      const dighomi = (await lookup(sourceId, 'dighomi')).filter((m) => m.match === 'exact');
      expect(dighomi.map((m) => m.ref).sort((a, b) => a - b)).toEqual([4, 28, 45, 46]);
      expect((await lookup(sourceId, 'Medical University'))[0]).toMatchObject({
        level: 'metro_station',
        match: 'exact',
        parent: 'Saburtalo District',
      });
      // Vazha-Pshavela: the station and the avenue, both exact; the station first.
      expect((await lookup(sourceId, 'Vazha-Pshavela')).map((m) => m.level)).toEqual([
        'metro_station',
        'street',
      ]);
    });

    it('hands on psycopg placeholders with every literal % doubled, and refuses kind words alone', () => {
      const built = placeLookupSql('Vake', { placeholders: 'psycopg' });
      expect(built?.sql).toContain("like ('%% ' || q.key || ' %%')");
      expect(built?.sql).not.toMatch(/\$\d/);
      expect(built?.params).toEqual([JSON.stringify(['vak']), 50]);
      expect(placeLookupSql('street')).toBeNull();
    });

    it('carries the official district holding most of an area’s located listings, by name', async () => {
      const sourceId = await newSource();
      await city(sourceId);
      await refreshPlaceCatalogue(db, { sourceId, at: NOW, map, curated });
      const built = placeLookupSql('Avlabari', { limit: 500 });
      const rows = (await pool.query(built?.sql ?? '', built?.params)).rows.filter(
        (r) => r.source_id === sourceId && r.level === 'subdistrict',
      );
      expect(rows[0]).toMatchObject({
        ref: 21,
        name_en: 'Avlabari',
        parent_name_en: 'Old Tbilisi',
        official_top_code: 'isani',
        official_top_name_en: 'Isani District',
        official_top_listings: 1,
      });
    });
  });

  describe('placeTextLookupSql and resolvePlaceText', () => {
    /** The places each part of a text names: per part, per name found, the best place as level:ref. */
    async function places(sourceId: string, text: string) {
      const built = placeTextLookupSql(text, { limit: 500 });
      if (built === null) return [];
      const rows = (await pool.query(built.sql, built.params)).rows.filter(
        (r) => r.source_id === sourceId,
      );
      return resolvePlaceText(built.text, rows).parts.map((part) =>
        part.segments.map((s) => `${s.places[0]?.level}:${s.places[0]?.ref}`),
      );
    }

    it("reads a text naming several places by Hermes's rule (N75, 2026-11-06)", async () => {
      const sourceId = await newSource();
      await city(sourceId);
      await listing(sourceId, {
        subdistrictRef: 26,
        subdistrictName: 'ლისის ტბა',
        streetRef: null,
        streetName: null,
      });
      await listing(sourceId, {
        districtRef: 2,
        districtName: 'გლდანი-ნაძალადევი',
        subdistrictRef: 37,
        subdistrictName: 'თემქა',
        streetRef: null,
        streetName: null,
      });
      await syncPlaces(db, { sourceId, at: NOW });
      await refreshPlaceCatalogue(db, { sourceId, at: NOW, map, curated });

      // Words that each name a place are that many places, not the district their joined name is.
      expect(await places(sourceId, 'Vake Saburtalo')).toEqual([
        ['subdistrict:47', 'subdistrict:3'],
      ]);
      // With a hyphen it is one word: ss.ge's district.
      expect(await places(sourceId, 'vake-saburtalo')).toEqual([['district:3']]);
      // Words that name nothing alone join.
      expect(await places(sourceId, 'Old Tbilisi')).toEqual([['district:5']]);
      expect(await places(sourceId, 'Didi Dighomi')).toEqual([['subdistrict:45']]);
      expect(await places(sourceId, 'Lisi Lake')).toEqual([['subdistrict:26']]);
      // Parts split on / , and ;.
      expect(await places(sourceId, 'Temka/Zgvisubani')).toEqual([
        ['subdistrict:37'],
        ['neighbourhood:1'],
      ]);
      expect(await places(sourceId, 'ვაკეში, საბურთალოზე')).toEqual([
        ['subdistrict:47'],
        ['subdistrict:3'],
      ]);
      // A street, with its kind word, is one name.
      expect(await places(sourceId, 'Chavchavadze Avenue')).toEqual([['street:501']]);
    });
  });

  it('gives every place its Georgian name in Latin letters, for showing', async () => {
    const sourceId = await newSource();
    await city(sourceId);
    await refreshPlaceCatalogue(db, { sourceId, at: NOW, map, curated });
    expect((await row(sourceId, 'street', 501))?.nameRoman).toBe('Chavchavadzis Gamz.');
    expect((await row(sourceId, 'city', 95))?.nameRoman).toBe('Tbilisi');
    expect((await row(sourceId, 'official_district', ISANI))?.nameRoman).toBe('Isnis Raioni');
  });
});
