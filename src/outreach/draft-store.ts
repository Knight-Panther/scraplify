import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import {
  auditEvents,
  candidateProfileClaims,
  candidateProfiles,
  type OutreachDraftRow,
  opportunities,
  opportunitySourceMemberships,
  outreachApprovals,
  outreachDrafts,
  sourceListingRevisions,
  sourceListings,
} from '../db/schema/index.js';
import type { Database, DatabaseOrTransaction, DatabaseTransaction } from '../db/types.js';

/**
 * Outreach drafts and their exact-content approvals (concept §18; Phase 6A).
 *
 * The one property everything here protects: **an approval only ever counts
 * for the exact content a person approved.** It binds the recipient, subject,
 * body, attachments (none yet), and the profile, opportunity and listing
 * versions the text was written from. Editing a draft invalidates its approval
 * in the same transaction; and because a future write path could forget to,
 * `approvalState` never trusts the stored row alone — it recomputes the hash and
 * re-checks every bound version before calling an approval current.
 *
 * Nothing here sends anything. Nothing here logs draft or profile text, and the
 * audit trail stores ids and hashes only.
 */

export const DRAFT_LANGUAGES = ['ka', 'en'] as const;
export type DraftLanguage = (typeof DRAFT_LANGUAGES)[number];

export class OutreachError extends Error {
  constructor(
    readonly code:
      | 'NOT_FOUND'
      | 'DELETED'
      | 'PROFILE_NOT_CURRENT'
      | 'OPPORTUNITY_NOT_CURRENT'
      | 'LISTING_NOT_IN_OPPORTUNITY'
      | 'LISTING_NOT_CURRENT'
      | 'UNKNOWN_CLAIM'
      | 'CONTENT_CHANGED'
      | 'EMPTY_BODY',
    message: string,
  ) {
    super(message);
    this.name = 'OutreachError';
  }
}

/** The fields an approval binds, in a fixed order. */
export interface BoundContent {
  kind: 'email' | 'cover_letter';
  recipient: string | null;
  subject: string | null;
  body: string;
  profileId: string;
  profileVersion: number;
  opportunityRevisionId: string;
  sourceListingRevisionId: string;
}

const HASH_SCHEME = 'outreach-approval-v1';

/**
 * sha-256 over every bound field. JSON of a fixed-order array, so there is no
 * delimiter a body could contain to make two different contents collide.
 */
export function contentHash(content: BoundContent): string {
  const canonical = JSON.stringify([
    HASH_SCHEME,
    content.kind,
    content.recipient,
    content.subject,
    content.body,
    [], // attachments: none can exist in 6A, bound anyway so adding them changes the hash
    content.profileId,
    content.profileVersion,
    content.opportunityRevisionId,
    content.sourceListingRevisionId,
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function boundContent(draft: OutreachDraftRow): BoundContent {
  return {
    kind: draft.kind,
    recipient: draft.recipient,
    subject: draft.subject,
    body: draft.body,
    profileId: draft.profileId,
    profileVersion: draft.profileVersion,
    opportunityRevisionId: draft.opportunityRevisionId,
    sourceListingRevisionId: draft.sourceListingRevisionId,
  };
}

/**
 * The email address a listing states for applications, or null.
 *
 * The only way a recipient ever enters a draft: read from the listing's own
 * application method, never typed, guessed or extracted from description text.
 */
export function recipientFromApplicationMethod(method: unknown): string | null {
  if (typeof method !== 'object' || method === null) return null;
  const { type, value } = method as { type?: unknown; value?: unknown };
  if (type !== 'email' || typeof value !== 'string') return null;
  const address = value.trim();
  // Deliberately loose: the address is the source's own, shown to the person
  // before any use; this only rejects values that are plainly not an address.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) ? address : null;
}

async function audit(
  tx: DatabaseOrTransaction,
  entry: {
    entityId: string;
    action: (typeof auditEvents.$inferInsert)['action'];
    at: string;
    details: Record<string, string | number | null>;
  },
): Promise<void> {
  await tx.insert(auditEvents).values({
    id: randomUUID(),
    entityType: 'outreach_draft',
    entityId: entry.entityId,
    action: entry.action,
    occurredAt: entry.at,
    details: entry.details,
  });
}

export interface CreateDraftInput {
  profileId: string;
  profileVersion: number;
  opportunityId: string;
  opportunityRevisionId: string;
  sourceListingId: string;
  sourceListingRevisionId: string;
  subject: string | null;
  body: string;
  language: DraftLanguage;
  generator: string;
  claimIds: readonly string[];
  now: string;
}

/**
 * Stores a newly generated draft, after re-checking that every input it was
 * written from is still current — a draft pinned to a superseded profile or
 * listing would be approvable text about facts that no longer hold.
 */
export async function createDraft(
  db: Database,
  input: CreateDraftInput,
): Promise<OutreachDraftRow> {
  if (input.body.trim().length === 0) {
    throw new OutreachError('EMPTY_BODY', 'A draft needs a body.');
  }
  return db.transaction(async (tx) => {
    const [profile] = await tx
      .select({ version: candidateProfiles.version, deletedAt: candidateProfiles.deletedAt })
      .from(candidateProfiles)
      .where(eq(candidateProfiles.id, input.profileId));
    if (!profile || profile.deletedAt !== null || profile.version !== input.profileVersion) {
      throw new OutreachError('PROFILE_NOT_CURRENT', 'The profile has changed since generation.');
    }

    const [opportunity] = await tx
      .select({ revisionId: opportunities.currentCanonicalRevisionId })
      .from(opportunities)
      .where(eq(opportunities.id, input.opportunityId));
    if (!opportunity || opportunity.revisionId !== input.opportunityRevisionId) {
      throw new OutreachError('OPPORTUNITY_NOT_CURRENT', 'The opportunity has changed.');
    }

    const [membership] = await tx
      .select({ id: opportunitySourceMemberships.id })
      .from(opportunitySourceMemberships)
      .where(
        and(
          eq(opportunitySourceMemberships.opportunityId, input.opportunityId),
          eq(opportunitySourceMemberships.sourceListingId, input.sourceListingId),
          isNull(opportunitySourceMemberships.supersededAt),
        ),
      );
    if (!membership) {
      throw new OutreachError(
        'LISTING_NOT_IN_OPPORTUNITY',
        'That listing is not part of this opportunity.',
      );
    }

    const [listing] = await tx
      .select({
        currentRevisionId: sourceListings.currentRevisionId,
        applicationMethod: sourceListingRevisions.applicationMethod,
      })
      .from(sourceListings)
      .innerJoin(
        sourceListingRevisions,
        eq(sourceListingRevisions.id, sourceListings.currentRevisionId),
      )
      .where(eq(sourceListings.id, input.sourceListingId));
    if (!listing || listing.currentRevisionId !== input.sourceListingRevisionId) {
      throw new OutreachError('LISTING_NOT_CURRENT', 'The listing has changed since generation.');
    }

    const uniqueClaimIds = [...new Set(input.claimIds)];
    if (uniqueClaimIds.length > 0) {
      const owned = await tx
        .select({ id: candidateProfileClaims.id })
        .from(candidateProfileClaims)
        .where(
          and(
            inArray(candidateProfileClaims.id, uniqueClaimIds),
            eq(candidateProfileClaims.profileId, input.profileId),
            eq(candidateProfileClaims.profileVersion, input.profileVersion),
          ),
        );
      if (owned.length !== uniqueClaimIds.length) {
        throw new OutreachError(
          'UNKNOWN_CLAIM',
          'The draft cites a claim that is not part of this profile version.',
        );
      }
    }

    const recipient = recipientFromApplicationMethod(listing.applicationMethod);
    const kind = recipient === null ? 'cover_letter' : 'email';
    const [draft] = await tx
      .insert(outreachDrafts)
      .values({
        id: randomUUID(),
        profileId: input.profileId,
        profileVersion: input.profileVersion,
        opportunityId: input.opportunityId,
        opportunityRevisionId: input.opportunityRevisionId,
        sourceListingId: input.sourceListingId,
        sourceListingRevisionId: input.sourceListingRevisionId,
        kind,
        recipient,
        // A cover letter has no subject line; one supplied anyway is dropped
        // rather than stored where nothing would ever show it.
        subject: kind === 'email' ? (input.subject?.trim() ?? null) : null,
        body: input.body,
        language: input.language,
        generator: input.generator,
        claimIds: uniqueClaimIds,
        createdAt: input.now,
        updatedAt: input.now,
        deletedAt: null,
      })
      .returning();
    if (!draft) throw new Error('createDraft: insert returned no row');

    await audit(tx, {
      entityId: draft.id,
      action: 'draft_generated',
      at: input.now,
      details: {
        contentHash: contentHash(boundContent(draft)),
        generator: input.generator,
        kind,
        claimCount: uniqueClaimIds.length,
      },
    });
    return draft;
  });
}

async function lockDraft(tx: DatabaseTransaction, draftId: string): Promise<OutreachDraftRow> {
  const [draft] = await tx
    .select()
    .from(outreachDrafts)
    .where(eq(outreachDrafts.id, draftId))
    .for('update');
  if (!draft) throw new OutreachError('NOT_FOUND', 'No such draft.');
  if (draft.deletedAt !== null) throw new OutreachError('DELETED', 'This draft was deleted.');
  return draft;
}

async function invalidateLiveApproval(
  tx: DatabaseTransaction,
  draftId: string,
  reason: 'edited' | 'deleted',
  at: string,
): Promise<void> {
  const invalidated = await tx
    .update(outreachApprovals)
    .set({ invalidatedAt: at, invalidationReason: reason })
    .where(and(eq(outreachApprovals.draftId, draftId), isNull(outreachApprovals.invalidatedAt)))
    .returning({ id: outreachApprovals.id, contentHash: outreachApprovals.contentHash });
  for (const approval of invalidated) {
    await audit(tx, {
      entityId: draftId,
      action: 'approval_invalidated',
      at,
      details: { approvalId: approval.id, approvedHash: approval.contentHash, reason },
    });
  }
}

export interface EditDraftInput {
  draftId: string;
  subject: string | null;
  body: string;
  now: string;
}

/**
 * Saves a person's edit. Recipient and every bound version are fixed at
 * creation and cannot be changed here. Any real change invalidates a live
 * approval in the same transaction; saving identical content is a no-op, so
 * pressing Save twice does not throw an approval away.
 */
export async function editDraft(db: Database, input: EditDraftInput): Promise<OutreachDraftRow> {
  if (input.body.trim().length === 0) {
    throw new OutreachError('EMPTY_BODY', 'A draft needs a body.');
  }
  return db.transaction(async (tx) => {
    const draft = await lockDraft(tx, input.draftId);
    const subject = draft.kind === 'email' ? (input.subject?.trim() ?? null) : null;
    const before = contentHash(boundContent(draft));
    const after = contentHash({ ...boundContent(draft), subject, body: input.body });
    if (before === after) return draft;

    const [updated] = await tx
      .update(outreachDrafts)
      .set({ subject, body: input.body, updatedAt: input.now })
      .where(eq(outreachDrafts.id, draft.id))
      .returning();
    if (!updated) throw new Error('editDraft: update returned no row');

    await invalidateLiveApproval(tx, draft.id, 'edited', input.now);
    await audit(tx, {
      entityId: draft.id,
      action: 'draft_edited',
      at: input.now,
      details: { previousHash: before, contentHash: after },
    });
    return updated;
  });
}

export interface ApproveDraftInput {
  draftId: string;
  /**
   * The hash of the content the person was looking at when they approved —
   * rendered into the approve form. If the draft changed since that page was
   * loaded, approving would bless text they never saw, so it is refused.
   */
  expectedContentHash: string;
  now: string;
}

export async function approveDraft(db: Database, input: ApproveDraftInput) {
  return db.transaction(async (tx) => {
    const draft = await lockDraft(tx, input.draftId);
    const hash = contentHash(boundContent(draft));
    if (hash !== input.expectedContentHash) {
      throw new OutreachError(
        'CONTENT_CHANGED',
        'This draft changed after the page was loaded. Review the current text before approving.',
      );
    }
    const staleness = await boundInputsStaleness(tx, draft);
    if (staleness !== null) throw staleness;

    const [live] = await tx
      .select()
      .from(outreachApprovals)
      .where(and(eq(outreachApprovals.draftId, draft.id), isNull(outreachApprovals.invalidatedAt)));
    if (live && live.contentHash === hash) return live;
    // A live approval of different content cannot exist if every edit went
    // through editDraft; retire it explicitly rather than trip the unique index.
    if (live) await invalidateLiveApproval(tx, draft.id, 'edited', input.now);

    const [approval] = await tx
      .insert(outreachApprovals)
      .values({
        id: randomUUID(),
        draftId: draft.id,
        contentHash: hash,
        approvedAt: input.now,
        invalidatedAt: null,
        invalidationReason: null,
      })
      .returning();
    if (!approval) throw new Error('approveDraft: insert returned no row');
    await audit(tx, {
      entityId: draft.id,
      action: 'draft_approved',
      at: input.now,
      details: { approvalId: approval.id, contentHash: hash },
    });
    return approval;
  });
}

/** Soft-deletes a draft and invalidates its approval. The text stays until the profile is purged. */
export async function deleteDraft(db: Database, draftId: string, now: string): Promise<void> {
  await db.transaction(async (tx) => {
    const draft = await lockDraft(tx, draftId);
    await tx
      .update(outreachDrafts)
      .set({ deletedAt: now, updatedAt: now })
      .where(eq(outreachDrafts.id, draft.id));
    await invalidateLiveApproval(tx, draft.id, 'deleted', now);
    await audit(tx, {
      entityId: draft.id,
      action: 'draft_deleted',
      at: now,
      details: { contentHash: contentHash(boundContent(draft)) },
    });
  });
}

/** Why an input the draft was written from no longer holds, or null if all still do. */
async function boundInputsStaleness(
  db: DatabaseOrTransaction,
  draft: OutreachDraftRow,
): Promise<OutreachError | null> {
  const [profile] = await db
    .select({ version: candidateProfiles.version, deletedAt: candidateProfiles.deletedAt })
    .from(candidateProfiles)
    .where(eq(candidateProfiles.id, draft.profileId));
  if (!profile || profile.deletedAt !== null || profile.version !== draft.profileVersion) {
    return new OutreachError(
      'PROFILE_NOT_CURRENT',
      'The profile has been revised since this draft.',
    );
  }
  const [opportunity] = await db
    .select({ revisionId: opportunities.currentCanonicalRevisionId })
    .from(opportunities)
    .where(eq(opportunities.id, draft.opportunityId));
  if (!opportunity || opportunity.revisionId !== draft.opportunityRevisionId) {
    return new OutreachError(
      'OPPORTUNITY_NOT_CURRENT',
      'The opportunity has changed since this draft.',
    );
  }
  const [listing] = await db
    .select({ currentRevisionId: sourceListings.currentRevisionId })
    .from(sourceListings)
    .where(eq(sourceListings.id, draft.sourceListingId));
  if (!listing || listing.currentRevisionId !== draft.sourceListingRevisionId) {
    return new OutreachError('LISTING_NOT_CURRENT', 'The listing has changed since this draft.');
  }
  return null;
}

export type ApprovalState =
  | { status: 'none' }
  | { status: 'current'; approvedAt: string; contentHash: string }
  | {
      status: 'stale';
      approvedAt: string;
      reason: 'content_changed' | 'inputs_changed';
      detail: string;
    };

/**
 * Whether the draft is approved RIGHT NOW. Never trusts the stored approval
 * alone: the hash is recomputed from the draft as it is, and every version the
 * approval bound is re-checked against what is current.
 */
export async function approvalState(
  db: DatabaseOrTransaction,
  draft: OutreachDraftRow,
): Promise<ApprovalState> {
  if (draft.deletedAt !== null) return { status: 'none' };
  const [live] = await db
    .select()
    .from(outreachApprovals)
    .where(and(eq(outreachApprovals.draftId, draft.id), isNull(outreachApprovals.invalidatedAt)));
  if (!live) return { status: 'none' };
  if (live.contentHash !== contentHash(boundContent(draft))) {
    return {
      status: 'stale',
      approvedAt: live.approvedAt,
      reason: 'content_changed',
      detail: 'The text changed after it was approved.',
    };
  }
  const staleness = await boundInputsStaleness(db, draft);
  if (staleness !== null) {
    return {
      status: 'stale',
      approvedAt: live.approvedAt,
      reason: 'inputs_changed',
      detail: staleness.message,
    };
  }
  return { status: 'current', approvedAt: live.approvedAt, contentHash: live.contentHash };
}

export async function loadDraft(
  db: DatabaseOrTransaction,
  draftId: string,
): Promise<{ draft: OutreachDraftRow; approval: ApprovalState; contentHash: string } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(draftId)) return null;
  const [draft] = await db.select().from(outreachDrafts).where(eq(outreachDrafts.id, draftId));
  if (!draft || draft.deletedAt !== null) return null;
  return {
    draft,
    approval: await approvalState(db, draft),
    contentHash: contentHash(boundContent(draft)),
  };
}

/** Drafts that have not been deleted, newest first, without their text. */
export async function listDrafts(db: DatabaseOrTransaction) {
  const rows = await db
    .select()
    .from(outreachDrafts)
    .where(isNull(outreachDrafts.deletedAt))
    .orderBy(desc(outreachDrafts.updatedAt));
  return Promise.all(
    rows.map(async (draft) => ({
      id: draft.id,
      profileId: draft.profileId,
      opportunityId: draft.opportunityId,
      kind: draft.kind,
      recipient: draft.recipient,
      language: draft.language,
      updatedAt: draft.updatedAt,
      approval: await approvalState(db, draft),
    })),
  );
}
