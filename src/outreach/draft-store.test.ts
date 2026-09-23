import { randomUUID } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import { eq, inArray } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  listDrafts,
  loadDraft,
  loadDraftContext,
  OutreachError,
  recipientFromApplicationMethod,
} from './draft-store.js';
import { generateDraft } from './generate-draft.js';

/** A fake Claude client that hands back a fixed, valid tool call — no network. */
function fakeGenerationClient(subject: string, body: string, claimIds: string[]) {
  const create = vi.fn().mockResolvedValue({
    model: 'claude-opus-5',
    stop_reason: 'tool_use',
    content: [
      {
        type: 'tool_use',
        id: 'tu_1',
        name: 'record_application_draft',
        input: { subject, body, claim_ids: claimIds },
      },
    ],
  });
  const client = { beta: { messages: { create } } } as unknown as Anthropic;
  return { client, create };
}

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

  async function addOpportunityRevision(
    opportunityId: string,
    canonicalTitle = 'Draft store test opportunity',
  ) {
    const revisionId = randomUUID();
    await db.insert(opportunityRevisions).values({
      id: revisionId,
      opportunityId,
      canonicalTitle,
      canonicalStatus: 'active',
      organizationId: null,
      resolvedFields: {},
      sourceMembershipVersions: {},
      resolutionRulesetVersion: 'test',
      meaningfulContentHash: randomUUID(),
      createdAt: NOW,
    });
    // Real re-resolution updates both: the revision is the pinned record,
    // and `opportunities.canonicalTitle`/`currentCanonicalRevisionId` are the
    // live denormalized view every OTHER screen reads. A test that only moved
    // the pointer, without also moving the live title, couldn't tell a fix
    // that reads the pinned revision apart from the bug that read the live
    // column — both would still see the original title.
    await db
      .update(opportunities)
      .set({ currentCanonicalRevisionId: revisionId, canonicalTitle })
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

  it('refuses to generate when the confirmation screen no longer matches what is current', async () => {
    // Save/Approve's exact-content guarantee has a sibling gap at generation
    // time: without this check, a profile edit or a re-crawl landing between
    // the confirmation screen rendering and the button being pressed would
    // send different claims or listing text to Claude than the person agreed
    // to send. `expected` is what closes it — checked before the model is
    // ever called, never after.
    const fixture = await setup();
    const { client, create } = fakeGenerationClient('Subject', 'Body', fixture.claimIds);
    const current = {
      profileVersion: fixture.profileVersion,
      opportunityRevisionId: fixture.opportunityRevisionId,
      listingRevisionId: fixture.sourceListingRevisionId,
    };

    await expect(
      generateDraft(
        db,
        {
          profileId: fixture.profileId,
          opportunityId: fixture.opportunityId,
          now: NOW,
          expected: { ...current, profileVersion: current.profileVersion + 1 },
        },
        client,
      ),
    ).rejects.toMatchObject({ code: 'CONFIRMATION_STALE' });

    await expect(
      generateDraft(
        db,
        {
          profileId: fixture.profileId,
          opportunityId: fixture.opportunityId,
          now: NOW,
          expected: { ...current, opportunityRevisionId: randomUUID() },
        },
        client,
      ),
    ).rejects.toMatchObject({ code: 'CONFIRMATION_STALE' });

    await expect(
      generateDraft(
        db,
        {
          profileId: fixture.profileId,
          opportunityId: fixture.opportunityId,
          now: NOW,
          expected: { ...current, listingRevisionId: randomUUID() },
        },
        client,
      ),
    ).rejects.toMatchObject({ code: 'CONFIRMATION_STALE' });

    // All three refusals happen before the model is ever reached.
    expect(create).not.toHaveBeenCalled();

    // Matching versions succeed, and do call the model.
    const draft = await generateDraft(
      db,
      {
        profileId: fixture.profileId,
        opportunityId: fixture.opportunityId,
        now: NOW,
        expected: current,
      },
      client,
    );
    draftIds.push(draft.id);
    expect(draft.subject).toBe('Subject');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('approves exactly the content shown, and nothing else', async () => {
    const draft = await draftFor(await setup());
    const loaded = await loadDraft(db, draft.id);
    expect(loaded?.approval).toEqual({ status: 'none' });

    await expect(
      approveDraft(db, {
        draftId: draft.id,
        expectedContentHash: 'f'.repeat(64),
        visibleSubject: draft.subject,
        visibleBody: draft.body,
        now: LATER,
      }),
    ).rejects.toMatchObject({ code: 'CONTENT_CHANGED' });

    await approveDraft(db, {
      draftId: draft.id,
      expectedContentHash: loaded?.contentHash ?? '',
      visibleSubject: draft.subject,
      visibleBody: draft.body,
      now: LATER,
    });
    const approval = (await loadDraft(db, draft.id))?.approval;
    expect(approval?.status).toBe('current');
    // Postgres returns its own timestamp text, not the ISO string written.
    expect(approval?.status === 'current' && Date.parse(approval.approvedAt)).toBe(
      Date.parse(LATER),
    );
  });

  it('refuses to approve submitted text that does not match what is actually stored, independent of the content hash', async () => {
    // This is the check that makes the exact-content guarantee real without
    // depending on JavaScript: the web layer submits Approve as a
    // `formAction` on the SAME form Save uses (see [id]/page.tsx), so the
    // visible subject/body always rides along with the approval, whatever
    // the browser is or isn't running. A correct `expectedContentHash` alone
    // says nothing about an unsaved LOCAL edit sitting in a textarea that
    // was never posted to the server before this — only comparing the
    // submitted text against the stored row can catch that.
    const draft = await draftFor(await setup());
    const hash = (await loadDraft(db, draft.id))?.contentHash ?? '';

    await expect(
      approveDraft(db, {
        draftId: draft.id,
        expectedContentHash: hash,
        visibleSubject: draft.subject,
        visibleBody: `${draft.body} — an edit that was never saved.`,
        now: LATER,
      }),
    ).rejects.toMatchObject({ code: 'UNSAVED_EDITS' });

    await expect(
      approveDraft(db, {
        draftId: draft.id,
        expectedContentHash: hash,
        visibleSubject: 'A subject that was never saved',
        visibleBody: draft.body,
        now: LATER,
      }),
    ).rejects.toMatchObject({ code: 'UNSAVED_EDITS' });

    expect((await loadDraft(db, draft.id))?.approval).toEqual({ status: 'none' });
  });

  it('invalidates the approval on any edit, and keeps it when saving identical text', async () => {
    const draft = await draftFor(await setup());
    const hash = (await loadDraft(db, draft.id))?.contentHash ?? '';
    await approveDraft(db, {
      draftId: draft.id,
      expectedContentHash: hash,
      visibleSubject: draft.subject,
      visibleBody: draft.body,
      now: LATER,
    });

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
    await approveDraft(db, {
      draftId: draft.id,
      expectedContentHash: hash,
      visibleSubject: draft.subject,
      visibleBody: draft.body,
      now: LATER,
    });
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
      visibleSubject: a.subject,
      visibleBody: a.body,
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
      visibleSubject: b.subject,
      visibleBody: b.body,
      now: LATER,
    });
    await addOpportunityRevision(opportunityCase.opportunityId);
    expect((await loadDraft(db, b.id))?.approval).toMatchObject({ status: 'stale' });
    // And a stale draft cannot be re-approved until it is regenerated.
    await expect(
      approveDraft(db, {
        draftId: b.id,
        expectedContentHash: (await loadDraft(db, b.id))?.contentHash ?? '',
        visibleSubject: b.subject,
        visibleBody: b.body,
        now: LATER,
      }),
    ).rejects.toMatchObject({ code: 'OPPORTUNITY_NOT_CURRENT' });

    const profileCase = await setup();
    const c = await draftFor(profileCase);
    await approveDraft(db, {
      draftId: c.id,
      expectedContentHash: (await loadDraft(db, c.id))?.contentHash ?? '',
      visibleSubject: c.subject,
      visibleBody: c.body,
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
      visibleSubject: draft.subject,
      visibleBody: draft.body,
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
    await approveDraft(db, {
      draftId: draft.id,
      expectedContentHash: hash,
      visibleSubject: draft.subject,
      visibleBody: draft.body,
      now: LATER,
    });
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
      visibleSubject: draft.subject,
      visibleBody: draft.body,
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

  it('lists both an unapproved and a currently-approved draft with the right status each', async () => {
    // `listDrafts` only re-fetches a draft's full row (needed to recompute its
    // hash) for the ones that carry a live approval — so this exercises both
    // branches of that split, not just the happy path where every draft has one.
    const unapproved = await draftFor(await setup());
    const approvedFixture = await setup();
    const approved = await draftFor(approvedFixture);
    const loaded = await loadDraft(db, approved.id);
    await approveDraft(db, {
      draftId: approved.id,
      expectedContentHash: loaded?.contentHash ?? '',
      visibleSubject: approved.subject,
      visibleBody: approved.body,
      now: LATER,
    });

    const rows = await listDrafts(db);
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(unapproved.id)?.approval).toEqual({ status: 'none' });
    expect(byId.get(approved.id)?.approval.status).toBe('current');
    // The list omits body/subject entirely — never assert on them existing.
    expect(byId.get(approved.id)).not.toHaveProperty('body');
    expect(byId.get(approved.id)).not.toHaveProperty('subject');
  });

  it('shows the title pinned to the draft, not the opportunity’s title after a later re-resolution', async () => {
    // A cross-posted vacancy can be re-resolved (a new crawl, a merge) after
    // a draft was written against it. `opportunities.canonicalTitle` moves
    // when that happens; `opportunityRevisions.canonicalTitle` for the
    // revision the draft actually cites does not. Both `loadDraftContext`
    // (the [id] screen) and `listDrafts` (the list) must read the latter.
    const fixture = await setup();
    const draft = await draftFor(fixture);
    await addOpportunityRevision(fixture.opportunityId, 'A retitled opportunity');

    const context = await loadDraftContext(db, draft);
    expect(context?.opportunityTitle).toBe('Draft store test opportunity');

    const rows = await listDrafts(db);
    expect(rows.find((row) => row.id === draft.id)?.opportunityTitle).toBe(
      'Draft store test opportunity',
    );
  });
});
