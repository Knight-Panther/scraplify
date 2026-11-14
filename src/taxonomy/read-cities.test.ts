import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../db/client.js';
import {
  listingClassifications,
  sourceListingRevisions,
  sourceListings,
  sources,
  taxonomyTerms,
} from '../db/schema/index.js';
import {
  cleanupTestSource,
  createTestResource,
  createTestSource,
  createTestSourceListing,
} from '../db/test-support.js';
import { CITY_READ_VERSION } from './city-read.js';
import { readCitiesFromText } from './read-cities.js';
import { TAXONOMY_VERSION } from './seed-terms.js';

// Place names no real board uses, so the real location terms never answer for them.
const tag = randomUUID().slice(0, 6);
const NORTH = `ჩრდილოეთ${tag}`;
const SOUTH = `სამხრეთ${tag}`;

const sourceIds: string[] = [];
let placesSlug = '';
let targetSlug = '';
let targetId = '';

async function slugOf(sourceId: string): Promise<string> {
  const [row] = await db
    .select({ slug: sources.slug })
    .from(sources)
    .where(eq(sources.id, sourceId));
  return row?.slug ?? '';
}

async function listing(
  sourceId: string,
  title: string,
  description: string,
  locations: string[] = [],
  status: 'active' | 'quarantined' = 'active',
): Promise<string> {
  const row = await createTestSourceListing(sourceId, { status });
  const resourceId = await createTestResource(sourceId);
  const revisionId = randomUUID();
  await db.insert(sourceListingRevisions).values({
    id: revisionId,
    sourceListingId: row.id,
    parserVersion: 'test-v1',
    extractionMethod: 'http',
    rawResourceHash: 'a'.repeat(64),
    meaningfulContentHash: randomUUID().replace(/-/g, '').padEnd(64, '0'),
    titleRaw: title,
    titleNormalized: title.toLowerCase(),
    organizationRaw: null,
    description,
    locations,
    salaryRaw: null,
    publishedDate: { raw: '', parsed: '2026-09-01T00:00:00Z' },
    deadlineDate: { raw: '', parsed: '2099-12-01T00:00:00Z' },
    applicationMethod: { type: 'email', value: 'apply@example.invalid' },
    sourceCategories: [],
    structuredAttributes: {},
    createdAt: '2026-09-01T00:00:00Z',
    provenanceResourceId: resourceId,
    provenanceFetchedAt: '2026-09-01T00:00:00Z',
    provenanceNotes: null,
  });
  await db
    .update(sourceListings)
    .set({ currentRevisionId: revisionId })
    .where(eq(sourceListings.id, row.id));
  return revisionId;
}

async function liveReadings(revisionId: string) {
  return db
    .select({
      label: taxonomyTerms.label,
      method: listingClassifications.method,
      evidence: listingClassifications.evidence,
      id: listingClassifications.id,
    })
    .from(listingClassifications)
    .innerJoin(taxonomyTerms, eq(taxonomyTerms.id, listingClassifications.taxonomyTermId))
    .where(
      and(
        eq(listingClassifications.sourceListingRevisionId, revisionId),
        eq(listingClassifications.axis, 'location'),
        isNull(listingClassifications.supersededAt),
      ),
    );
}

const run = () => readCitiesFromText(db, { sourceSlug: targetSlug, placesSlug });

beforeAll(async () => {
  const placesId = await createTestSource();
  targetId = await createTestSource();
  sourceIds.push(placesId, targetId);
  placesSlug = await slugOf(placesId);
  targetSlug = await slugOf(targetId);
  await listing(placesId, 'ვაკანსია', '', [NORTH]);
  await listing(placesId, 'ვაკანსია', '', [SOUTH]);
  await listing(placesId, 'ვაკანსია', '', ['საზღვარგარეთ']);
});

afterAll(async () => {
  for (const sourceId of sourceIds.splice(0)) await cleanupTestSource(sourceId);
  await db.delete(taxonomyTerms).where(like(taxonomyTerms.code, `location-%${tag}`));
});

describe('readCitiesFromText', () => {
  it('records each named place in order, once per reader version', async () => {
    const revision = await listing(targetId, 'მოლარე', `ოფისი ${SOUTH}ში, ასევე ${NORTH}ში`);
    const first = await run();
    expect(first.readingsCreated).toBeGreaterThanOrEqual(2);
    const live = await liveReadings(revision);
    const ordered = [...live].sort(
      (a, b) =>
        ((a.evidence as { order: number }).order ?? 0) -
        ((b.evidence as { order: number }).order ?? 0),
    );
    expect(ordered.map((r) => r.label)).toEqual([SOUTH, NORTH]);
    expect(live.every((r) => r.method === 'keyword')).toBe(true);
    expect((live[0]?.evidence as { reader?: string } | undefined)?.reader).toBe(CITY_READ_VERSION);

    // One location term per place, made once.
    const terms = await db
      .select({ id: taxonomyTerms.id })
      .from(taxonomyTerms)
      .where(inArray(taxonomyTerms.code, [`location-${NORTH}`, `location-${SOUTH}`]));
    expect(terms).toHaveLength(2);

    expect((await run()).readingsCreated).toBe(0);
    expect(await liveReadings(revision)).toHaveLength(2);
  });

  it('writes nothing where no place is named, and reads it again next run', async () => {
    const revision = await listing(targetId, 'მძღოლი', 'გამოცდილება 2 წელი');
    await run();
    expect(await liveReadings(revision)).toHaveLength(0);
    expect((await run()).revisionsScanned).toBeGreaterThanOrEqual(1);
  });

  it('never reads over a place a person set, nor a quarantined listing', async () => {
    const human = await listing(targetId, 'მოლარე', `${NORTH}ში`);
    await run();
    const [reading] = await liveReadings(human);
    expect(reading).toBeDefined();
    // A person's correction: the reading retired, their own place live.
    await db
      .update(listingClassifications)
      .set({ supersededAt: new Date().toISOString() })
      .where(eq(listingClassifications.id, reading?.id as string));
    const [south] = await db
      .select({ id: taxonomyTerms.id })
      .from(taxonomyTerms)
      .where(eq(taxonomyTerms.code, `location-${SOUTH}`));
    await db.insert(listingClassifications).values({
      id: randomUUID(),
      sourceListingRevisionId: human,
      taxonomyTermId: south?.id as string,
      axis: 'location',
      method: 'human_review',
      confidence: 1,
      evidence: {},
      taxonomyVersion: TAXONOMY_VERSION,
      createdAt: new Date().toISOString(),
    });
    await run();
    expect((await liveReadings(human)).map((r) => r.method)).toEqual(['human_review']);

    const hidden = await listing(targetId, 'მოლარე', `${NORTH}ში`, [], 'quarantined');
    await run();
    expect(await liveReadings(hidden)).toHaveLength(0);
  });

  it('retires a reading from an older reader and reads again', async () => {
    const revision = await listing(targetId, 'მოლარე', `${SOUTH}ში`);
    await run();
    const [current] = await liveReadings(revision);
    await db
      .update(listingClassifications)
      .set({ evidence: { reader: 'city-read-v0', order: 0 } })
      .where(eq(listingClassifications.id, current?.id as string));
    const result = await run();
    expect(result.retired).toBeGreaterThanOrEqual(1);
    const live = await liveReadings(revision);
    expect(live).toHaveLength(1);
    expect(live[0]?.id).not.toBe(current?.id);
    expect(live[0]?.label).toBe(SOUTH);
  });
});
