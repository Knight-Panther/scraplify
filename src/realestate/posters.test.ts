import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { FAKE_PHOTO_GUID, fakePhone, fakePhoneTyped, fakeUserId } from '../adapters/ss-ge/fakes.js';
import { db } from '../db/client.js';
import {
  contacts,
  listingContacts,
  listingPhotoRefs,
  listingPosters,
  photoRefs,
  posterAccounts,
  realEstateListings,
} from '../db/schema/index.js';
import { cleanupTestSource, createTestSource } from '../db/test-support.js';
import { backfillDescriptionContacts } from './poster-backfill.js';
import { type PhotoSetSighting, type PosterSighting, recordPosterSightings } from './posters.js';

/**
 * The page-by-page writer of the private directory (Phases 17B and 17G),
 * on a throwaway database. Invented values only; this file's phones are
 * the reserved fakes 20 to 39, so no other test file's accounts share them.
 */

const HOUR_MS = 60 * 60 * 1000;
const T0 = Date.parse('2026-12-01T21:30:00.000Z');
const at = (hours: number) => new Date(T0 + hours * HOUR_MS).toISOString();
const instant = (value: string | null | undefined) =>
  value === null || value === undefined ? null : new Date(value).getTime();
const ref = (index: number) => `20241105/${index}_${FAKE_PHOTO_GUID}.jpg`;

function photos(indexes: number[], origin: PhotoSetSighting['origin'] = 'row'): PhotoSetSighting {
  return {
    origin,
    refs: indexes.map(ref),
    mainRef: indexes.length > 0 ? ref(indexes[0] as number) : null,
    imageCount: indexes.length,
    photos: indexes.map((index) => ({
      ref: ref(index),
      uploadDay: '2024-11-05',
      is360: false,
      imageType: 1,
    })),
  };
}

const sighting = (key: string, overrides: Partial<PosterSighting> = {}): PosterSighting => ({
  sourceListingKey: key,
  account: null,
  contacts: [],
  photos: null,
  ...overrides,
});

describe('recordPosterSightings', () => {
  const sourceIds: string[] = [];
  afterEach(async () => {
    while (sourceIds.length > 0) await cleanupTestSource(sourceIds.pop() as string);
  });
  async function newSource() {
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);
    return sourceId;
  }
  const record = (sourceId: string, seenAt: string, sightings: PosterSighting[]) =>
    recordPosterSightings(db, { sourceId, seenAt, sightings });

  async function photoRows(sourceId: string, key: string) {
    return db
      .select()
      .from(listingPhotoRefs)
      .where(
        and(eq(listingPhotoRefs.sourceId, sourceId), eq(listingPhotoRefs.sourceListingKey, key)),
      )
      .orderBy(asc(listingPhotoRefs.origin), asc(listingPhotoRefs.validFrom));
  }

  it('writes nothing for an unchanged photo set, and one new row that closes the old for a change', async () => {
    const sourceId = await newSource();
    expect(
      await record(sourceId, at(0), [sighting('p1', { photos: photos([1, 2, 3]) })]),
    ).toMatchObject({
      photoSetsOpened: 1,
      photoSetsClosed: 0,
    });
    // The same set, the next night and again: nothing.
    for (const hours of [24, 24, 25]) {
      expect(
        await record(sourceId, at(hours), [sighting('p1', { photos: photos([1, 2, 3]) })]),
      ).toMatchObject({ photoSetsOpened: 0, photoSetsClosed: 0 });
    }
    expect(await photoRows(sourceId, 'p1')).toHaveLength(1);

    // A reorder is a change: one row closed, one opened.
    expect(
      await record(sourceId, at(48), [sighting('p1', { photos: photos([2, 1, 3]) })]),
    ).toMatchObject({ photoSetsOpened: 1, photoSetsClosed: 1 });
    // So is a new photo.
    expect(
      await record(sourceId, at(72), [sighting('p1', { photos: photos([2, 1, 3, 4]) })]),
    ).toMatchObject({ photoSetsOpened: 1, photoSetsClosed: 1 });
    const rows = await photoRows(sourceId, 'p1');
    expect(rows.map((row) => row.refs)).toEqual([
      [ref(1), ref(2), ref(3)],
      [ref(2), ref(1), ref(3)],
      [ref(2), ref(1), ref(3), ref(4)],
    ]);
    expect(rows.map((row) => [instant(row.validFrom), instant(row.validTo)])).toEqual([
      [instant(at(0)), instant(at(48))],
      [instant(at(48)), instant(at(72))],
      [instant(at(72)), null],
    ]);
    expect(rows[2]).toMatchObject({ mainRef: ref(2), imageCount: 4 });

    // A sighting older than the open set changes nothing.
    expect(await record(sourceId, at(60), [sighting('p1', { photos: photos([9]) })])).toMatchObject(
      { photoSetsOpened: 0, photoSetsClosed: 0 },
    );
  });

  it('keeps a row and a listing page apart, so their sets never take turns', async () => {
    const sourceId = await newSource();
    await record(sourceId, at(0), [sighting('p2', { photos: photos([1, 2]) })]);
    await record(sourceId, at(1), [
      sighting('p2', { photos: photos([1, 2, 3, 4, 5], 'listing_page') }),
    ]);
    expect(
      await record(sourceId, at(24), [sighting('p2', { photos: photos([1, 2]) })]),
    ).toMatchObject({ photoSetsOpened: 0, photoSetsClosed: 0 });
    const rows = await photoRows(sourceId, 'p2');
    expect(rows.map((row) => [row.origin, row.validTo])).toEqual([
      ['listing_page', null],
      ['row', null],
    ]);
  });

  it('notes each photo once, with the listing it was first seen on and its upload day', async () => {
    const sourceId = await newSource();
    await record(sourceId, at(0), [sighting('p3', { photos: photos([1, 2]) })]);
    await record(sourceId, at(5), [sighting('p4', { photos: photos([2, 7]) })]);
    const noted = await db
      .select()
      .from(photoRefs)
      .where(eq(photoRefs.sourceId, sourceId))
      .orderBy(asc(photoRefs.ref));
    expect(
      noted.map((row) => [row.ref, row.firstListingKey, instant(row.firstSeenAt), row.uploadDay]),
    ).toEqual([
      [ref(1), 'p3', instant(at(0)), '2024-11-05'],
      [ref(2), 'p3', instant(at(0)), '2024-11-05'],
      [ref(7), 'p4', instant(at(5)), '2024-11-05'],
    ]);
  });

  it('upserts the account and its listing, moving last seen on and keeping what a page did not say', async () => {
    const sourceId = await newSource();
    const user = fakeUserId(20);
    const fromRow = sighting('a1', {
      account: { userId: user, displayName: 'შპს გამოგონილი', userType: 2 },
    });
    expect(await record(sourceId, at(0), [fromRow])).toMatchObject({
      accountsWritten: 1,
      postersWritten: 1,
    });
    // The same page again at the same instant: nothing. Within the hour: the listing only.
    expect(await record(sourceId, at(0), [fromRow])).toMatchObject({
      accountsWritten: 0,
      postersWritten: 0,
    });
    expect(await record(sourceId, at(0.5), [fromRow])).toMatchObject({
      accountsWritten: 0,
      postersWritten: 1,
    });
    // The listing page names the contact and the account's kind; the row's name stays.
    const fromPage = sighting('a1', {
      account: { userId: user, contactName: 'ნინო', entityType: 'Broker', listingCount: 36 },
      contacts: [
        { kind: 'phone', value: fakePhone(21), contactName: 'ნინო', seenIn: 'listing_page' },
      ],
    });
    expect(await record(sourceId, at(24), [fromPage])).toMatchObject({
      accountsWritten: 1,
      postersWritten: 1,
      contactsWritten: 1,
      listingContactsWritten: 1,
    });
    const [account] = await db
      .select()
      .from(posterAccounts)
      .where(eq(posterAccounts.sourceId, sourceId));
    expect(account).toMatchObject({
      sourceUserId: user,
      displayName: 'შპს გამოგონილი',
      contactName: 'ნინო',
      userType: 2,
      entityType: 'Broker',
      listingCount: 36,
    });
    expect([instant(account?.firstSeenAt), instant(account?.lastSeenAt)]).toEqual([
      instant(at(0)),
      instant(at(24)),
    ]);
    const [link] = await db
      .select()
      .from(listingPosters)
      .where(eq(listingPosters.sourceId, sourceId));
    expect([instant(link?.firstSeenAt), instant(link?.lastSeenAt)]).toEqual([
      instant(at(0)),
      instant(at(24)),
    ]);
    // Rerun: idempotent.
    expect(await record(sourceId, at(24), [fromPage])).toEqual({
      accountsWritten: 0,
      postersWritten: 0,
      contactsWritten: 0,
      listingContactsWritten: 0,
      photoSetsOpened: 0,
      photoSetsClosed: 0,
    });
  });

  it('backfills description contacts from the live rows, once, with each listing’s own dates', async () => {
    const sourceId = await newSource();
    const email = `${randomUUID()}@example.invalid`;
    const base = {
      sourceId,
      dealType: 'sale' as const,
      propertyType: 'flat' as const,
      sourceUpdatedAt: at(-50),
      firstSeenAt: at(-50),
      lastSeenAt: at(-2),
      contentHash: 'h',
    };
    await db.insert(realEstateListings).values([
      {
        ...base,
        sourceListingKey: 'b1',
        canonicalUrl: 'https://example.invalid/b1',
        description: `ტელ: ${fakePhoneTyped(22)}, ფასი 120000 $, ${email}`,
      },
      {
        ...base,
        sourceListingKey: 'b2',
        canonicalUrl: 'https://example.invalid/b2',
        description: 'საკადასტრო 01.10.13.002.015, 2024 წელი, სართული 5/12',
      },
      { ...base, sourceListingKey: 'b3', canonicalUrl: 'https://example.invalid/b3' },
    ]);

    const first = await backfillDescriptionContacts(db, { sourceId, batchSize: 2 });
    expect(first).toEqual({
      listingsRead: 2,
      listingsWithContacts: 1,
      contactsWritten: 2,
      listingContactsWritten: 2,
    });
    const linked = await db
      .select({
        kind: contacts.kind,
        value: contacts.value,
        seenIn: listingContacts.seenIn,
        firstSeenAt: listingContacts.firstSeenAt,
        lastSeenAt: listingContacts.lastSeenAt,
      })
      .from(listingContacts)
      .innerJoin(contacts, eq(contacts.id, listingContacts.contactId))
      .where(eq(listingContacts.sourceId, sourceId))
      .orderBy(asc(contacts.kind));
    expect(linked.map((row) => [row.kind, row.value, row.seenIn])).toEqual([
      ['email', email, 'description'],
      ['phone', fakePhone(22), 'description'],
    ]);
    expect(linked.map((row) => [instant(row.firstSeenAt), instant(row.lastSeenAt)])).toEqual([
      [instant(at(-50)), instant(at(-2))],
      [instant(at(-50)), instant(at(-2))],
    ]);

    const second = await backfillDescriptionContacts(db, { sourceId });
    expect(second).toMatchObject({ listingsWithContacts: 1, listingContactsWritten: 0 });
  });
});
