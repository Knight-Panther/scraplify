import { describe, expect, it } from 'vitest';
import { parseListingPageSighting } from './detail.js';
import {
  FAKE_PHOTO_GUID,
  fakePhone,
  fakePhoneTyped,
  fakePhotoFileName,
  fakeUserId,
} from './fakes.js';
import { parseResultsPage } from './list.js';
import {
  canonicalPhotoRef,
  listingPagePosterSighting,
  photoUploadDay,
  readPhotoSet,
  rowPosterSighting,
} from './poster.js';

/**
 * Hand-made blocks in ss.ge's shapes (RECON_NOTES.md, "Posters and
 * photos"), every value invented: reserved fake account ids, phones and
 * photo GUIDs (`reserved-fakes.json`), and made-up names.
 */

function page(pageProps: Record<string, unknown>): string {
  const data = JSON.stringify({ props: { pageProps } });
  return `<html><body><script id="__NEXT_DATA__" type="application/json">${data}</script></body></html>`;
}

function row(id: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    applicationId: id,
    type: 5,
    dealType: 4,
    title: 'იყიდება 2 ოთახიანი ბინა',
    orderDate: '2026-11-17T10:00:00',
    price: { priceUsd: 100000, currencyType: 2 },
    ...extra,
  };
}

const ref = (day: string, index: number) => `${day}/${index}_${FAKE_PHOTO_GUID}.jpg`;

describe('photo references', () => {
  it('reads a row photo and the same photo on the listing page as one ref, without host or size', () => {
    const onRow = canonicalPhotoRef(fakePhotoFileName('20241105', 3, 'thumbs'));
    const onPage = canonicalPhotoRef(fakePhotoFileName('20241105', 3));
    const thumb = canonicalPhotoRef(fakePhotoFileName('20241105', 3, 'Thumb'));
    expect(onRow).toBe(ref('20241105', 3));
    expect(onPage).toBe(onRow);
    expect(thumb).toBe(onRow);
    // A bare path, upper-case GUID, a query string: still the same photo.
    expect(canonicalPhotoRef(`20241105/03_${FAKE_PHOTO_GUID.toUpperCase()}_large.JPG?v=2`)).toBe(
      onRow,
    );
  });

  it('reads the upload day only when the 8 digits are a real date', () => {
    expect(photoUploadDay(ref('20241105', 1))).toBe('2024-11-05');
    expect(photoUploadDay(ref('20240230', 1))).toBeNull();
    expect(photoUploadDay(ref('19991231', 1))).toBeNull();
    expect(photoUploadDay(ref('12345678', 1))).toBeNull();
  });

  it('skips what is not a photo path, and never throws', () => {
    for (const junk of [
      null,
      42,
      '',
      'https://static.ss.ge/20241105/photo.jpg',
      `https://static.ss.ge/2024110/1_${FAKE_PHOTO_GUID}.jpg`,
      `https://static.ss.ge/20241105/1_${FAKE_PHOTO_GUID}.pdf`,
      `https://static.ss.ge/20241105/1_not-a-guid.jpg`,
      { fileName: 'x' },
    ]) {
      expect(canonicalPhotoRef(junk), String(junk)).toBeNull();
    }
    const set = readPhotoSet(
      [
        null,
        'x',
        { fileName: 'nothing like a path' },
        { fileName: fakePhotoFileName('20241105', 2, 'thumbs'), orderNo: 2 },
        { fileName: fakePhotoFileName('20241105', 1, 'thumbs'), orderNo: 1, isMain: true },
        // The same photo twice is one photo.
        { fileName: fakePhotoFileName('20241105', 1), orderNo: 5 },
        { fileName: fakePhotoFileName('20241105', 9), orderNo: null, is360: true, imageType: 2 },
      ],
      7,
    );
    expect(set).toMatchObject({
      refs: [ref('20241105', 1), ref('20241105', 2), ref('20241105', 9)],
      mainRef: ref('20241105', 1),
      imageCount: 7,
    });
    expect(set?.photos[2]).toMatchObject({ is360: true, imageType: 2 });
    expect(readPhotoSet('not a list', 'many')).toBeNull();
    expect(readPhotoSet([], 0)).toMatchObject({ refs: [], mainRef: null, imageCount: 0 });
  });
});

describe('the poster on a results row', () => {
  const html = page({
    initialPage: 1,
    initialCardCount: 3,
    applicationList: {
      realStateItemModel: [
        row(101, {
          userId: fakeUserId(1).toUpperCase(),
          userInfo: { name: 'შპს გამოგონილი', image: '', userType: 2 },
          appImages: [
            { fileName: fakePhotoFileName('20241105', 2, 'thumbs'), orderNo: 2, isMain: false },
            { fileName: fakePhotoFileName('20241105', 1, 'thumbs'), orderNo: 1, isMain: true },
          ],
          imageCount: 12,
          description: `ტელ: ${fakePhoneTyped(11)}, ფასი 120000`,
        }),
        row(102, { userId: fakeUserId(2), userInfo: null }),
        // No account id, a broken one, another kind of listing: no poster, never a throw.
        row(103, { userId: 'not-a-guid', appImages: 'broken' }),
        row(104, { type: 3, userId: fakeUserId(4) }),
      ],
    },
  });
  const parsed = parseResultsPage(html, { propertyType: 'flat', dealType: 'sale', page: 1 });

  it('gives one sighting per card, in order, with the account id lower-cased', () => {
    expect(parsed.cards.map((card) => card.sourceListingKey)).toEqual(['101', '102', '103']);
    expect(parsed.sightings.map((sighting) => sighting.sourceListingKey)).toEqual([
      '101',
      '102',
      '103',
    ]);
    expect(parsed.sightings[0]).toEqual({
      sourceListingKey: '101',
      poster: { userId: fakeUserId(1), displayName: 'შპს გამოგონილი', userType: 2 },
      photos: {
        refs: [ref('20241105', 1), ref('20241105', 2)],
        mainRef: ref('20241105', 1),
        imageCount: 12,
        photos: expect.any(Array),
      },
    });
    expect(parsed.sightings[1]).toMatchObject({
      poster: { userId: fakeUserId(2), displayName: null, userType: null },
      photos: null,
    });
    expect(parsed.sightings[2]).toMatchObject({ poster: null, photos: null });
  });

  it('keeps the account and the name off the card', () => {
    expect(JSON.stringify(parsed.cards)).not.toContain(fakeUserId(1));
    expect(JSON.stringify(parsed.cards)).not.toContain('გამოგონილი');
  });

  it('becomes a directory sighting with the description phone, never the price', () => {
    const sighting = rowPosterSighting(
      parsed.sightings[0] as never,
      parsed.cards[0]?.description ?? null,
    );
    expect(sighting).toMatchObject({
      sourceListingKey: '101',
      account: { userId: fakeUserId(1), displayName: 'შპს გამოგონილი', userType: 2 },
      contacts: [{ kind: 'phone', value: fakePhone(11), contactName: '', seenIn: 'description' }],
      photos: { origin: 'row', refs: [ref('20241105', 1), ref('20241105', 2)] },
    });
    expect(sighting.photos?.photos[0]).toMatchObject({ uploadDay: '2024-11-05' });
  });
});

describe('the poster on a listing page', () => {
  const listing = {
    applicationId: 201,
    status: 'Active',
    userId: fakeUserId(3),
    contactPerson: 'ნინო გამოგონილი',
    applicationPhones: [
      { phoneNumber: '500000012' },
      { phoneNumber: '500 00 00 12' },
      { phoneNumber: '598 90 99 **' },
      { phoneNumber: null },
      'junk',
    ],
    userEntityType: 'Broker',
    userApplicationCount: 36,
    agencyId: null,
    agencyName: null,
    companyId: null,
    companyName: null,
    projectId: null,
    projectName: null,
    appImages: [
      {
        fileName: fakePhotoFileName('20241105', 1),
        fileNameThumb: fakePhotoFileName('20241105', 1, 'Thumb'),
        orderNo: 1,
        isMain: true,
      },
      { fileNameThumb: fakePhotoFileName('20241106', 2, 'Thumb'), orderNo: 2 },
    ],
  };
  const agent = {
    agentContactName: 'სხვა სახელი',
    companyId: 77,
    companyName: 'შპს გამოგონილი',
    companyLogoImage: '',
    companyType: 2,
    infoType: 1,
    userId: null,
  };

  it('reads the account, contact name, phones, kind and counts, and the agent block beside it', () => {
    const sighting = parseListingPageSighting(
      page({ applicationData: listing, initialAgentInfoData: agent }),
      '201',
    );
    expect(sighting).toEqual({
      sourceListingKey: '201',
      userId: fakeUserId(3),
      contactName: 'ნინო გამოგონილი',
      phones: [fakePhone(12)],
      entityType: 'Broker',
      listingCount: 36,
      agencyRef: null,
      agencyName: null,
      companyRef: 77,
      companyName: 'შპს გამოგონილი',
      companyType: 2,
      agentInfoType: 1,
      photos: {
        refs: [ref('20241105', 1), ref('20241106', 2)],
        mainRef: ref('20241105', 1),
        imageCount: null,
        photos: expect.any(Array),
      },
    });
    expect(listingPagePosterSighting(sighting as never)).toMatchObject({
      account: { userId: fakeUserId(3), contactName: 'ნინო გამოგონილი', listingCount: 36 },
      contacts: [
        {
          kind: 'phone',
          value: fakePhone(12),
          contactName: 'ნინო გამოგონილი',
          seenIn: 'listing_page',
        },
      ],
      photos: { origin: 'listing_page' },
    });
  });

  it('gives the row and the page of one listing the same photo refs', () => {
    const pageSet = parseListingPageSighting(page({ applicationData: listing }), '201')?.photos;
    const rowSet = readPhotoSet(
      [{ fileName: fakePhotoFileName('20241105', 1, 'thumbs'), orderNo: 1, isMain: true }],
      2,
    );
    expect(pageSet?.refs[0]).toBe(rowSet?.refs[0]);
  });

  it('falls back to the agent name, and reads nothing from a missing or wrong page', () => {
    const bare = { applicationId: 201, status: 'Active', userId: 'nope' };
    expect(
      parseListingPageSighting(page({ applicationData: bare, initialAgentInfoData: agent }), '201'),
    ).toMatchObject({ userId: null, contactName: 'სხვა სახელი', phones: [], photos: null });
    expect(parseListingPageSighting(page({}), '201')).toBeNull();
    expect(parseListingPageSighting(page({ applicationData: listing }), '999')).toBeNull();
    expect(parseListingPageSighting('<html>no data</html>', '201')).toBeNull();
  });
});
