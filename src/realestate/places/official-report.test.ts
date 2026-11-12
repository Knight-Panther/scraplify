import { and, eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../db/client.js';
import {
  type NewRealEstateListingRow,
  realEstateListings,
  realEstatePlaces,
} from '../../db/schema/index.js';
import { cleanupTestSource, createTestSource } from '../../db/test-support.js';
import { recordStreetPoint, syncPlaces } from '../places.js';
import { refreshPlaceCatalogue } from './catalogue.js';
import { type CuratedPlaces, loadCuratedPlaces } from './curated.js';
import { loadOfficialMap, type OfficialMap } from './official.js';
import {
  formatOfficialReport,
  loadOfficialReport,
  type OfficialReport,
  type ReportArea,
  type ReportStreet,
} from './official-report.js';

const NOW = '2026-11-12T14:00:00.000Z';
const LATER = '2026-11-13T14:00:00.000Z';

/** OSM relation ids of the official districts the tests use. */
const VAKE = 11300449;
const SABURTALO = 11300446;
const ISANI = 13438808;

/** Street points inside each official district (as in catalogue.test.ts). */
const IN_VAKE = { latitude: 41.70972, longitude: 44.7655 };
const IN_SABURTALO = { latitude: 41.72386, longitude: 44.76181 };
const IN_ISANI = { latitude: 41.68996, longitude: 44.82332 };

let map: OfficialMap;
let curated: CuratedPlaces;
beforeAll(async () => {
  map = await loadOfficialMap();
  curated = await loadCuratedPlaces();
});

describe('the official-map report (Phase 14B)', () => {
  const sourceIds: string[] = [];
  let nextKey = 1;

  afterEach(async () => {
    for (const sourceId of sourceIds.splice(0)) await cleanupTestSource(sourceId);
  });

  async function newSource(): Promise<string> {
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);
    return sourceId;
  }

  const SABURTALO_AREA = { subdistrictRef: 3, subdistrictName: 'საბურთალო' };
  const VAKE_AREA = { subdistrictRef: 47, subdistrictName: 'ვაკე' };
  const AVLABARI_AREA = {
    districtRef: 5,
    districtName: 'ძველი თბილისი',
    subdistrictRef: 21,
    subdistrictName: 'ავლაბარი',
  };

  /** A Tbilisi flat in Vake-Saburtalo, on the street given. */
  async function listing(
    sourceId: string,
    streetRef: number | null,
    overrides: Partial<NewRealEstateListingRow> = {},
  ) {
    const key = `r${nextKey++}`;
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
      ...VAKE_AREA,
      streetRef,
      streetName: streetRef === null ? null : `ქუჩა ${streetRef}`,
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
    at: { latitude: number; longitude: number },
  ) {
    await recordStreetPoint(db, {
      sourceId,
      streetRef,
      streetName: null,
      subdistrictRef: null,
      cityRef: null,
      point: { status: 'known', ...at },
      readAt: NOW,
    });
  }

  /** A trusted pin in the official district given, as 14C stores it (private columns). */
  const trustedPin = (latitude: string, longitude: string, district: number) => ({
    latitude,
    longitude,
    pinTrusted: true,
    pinOfficialDistrictRef: district,
  });

  /**
   * Saburtalo: 3 listings on a Saburtalo street, 2 on a Vake street, 1 on a
   * street with no point, 1 with no street. Vake: 4 on a Vake street whose
   * trusted pins sit at 2 positions in Saburtalo, 1 on a Vake street with one
   * such position. Avlabari: 1 on an Isani street. Plus a Batumi listing and
   * a gone one, which do not count.
   */
  async function city(sourceId: string) {
    for (let i = 0; i < 3; i++) await listing(sourceId, 502, SABURTALO_AREA);
    for (let i = 0; i < 2; i++) await listing(sourceId, 501, SABURTALO_AREA);
    await listing(sourceId, 503, SABURTALO_AREA);
    await listing(sourceId, 503, SABURTALO_AREA);
    await listing(sourceId, null, SABURTALO_AREA);
    await listing(sourceId, 501, trustedPin('41.709700', '44.765500', VAKE));
    await listing(sourceId, 501, trustedPin('41.729000', '44.745000', SABURTALO));
    await listing(sourceId, 501, trustedPin('41.729500', '44.745500', SABURTALO));
    // The same position again: still two in Saburtalo.
    await listing(sourceId, 501, trustedPin('41.729500', '44.745500', SABURTALO));
    await listing(sourceId, 505, trustedPin('41.729000', '44.745000', SABURTALO));
    await listing(sourceId, 504, AVLABARI_AREA);
    await listing(sourceId, 502, {
      ...SABURTALO_AREA,
      cityRef: 96,
      cityName: 'ბათუმი',
      districtRef: 8,
      districtName: 'ბათუმის უბნები',
    });
    await listing(sourceId, 504, { ...SABURTALO_AREA, status: 'gone' });
    await syncPlaces(db, { sourceId, at: NOW });
    await point(sourceId, 501, IN_VAKE);
    await point(sourceId, 502, IN_SABURTALO);
    await point(sourceId, 504, IN_ISANI);
    await point(sourceId, 505, IN_VAKE);
    await refreshPlaceCatalogue(db, { sourceId, at: NOW, map, curated });
  }

  const area = (report: OfficialReport, level: 'district' | 'subdistrict', ref: number) => {
    const found = (level === 'district' ? report.districts : report.subdistricts).find(
      (a) => a.ref === ref,
    );
    if (found === undefined) throw new Error(`no ${level} ${ref} in the report`);
    return found;
  };

  it('counts each area’s shares exactly as C6’s official_shares does', async () => {
    const sourceId = await newSource();
    await city(sourceId);
    const report = await loadOfficialReport(db, { sourceId, at: NOW });
    const code = new Map(report.official.map((o) => [o.ref, o.code]));
    const stored = await db
      .select()
      .from(realEstatePlaces)
      .where(and(eq(realEstatePlaces.sourceId, sourceId)));
    let compared = 0;
    for (const place of stored) {
      if (place.level !== 'district' && place.level !== 'subdistrict') continue;
      if (place.officialShares === null) continue;
      const mine = area(report, place.level, place.ref);
      expect({
        listings: mine.listings,
        located: mine.located,
        by_district: Object.fromEntries(mine.shares.map((s) => [code.get(s.ref), s.listings])),
      }).toEqual(place.officialShares);
      compared++;
    }
    // Vake-Saburtalo, Old Tbilisi, Saburtalo, Vake and Avlabari: Batumi has no shares.
    expect(compared).toBe(5);
    expect(report.tbilisi).toEqual({ listings: 14, located: 11, noStreet: 1, noSubdistrict: 0 });
  });

  it('lists a sub-district’s streets in another official district, its unplaced streets and its listings with no street', async () => {
    const sourceId = await newSource();
    await city(sourceId);
    const saburtalo = area(await loadOfficialReport(db, { sourceId, at: NOW }), 'subdistrict', 3);
    expect(saburtalo).toMatchObject({
      nameKa: 'საბურთალო',
      nameEn: 'Saburtalo',
      districtRef: 3,
      listings: 8,
      located: 5,
      shares: [
        { ref: SABURTALO, listings: 3 },
        { ref: VAKE, listings: 2 },
      ],
      main: SABURTALO,
      noStreet: 1,
    });
    expect(saburtalo.elsewhere.map((s) => [s.ref, s.listings, s.official, s.source])).toEqual([
      [501, 2, VAKE, 'ss.ge'],
    ]);
    // Its pins all come from Vake's listings, none from Saburtalo's own.
    expect(saburtalo.elsewhere[0]).toMatchObject({
      pinsHere: [],
      pins: [
        { ref: SABURTALO, positions: 2 },
        { ref: VAKE, positions: 1 },
      ],
    });
    expect(saburtalo.unplaced.map((s) => [s.ref, s.listings])).toEqual([[503, 2]]);
    expect(saburtalo.crossing).toEqual([]);
  });

  it('marks a street crossing a border by two trusted pin positions on the other side, not one', async () => {
    const sourceId = await newSource();
    await city(sourceId);
    const vake = area(await loadOfficialReport(db, { sourceId, at: NOW }), 'subdistrict', 47);
    expect(vake.main).toBe(VAKE);
    expect(vake.elsewhere).toEqual([]);
    expect(vake.crossing).toHaveLength(1);
    expect(vake.crossing[0]).toMatchObject({
      ref: 501,
      listings: 4,
      official: VAKE,
      pins: [
        { ref: SABURTALO, positions: 2 },
        { ref: VAKE, positions: 1 },
      ],
      pinsHere: [
        { ref: SABURTALO, positions: 2 },
        { ref: VAKE, positions: 1 },
      ],
    });
    // Street 505 has one position in Saburtalo: listed nowhere.
    expect([...vake.elsewhere, ...vake.crossing, ...vake.unplaced].map((s) => s.ref)).not.toContain(
      505,
    );
  });

  it('orders ss.ge’s districts by listings and each district’s sub-districts after it', async () => {
    const sourceId = await newSource();
    await city(sourceId);
    const report = await loadOfficialReport(db, { sourceId, at: NOW });
    expect(report.districts.map((d) => d.ref)).toEqual([3, 5]);
    expect(report.subdistricts.map((s) => s.ref)).toEqual([3, 47, 21]);
    expect(area(report, 'subdistrict', 21)).toMatchObject({ districtRef: 5, main: ISANI });
    // Districts carry shares only.
    expect(area(report, 'district', 3)).toMatchObject({
      elsewhere: [],
      crossing: [],
      unplaced: [],
    });
  });

  it('runs inside a read-only transaction, as the CLI runs it', async () => {
    const sourceId = await newSource();
    await city(sourceId);
    const report = await db.transaction((tx) => loadOfficialReport(tx, { sourceId, at: NOW }), {
      isolationLevel: 'repeatable read',
      accessMode: 'read only',
    });
    expect(report.subdistricts).toHaveLength(3);
  });
});

describe('formatOfficialReport', () => {
  const street = (
    ref: number,
    listings: number,
    over: Partial<ReportStreet> = {},
  ): ReportStreet => ({
    ref,
    nameKa: `ქუჩა ${ref}`,
    listings,
    official: VAKE,
    source: 'pins',
    locatedPins: 12,
    pins: [],
    pinsHere: [],
    ...over,
  });
  const subdistrict = (over: Partial<ReportArea>): ReportArea => ({
    level: 'subdistrict',
    ref: 3,
    nameKa: 'საბურთალო',
    nameEn: 'Saburtalo',
    districtRef: 3,
    listings: 100,
    located: 80,
    shares: [
      { ref: SABURTALO, listings: 60 },
      { ref: VAKE, listings: 20 },
    ],
    main: SABURTALO,
    noStreet: 15,
    elsewhere: [],
    crossing: [],
    unplaced: [],
    ...over,
  });
  const report = (subdistricts: ReportArea[]): OfficialReport => ({
    generatedAt: '2026-11-12 14:00 UTC',
    tbilisi: { listings: 100, located: 80, noStreet: 15, noSubdistrict: 0 },
    official: [
      { ref: SABURTALO, code: 'saburtalo', name: 'Saburtalo District' },
      { ref: VAKE, code: 'vake', name: 'Vake District' },
    ],
    districts: [
      {
        ...subdistrict({}),
        level: 'district',
        nameKa: 'ვაკე-საბურთალო',
        nameEn: 'Vake-Saburtalo',
        districtRef: null,
      },
    ],
    subdistricts,
  });

  it('shows the shares of the located listings, and each split street with its pins', () => {
    const text = formatOfficialReport(
      report([
        subdistrict({
          elsewhere: [
            street(501, 20, {
              pins: [
                { ref: VAKE, positions: 9 },
                { ref: SABURTALO, positions: 3 },
              ],
              pinsHere: [{ ref: VAKE, positions: 2 }],
            }),
          ],
          crossing: [street(502, 7, { official: SABURTALO, source: 'ss.ge', locatedPins: 0 })],
          unplaced: [street(503, 5, { official: null, source: null, locatedPins: null })],
        }),
      ]),
    );
    expect(text).toContain(
      '| Vake-Saburtalo (ვაკე-საბურთალო) | 100 | 80 (80.0%) | Saburtalo 75.0% · Vake 25.0% |',
    );
    expect(text).toContain(
      '| Saburtalo (საბურთალო) | Vake-Saburtalo (ვაკე-საბურთალო) | 100 | 80 (80.0%) | Saburtalo 75.0% | Vake 25.0% |',
    );
    expect(text).toContain('### Saburtalo (საბურთალო), Vake-Saburtalo (ვაკე-საბურთალო)');
    expect(text).toContain('| ქუჩა 501 | 20 | Vake | pins (12) | Vake 2 | Vake 9 · Saburtalo 3 |');
    expect(text).toContain('Streets in Saburtalo whose trusted pins cross a border: 1.');
    expect(text).toContain('| ქუჩა 502 | 7 | ss.ge | — | — |');
    expect(text).toContain(
      'Not located: 15 listings name no street; 5 are on 1 streets not placed yet (busiest: ქუჩა 503 5).',
    );
  });

  it('caps each street list and says how many more there are; skips a sub-district with nothing split', () => {
    const many = Array.from({ length: 5 }, (_, i) => street(600 + i, 10 - i));
    const text = formatOfficialReport(
      report([
        subdistrict({ elsewhere: many }),
        subdistrict({ ref: 47, nameKa: 'ვაკე', nameEn: 'Vake' }),
      ]),
      { streets: 2 },
    );
    expect(text).toContain('| ქუჩა 601 | 9 |');
    expect(text).not.toContain('| ქუჩა 602 |');
    expect(text).toContain('…and 3 more, 21 listings.');
    expect(text).not.toContain('### Vake (ვაკე)');
  });

  it('writes a tiny share as under 0.1% and escapes a pipe in a name', () => {
    const text = formatOfficialReport(
      report([
        subdistrict({
          listings: 2500,
          located: 2000,
          shares: [
            { ref: SABURTALO, listings: 1999 },
            { ref: VAKE, listings: 1 },
          ],
          elsewhere: [street(501, 1, { nameKa: 'ა|ბ' })],
        }),
      ]),
    );
    expect(text).toContain('| 2,500 | 2,000 (80.0%) | Saburtalo >99.9% | Vake <0.1% |');
    expect(text).toContain('| ა\\|ბ | 1 |');
  });
});
