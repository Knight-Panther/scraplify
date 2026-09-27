import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { db, pool } from '../db/client.js';
import { acquireCrawlProcessLock } from '../db/crawl-process-lock.js';
import {
  candidateProfiles,
  duplicateCandidates,
  fetchAttempts,
  listingClassifications,
  opportunities,
  opportunityDecisions,
  opportunityRevisions,
  opportunitySourceMemberships,
  outreachDrafts,
  parserIncidents,
  rankings,
  resources,
  sourceListingRevisions,
  sourceListings,
  taxonomyTerms,
} from '../db/schema/index.js';
import {
  cleanupTestSource,
  createTestCrawlRun,
  createTestResource,
  createTestSource,
  createTestSourceListing,
} from '../db/test-support.js';
import { planTier2Revisions } from './eligibility.js';
import { runRetention } from './run-retention.js';

/**
 * Real-database tests for the whole retention pass (Phase 7C). Every source
 * used is disposable (`createTestSource`), and `sourceIds` is always passed
 * explicitly, scoping locks AND queries — the same discipline
 * `run-dedupe.test.ts` documents: an unscoped pass reads and writes the
 * WHOLE database, and this suite runs against a shared dev database in CI's
 * sibling environment.
 */

const NOW = new Date('2027-06-01T00:00:00Z');
const NOW_ISO = NOW.toISOString();

/** An instant N days before the fixed `NOW` this suite runs retention against. */
function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

// Retention policy: telemetry/trim cutoffs at 60 days, purge at 180 —
// these fixtures sit comfortably on each side of every cutoff rather than
// exactly on the boundary, so the test is not sensitive to `>` vs `>=`.
const NOT_DEAD_ENOUGH_FOR_TRIM_DAYS = 10; // well inside 60d
const DEAD_FOR_TRIM_DAYS = 90; // > 60d, < 180d
const DEAD_FOR_PURGE_DAYS = 220; // > 180d

async function insertListingWithRevision(
  sourceId: string,
  opts: {
    status: 'active' | 'closed' | 'expired';
    lastSeenAt: string;
    lastReconciledAt?: string | null;
    sourceDeadlineAt?: string | null;
    description?: string;
    /** Overrides the randomly-generated id — for tests that need to control keyset-pagination order. */
    id?: string;
  },
): Promise<{ listingId: string; revisionId: string }> {
  const listing = await createTestSourceListing(sourceId, {
    ...(opts.id === undefined ? {} : { id: opts.id }),
    status: opts.status,
    firstSeenAt: opts.lastSeenAt,
    lastSeenAt: opts.lastSeenAt,
    lastReconciledAt: opts.lastReconciledAt ?? null,
    sourceDeadlineAt: opts.sourceDeadlineAt ?? null,
  });
  const revisionId = await addRevision(sourceId, listing.id, opts.lastSeenAt, opts.description);
  await db
    .update(sourceListings)
    .set({ currentRevisionId: revisionId })
    .where(eq(sourceListings.id, listing.id));
  return { listingId: listing.id, revisionId };
}

async function addRevision(
  sourceId: string,
  listingId: string,
  createdAt: string,
  description = 'a real description of the vacancy',
): Promise<string> {
  const resourceId = await createTestResource(sourceId);
  const revisionId = randomUUID();
  await db.insert(sourceListingRevisions).values({
    id: revisionId,
    sourceListingId: listingId,
    parserVersion: 'test-v1',
    extractionMethod: 'http',
    rawResourceHash: 'a'.repeat(64),
    meaningfulContentHash: randomUUID().replace(/-/g, '').padEnd(64, '0'),
    titleRaw: 'Test listing',
    titleNormalized: 'test listing',
    organizationRaw: 'Acme',
    description,
    locations: [],
    publishedDate: { raw: '', parsed: createdAt },
    deadlineDate: { raw: '', parsed: null },
    applicationMethod: null,
    sourceCategories: [],
    structuredAttributes: {},
    createdAt,
    provenanceResourceId: resourceId,
    provenanceFetchedAt: createdAt,
    provenanceNotes: null,
  });
  return revisionId;
}

async function insertOpportunityWithRevision(
  canonicalTitle: string,
  canonicalStatus: string,
  createdAt: string,
): Promise<{ opportunityId: string; revisionId: string }> {
  const opportunityId = randomUUID();
  await db.insert(opportunities).values({
    id: opportunityId,
    type: 'job',
    canonicalTitle,
    organizationId: null,
    canonicalStatus: canonicalStatus as never,
    currentCanonicalRevisionId: null,
    createdAt,
    updatedAt: createdAt,
  });
  const revisionId = randomUUID();
  await db.insert(opportunityRevisions).values({
    id: revisionId,
    opportunityId,
    canonicalTitle,
    canonicalStatus: canonicalStatus as never,
    organizationId: null,
    resolvedFields: {},
    sourceMembershipVersions: {},
    resolutionRulesetVersion: 'test-v1',
    meaningfulContentHash: 'x'.repeat(64),
    createdAt,
  });
  await db
    .update(opportunities)
    .set({ currentCanonicalRevisionId: revisionId })
    .where(eq(opportunities.id, opportunityId));
  return { opportunityId, revisionId };
}

async function insertMembership(
  opportunityId: string,
  sourceListingId: string,
  at: string,
  options: { decidedBy?: 'ruleset' | 'model' | 'human'; supersededAt?: string | null } = {},
): Promise<void> {
  await db.insert(opportunitySourceMemberships).values({
    id: randomUUID(),
    opportunityId,
    sourceListingId,
    decision: 'confirmed_same',
    confidence: 1,
    evidence: {},
    decidedBy: options.decidedBy ?? 'ruleset',
    decidedAt: at,
    dedupeModelOrRulesetVersion: 'test-v1',
    supersededAt: options.supersededAt ?? null,
  });
}

describe('runRetention', () => {
  const sourceIds: string[] = [];
  const profileIds: string[] = [];
  const taxonomyTermIds: string[] = [];

  afterEach(async () => {
    for (const sourceId of sourceIds.splice(0)) {
      await cleanupTestSource(sourceId, { taxonomyTermIds: taxonomyTermIds.splice(0) });
    }
    for (const profileId of profileIds.splice(0)) {
      await db.delete(candidateProfiles).where(eq(candidateProfiles.id, profileId));
    }
  });

  it('tier 1: deletes aged fetch_attempts and resolved incidents; an unresolved incident, a still-referenced resource, and fresh telemetry all survive', async () => {
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);
    const run = await createTestCrawlRun(sourceId, {
      startedAt: daysAgo(DEAD_FOR_TRIM_DAYS),
      finishedAt: daysAgo(DEAD_FOR_TRIM_DAYS),
      reconciledAt: daysAgo(DEAD_FOR_TRIM_DAYS),
    });

    const agedResourceId = await createTestResource(sourceId);
    const agedAttemptId = randomUUID();
    await db.insert(fetchAttempts).values({
      id: agedAttemptId,
      crawlRunId: run.id,
      resourceId: agedResourceId,
      attemptedAt: daysAgo(DEAD_FOR_TRIM_DAYS),
      statusCode: 200,
      durationMs: 100,
      outcome: 'success',
      errorKind: null,
    });

    const freshResourceId = await createTestResource(sourceId);
    const freshAttemptId = randomUUID();
    await db.insert(fetchAttempts).values({
      id: freshAttemptId,
      crawlRunId: run.id,
      resourceId: freshResourceId,
      attemptedAt: daysAgo(NOT_DEAD_ENOUGH_FOR_TRIM_DAYS),
      statusCode: 200,
      durationMs: 100,
      outcome: 'success',
      errorKind: null,
    });

    const resolvedOldIncidentId = randomUUID();
    await db.insert(parserIncidents).values({
      id: resolvedOldIncidentId,
      sourceId,
      crawlRunId: run.id,
      detectedAt: daysAgo(DEAD_FOR_TRIM_DAYS),
      kind: 'other',
      severity: 'info',
      evidence: {},
      resolved: true,
      resolvedAt: daysAgo(DEAD_FOR_TRIM_DAYS),
    });

    const unresolvedOldIncidentId = randomUUID();
    await db.insert(parserIncidents).values({
      id: unresolvedOldIncidentId,
      sourceId,
      crawlRunId: run.id,
      detectedAt: daysAgo(DEAD_FOR_TRIM_DAYS),
      kind: 'other',
      severity: 'critical',
      evidence: {},
      resolved: false,
      resolvedAt: null,
    });

    // An orphan resource, old enough to sweep — no fetch_attempts, no
    // revision provenance, no resource_links.
    const orphanResourceId = await createTestResource(sourceId);
    await db
      .update(resources)
      .set({ fetchedAt: daysAgo(DEAD_FOR_TRIM_DAYS) })
      .where(eq(resources.id, orphanResourceId));

    const outcome = await runRetention(db, pool, { now: NOW, apply: true, sourceIds: [sourceId] });
    if (!outcome.ran) throw new Error(`expected the pass to run, got skipped: ${outcome.reason}`);

    expect(outcome.result.tier1.fetchAttemptsDeleted).toBe(1);
    expect(outcome.result.tier1.incidentsDeleted).toBe(1);
    // 2, not 1: the orphan sweep runs LAST in the same pass (plan §4's run
    // order), specifically so it sees what earlier steps freed up.
    // `agedResourceId` only becomes orphaned once `agedAttempt` itself is
    // deleted a moment earlier in this same call — the intentionally-orphan
    // `orphanResourceId` is the other one.
    expect(outcome.result.tier1.orphanResourcesDeleted).toBe(2);

    expect(
      await db.select().from(fetchAttempts).where(eq(fetchAttempts.id, agedAttemptId)),
    ).toEqual([]);
    expect(
      (await db.select().from(fetchAttempts).where(eq(fetchAttempts.id, freshAttemptId))).length,
    ).toBe(1);
    expect(await db.select().from(resources).where(eq(resources.id, agedResourceId))).toEqual([]);
    expect(
      await db.select().from(parserIncidents).where(eq(parserIncidents.id, resolvedOldIncidentId)),
    ).toEqual([]);
    expect(
      (
        await db
          .select()
          .from(parserIncidents)
          .where(eq(parserIncidents.id, unresolvedOldIncidentId))
      ).length,
    ).toBe(1);
    expect(await db.select().from(resources).where(eq(resources.id, orphanResourceId))).toEqual([]);
    // freshResourceId has an attempt referencing it, so it must survive.
    expect(
      (await db.select().from(resources).where(eq(resources.id, freshResourceId))).length,
    ).toBe(1);
  });

  it('tier 2: trims a listing dead more than 60 days (deletes its old revision, blanks and stamps the current one); leaves an active listing and a not-yet-60-day-dead listing untouched', async () => {
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);

    const dead = await insertListingWithRevision(sourceId, {
      status: 'closed',
      lastSeenAt: daysAgo(DEAD_FOR_TRIM_DAYS),
      lastReconciledAt: daysAgo(DEAD_FOR_TRIM_DAYS),
    });
    const oldRevisionId = await addRevision(
      sourceId,
      dead.listingId,
      daysAgo(DEAD_FOR_TRIM_DAYS + 1),
    );

    const stillActive = await insertListingWithRevision(sourceId, {
      status: 'active',
      lastSeenAt: daysAgo(1),
    });
    const notDeadEnough = await insertListingWithRevision(sourceId, {
      status: 'closed',
      lastSeenAt: daysAgo(NOT_DEAD_ENOUGH_FOR_TRIM_DAYS),
      lastReconciledAt: daysAgo(NOT_DEAD_ENOUGH_FOR_TRIM_DAYS),
    });

    const dryRun = await runRetention(db, pool, { now: NOW, apply: false, sourceIds: [sourceId] });
    if (!dryRun.ran) throw new Error('expected dry run to run');
    expect(dryRun.result.tier2.listingsTrimmed).toBe(1);
    expect(dryRun.result.tier2.revisionsDeleted).toBe(1);

    const applied = await runRetention(db, pool, { now: NOW, apply: true, sourceIds: [sourceId] });
    if (!applied.ran) throw new Error('expected apply to run');
    expect(applied.result.tier2).toEqual(dryRun.result.tier2);

    expect(
      await db
        .select()
        .from(sourceListingRevisions)
        .where(eq(sourceListingRevisions.id, oldRevisionId)),
    ).toEqual([]);
    const [current] = await db
      .select()
      .from(sourceListingRevisions)
      .where(eq(sourceListingRevisions.id, dead.revisionId));
    expect(current?.description).toBe('');
    expect(current?.trimmedAt).not.toBeNull();

    const [activeRevision] = await db
      .select()
      .from(sourceListingRevisions)
      .where(eq(sourceListingRevisions.id, stillActive.revisionId));
    expect(activeRevision?.description).not.toBe('');
    expect(activeRevision?.trimmedAt).toBeNull();

    const [tooFreshRevision] = await db
      .select()
      .from(sourceListingRevisions)
      .where(eq(sourceListingRevisions.id, notDeadEnough.revisionId));
    expect(tooFreshRevision?.description).not.toBe('');
    expect(tooFreshRevision?.trimmedAt).toBeNull();

    // Idempotent: nothing left to trim on a second apply.
    const secondApply = await runRetention(db, pool, {
      now: NOW,
      apply: true,
      sourceIds: [sourceId],
    });
    if (!secondApply.ran) throw new Error('expected second apply to run');
    expect(secondApply.result.tier2.listingsTrimmed).toBe(0);
    expect(secondApply.result.tier2.revisionsDeleted).toBe(0);
  });

  it('tier 2: excludes a dead listing whose opportunity carries a shortlist decision or an outreach draft', async () => {
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);
    const dead = await insertListingWithRevision(sourceId, {
      status: 'closed',
      lastSeenAt: daysAgo(DEAD_FOR_TRIM_DAYS),
      lastReconciledAt: daysAgo(DEAD_FOR_TRIM_DAYS),
    });
    await addRevision(sourceId, dead.listingId, daysAgo(DEAD_FOR_TRIM_DAYS + 1));
    const { opportunityId } = await insertOpportunityWithRevision(
      'Test opportunity',
      'closed',
      daysAgo(DEAD_FOR_TRIM_DAYS),
    );
    await insertMembership(opportunityId, dead.listingId, daysAgo(DEAD_FOR_TRIM_DAYS));
    await db.insert(opportunityDecisions).values({
      id: randomUUID(),
      opportunityId,
      decision: 'saved',
      note: null,
      decidedAt: daysAgo(DEAD_FOR_TRIM_DAYS),
      firstDecidedAt: daysAgo(DEAD_FOR_TRIM_DAYS),
    });

    const outcome = await runRetention(db, pool, { now: NOW, apply: true, sourceIds: [sourceId] });
    if (!outcome.ran) throw new Error('expected the pass to run');
    expect(outcome.result.tier2.listingsTrimmed).toBe(0);
    expect(outcome.result.tier2.revisionsDeleted).toBe(0);

    const [revision] = await db
      .select()
      .from(sourceListingRevisions)
      .where(eq(sourceListingRevisions.id, dead.revisionId));
    expect(revision?.description).not.toBe('');
  });

  it('planTier2Revisions: skips a non-current revision pinned by an outreach draft', async () => {
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);
    const listing = await insertListingWithRevision(sourceId, {
      status: 'closed',
      lastSeenAt: daysAgo(DEAD_FOR_TRIM_DAYS),
      lastReconciledAt: daysAgo(DEAD_FOR_TRIM_DAYS),
    });
    const oldRevisionId = await addRevision(
      sourceId,
      listing.listingId,
      daysAgo(DEAD_FOR_TRIM_DAYS + 1),
    );
    const { opportunityId, revisionId: opportunityRevisionId } =
      await insertOpportunityWithRevision(
        'Pinned opportunity',
        'closed',
        daysAgo(DEAD_FOR_TRIM_DAYS),
      );

    const profileId = randomUUID();
    profileIds.push(profileId);
    await db.insert(candidateProfiles).values({
      id: profileId,
      label: 'test profile',
      version: 1,
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    });
    await db.insert(outreachDrafts).values({
      id: randomUUID(),
      profileId,
      profileVersion: 1,
      opportunityId,
      opportunityRevisionId,
      sourceListingId: listing.listingId,
      sourceListingRevisionId: oldRevisionId,
      kind: 'cover_letter',
      recipient: null,
      subject: null,
      body: 'draft body',
      language: 'en',
      generator: 'test',
      claimIds: [],
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
      deletedAt: null,
    });

    const [plan] = await planTier2Revisions(db, [listing.listingId]);
    expect(plan?.deletableRevisionIds).toEqual([]);
    expect(plan?.skippedPinnedByDraft).toBe(1);
  });

  it('tier 3: an entangled cluster (one dead candidate, one still-active member) is left entirely untouched', async () => {
    const sourceA = await createTestSource();
    const sourceB = await createTestSource();
    sourceIds.push(sourceA, sourceB);

    const dead = await insertListingWithRevision(sourceA, {
      status: 'closed',
      lastSeenAt: daysAgo(DEAD_FOR_PURGE_DAYS),
      lastReconciledAt: daysAgo(DEAD_FOR_PURGE_DAYS),
    });
    const alive = await insertListingWithRevision(sourceB, {
      status: 'active',
      lastSeenAt: daysAgo(1),
    });
    const { opportunityId } = await insertOpportunityWithRevision(
      'Entangled opportunity',
      'active',
      daysAgo(DEAD_FOR_PURGE_DAYS),
    );
    await insertMembership(opportunityId, dead.listingId, daysAgo(DEAD_FOR_PURGE_DAYS));
    await insertMembership(opportunityId, alive.listingId, daysAgo(1));

    const outcome = await runRetention(db, pool, {
      now: NOW,
      apply: true,
      sourceIds: [sourceA, sourceB],
    });
    if (!outcome.ran) throw new Error('expected the pass to run');
    expect(outcome.result.tier3.listingsDeleted).toBe(0);
    expect(outcome.result.tier3.opportunitiesDeleted).toBe(0);
    expect(outcome.result.tier3.blockedEntangled).toBeGreaterThan(0);

    expect(
      (await db.select().from(opportunities).where(eq(opportunities.id, opportunityId))).length,
    ).toBe(1);
    expect(
      (await db.select().from(sourceListings).where(eq(sourceListings.id, dead.listingId))).length,
    ).toBe(1);
  });

  it('tier 3: a fully-dead multi-member cluster is purged whole, and a second pass finds nothing left to do', async () => {
    const sourceA = await createTestSource();
    const sourceB = await createTestSource();
    sourceIds.push(sourceA, sourceB);

    const first = await insertListingWithRevision(sourceA, {
      status: 'closed',
      lastSeenAt: daysAgo(DEAD_FOR_PURGE_DAYS),
      lastReconciledAt: daysAgo(DEAD_FOR_PURGE_DAYS),
    });
    const second = await insertListingWithRevision(sourceB, {
      status: 'expired',
      lastSeenAt: daysAgo(DEAD_FOR_PURGE_DAYS),
      sourceDeadlineAt: daysAgo(DEAD_FOR_PURGE_DAYS),
    });
    const { opportunityId } = await insertOpportunityWithRevision(
      'Fully dead opportunity',
      'closed',
      daysAgo(DEAD_FOR_PURGE_DAYS),
    );
    await insertMembership(opportunityId, first.listingId, daysAgo(DEAD_FOR_PURGE_DAYS));
    await insertMembership(opportunityId, second.listingId, daysAgo(DEAD_FOR_PURGE_DAYS));
    const duplicateId = randomUUID();
    await db.insert(duplicateCandidates).values({
      id: duplicateId,
      sourceListingIdA: first.listingId < second.listingId ? first.listingId : second.listingId,
      sourceListingIdB: first.listingId < second.listingId ? second.listingId : first.listingId,
      generatedAt: daysAgo(DEAD_FOR_PURGE_DAYS),
      generationMethod: 'deterministic_match',
      similarityScore: 1,
      status: 'evaluated',
      resultingDecision: 'confirmed_same',
      decidedBy: 'ruleset',
      evidence: {},
    });

    const dryRun = await runRetention(db, pool, {
      now: NOW,
      apply: false,
      sourceIds: [sourceA, sourceB],
    });
    if (!dryRun.ran) throw new Error('expected dry run to run');
    expect(dryRun.result.tier3.listingsDeleted).toBe(2);
    expect(dryRun.result.tier3.opportunitiesDeleted).toBe(1);
    expect(dryRun.result.tier3.duplicateCandidatesDeleted).toBe(1);

    const applied = await runRetention(db, pool, {
      now: NOW,
      apply: true,
      sourceIds: [sourceA, sourceB],
    });
    if (!applied.ran) throw new Error('expected apply to run');
    expect(applied.result.tier3).toEqual(dryRun.result.tier3);

    expect(
      (await db.select().from(opportunities).where(eq(opportunities.id, opportunityId))).length,
    ).toBe(0);
    expect(
      (await db.select().from(sourceListings).where(eq(sourceListings.id, first.listingId))).length,
    ).toBe(0);
    expect(
      (await db.select().from(sourceListings).where(eq(sourceListings.id, second.listingId)))
        .length,
    ).toBe(0);
    expect(
      (
        await db
          .select()
          .from(sourceListingRevisions)
          .where(eq(sourceListingRevisions.id, first.revisionId))
      ).length,
    ).toBe(0);
    expect(
      (
        await db
          .select()
          .from(opportunitySourceMemberships)
          .where(eq(opportunitySourceMemberships.opportunityId, opportunityId))
      ).length,
    ).toBe(0);
    expect(
      (await db.select().from(duplicateCandidates).where(eq(duplicateCandidates.id, duplicateId)))
        .length,
    ).toBe(0);

    // Idempotent: everything is already gone, so a second apply over the
    // same (now-empty) scope does nothing.
    const secondApply = await runRetention(db, pool, {
      now: NOW,
      apply: true,
      sourceIds: [sourceA, sourceB],
    });
    if (!secondApply.ran) throw new Error('expected second apply to run');
    expect(secondApply.result.tier3.listingsDeleted).toBe(0);
    expect(secondApply.result.tier3.opportunitiesDeleted).toBe(0);
  });

  it('tier 3: a human-decided membership blocks purge even though the listing is otherwise dead long enough', async () => {
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);
    const dead = await insertListingWithRevision(sourceId, {
      status: 'closed',
      lastSeenAt: daysAgo(DEAD_FOR_PURGE_DAYS),
      lastReconciledAt: daysAgo(DEAD_FOR_PURGE_DAYS),
    });
    const { opportunityId } = await insertOpportunityWithRevision(
      'Human-decided opportunity',
      'closed',
      daysAgo(DEAD_FOR_PURGE_DAYS),
    );
    await insertMembership(opportunityId, dead.listingId, daysAgo(DEAD_FOR_PURGE_DAYS), {
      decidedBy: 'human',
    });

    const outcome = await runRetention(db, pool, { now: NOW, apply: true, sourceIds: [sourceId] });
    if (!outcome.ran) throw new Error('expected the pass to run');
    expect(outcome.result.tier3.listingsDeleted).toBe(0);
    expect(
      (await db.select().from(sourceListings).where(eq(sourceListings.id, dead.listingId))).length,
    ).toBe(1);
  });

  it('tier 3: a ranking blocks purge even though every member is a candidate', async () => {
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);
    const dead = await insertListingWithRevision(sourceId, {
      status: 'closed',
      lastSeenAt: daysAgo(DEAD_FOR_PURGE_DAYS),
      lastReconciledAt: daysAgo(DEAD_FOR_PURGE_DAYS),
    });
    const { opportunityId, revisionId: opportunityRevisionId } =
      await insertOpportunityWithRevision(
        'Ranked opportunity',
        'closed',
        daysAgo(DEAD_FOR_PURGE_DAYS),
      );
    await insertMembership(opportunityId, dead.listingId, daysAgo(DEAD_FOR_PURGE_DAYS));

    const profileId = randomUUID();
    profileIds.push(profileId);
    await db.insert(candidateProfiles).values({
      id: profileId,
      label: 'test profile',
      version: 1,
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    });
    await db.insert(rankings).values({
      id: randomUUID(),
      opportunityId,
      opportunityRevisionId,
      profileId,
      profileVersion: 1,
      evaluationVersion: 'test-v1',
      score: 0.5,
      eligible: true,
      hardFilterReasons: [],
      componentScores: {},
      createdAt: NOW_ISO,
    });

    const outcome = await runRetention(db, pool, { now: NOW, apply: true, sourceIds: [sourceId] });
    if (!outcome.ran) throw new Error('expected the pass to run');
    expect(outcome.result.tier3.listingsDeleted).toBe(0);
    expect(outcome.result.tier3.blockedUserData).toBeGreaterThan(0);
  });

  it('tier 3: a human-reviewed classification blocks purge', async () => {
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);
    const dead = await insertListingWithRevision(sourceId, {
      status: 'closed',
      lastSeenAt: daysAgo(DEAD_FOR_PURGE_DAYS),
      lastReconciledAt: daysAgo(DEAD_FOR_PURGE_DAYS),
    });

    const termId = randomUUID();
    taxonomyTermIds.push(termId);
    await db.insert(taxonomyTerms).values({
      id: termId,
      axis: 'profession',
      code: `test-term-${termId}`,
      label: 'Test term',
      taxonomyVersion: 'test-v1',
      parentId: null,
    });
    await db.insert(listingClassifications).values({
      id: randomUUID(),
      sourceListingRevisionId: dead.revisionId,
      taxonomyTermId: termId,
      axis: 'profession',
      method: 'human_review',
      confidence: 1,
      evidence: {},
      taxonomyVersion: 'test-v1',
      createdAt: daysAgo(DEAD_FOR_PURGE_DAYS),
      supersededAt: null,
      previousClassificationId: null,
    });

    const outcome = await runRetention(db, pool, { now: NOW, apply: true, sourceIds: [sourceId] });
    if (!outcome.ran) throw new Error('expected the pass to run');
    expect(outcome.result.tier3.listingsDeleted).toBe(0);
    expect(
      (await db.select().from(sourceListings).where(eq(sourceListings.id, dead.listingId))).length,
    ).toBe(1);
  });

  it('tier 3: a superseded membership in ANOTHER opportunity keeps the whole cluster — not just the one listing that first looked entangled (P1, adversarial review 2026-09-28)', async () => {
    // L1 has a LIVE membership in O2 (blocked directly by a ranking) and a
    // SUPERSEDED membership in O1 (shared with M, otherwise a fully candidate
    // pair). A two-step lookup that tests O1's members against "is a
    // candidate" rather than "is deletable" wrongly marks O1 deletable — its
    // members (L1, M) are both candidates — even though L1 itself is never
    // going to be deleted (O2 keeps it), which would delete O1 while L1's
    // own membership row in it survives, and previously threw the leftover-
    // membership assertion below and rolled back every tier 3 batch, forever.
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);

    const l1 = await insertListingWithRevision(sourceId, {
      status: 'closed',
      lastSeenAt: daysAgo(DEAD_FOR_PURGE_DAYS),
      lastReconciledAt: daysAgo(DEAD_FOR_PURGE_DAYS),
    });
    const m = await insertListingWithRevision(sourceId, {
      status: 'closed',
      lastSeenAt: daysAgo(DEAD_FOR_PURGE_DAYS),
      lastReconciledAt: daysAgo(DEAD_FOR_PURGE_DAYS),
    });

    const { opportunityId: o1 } = await insertOpportunityWithRevision(
      'O1 (shared history)',
      'closed',
      daysAgo(DEAD_FOR_PURGE_DAYS + 10),
    );
    await insertMembership(o1, l1.listingId, daysAgo(DEAD_FOR_PURGE_DAYS + 10), {
      supersededAt: daysAgo(DEAD_FOR_PURGE_DAYS),
    });
    await insertMembership(o1, m.listingId, daysAgo(DEAD_FOR_PURGE_DAYS + 10));

    const { opportunityId: o2, revisionId: o2RevisionId } = await insertOpportunityWithRevision(
      'O2 (kept by a ranking)',
      'closed',
      daysAgo(DEAD_FOR_PURGE_DAYS),
    );
    await insertMembership(o2, l1.listingId, daysAgo(DEAD_FOR_PURGE_DAYS));

    const profileId = randomUUID();
    profileIds.push(profileId);
    await db.insert(candidateProfiles).values({
      id: profileId,
      label: 'test profile',
      version: 1,
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    });
    await db.insert(rankings).values({
      id: randomUUID(),
      opportunityId: o2,
      opportunityRevisionId: o2RevisionId,
      profileId,
      profileVersion: 1,
      evaluationVersion: 'test-v1',
      score: 0.5,
      eligible: true,
      hardFilterReasons: [],
      componentScores: {},
      createdAt: NOW_ISO,
    });

    // The whole point: this must not throw (the leftover-membership
    // assertion in runTier3 firing was the observable symptom of the bug).
    const outcome = await runRetention(db, pool, { now: NOW, apply: true, sourceIds: [sourceId] });
    if (!outcome.ran) throw new Error('expected the pass to run');

    // Nothing in this connected component is safe to delete: L1 is kept (O2
    // keeps it), so O1 must be kept too (L1's superseded row in it would
    // otherwise survive its deletion), which keeps M as well.
    expect(outcome.result.tier3.listingsDeleted).toBe(0);
    expect(outcome.result.tier3.opportunitiesDeleted).toBe(0);
    expect(
      (await db.select().from(sourceListings).where(eq(sourceListings.id, l1.listingId))).length,
    ).toBe(1);
    expect(
      (await db.select().from(sourceListings).where(eq(sourceListings.id, m.listingId))).length,
    ).toBe(1);
    expect((await db.select().from(opportunities).where(eq(opportunities.id, o1))).length).toBe(1);
    expect((await db.select().from(opportunities).where(eq(opportunities.id, o2))).length).toBe(1);

    // Idempotent: a second apply over the same, still-entangled fixtures
    // does nothing either (confirms the fix, not just a lucky first pass).
    const secondOutcome = await runRetention(db, pool, {
      now: NOW,
      apply: true,
      sourceIds: [sourceId],
    });
    if (!secondOutcome.ran) throw new Error('expected the second pass to run');
    expect(secondOutcome.result.tier3.listingsDeleted).toBe(0);
  });

  it('tier 3: pagination finds a deletable listing behind a full page of permanently-blocked ones with lower ids, in one run (P1, adversarial review 2026-09-28)', async () => {
    // Without keyset pagination, a batch selected by id alone would keep
    // re-selecting the same blocked low-id rows every run and never reach a
    // genuinely deletable listing sitting behind them. Ids are generated and
    // sorted up front so the three entangled (permanently blocked) listings
    // are guaranteed to sort BEFORE the one deletable listing, and
    // batchSize.tier3 is set to 2 so the blocked ones alone fill an entire
    // page with no work.
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);

    const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()].sort();
    const [blockedId1, blockedId2, blockedId3, deletableId] = ids as [
      string,
      string,
      string,
      string,
    ];

    for (const blockedId of [blockedId1, blockedId2, blockedId3]) {
      const blocked = await insertListingWithRevision(sourceId, {
        id: blockedId,
        status: 'closed',
        lastSeenAt: daysAgo(DEAD_FOR_PURGE_DAYS),
        lastReconciledAt: daysAgo(DEAD_FOR_PURGE_DAYS),
      });
      // A still-active partner in the same opportunity — permanently
      // entangled, since it never becomes dead in this test.
      const activePartner = await insertListingWithRevision(sourceId, {
        status: 'active',
        lastSeenAt: daysAgo(1),
      });
      const { opportunityId } = await insertOpportunityWithRevision(
        `Entangled opportunity (${blockedId})`,
        'active',
        daysAgo(DEAD_FOR_PURGE_DAYS),
      );
      await insertMembership(opportunityId, blocked.listingId, daysAgo(DEAD_FOR_PURGE_DAYS));
      await insertMembership(opportunityId, activePartner.listingId, daysAgo(1));
    }

    const deletable = await insertListingWithRevision(sourceId, {
      id: deletableId,
      status: 'closed',
      lastSeenAt: daysAgo(DEAD_FOR_PURGE_DAYS),
      lastReconciledAt: daysAgo(DEAD_FOR_PURGE_DAYS),
    });
    const { opportunityId: deletableOpportunityId } = await insertOpportunityWithRevision(
      'Fully dead opportunity',
      'closed',
      daysAgo(DEAD_FOR_PURGE_DAYS),
    );
    await insertMembership(
      deletableOpportunityId,
      deletable.listingId,
      daysAgo(DEAD_FOR_PURGE_DAYS),
    );

    const outcome = await runRetention(db, pool, {
      now: NOW,
      apply: true,
      sourceIds: [sourceId],
      batchSize: { tier3: 2 },
    });
    if (!outcome.ran) throw new Error('expected the pass to run');

    expect(outcome.result.tier3.listingsDeleted).toBe(1);
    expect(outcome.result.tier3.blockedEntangled).toBeGreaterThanOrEqual(3);

    expect(
      (await db.select().from(sourceListings).where(eq(sourceListings.id, deletable.listingId)))
        .length,
    ).toBe(0);
    expect(
      (await db.select().from(opportunities).where(eq(opportunities.id, deletableOpportunityId)))
        .length,
    ).toBe(0);
    for (const blockedId of [blockedId1, blockedId2, blockedId3]) {
      expect(
        (await db.select().from(sourceListings).where(eq(sourceListings.id, blockedId))).length,
      ).toBe(1);
    }
  });

  it('skips the whole pass when a source crawl lock is already held', async () => {
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);
    const crawlLock = await acquireCrawlProcessLock(pool, sourceId);
    if (crawlLock === null)
      throw new Error('expected to acquire the crawl lock for this fresh source');
    try {
      const outcome = await runRetention(db, pool, {
        now: NOW,
        apply: true,
        sourceIds: [sourceId],
      });
      expect(outcome.ran).toBe(false);
    } finally {
      await crawlLock.release();
    }
  });
});
