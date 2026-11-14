import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
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
import { FIELD_GUESS_VERSION } from './field-guess.js';
import { guessFields } from './guess-fields.js';
import { TAXONOMY_VERSION } from './seed-terms.js';

const tag = randomUUID().slice(0, 8);
// Labels no real field has, so the real taxonomy never answers for them.
const COOK = `test-cook-${tag}`;
const DRIVER = `test-driver-${tag}`;

const sourceIds: string[] = [];
const termIds: Record<string, string> = {};
let labelled = '';
let target = '';

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
  attributes: Record<string, unknown> = {},
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
    description: '',
    locations: [],
    salaryRaw: null,
    publishedDate: { raw: '', parsed: '2026-09-01T00:00:00Z' },
    deadlineDate: { raw: '', parsed: '2099-12-01T00:00:00Z' },
    applicationMethod: { type: 'email', value: 'apply@example.invalid' },
    sourceCategories: [],
    structuredAttributes: attributes,
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

async function liveGuesses(revisionId: string) {
  return db
    .select()
    .from(listingClassifications)
    .where(
      and(
        eq(listingClassifications.sourceListingRevisionId, revisionId),
        isNull(listingClassifications.supersededAt),
      ),
    );
}

const run = (now = new Date().toISOString()) =>
  guessFields(db, { sourceSlug: target, labelledSlug: labelled, minExamples: 4, now });

beforeAll(async () => {
  for (const label of [COOK, DRIVER]) {
    const id = randomUUID();
    termIds[label] = id;
    await db.insert(taxonomyTerms).values({
      id,
      axis: 'profession',
      code: `profession-test-${label}`,
      label,
      taxonomyVersion: TAXONOMY_VERSION,
      parentId: null,
    });
  }
  const labelledId = await createTestSource();
  const targetId = await createTestSource();
  sourceIds.push(labelledId, targetId);
  labelled = await slugOf(labelledId);
  target = await slugOf(targetId);
  const spec = (name: string) => ({ specialty: [{ name, children: [] }] });
  for (const title of ['მზარეული', 'მზარეულის დამხმარე', 'უფროსი მზარეული', 'პიცის მზარეული']) {
    await listing(labelledId, title, spec(COOK));
  }
  for (const title of ['მძღოლი', 'სატვირთოს მძღოლი', 'ტაქსის მძღოლი', 'მძღოლი-კურიერი']) {
    await listing(labelledId, title, spec(DRIVER));
  }
});

afterAll(async () => {
  for (const sourceId of sourceIds.splice(0)) await cleanupTestSource(sourceId);
  await db.delete(taxonomyTerms).where(inArray(taxonomyTerms.id, Object.values(termIds)));
});

describe('guessFields', () => {
  it('writes a keyword guess for a listing whose board states no field, once per model', async () => {
    const targetId = sourceIds[1] as string;
    const cook = await listing(targetId, 'მზარეული ცხელ საამქროში');
    const driver = await listing(targetId, 'მძღოლი');

    const first = await run();
    expect(first.trainedOn).toBe(8);
    expect(first.guessesCreated).toBeGreaterThanOrEqual(2);

    const [cookGuess] = await liveGuesses(cook);
    expect(cookGuess?.taxonomyTermId).toBe(termIds[COOK]);
    expect(cookGuess?.method).toBe('keyword');
    expect(cookGuess?.axis).toBe('profession');
    expect(cookGuess?.confidence).toBeGreaterThanOrEqual(0.8);
    expect((cookGuess?.evidence as { model?: string } | undefined)?.model).toBe(
      FIELD_GUESS_VERSION,
    );
    expect((await liveGuesses(driver))[0]?.taxonomyTermId).toBe(termIds[DRIVER]);

    // Nothing new on the next run: each revision is guessed once per model.
    const second = await run();
    expect(second.guessesCreated).toBe(0);
    expect(await liveGuesses(cook)).toHaveLength(1);
  });

  it('writes nothing below the floor, and looks again next run', async () => {
    const targetId = sourceIds[1] as string;
    // Equal evidence for both fields: about half each.
    const both = await listing(targetId, 'მზარეული მძღოლი');
    const result = await run();
    expect(result.belowFloor).toBeGreaterThanOrEqual(1);
    expect(await liveGuesses(both)).toHaveLength(0);
    expect((await run()).revisionsScanned).toBeGreaterThanOrEqual(1);
  });

  it('never guesses over a field a person set', async () => {
    const targetId = sourceIds[1] as string;
    const revision = await listing(targetId, 'მზარეული');
    await db.insert(listingClassifications).values({
      id: randomUUID(),
      sourceListingRevisionId: revision,
      taxonomyTermId: termIds[DRIVER] as string,
      axis: 'profession',
      method: 'human_review',
      confidence: 1,
      evidence: { reasons: ['set by hand'] },
      taxonomyVersion: TAXONOMY_VERSION,
      createdAt: new Date().toISOString(),
    });
    await run();
    const live = await liveGuesses(revision);
    expect(live).toHaveLength(1);
    expect(live[0]?.method).toBe('human_review');
  });

  it('retires a guess from an older model and guesses again', async () => {
    const targetId = sourceIds[1] as string;
    const revision = await listing(targetId, 'სატვირთოს მძღოლი');
    const oldId = randomUUID();
    await db.insert(listingClassifications).values({
      id: oldId,
      sourceListingRevisionId: revision,
      taxonomyTermId: termIds[COOK] as string,
      axis: 'profession',
      method: 'keyword',
      confidence: 0.9,
      evidence: { model: 'field-guess-v0' },
      taxonomyVersion: TAXONOMY_VERSION,
      createdAt: '2026-11-01T00:00:00Z',
    });
    const result = await run();
    expect(result.retired).toBeGreaterThanOrEqual(1);
    const live = await liveGuesses(revision);
    expect(live).toHaveLength(1);
    expect(live[0]?.id).not.toBe(oldId);
    expect(live[0]?.taxonomyTermId).toBe(termIds[DRIVER]);
  });

  it('skips quarantined listings, and trains nothing from too few examples', async () => {
    const targetId = sourceIds[1] as string;
    const hidden = await listing(targetId, 'მზარეული', {}, 'quarantined');
    await run();
    expect(await liveGuesses(hidden)).toHaveLength(0);

    const thin = await guessFields(db, {
      sourceSlug: target,
      labelledSlug: labelled,
      minExamples: 9,
    });
    expect(thin).toMatchObject({ trainedOn: 8, revisionsScanned: 0, guessesCreated: 0 });
  });
});
