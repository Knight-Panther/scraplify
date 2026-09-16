import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { db } from '../db/client.js';
import {
  auditEvents,
  opportunities,
  opportunityRevisions,
  opportunitySourceMemberships,
  outreachApprovals,
  sourceListingRevisions,
  sourceListings,
} from '../db/schema/index.js';
import {
  cleanupTestSource,
  createTestResource,
  createTestSource,
  createTestSourceListing,
} from '../db/test-support.js';
import {
  createCandidateProfile,
  deleteCandidateProfile,
  loadCandidateProfile,
  reviseCandidateProfile,
} from '../ranking/profile-store.js';
import {
  approvalState,
  approveDraft,
  contentHash,
  createDraft,
  deleteDraft,
  editDraft,
  loadDraft,
  OutreachError,
  recipientFromApplicationMethod,
} from './draft-store.js';

const NOW = '2026-09-16T12:00:00.000Z';
const LATER = '2026-09-16T13:00:00.000Z';

/** Listing text a person could never mistake for real data. */
const SECRET_BODY = 'Body text that must never reach the audit trail — marker 7f3a.';

describe('recipientFromApplicationMethod', () => {
  it('takes the address only from an email application method', () => {
    expect(recipientFromApplicationMethod({ type: 'email', value: ' jobs@example.ge ' })).toBe(
      'jobs@example.ge',
    );
    expect(recipientFromApplicationMethod({ type: 'url', value: 'https://example.ge' })).toBeNull();
    expect(recipientFromApplicationMethod({ type: 'email', value: 'not an address' })).toBeNull();
    expect(recipientFromApplicationMethod(null)).toBeNull();
  });
});

describe('outreach draft store', () => {
  const sourceIds: string[] = [];
  const profileIds: string[] = [];
  const opportunityIds: string[] = [];
  const draftIds: string[] = [];

  afterEach(async () => {
    // Audit rows outlive drafts by design (no text, no FK); for test drafts they
    // are debris, so they are removed explicitly.
    const drafts = draftIds.splice(0);
    if (drafts.length > 0)
      await db.delete(auditEvents).where(inArray(auditEvents.entityId, drafts));
    for (const id of profileIds.splice(0)) await deleteCandidateProfile(db, id);
    // Test drafts are gone with their profiles; opportunities made here are not
    // attached to anything cleanupTestSource can find by source, so unwind them
    // explicitly before the source.
    const ids = opportunityIds.splice(0);
    if (ids.length > 0) {
      await db
        .delete(opportunitySourceMemberships)
        .where(inArray(opportunitySourceMemberships.opportunityId, ids));
      await db
        .update(opportunities)
        .set({ currentCanonicalRevisionId: null })
        .where(inArray(opportunities.id, ids));
      await db.delete(opportunityRevisions).where(inArray(opportunityRevisions.opportunityId, ids));
      await db.delete(opportunities).where(inArray(opportunities.id, ids));
    }
    for (const id of sourceIds.splice(0)) await cleanupTestSource(id);
  });

  async function addListingRevision(listingId: string, sourceId: string, method: unknown) {
    const revisionId = randomUUID();
    await db.insert(sourceListingRevisions).values({
      id: revisionId,
      sourceListingId: listingId,
      parserVersion: 'test-v1',
      extractionMethod: 'http',
      rawResourceHash: 'a'.repeat(64),
      meaningfulContentHash: randomUUID().replace(/-/g, '').padEnd(64, '0'),
      titleRaw: 'Draft store test listing',
      titleNormalized: 'draft store test listing',
      organizationRaw: 'Test Org',
      description: 'description',
      locations: [],
      publishedDate: { raw: '', parsed: NOW },
      deadlineDate: { raw: '', parsed: NOW },
      applicationMethod: method,
      sourceCategories: [],
      structuredAttributes: {},
      createdAt: NOW,
      provenanceResourceId: await createTestResource(sourceId),
      provenanceFetchedAt: NOW,
      provenanceNotes: null,
    });
    await db
      .update(sourceListings)
      .set({ currentRevisionId: revisionId })
      .where(eq(sourceListings.id, listingId));
    return revisionId;
  }

  async function addOpportunityRevision(opportunityId: string) {
    const revisionId = randomUUID();
    await db.insert(opportunityRevisions).values({
      id: revisionId,
      opportunityId,
      canonicalTitle: 'Draft store test opportunity',
      canonicalStatus: 'active',
      organizationId: null,
      resolvedFields: {},
      sourceMembershipVersions: {},
      resolutionRulesetVersion: 'test',
      meaningfulContentHash: randomUUID(),
      createdAt: NOW,
    });
    await db
      .update(opportunities)
      .set({ currentCanonicalRevisionId: revisionId })
      .where(eq(opportunities.id, opportunityId));
    return revisionId;
  }

  /** A profile, a listing with a current revision, and an opportunity holding it. */
  async function setup(method: unknown = { type: 'email', value: 'hr@example.ge' }) {
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);
    const listing = await createTestSourceListing(sourceId);
    const sourceListingRevisionId = await addListingRevision(listing.id, sourceId, method);

    const opportunityId = randomUUID();
    opportunityIds.push(opportunityId);
    await db.insert(opportunities).values({
      id: opportunityId,
      type: 'job',
      canonicalTitle: 'Draft store test opportunity',
      organizationId: null,
      canonicalStatus: 'active',
      currentCanonicalRevisionId: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const opportunityRevisionId = await addOpportunityRevision(opportunityId);
    await db.insert(opportunitySourceMemberships).values({
      id: randomUUID(),
      opportunityId,
      sourceListingId: listing.id,
      decision: 'confirmed_same',
      confidence: 1,
      evidence: {},
      decidedBy: 'ruleset',
      decidedAt: NOW,
      dedupeModelOrRulesetVersion: 'test',
      supersededAt: null,
    });

    const { profileId } = await createCandidateProfile(db, {
      label: 'draft store test profile',
      claims: [{ kind: 'skill', value: 'TypeScript', evidence: 'TypeScript, 5 years' }],
      now: NOW,
    });
    profileIds.push(profileId);
    const profile = await loadCandidateProfile(db, profileId);
    if (!profile) throw new Error('setup: profile missing');

    return {
      sourceId,
      listingId: listing.id,
      sourceListingRevisionId,
      opportunityId,
      opportunityRevisionId,
      profileId,
      profileVersion: profile.version,
      claimIds: profile.claims.map((claim) => claim.id),
    };
  }

  async function draftFor(fixture: Awaited<ReturnType<typeof setup>>) {
    const draft = await createDraft(db, {
      profileId: fixture.profileId,
      profileVersion: fixture.profileVersion,
      opportunityId: fixture.opportunityId,
      opportunityRevisionId: fixture.opportunityRevisionId,
      sourceListingId: fixture.listingId,
      sourceListingRevisionId: fixture.sourceListingRevisionId,
      subject: 'Application: Draft store test opportunity',
      body: SECRET_BODY,
      language: 'en',
      generator: 'test/outreach-v1',
      claimIds: fixture.claimIds,
      now: NOW,
    });
    draftIds.push(draft.id);
    return draft;
  }

  it('makes an email draft addressed to the listing’s own address, and a cover letter otherwise', async () => {
    const email = await draftFor(await setup());
    expect(email).toMatchObject({ kind: 'email', recipient: 'hr@example.ge' });

    const letter = await draftFor(await setup({ type: 'url', value: 'https://example.ge/apply' }));
    expect(letter).toMatchObject({ kind: 'cover_letter', recipient: null, subject: null });
  });

  it('refuses a claim id that does not belong to the profile version', async () => {
    const fixture = await setup();
    await expect(
      draftFor({ ...fixture, claimIds: [...fixture.claimIds, randomUUID()] }),
    ).rejects.toMatchObject({ code: 'UNKNOWN_CLAIM' });
  });

  it('refuses to draft against a listing revision that is no longer current', async () => {
    const fixture = await setup();
    await addListingRevision(fixture.listingId, fixture.sourceId, {
      type: 'email',
      value: 'new@example.ge',
    });
    await expect(draftFor(fixture)).rejects.toMatchObject({ code: 'LISTING_NOT_CURRENT' });
  });

  it('approves exactly the content shown, and nothing else', async () => {
    const draft = await draftFor(await setup());
    const loaded = await loadDraft(db, draft.id);
    expect(loaded?.approval).toEqual({ status: 'none' });

    await expect(
      approveDraft(db, { draftId: draft.id, expectedContentHash: 'f'.repeat(64), now: LATER }),
    ).rejects.toMatchObject({ code: 'CONTENT_CHANGED' });

    await approveDraft(db, {
      draftId: draft.id,
      expectedContentHash: loaded?.contentHash ?? '',
      now: LATER,
    });
    const approval = (await loadDraft(db, draft.id))?.approval;
    expect(approval?.status).toBe('current');
    // Postgres returns its own timestamp text, not the ISO string written.
    expect(approval?.status === 'current' && Date.parse(approval.approvedAt)).toBe(
      Date.parse(LATER),
    );
  });

  it('invalidates the approval on any edit, and keeps it when saving identical text', async () => {
    const draft = await draftFor(await setup());
    const hash = (await loadDraft(db, draft.id))?.contentHash ?? '';
    await approveDraft(db, { draftId: draft.id, expectedContentHash: hash, now: LATER });

    await editDraft(db, {
      draftId: draft.id,
      subject: draft.subject,
      body: draft.body,
      now: LATER,
    });
    expect((await loadDraft(db, draft.id))?.approval.status).toBe('current');

    await editDraft(db, {
      draftId: draft.id,
      subject: draft.subject,
      body: `${draft.body} One more sentence.`,
      now: LATER,
    });
    expect((await loadDraft(db, draft.id))?.approval).toEqual({ status: 'none' });
    const [approval] = await db
      .select()
      .from(outreachApprovals)
      .where(eq(outreachApprovals.draftId, draft.id));
    expect(approval?.invalidationReason).toBe('edited');
    expect(Date.parse(approval?.invalidatedAt ?? '')).toBe(Date.parse(LATER));
  });

  it('never calls an approval current once the approved content no longer matches, even if nothing invalidated it', async () => {
    // A future write path that edits the row directly and forgets to invalidate.
    const draft = await draftFor(await setup());
    const hash = (await loadDraft(db, draft.id))?.contentHash ?? '';
    await approveDraft(db, { draftId: draft.id, expectedContentHash: hash, now: LATER });
    await db
      .update((await import('../db/schema/index.js')).outreachDrafts)
      .set({ body: 'Changed behind the store’s back.' })
      .where(eq((await import('../db/schema/index.js')).outreachDrafts.id, draft.id));

    const loaded = await loadDraft(db, draft.id);
    expect(loaded?.approval).toMatchObject({ status: 'stale', reason: 'content_changed' });
  });

  it('makes an approval stale when the listing, the opportunity or the profile changes', async () => {
    const listingCase = await setup();
    const a = await draftFor(listingCase);
    await approveDraft(db, {
      draftId: a.id,
      expectedContentHash: (await loadDraft(db, a.id))?.contentHash ?? '',
      now: LATER,
    });
    await addListingRevision(listingCase.listingId, listingCase.sourceId, {
      type: 'email',
      value: 'hr@example.ge',
    });
    expect((await loadDraft(db, a.id))?.approval).toMatchObject({
      status: 'stale',
      reason: 'inputs_changed',
    });

    const opportunityCase = await setup();
    const b = await draftFor(opportunityCase);
    await approveDraft(db, {
      draftId: b.id,
      expectedContentHash: (await loadDraft(db, b.id))?.contentHash ?? '',
      now: LATER,
    });
    await addOpportunityRevision(opportunityCase.opportunityId);
    expect((await loadDraft(db, b.id))?.approval).toMatchObject({ status: 'stale' });
    // And a stale draft cannot be re-approved until it is regenerated.
    await expect(
      approveDraft(db, {
        draftId: b.id,
        expectedContentHash: (await loadDraft(db, b.id))?.contentHash ?? '',
        now: LATER,
      }),
    ).rejects.toMatchObject({ code: 'OPPORTUNITY_NOT_CURRENT' });

    const profileCase = await setup();
    const c = await draftFor(profileCase);
    await approveDraft(db, {
      draftId: c.id,
      expectedContentHash: (await loadDraft(db, c.id))?.contentHash ?? '',
      now: LATER,
    });
    await reviseCandidateProfile(db, {
      profileId: profileCase.profileId,
      claims: [{ kind: 'skill', value: 'PostgreSQL' }],
      now: LATER,
    });
    expect((await loadDraft(db, c.id))?.approval).toMatchObject({ status: 'stale' });
  });

  it('binds the recipient and versions into the hash, not just the text', () => {
    const base = {
      kind: 'email' as const,
      recipient: 'hr@example.ge',
      subject: 'Subject',
      body: 'Body',
      profileId: 'p',
      profileVersion: 1,
      opportunityRevisionId: 'o',
      sourceListingRevisionId: 's',
    };
    const hash = contentHash(base);
    for (const change of [
      { recipient: 'other@example.ge' },
      { subject: 'Other' },
      { profileVersion: 2 },
      { opportunityRevisionId: 'o2' },
      { sourceListingRevisionId: 's2' },
      { kind: 'cover_letter' as const },
    ]) {
      expect(contentHash({ ...base, ...change })).not.toBe(hash);
    }
  });

  it('deleting a draft invalidates its approval and hides it', async () => {
    const draft = await draftFor(await setup());
    await approveDraft(db, {
      draftId: draft.id,
      expectedContentHash: (await loadDraft(db, draft.id))?.contentHash ?? '',
      now: LATER,
    });
    await deleteDraft(db, draft.id, LATER);
    expect(await loadDraft(db, draft.id)).toBeNull();
    await expect(
      editDraft(db, { draftId: draft.id, subject: null, body: 'x', now: LATER }),
    ).rejects.toBeInstanceOf(OutreachError);
    const [approval] = await db
      .select()
      .from(outreachApprovals)
      .where(eq(outreachApprovals.draftId, draft.id));
    expect(approval?.invalidationReason).toBe('deleted');
  });

  it('audits every mutation with ids and hashes only, never the text', async () => {
    const draft = await draftFor(await setup());
    const hash = (await loadDraft(db, draft.id))?.contentHash ?? '';
    await approveDraft(db, { draftId: draft.id, expectedContentHash: hash, now: LATER });
    await editDraft(db, {
      draftId: draft.id,
      subject: 'New subject',
      body: 'New body',
      now: LATER,
    });
    await deleteDraft(db, draft.id, LATER);

    const events = await db.select().from(auditEvents).where(eq(auditEvents.entityId, draft.id));
    expect(events.map((event) => event.action).sort()).toEqual(
      [
        'approval_invalidated',
        'draft_approved',
        'draft_deleted',
        'draft_edited',
        'draft_generated',
      ].sort(),
    );
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('marker 7f3a');
    expect(serialized).not.toContain('New body');
    expect(serialized).not.toContain('New subject');
    expect(serialized).not.toContain('hr@example.ge');
  });

  it('purges drafts and approvals with the profile, keeping only text-free audit rows', async () => {
    const fixture = await setup();
    const draft = await draftFor(fixture);
    await approveDraft(db, {
      draftId: draft.id,
      expectedContentHash: (await loadDraft(db, draft.id))?.contentHash ?? '',
      now: LATER,
    });
    const result = await deleteCandidateProfile(db, fixture.profileId);
    profileIds.splice(profileIds.indexOf(fixture.profileId), 1);
    expect(result.draftsDeleted).toBe(1);
    expect(await loadDraft(db, draft.id)).toBeNull();
    expect(
      await db.select().from(outreachApprovals).where(eq(outreachApprovals.draftId, draft.id)),
    ).toHaveLength(0);
    // The audit rows must go too for a test; only here, not in production.
    await db.delete(auditEvents).where(eq(auditEvents.entityId, draft.id));
  });

  it('reports no approval for a draft that was never approved', async () => {
    const draft = await draftFor(await setup());
    expect(await approvalState(db, draft)).toEqual({ status: 'none' });
  });
});
