import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseResultsPage, RESULTS_PAGE_SIZE, SsGePageShapeError } from './list.js';

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

  // The first pass checked about 960 listings past their 30 days: of those
  // posted by no business, 890 had an end exactly 45 days after their order
  // time (2026-10-15). No agency listing outlived 30 days.
  it('expects 45 days of life for a listing no business posted, and 30 for a business one', () => {
    const lifeDays = (card: { sourceUpdatedAt: string; expectedEndAt: string | null }) =>
      (Date.parse(card.expectedEndAt ?? '') - Date.parse(card.sourceUpdatedAt)) / 86_400_000;
    const developerPage = parseResultsPage(fixture('results-flats-sale-last-page.html'), {
      ...FLATS_FOR_SALE,
      page: 2596,
    });
    const cards = [...first.cards, ...developerPage.cards];
    const byPoster = new Map(cards.map((card) => [card.posterType, lifeDays(card)]));
    expect(byPoster.get('unknown')).toBe(45);
    expect(byPoster.get('agent')).toBe(30);
    expect(byPoster.get('developer')).toBe(30);
    for (const card of cards) {
      expect(lifeDays(card)).toBe(card.posterType === 'unknown' ? 45 : 30);
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

  it('refuses a page with no listing data instead of reading it as an empty list', () => {
    expect(() =>
      parseResultsPage('<html><body>Just a moment...</body></html>', {
        ...FLATS_FOR_SALE,
        page: 1,
      }),
    ).toThrow(SsGePageShapeError);
  });
});
