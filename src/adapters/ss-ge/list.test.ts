import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DealType, PropertyType } from '../../realestate/kinds.js';
import {
  floorRange,
  parseResultsPage,
  RESULTS_PAGE_SIZE,
  readMetro,
  SsGePageShapeError,
} from './list.js';

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf-8');
}

const FLATS_FOR_SALE = { propertyType: 'flat', dealType: 'sale' } as const;

describe('parseResultsPage', () => {
  const first = parseResultsPage(fixture('results-flats-sale-p1.html'), {
    ...FLATS_FOR_SALE,
    page: 1,
  });

  it('reads one card per listing, 16 to a full page', () => {
    expect(RESULTS_PAGE_SIZE).toBe(16);
    expect(first).toMatchObject({ pastEnd: false, servedPage: 1, rowCount: 16, skipped: 0 });
    expect(first.cards).toHaveLength(16);
    expect(new Set(first.cards.map((card) => card.sourceListingKey)).size).toBe(16);
  });

  it('reads deal, kind, size, floor, both prices and the location from a row', () => {
    expect(first.cards[0]).toMatchObject({
      sourceListingKey: '35834941',
      canonicalUrl: 'https://home.ss.ge/ka/udzravi-qoneba/35834941',
      dealType: 'sale',
      propertyType: 'flat',
      rooms: 3,
      bedrooms: 1,
      areaM2: 93,
      floor: 2,
      totalFloors: 3,
      priceGel: 455000,
      priceUsd: 175000,
      pricePerM2Usd: 1880,
      currencyPosted: 'usd',
      cityRef: 95,
      cityName: 'თბილისი',
      districtRef: 5,
      districtName: 'ძველი თბილისი',
      subdistrictRef: 23,
      subdistrictName: 'ვერა',
      streetName: 'თარხნიშვილის ქ.',
      streetNumber: null,
      promoted: false,
      similarityGroup: null,
    });
  });

  it('reads times as Tbilisi wall-clock whatever zone marker follows, and expects 30 days of life', () => {
    // This row's order time ends in "Z" and its creation time in "+04:00";
    // both are the same clock (guideline §15, trap 4).
    expect(first.cards[0]).toMatchObject({
      sourceUpdatedAt: '2026-10-12T12:46:44.954Z',
      sourceCreatedAt: '2026-06-15T09:18:20.494Z',
      expectedEndAt: '2026-11-11T12:46:44.954Z',
    });
  });

  // A row that names no business is a broker's about nine times in ten, and a
  // broker's listing ends after 30 days; only an owner's own runs 45
  // (2026-11-09). Expecting 45 for all of them kept a broker's dead listing
  // on the tab for 17 days, so 30 is expected whoever posted it, and an
  // owner's listing still listed after that gets its real end from its page.
  it('expects 30 days of life whoever posted the listing', () => {
    const lifeDays = (card: { sourceUpdatedAt: string; expectedEndAt: string | null }) =>
      (Date.parse(card.expectedEndAt ?? '') - Date.parse(card.sourceUpdatedAt)) / 86_400_000;
    const developerPage = parseResultsPage(fixture('results-flats-sale-last-page.html'), {
      ...FLATS_FOR_SALE,
      page: 2596,
    });
    const cards = [...first.cards, ...developerPage.cards];
    expect(new Set(cards.map((card) => card.posterType))).toEqual(
      new Set(['unknown', 'agent', 'developer']),
    );
    for (const card of cards) {
      expect(lifeDays(card)).toBe(30);
    }
  });

  it('calls a poster an agent only where the row says so, and never guesses an owner', () => {
    expect(first.cards[0]?.posterType).toBe('agent');
    expect(first.cards[1]?.posterType).toBe('unknown');
    expect(first.cards.some((card) => card.posterType === 'owner')).toBe(false);
  });

  it('keeps a street number, and turns an empty description into none', () => {
    expect(first.cards[1]).toMatchObject({ streetNumber: '75', description: null });
  });

  it('reports a page the site swapped for page 1 as past the end, with no cards', () => {
    const page = parseResultsPage(fixture('results-past-end.html'), {
      ...FLATS_FOR_SALE,
      page: 2597,
    });

    expect(page).toMatchObject({ pastEnd: true, servedPage: 1 });
    expect(page.cards).toEqual([]);
  });

  describe('the last real page of a list', () => {
    const last = parseResultsPage(fixture('results-flats-sale-last-page.html'), {
      ...FLATS_FOR_SALE,
      page: 2596,
    });

    it('is short, which is how the walk knows it ended', () => {
      expect(last).toMatchObject({ pastEnd: false, servedPage: 2596, rowCount: 8 });
      expect(last.cards).toHaveLength(8);
    });

    it('leaves a floor that is a list or a range unknown', () => {
      // '7, 10, 11, 13, 15' and '2-14': one listing standing for several flats.
      expect(last.cards[0]).toMatchObject({ floor: null, totalFloors: 17 });
      expect(last.cards[2]?.floor).toBeNull();
      expect(last.cards[7]?.floor).toBe(3);
    });

    it('leaves a missing price and a zero bedroom count unknown', () => {
      expect(last.cards[2]).toMatchObject({ priceGel: null, priceUsd: null, pricePerM2Usd: null });
      expect(last.cards[3]?.bedrooms).toBeNull();
    });

    it('marks a construction company as a developer and strips markup from its description', () => {
      expect(last.cards[0]?.posterType).toBe('developer');
      expect(last.cards[0]?.description).toMatch(/^საცხოვრებელი კომპლექსი/);
      expect(last.cards[0]?.description).not.toMatch(/[<>]/);
    });
  });

  it('reads houses for rent: no floor, lari as the posted currency', () => {
    const page = parseResultsPage(fixture('results-houses-rent-p1.html'), {
      propertyType: 'house',
      dealType: 'rent',
      page: 1,
    });

    expect(page.cards).toHaveLength(16);
    expect(page.cards[0]).toMatchObject({
      sourceListingKey: '36996589',
      propertyType: 'house',
      dealType: 'rent',
      rooms: 2,
      areaM2: 30,
      floor: null,
      totalFloors: null,
      priceGel: 350,
      priceUsd: 135,
      currencyPosted: 'gel',
      streetNumber: '1',
    });
  });

  it('reads cottages, whose titles do not always carry a room count', () => {
    const page = parseResultsPage(fixture('results-cottages-rent-p1.html'), {
      propertyType: 'cottage',
      dealType: 'rent',
      page: 1,
    });

    expect(page.cards).toHaveLength(16);
    expect(page.cards[0]).toMatchObject({
      propertyType: 'cottage',
      rooms: 5,
      cityRef: 113,
      cityName: 'კოჯორი',
      districtRef: null,
      subdistrictName: null,
      streetName: null,
    });
    expect(page.cards.filter((card) => card.rooms === null)).toHaveLength(2);
  });

  it('skips rows of another kind or deal than the list being walked', () => {
    const page = parseResultsPage(fixture('results-houses-rent-p1.html'), {
      ...FLATS_FOR_SALE,
      page: 1,
    });

    expect(page).toMatchObject({ rowCount: 16, skipped: 16 });
    expect(page.cards).toEqual([]);
  });

  it('drops characters a text column cannot hold, wherever a poster typed them', () => {
    // A description on the live site carried U+0000 between two words
    // (listing 36827800, 2026-10-12); Postgres refuses it in a text value.
    const row = {
      applicationId: 36827800,
      type: 4,
      dealType: 1,
      title: 'x',
      orderDate: '2026-09-24T16:32:10.586Z',
      description: 'ქირავდება\u0000სახლი\u0007 ბაღში\u007f',
      address: {
        cityId: 96,
        cityTitle: 'ბათ\u0000უმი',
        streetTitle: '\u0000აეროპორტის გზატ.',
        streetNumber: '1\u00000',
      },
    };
    const data = {
      props: { pageProps: { initialPage: 1, applicationList: { realStateItemModel: [row] } } },
    };
    const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script>`;
    const expected = { propertyType: 'house', dealType: 'rent', page: 1 } as const;
    const page = parseResultsPage(html, expected);

    expect(page.cards).toHaveLength(1);
    expect(page.cards[0]).toMatchObject({
      description: 'ქირავდება სახლი ბაღში',
      cityName: 'ბათუმი',
      streetName: 'აეროპორტის გზატ.',
      streetNumber: '10',
    });
    const stored = Object.values(page.cards[0] ?? {})
      .filter((value) => typeof value === 'string')
      .join('');
    const codes = [...stored].map((char) => char.charCodeAt(0));
    expect(codes.filter((code) => code < 32 || code === 127)).toEqual([]);
  });

  it('reads a number too large for its column as unknown, and keeps the rest of the row', () => {
    // A house in Senaki gave its area as 100,000,000 m² (listing 37114086,
    // 2026-10-26); area_m2 holds at most 99,999,999.99, and the insert error
    // ended the whole run.
    const row = {
      applicationId: 37114086,
      type: 4,
      dealType: 4,
      title: 'x',
      orderDate: '2026-10-23T18:17:48.648Z',
      totalArea: 100_000_000,
      price: {
        priceGeo: 1_000_000_000_000,
        priceUsd: 50_000,
        unitPriceUsd: 10_000_000_000,
        currencyType: 2,
      },
      address: { cityId: 3_000_000_000, cityTitle: 'სენაკი', subdistrictId: 7 },
    };
    const data = {
      props: { pageProps: { initialPage: 1, applicationList: { realStateItemModel: [row] } } },
    };
    const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script>`;
    const page = parseResultsPage(html, { propertyType: 'house', dealType: 'sale', page: 1 });

    expect(page.cards).toHaveLength(1);
    expect(page.cards[0]).toMatchObject({
      sourceListingKey: '37114086',
      areaM2: null,
      priceGel: null,
      priceUsd: 50_000,
      pricePerM2Usd: null,
      cityRef: null,
      cityName: 'სენაკი',
      subdistrictRef: 7,
    });
  });

  describe('a phone number typed into the address', () => {
    // The first pass found posters' numbers in 33 street numbers (2026-10-14):
    // bare, spaced, after a building name, and inside a whole pasted advert.
    function streetOf(streetTitle: string, streetNumber: string) {
      const row = {
        applicationId: 1,
        type: 5,
        dealType: 4,
        title: 'x',
        orderDate: '2026-10-14T10:00:00.000Z',
        address: { cityId: 1, cityTitle: 'თბილისი', streetTitle, streetNumber },
      };
      const data = {
        props: { pageProps: { initialPage: 1, applicationList: { realStateItemModel: [row] } } },
      };
      const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script>`;
      const card = parseResultsPage(html, { ...FLATS_FOR_SALE, page: 1 }).cards[0];
      return { streetName: card?.streetName, streetNumber: card?.streetNumber };
    }

    it.each([
      '599000000',
      '+995 599 00-00-00',
      '599.00.00.00',
      '(599) 00 00 00',
      'მედინა.599000000',
      'ზღვის ხედი 📞 დასაკავშირებლად: 599 00 00 00 დამიკავშირდით',
      '123456789012345678901234567890123456',
    ])('drops the street number %j', (streetNumber) => {
      expect(streetOf('ვაჟა-ფშაველას გამზ.', streetNumber)).toEqual({
        streetName: 'ვაჟა-ფშაველას გამზ.',
        streetNumber: null,
      });
    });

    it('drops a street name holding one', () => {
      expect(streetOf('ზარდიაშვილის 599 00 00 00', '7').streetName).toBeNull();
    });

    it.each([
      '75',
      '12ა',
      '12, 14, 16, 18, 20-22 24',
      'გრიგოლ ელიავა 12ა 6010 ბათუმი',
      'თამარ მეფის 1234',
      '9 შესახვევი #15',
    ])('keeps the street number %j', (streetNumber) => {
      expect(streetOf('ვაჟა-ფშაველას გამზ.', streetNumber).streetNumber).toBe(streetNumber);
    });
  });

  describe('every kind and deal (Phase 12A, fixtures of 2026-11-03)', () => {
    const page1 = (name: string, propertyType: PropertyType, dealType: DealType) =>
      parseResultsPage(fixture(name), { propertyType, dealType, page: 1 });
    const commercial = page1('results-commercial-rent-p1.html', 'commercial', 'rent');
    const land = page1('results-land-sale-p1.html', 'land', 'sale');
    const hotels = page1('results-hotel-sale-p1.html', 'hotel', 'sale');
    const daily = page1('results-flats-daily-p1.html', 'flat', 'daily');
    const pledge = page1('results-flats-pledge-p1.html', 'flat', 'pledge');

    it('reads commercial rows with their space type and no room count', () => {
      expect(commercial.cards).toHaveLength(16);
      for (const card of commercial.cards) {
        expect(card.propertyType).toBe('commercial');
        expect([6, 7, 13, 14, 21, 22, 31, null]).toContain(card.commercialType);
        expect(card.rooms).toBeNull();
        expect(card.landType).toBeNull();
      }
      expect(commercial.cards.some((card) => card.commercialType === 7)).toBe(true);
      // ss.ge writes 0 for "none"; that is not a code.
      expect(commercial.cards.some((card) => card.commercialType === null)).toBe(true);
    });

    it('reads land rows with their land type', () => {
      expect(land.cards).toHaveLength(16);
      for (const card of land.cards) {
        expect(card.propertyType).toBe('land');
        expect([1, 2, 3, 4, 5, 6, null]).toContain(card.landType);
        expect(card.commercialType).toBeNull();
      }
      expect(land.cards.filter((card) => card.landType !== null).length).toBeGreaterThan(8);
    });

    it('reads hotels, daily rent and pledge under their own deal codes', () => {
      expect(hotels.cards).toHaveLength(16);
      expect(hotels.cards.every((card) => card.propertyType === 'hotel')).toBe(true);
      expect(daily.cards).toHaveLength(16);
      expect(daily.cards.every((card) => card.dealType === 'daily')).toBe(true);
      expect(pledge.cards).toHaveLength(16);
      expect(pledge.cards.every((card) => card.dealType === 'pledge')).toBe(true);
      // The same rows refused under a list they do not belong to.
      expect(page1('results-flats-daily-p1.html', 'flat', 'rent').skipped).toBe(16);
    });

    it('reads the photo count, furniture, built-in kitchen, exclusive and video viewing', () => {
      const cards = [...commercial.cards, ...land.cards, ...hotels.cards, ...daily.cards];
      for (const card of cards) {
        expect(Number.isInteger(card.imageCount)).toBe(true);
        expect(card.imageCount).toBeGreaterThanOrEqual(0);
        expect(typeof card.exclusive).toBe('boolean');
        expect(typeof card.videoViewing).toBe('boolean');
        expect([true, false, null]).toContain(card.hasFurniture);
        expect([true, false, null]).toContain(card.hasBuiltInKitchen);
      }
      expect(cards.some((card) => card.videoViewing)).toBe(true);
      expect(cards.some((card) => card.hasFurniture === true)).toBe(true);
      // The commercial page has rows that say nothing about furniture.
      expect(commercial.cards.some((card) => card.hasFurniture === null)).toBe(true);
    });

    it('reads the price per m² in lari beside the one in dollars', () => {
      expect(land.cards[0]).toMatchObject({
        priceGel: 374000,
        priceUsd: 144000,
        pricePerM2Usd: 336,
        pricePerM2Gel: 874,
      });
    });

    it('keeps a space type code it does not know rather than dropping the row', () => {
      const row = {
        applicationId: 2,
        type: 6,
        dealType: 1,
        title: 'x',
        orderDate: '2026-11-03T10:00:00.000Z',
        commercialRealEstateType: 99,
        imageCount: 0,
      };
      const data = {
        props: { pageProps: { initialPage: 1, applicationList: { realStateItemModel: [row] } } },
      };
      const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script>`;
      const page = parseResultsPage(html, {
        propertyType: 'commercial',
        dealType: 'rent',
        page: 1,
      });

      expect(page.cards).toHaveLength(1);
      // No photos is real data, not unknown.
      expect(page.cards[0]).toMatchObject({ commercialType: 99, imageCount: 0 });
    });

    it('reads an empty list as total 0 with no rows, not as past the end', () => {
      const empty = page1('results-empty.html', 'land', 'daily');
      expect(empty).toMatchObject({ pastEnd: false, rowCount: 0, listTotal: 0 });
      expect(empty.cards).toEqual([]);
      expect(commercial.listTotal).toBeGreaterThan(16);
    });

    it('sizes a list by the listings it can show, not the counter that overstates flats', () => {
      // Guideline §4: initialTotalApplicationCount counts look-alikes the
      // list folds away (4,755 here); initialCardCount is what can be read.
      expect(daily.listTotal).toBe(3_329);
      expect(pledge.listTotal).toBe(759);
    });
  });

  it('refuses a page with no listing data instead of reading it as an empty list', () => {
    expect(() =>
      parseResultsPage('<html><body>Just a moment...</body></html>', {
        ...FLATS_FOR_SALE,
        page: 1,
      }),
    ).toThrow(SsGePageShapeError);
  });
});

describe('places on a results row (Phase 14A, fixture of 2026-11-07)', () => {
  const page = parseResultsPage(fixture('results-flats-sale-places-p1.html'), {
    ...FLATS_FOR_SALE,
    page: 1,
  });
  const byKey = (key: string) => {
    const card = page.cards.find((candidate) => candidate.sourceListingKey === key);
    if (card === undefined) throw new Error(`no card ${key}`);
    return card;
  };

  it('keeps the street id beside its name, on every row that has a street', () => {
    expect(page.cards).toHaveLength(16);
    expect(page.cards.every((card) => card.streetRef !== null)).toBe(true);
    expect(byKey('37271265')).toMatchObject({
      subdistrictRef: 3,
      streetRef: 92,
      streetName: 'ნუცუბიძის ქ.',
      streetNumber: '125ა',
    });
  });

  it('keeps the metro stations ss.ge lists, by station, and none for an empty list', () => {
    expect(byKey('37271265').ssMetro).toEqual({ state_uni: 10, vazha_pshavela: 15 });
    expect(byKey('37271365').ssMetro).toBeNull();
  });

  it('reads one floor as both ends of the range', () => {
    expect(byKey('37271265')).toMatchObject({ floor: 17, floorLow: 17, floorHigh: 17 });
  });
});

describe('readMetro', () => {
  it('keeps the nearest entrance of each station, and skips what is not a station', () => {
    expect(
      readMetro([
        { stationId: 81, stationTitle: 'isani', timeDistance: 15 },
        { stationId: 84, stationTitle: 'isani', timeDistance: 5 },
        { stationId: 9, stationTitle: 'samasi_aragveli', timeDistance: 20 },
        { stationId: 1, stationTitle: 'Bad Slug!', timeDistance: 5 },
        { stationId: 2, stationTitle: 'delisi', timeDistance: 0 },
        { stationId: 3, stationTitle: 'delisi', timeDistance: '5' },
        'not a station',
      ]),
    ).toEqual({ isani: 5, samasi_aragveli: 20 });
  });

  it('reads no list, or a list with nothing usable, as unknown', () => {
    expect(readMetro(null)).toBeNull();
    expect(readMetro([])).toBeNull();
    expect(readMetro([{ stationTitle: 'x', timeDistance: 5 }])).toBeNull();
  });
});

describe('floorRange', () => {
  it.each([
    [3, 3, 3],
    ['3', 3, 3],
    ['7, 10, 11, 13, 15', 7, 15],
    ['2-14', 2, 14],
    ['-1-14', -1, 14],
    ['-2-16', -2, 16],
    ['1–3, 5', 1, 5],
  ])('reads %j as floors %d to %d', (value, low, high) => {
    expect(floorRange(value)).toEqual({ floorLow: low, floorHigh: high });
  });

  it.each([[null], [''], ['ground'], ['3a'], [2.5], ['1, x'], ['300'], ['-9']])(
    'reads %j as unknown',
    (value) => {
      expect(floorRange(value)).toEqual({ floorLow: null, floorHigh: null });
    },
  );
});
