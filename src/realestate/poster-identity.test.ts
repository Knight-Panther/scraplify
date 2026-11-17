import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { fakePhone, fakeUserId } from '../adapters/ss-ge/fakes.js';
import { db } from '../db/client.js';
import {
  contacts,
  posterAccounts,
  posterDaily,
  posterEntities,
  posterEntityMembers,
  posterEntityOverrides,
  posterSteps,
  realEstateListings,
} from '../db/schema/index.js';
import { cleanupTestSource, createTestSource } from '../db/test-support.js';
import {
  assignEntityIds,
  groupAccounts,
  MAX_ACCOUNTS_PER_CONTACT,
  POSTER_RULE_VERSION,
  recordPosterStep,
} from './poster-identity.js';
import { type PosterSighting, recordPosterSightings } from './posters.js';

/**
 * Who is one person or agency (Phase 17B). The rules first, without a
 * database; then the nightly step on a throwaway one. Invented values only;
 * this file's phones are the reserved fakes 40 to 79, and its emails are
 * random under example.invalid, so no other test file's accounts share them.
 */

describe('groupAccounts', () => {
  const edge = (accountId: number, contactId: number) => ({ accountId, contactId });

  it('joins accounts that share a contact, and leaves the rest alone', () => {
    const { groups } = groupAccounts({
      accounts: [1, 2, 3, 4, 5],
      edges: [edge(1, 100), edge(2, 100), edge(2, 101), edge(3, 101), edge(4, 102)],
      overrides: [],
    });
    expect(groups).toEqual([[1, 2, 3], [4], [5]]);
  });

  it('flags a contact over the cap and never joins through it', () => {
    const many = Array.from({ length: MAX_ACCOUNTS_PER_CONTACT + 1 }, (_, i) => i + 1);
    const { groups, blocked, accountsPerContact } = groupAccounts({
      accounts: many,
      edges: [...many.map((account) => edge(account, 900)), edge(1, 901), edge(2, 901)],
      overrides: [],
    });
    expect(blocked).toEqual(new Set([900]));
    expect(accountsPerContact.get(900)).toBe(MAX_ACCOUNTS_PER_CONTACT + 1);
    expect(groups[0]).toEqual([1, 2]);
    expect(groups).toHaveLength(MAX_ACCOUNTS_PER_CONTACT);
    // At the cap itself it still joins.
    const atCap = many.slice(0, MAX_ACCOUNTS_PER_CONTACT);
    expect(
      groupAccounts({ accounts: atCap, edges: atCap.map((a) => edge(a, 900)), overrides: [] })
        .groups,
    ).toEqual([atCap]);
  });

  it('applies the overrides: a link, an account or a contact split off, two accounts merged', () => {
    const base = {
      accounts: [1, 2, 3, 4],
      edges: [edge(1, 100), edge(2, 100), edge(3, 101), edge(4, 101)],
    };
    const split = (accountId: number | null, contactId: number | null) => ({
      kind: 'split' as const,
      accountId,
      otherAccountId: null,
      contactId,
    });
    expect(groupAccounts({ ...base, overrides: [split(2, 100)] }).groups).toEqual([
      [3, 4],
      [1],
      [2],
    ]);
    expect(groupAccounts({ ...base, overrides: [split(2, null)] }).groups[0]).toEqual([3, 4]);
    expect(groupAccounts({ ...base, overrides: [split(null, 101)] }).groups).toEqual([
      [1, 2],
      [3],
      [4],
    ]);
    expect(
      groupAccounts({
        ...base,
        overrides: [{ kind: 'merge', accountId: 1, otherAccountId: 4, contactId: null }],
      }).groups,
    ).toEqual([[1, 2, 3, 4]]);
  });
});

describe('assignEntityIds', () => {
  let n = 0;
  const newId = () => `new-${++n}`;

  it('keeps each id with the largest part of its accounts, and gives a new one otherwise', () => {
    const previous = new Map([
      [1, 'A'],
      [2, 'A'],
      [3, 'A'],
      [4, 'B'],
    ]);
    // A splits 2 + 1; B joins the larger part.
    expect(assignEntityIds([[1, 2, 4], [3], [9]], previous, newId)).toEqual([
      'A',
      'new-1',
      'new-2',
    ]);
    // Unchanged groups keep their ids, in any order.
    expect(assignEntityIds([[4], [1, 2, 3]], previous, newId)).toEqual(['B', 'A']);
    // Two groups wanting the same id: the larger one, which comes first, has it.
    expect(assignEntityIds([[1, 2], [3]], previous, newId)).toEqual(['A', 'new-3']);
  });
});

describe('recordPosterStep', () => {
  const sourceIds: string[] = [];
  afterEach(async () => {
    while (sourceIds.length > 0) await cleanupTestSource(sourceIds.pop() as string);
  });

  const NOW = '2026-12-02T13:30:00.000Z';
  const LATER = '2026-12-03T13:30:00.000Z';
  let nextUser = 40;

  async function newSource() {
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);
    return sourceId;
  }

  /** A listing `key` posted by `user`, showing `contactsShown` on its page. */
  function posted(
    key: string,
    user: string,
    contactsShown: { kind: 'phone' | 'email'; value: string }[],
  ): PosterSighting {
    return {
      sourceListingKey: key,
      account: { userId: user },
      contacts: contactsShown.map((contact) => ({
        ...contact,
        contactName: '',
        seenIn: 'listing_page',
      })),
      photos: null,
    };
  }

  async function entitiesOf(sourceId: string): Promise<Map<string, string>> {
    const rows = await db
      .select({ user: posterAccounts.sourceUserId, entity: posterEntityMembers.entityId })
      .from(posterAccounts)
      .innerJoin(posterEntityMembers, eq(posterEntityMembers.accountId, posterAccounts.id))
      .where(eq(posterAccounts.sourceId, sourceId));
    return new Map(rows.map((row) => [row.user, row.entity]));
  }

  const step = (sourceId: string, now = NOW) =>
    recordPosterStep(db, { sourceId, now, crawlRunId: null });

  it('joins accounts sharing a phone, or an email, keeps others apart, and keeps the ids on the next night', async () => {
    const sourceId = await newSource();
    const [a, b, c, d, e] = Array.from({ length: 5 }, () => fakeUserId(nextUser++));
    const phone = fakePhone(nextUser++);
    const email = `${randomUUID()}@example.invalid`;
    await recordPosterSightings(db, {
      sourceId,
      seenAt: '2026-12-02T01:00:00.000Z',
      sightings: [
        posted('i1', a as string, [{ kind: 'phone', value: phone }]),
        posted('i2', b as string, [{ kind: 'phone', value: phone }]),
        posted('i3', c as string, [{ kind: 'email', value: email }]),
        posted('i4', d as string, [{ kind: 'email', value: email }]),
        posted('i5', e as string, []),
      ],
    });

    const first = await step(sourceId);
    expect(first).toMatchObject({ ok: true, error: null, linksWritten: 4 });
    const night1 = await entitiesOf(sourceId);
    expect(night1.size).toBe(5);
    expect(night1.get(a as string)).toBe(night1.get(b as string));
    expect(night1.get(c as string)).toBe(night1.get(d as string));
    expect(new Set(night1.values()).size).toBe(3);

    const second = await step(sourceId, LATER);
    expect(second).toMatchObject({ ok: true, linksWritten: 0 });
    expect(await entitiesOf(sourceId)).toEqual(night1);
    const [entity] = await db
      .select()
      .from(posterEntities)
      .where(eq(posterEntities.id, night1.get(a as string) as string));
    expect(entity).toMatchObject({
      accountCount: 2,
      ruleVersion: POSTER_RULE_VERSION,
      retiredAt: null,
    });
    const steps = await db.select().from(posterSteps).where(eq(posterSteps.sourceId, sourceId));
    expect(steps.map((row) => row.ok)).toEqual([true, true]);
  });

  it('flags a phone more than the cap of accounts use, and joins none of them through it', async () => {
    const sourceId = await newSource();
    const shared = fakePhone(nextUser++);
    const users = Array.from({ length: MAX_ACCOUNTS_PER_CONTACT + 1 }, () =>
      randomUUID().toLowerCase(),
    );
    await recordPosterSightings(db, {
      sourceId,
      seenAt: '2026-12-02T01:00:00.000Z',
      sightings: users.map((user, index) =>
        posted(`c${index}`, user, [{ kind: 'phone', value: shared }]),
      ),
    });
    const result = await step(sourceId);
    expect(result.ok).toBe(true);
    expect(result.contactsFlagged).toBeGreaterThanOrEqual(1);
    const [contact] = await db.select().from(contacts).where(eq(contacts.value, shared));
    expect(contact).toMatchObject({
      accountCount: MAX_ACCOUNTS_PER_CONTACT + 1,
      mergeBlocked: true,
    });
    expect(new Set((await entitiesOf(sourceId)).values()).size).toBe(users.length);
  });

  it('splits on an override, the larger part keeping the id', async () => {
    const sourceId = await newSource();
    const [a, b, c] = Array.from({ length: 3 }, () => fakeUserId(nextUser++));
    const phone = fakePhone(nextUser++);
    await recordPosterSightings(db, {
      sourceId,
      seenAt: '2026-12-02T01:00:00.000Z',
      sightings: [
        posted('s1', a as string, [{ kind: 'phone', value: phone }]),
        posted('s2', b as string, [{ kind: 'phone', value: phone }]),
        posted('s3', c as string, [{ kind: 'phone', value: phone }]),
      ],
    });
    await step(sourceId);
    const before = await entitiesOf(sourceId);
    const joined = before.get(a as string);
    expect(new Set(before.values())).toEqual(new Set([joined]));

    // The owner says c's number was recycled: c's link to it never joins.
    const [account] = await db
      .select({ id: posterAccounts.id })
      .from(posterAccounts)
      .where(eq(posterAccounts.sourceUserId, c as string));
    const [contact] = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.value, phone));
    await db.insert(posterEntityOverrides).values({
      kind: 'split',
      accountId: account?.id,
      contactId: contact?.id,
      note: 'test',
    });
    const result = await step(sourceId, LATER);
    expect(result).toMatchObject({ ok: true, membersChanged: 1 });
    const after = await entitiesOf(sourceId);
    expect(after.get(a as string)).toBe(joined);
    expect(after.get(b as string)).toBe(joined);
    expect(after.get(c as string)).not.toBe(joined);
    const [kept] = await db
      .select()
      .from(posterEntities)
      .where(eq(posterEntities.id, joined as string));
    expect(kept?.accountCount).toBe(2);
  });

  it('counts each entity’s listings on show and new today', async () => {
    const sourceId = await newSource();
    const [a, b] = Array.from({ length: 2 }, () => fakeUserId(nextUser++));
    const phone = fakePhone(nextUser++);
    const listing = (key: string, extra: Partial<typeof realEstateListings.$inferInsert> = {}) => ({
      sourceId,
      sourceListingKey: key,
      canonicalUrl: `https://example.invalid/${key}`,
      dealType: 'sale' as const,
      propertyType: 'flat' as const,
      rooms: 2,
      areaM2: '60.00',
      currencyPosted: 'usd' as const,
      priceUsd: '100000.00',
      priceGel: '270000.00',
      cityRef: 95,
      cityName: 'თბილისი',
      sourceUpdatedAt: '2026-11-30T10:00:00.000Z',
      expectedEndAt: '2026-12-30T10:00:00.000Z',
      firstSeenAt: '2026-11-30T10:00:00.000Z',
      lastSeenAt: '2026-12-02T01:00:00.000Z',
      contentHash: 'h',
      ...extra,
    });
    await db.insert(realEstateListings).values([
      listing('d1', { groupKey: `g-${randomUUID()}` }),
      // First seen today (Tbilisi), on show.
      listing('d2', { firstSeenAt: '2026-12-02T08:00:00.000Z' }),
      // Gone: neither on show nor new.
      listing('d3', { status: 'gone', goneAt: '2026-12-01T00:00:00.000Z' }),
    ]);
    await recordPosterSightings(db, {
      sourceId,
      seenAt: '2026-12-02T01:00:00.000Z',
      sightings: [
        posted('d1', a as string, [{ kind: 'phone', value: phone }]),
        posted('d2', b as string, [{ kind: 'phone', value: phone }]),
        posted('d3', b as string, []),
      ],
    });
    const result = await step(sourceId);
    expect(result).toMatchObject({ ok: true, dailyRows: 1 });
    const rows = await db.select().from(posterDaily).where(eq(posterDaily.sourceId, sourceId));
    expect(rows).toEqual([
      {
        sourceId,
        entityId: (await entitiesOf(sourceId)).get(a as string),
        day: '2026-12-02',
        listingsOnShow: 2,
        newListings: 1,
        distinctGroups: 2,
      },
    ]);
    // The same day again rewrites it, not adds to it.
    expect(await step(sourceId, '2026-12-02T15:00:00.000Z')).toMatchObject({ dailyRows: 1 });
    expect(
      await db
        .select()
        .from(posterDaily)
        .where(inArray(posterDaily.sourceId, [sourceId])),
    ).toHaveLength(1);
  });
});
