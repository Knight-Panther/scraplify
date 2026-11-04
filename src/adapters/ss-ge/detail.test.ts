import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ListingDetails } from '../../realestate/details.js';
import { type DetailResult, parseDetailPage } from './detail.js';
import { SsGePageShapeError } from './list.js';

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf-8');
}

/** What a page that names none of the details reads as. */
const NO_DETAILS: ListingDetails = {
  buildingStatus: null,
  condition: null,
  project: null,
  floorType: null,
  bathrooms: null,
  balconies: null,
  kitchenAreaM2: null,
  houseAreaM2: null,
  yardAreaM2: null,
  posterEntity: null,
  amenities: [],
  latitude: null,
  longitude: null,
  municipalityRef: null,
  municipalityName: null,
};

function detailsOf(result: DetailResult): ListingDetails {
  if (result.status !== 'active') throw new Error(`expected a live listing, got ${result.status}`);
  return result.details;
}

/** A listing page holding only what a test gives it. */
function pageWith(fields: Record<string, unknown>): string {
  const data = {
    props: {
      pageProps: {
        applicationData: {
          applicationId: 1,
          status: 'Active',
          isInactiveApplication: false,
          ...fields,
        },
      },
    },
  };
  return `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script>`;
}

describe('parseDetailPage', () => {
  it('reads a live listing and when the site will drop it', () => {
    expect(parseDetailPage(fixture('detail-active.html'), '35834941')).toEqual({
      status: 'active',
      endAt: '2026-11-11T12:46:44.954Z',
      // Its price too: a listing nobody renews may still have had it edited.
      price: {
        priceGel: 455000,
        priceUsd: 175000,
        pricePerM2Usd: 1880,
        pricePerM2Gel: 4892,
        currencyPosted: 'usd',
      },
      // This old fixture keeps none of the detail fields.
      details: NO_DETAILS,
    });
  });

  it('reads a long-running listing, whose end is years away', () => {
    expect(parseDetailPage(fixture('detail-long-running.html'), '6113387')).toEqual({
      status: 'active',
      endAt: '2039-12-31T20:00:00.000Z',
      price: {
        priceGel: 1500,
        priceUsd: 578,
        pricePerM2Usd: 9.6,
        pricePerM2Gel: 25,
        currencyPosted: 'gel',
      },
      details: NO_DETAILS,
    });
  });

  it('reads an expired listing as gone: the site still answers 200 for it', () => {
    expect(parseDetailPage(fixture('detail-expired.html'), '30000000')).toEqual({
      status: 'gone',
      reason: 'expired',
    });
  });

  it('reads a page with no listing record as gone: the site has no 404', () => {
    expect(parseDetailPage(fixture('detail-missing.html'), '123')).toEqual({
      status: 'gone',
      reason: 'missing',
    });
  });

  it('refuses a page that shows another listing than the one asked for', () => {
    // Read as it stands, it would mark the wrong listing live or gone.
    expect(() => parseDetailPage(fixture('detail-active.html'), '35834942')).toThrow(
      SsGePageShapeError,
    );
    expect(() => parseDetailPage(fixture('detail-expired.html'), '35834942')).toThrow(
      SsGePageShapeError,
    );
  });

  it('refuses a page that is not a listing page at all', () => {
    expect(() => parseDetailPage('<html><body>Just a moment...</body></html>', '123')).toThrow(
      SsGePageShapeError,
    );
  });

  describe('details (Phase 12B, pages read 2026-11-04)', () => {
    it("reads status, condition, project, bathrooms and balconies from a flat's page", () => {
      expect(
        detailsOf(parseDetailPage(fixture('detail-flat-sale.html'), '37237450')),
      ).toMatchObject({
        buildingStatus: 'under-construction',
        condition: 'newly-renovated',
        project: 'non-standard',
        floorType: null,
        bathrooms: 1,
        balconies: 2,
        posterEntity: 'broker',
        latitude: null,
        longitude: null,
      });
      // "არ აქვს" is "has none": a real 0, not unknown.
      expect(
        detailsOf(parseDetailPage(fixture('detail-flat-rent.html'), '37237424')),
      ).toMatchObject({
        buildingStatus: 'new',
        bathrooms: 0,
        balconies: 0,
        // Fixtures keep coordinates to two decimals, about a kilometre.
        latitude: 41.68,
        longitude: 44.85,
      });
    });

    it("reads house and yard area from a house's page, and its municipality", () => {
      expect(detailsOf(parseDetailPage(fixture('detail-house-sale.html'), '36804059'))).toEqual({
        ...NO_DETAILS,
        buildingStatus: 'new',
        condition: 'green-frame',
        houseAreaM2: 500,
        yardAreaM2: 1000,
        posterEntity: 'broker',
        amenities: ['balcony', 'natural-gas', 'pool'],
        municipalityRef: 1,
        municipalityName: 'თბილისის შემოგარენი',
      });
    });

    it('reads the amenities marked true as keys, and only those', () => {
      expect(
        detailsOf(parseDetailPage(fixture('detail-flat-sale.html'), '37237450')).amenities,
      ).toEqual([
        'balcony',
        'basement',
        'elevator',
        'furniture',
        'garage',
        'central-heating',
        'natural-gas',
        'storage',
        'yard-view',
        'street-view',
        'bright',
        'cozy',
        'built-in-kitchen',
      ]);
      expect(
        detailsOf(parseDetailPage(fixture('detail-land-sale.html'), '35961436')).amenities,
      ).toEqual(['electricity', 'sewage', 'water']);
      // Only exactly true: a string, a 1 or a field we do not know is not an amenity.
      const odd = pageWith({ furniture: 'true', balcony: 1, sauna: true, elevator: true });
      expect(detailsOf(parseDetailPage(odd, '1')).amenities).toEqual(['elevator']);
    });

    it('leaves a condition it does not know as unknown', () => {
      const page = pageWith({
        realEstateStatus: 'ნახევრად აშენებული',
        state: 'კარგი',
        project: 'toString',
        floorTypeText: 'სარდაფი',
        userEntityType: 'Robot',
      });
      expect(detailsOf(parseDetailPage(page, '1'))).toEqual(NO_DETAILS);
    });

    it('reads a developer as a developer', () => {
      expect(detailsOf(parseDetailPage(fixture('detail-developer.html'), '3671991'))).toMatchObject(
        {
          posterEntity: 'developer',
          buildingStatus: 'new',
          condition: 'green-frame',
        },
      );
    });

    it('reads a duplex for daily rent in Batumi, and the numbers ss.ge writes as text', () => {
      expect(
        detailsOf(parseDetailPage(fixture('detail-flat-daily.html'), '36036302')),
      ).toMatchObject({
        floorType: 'duplex',
        posterEntity: 'individual',
        latitude: 41.64,
        longitude: 41.61,
      });
      const page = pageWith({
        toilet: '5+',
        balcony_Loggia: '',
        kitchenArea: '12.5',
        areaOfHouse: 'abc',
        areaOfYard: '0',
      });
      expect(detailsOf(parseDetailPage(page, '1'))).toMatchObject({
        bathrooms: 5,
        balconies: null,
        kitchenAreaM2: 12.5,
        houseAreaM2: null,
        yardAreaM2: null,
      });
    });

    it('rounds an area to the cent before holding it against its column', () => {
      const page = pageWith({
        kitchenArea: '999999.999',
        areaOfHouse: '0.001',
        areaOfYard: '12.345',
      });
      expect(detailsOf(parseDetailPage(page, '1'))).toMatchObject({
        // 1,000,000.00 would not fit numeric(8,2).
        kitchenAreaM2: null,
        houseAreaM2: null,
        yardAreaM2: 12.35,
      });
      expect(
        detailsOf(parseDetailPage(pageWith({ kitchenArea: '999999.99' }), '1')).kitchenAreaM2,
      ).toBe(999999.99);
    });

    it("keeps coordinates to six decimals, the column's scale", () => {
      const page = pageWith({ locationLatitude: 41.639213445578434, locationLongitude: 44.8 });
      expect(detailsOf(parseDetailPage(page, '1'))).toMatchObject({
        latitude: 41.639213,
        longitude: 44.8,
      });
    });

    it('keeps coordinates only inside Georgia', () => {
      const outside = pageWith({ locationLatitude: 0, locationLongitude: 0 });
      expect(detailsOf(parseDetailPage(outside, '1'))).toMatchObject({
        latitude: null,
        longitude: null,
      });
      const half = pageWith({ locationLatitude: 41.7, locationLongitude: 'x' });
      expect(detailsOf(parseDetailPage(half, '1'))).toMatchObject({
        latitude: null,
        longitude: null,
      });
    });

    it('reads commercial and hotel pages, which name no rooms or project', () => {
      expect(
        detailsOf(parseDetailPage(fixture('detail-commercial-rent.html'), '37237479')),
      ).toMatchObject({
        buildingStatus: 'new',
        condition: 'needs-renovation',
        project: null,
        amenities: [],
      });
      expect(
        detailsOf(parseDetailPage(fixture('detail-hotel-sale.html'), '33953472')).amenities,
      ).toEqual(['air-conditioning', 'balcony', 'fridge', 'furniture', 'hot-water', 'tv', 'wifi']);
    });
  });
});
