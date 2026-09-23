import { db } from '../../../../src/db/client.js';
import type { OutreachDraftRow } from '../../../../src/db/schema/index.js';
import {
  type ApprovalState,
  loadDraft,
  loadDraftClaims,
  loadDraftContext,
} from '../../../../src/outreach/draft-store.js';
import {
  ApproveSubmitButton,
  LiveApprovedActions,
} from '../../../components/draft-approval-guard.js';
import { SubmitButton } from '../../../components/submit-button.js';
import { UnsavedChangesGuard } from '../../../components/unsaved-changes-guard.js';
import { absoluteTime, relativeTime } from '../../../lib/format.js';
import { mailtoHref } from '../../../lib/draft-input.js';
import { claimKindLabel } from '../../../lib/labels.js';
import { UUID } from '../../../lib/profile-input.js';
import type { RawSearchParams } from '../../../lib/search-params.js';
import { one } from '../../../lib/search-params.js';
import { writesEnabled } from '../../../lib/writes.js';
import { approveDraftAction, deleteDraftAction, saveDraftAction } from '../actions.js';

/**
 * One draft: review, edit, approve (concept §18, Phase 6A).
 *
 * The screen's one job is to make the approval boundary impossible to misread.
 * The approval state sits above the text and says whether it covers the text
 * shown right now. The only "ready to use" affordances — copy, and for an email
 * opening it in the person's own mail client — render ONLY while the approval
 * is current, so there is no path from an unapproved or edited draft to using
 * it. Nothing here sends anything.
 */

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Draft · Xtelo' };

const buttonClass =
  'rounded-[var(--radius)] border border-border-strong bg-surface-raised px-4 py-1.5 text-sm hover:bg-surface-active disabled:cursor-not-allowed disabled:opacity-60';

export default async function DraftPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<RawSearchParams>;
}) {
  const { id } = await params;
  const raw = await searchParams;
  const error = one(raw.error);
  const saved = one(raw.saved) === '1';
  const approved = one(raw.approved) === '1';

  if (!UUID.test(id)) return <NotFound />;
  const loaded = await loadDraft(db, id);
  if (loaded === null) return <NotFound />;
  const { draft, approval, contentHash } = loaded;
  const [context, claims] = await Promise.all([
    loadDraftContext(db, draft),
    loadDraftClaims(db, draft),
  ]);
  const canWrite = writesEnabled();

  return (
    <main className="w-full px-4 py-8 sm:px-6 sm:py-10">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold">
            {draft.kind === 'email' ? 'Application email' : 'Cover letter'}
          </h1>
          <p className="mt-2 max-w-[var(--measure)] text-sm text-muted">
            For{' '}
            <a
              href={`/opportunities/${draft.opportunityId}`}
              className="text-foreground underline decoration-border-strong underline-offset-2 hover:decoration-accent"
            >
              {context?.opportunityTitle ?? 'this opportunity'}
            </a>
            , written from{' '}
            <a
              href={`/profile/${draft.profileId}`}
              className="text-accent underline underline-offset-2 hover:text-foreground"
            >
              {context?.profileLabel ?? 'your profile'}
            </a>{' '}
            (version <span className="numeric">{draft.profileVersion}</span>). Last changed{' '}
            <time dateTime={draft.updatedAt} title={absoluteTime(draft.updatedAt)}>
              {relativeTime(draft.updatedAt)}
            </time>
            .
          </p>
        </div>
        {canWrite && <DeleteDraft draftId={draft.id} />}
      </header>

      {error !== '' && (
        <div
          role="alert"
          className="mt-4 max-w-[var(--measure)] rounded-[var(--radius)] border border-status-held bg-surface px-4 py-3 text-sm"
        >
          {error}
        </div>
      )}
      {(saved || approved) && error === '' && (
        <p className="mt-4 text-sm text-status-open" aria-live="polite">
          {approved ? 'Approved.' : 'Saved.'}
        </p>
      )}

      {canWrite ? (
        // Save and Approve share this one form deliberately (concept §18):
        // the Approve button is a `formAction` override below, inside
        // ApprovalPanel, so pressing it submits the SAME subject/body fields
        // Save does — whatever they currently hold, edited or not — and
        // `approveDraft` refuses if they don't match what's actually stored.
        // That is what makes the exact-content guarantee real without
        // depending on the client-side dirty guard's JavaScript ever
        // running. `className="contents"` keeps the form from adding a box
        // of its own between the two sections it wraps.
        <form id="draft-edit-form" action={saveDraftAction} className="contents">
          <UnsavedChangesGuard formId="draft-edit-form" />
          <input type="hidden" name="draftId" value={draft.id} />

          <ApprovalPanel
            draft={draft}
            approval={approval}
            contentHash={contentHash}
            canWrite={canWrite}
          />

          <section className="mt-6 max-w-[var(--measure)]">
            <Recipient draft={draft} />
            <div className="mt-3 flex flex-col gap-3">
              {draft.kind === 'email' && (
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-muted">Subject</span>
                  <input
                    type="text"
                    name="subject"
                    defaultValue={draft.subject ?? ''}
                    autoComplete="off"
                    lang={draft.language}
                    maxLength={300}
                    className="rounded-[var(--radius)] border border-border bg-surface px-3 py-1.5 text-sm text-foreground"
                  />
                </label>
              )}
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-muted">{draft.kind === 'email' ? 'Message' : 'Letter'}</span>
                <textarea
                  name="body"
                  defaultValue={draft.body}
                  lang={draft.language}
                  rows={18}
                  maxLength={20_000}
                  className="w-full rounded-[var(--radius)] border border-border bg-surface px-3 py-2 text-sm leading-relaxed text-foreground"
                />
              </label>
              <div className="flex flex-wrap items-center gap-3">
                <SubmitButton
                  pendingLabel="Saving…"
                  className={buttonClass}
                  formAction={saveDraftAction}
                >
                  Save changes
                </SubmitButton>
                {approval.status !== 'none' && (
                  <span className="text-xs text-faint">
                    Saving any change withdraws the approval; approve again afterwards.
                  </span>
                )}
              </div>
            </div>
          </section>
        </form>
      ) : (
        <>
          <ApprovalPanel
            draft={draft}
            approval={approval}
            contentHash={contentHash}
            canWrite={canWrite}
          />
          <section className="mt-6 max-w-[var(--measure)]">
            <Recipient draft={draft} />
            <div className="mt-3 rounded-[var(--radius)] border border-border bg-surface px-4 py-3 text-sm">
              {draft.subject !== null && (
                <p className="font-medium" lang={draft.language}>
                  {draft.subject}
                </p>
              )}
              <p className="mt-2 whitespace-pre-wrap leading-relaxed" lang={draft.language}>
                {draft.body}
              </p>
            </div>
          </section>
        </>
      )}

      <ClaimsUsed claims={claims} />

      <p className="mt-6 text-sm">
        <a
          href="/drafts"
          className="text-accent underline underline-offset-2 hover:text-foreground"
        >
          All drafts
        </a>
      </p>
    </main>
  );
}

function ApprovalPanel({
  draft,
  approval,
  contentHash,
  canWrite,
}: {
  draft: OutreachDraftRow;
  approval: ApprovalState;
  contentHash: string;
  canWrite: boolean;
}) {
  return (
    <section
      aria-label="Approval"
      className="mt-6 max-w-[var(--measure)] rounded-[var(--radius)] border border-border bg-surface px-4 py-3 text-sm"
    >
      {approval.status === 'current' && (
        <>
          <p>
            <span className="font-medium text-status-open">Approved</span>{' '}
            <time dateTime={approval.approvedAt} title={absoluteTime(approval.approvedAt)}>
              {relativeTime(approval.approvedAt)}
            </time>{' '}
            <span className="text-muted">
              — this approval covers exactly the text below
              {draft.kind === 'email' ? ', subject and recipient' : ''}.
            </span>
          </p>
          <LiveApprovedActions
            editFormId="draft-edit-form"
            text={draft.subject ? `${draft.subject}\n\n${draft.body}` : draft.body}
            mailtoHref={
              draft.kind === 'email' && draft.recipient !== null
                ? mailtoHref(draft.recipient, draft.subject, draft.body)
                : null
            }
          />
          <p className="mt-2 text-xs text-faint">
            Xtelo never sends anything. Opening it in your mail app still leaves sending to you.
          </p>
        </>
      )}

      {approval.status === 'stale' && (
        <p>
          <span className="font-medium text-status-unconfirmed">Approval no longer valid.</span>{' '}
          <span className="text-muted">{approval.detail}</span>{' '}
          {approval.reason === 'inputs_changed' && (
            <span className="text-muted">
              Write a new draft to approve against the current version.
            </span>
          )}
        </p>
      )}

      {approval.status === 'none' && (
        <p>
          <span className="font-medium">Not approved.</span>{' '}
          <span className="text-muted">
            Review the text, save any changes, then approve it. Only approved text can be copied or
            opened in a mail app.
          </span>
        </p>
      )}

      {canWrite &&
        approval.status !== 'current' &&
        !(approval.status === 'stale' && approval.reason === 'inputs_changed') && (
          // No wrapping <form>: this button submits the shared
          // draft-edit-form via `formAction`, which is what carries the
          // current subject/body along with it — see ApproveSubmitButton.
          <div className="mt-3">
            <input type="hidden" name="contentHash" value={contentHash} />
            <ApproveSubmitButton
              editFormId="draft-edit-form"
              formAction={approveDraftAction}
              className={buttonClass}
            >
              Approve this exact text
            </ApproveSubmitButton>
          </div>
        )}
    </section>
  );
}

function Recipient({ draft }: { draft: OutreachDraftRow }) {
  if (draft.kind !== 'email') return null;
  return (
    <p className="text-sm">
      <span className="text-faint">To </span>
      <span translate="no">{draft.recipient}</span>
      <span className="text-xs text-faint"> — from the listing; not editable</span>
    </p>
  );
}

function ClaimsUsed({
  claims,
}: {
  claims: Array<{ id: string; kind: string; value: string; evidence: string | null }>;
}) {
  return (
    <section className="mt-8 max-w-[var(--measure)]">
      <h2 className="text-sm font-medium">What this draft relies on</h2>
      {claims.length === 0 ? (
        <p className="mt-2 text-sm text-faint">The draft cites no profile claims.</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {claims.map((claim) => (
            <li
              key={claim.id}
              className="rounded-[var(--radius)] border border-border bg-surface px-3 py-2 text-sm"
            >
              <span className="text-faint">{claimKindLabel(claim.kind).short}:</span> {claim.value}
              {claim.evidence !== null && (
                <p
                  className="mt-1 text-xs text-faint"
                  title="The exact CV text this claim was drawn from"
                >
                  “{claim.evidence}”
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function DeleteDraft({ draftId }: { draftId: string }) {
  const popoverId = `delete-draft-${draftId}`;
  return (
    <div className="shrink-0">
      <button
        type="button"
        popoverTarget={popoverId}
        className="rounded-[var(--radius)] px-3 py-1 text-sm text-status-held underline underline-offset-2 hover:text-foreground"
      >
        Delete
      </button>
      <div
        id={popoverId}
        popover="auto"
        className="m-auto max-w-sm rounded-[var(--radius)] border border-border bg-surface p-4 text-sm text-foreground"
      >
        <p>Delete this draft? Its approval is withdrawn and it disappears from your drafts.</p>
        <div className="mt-3 flex items-center gap-3">
          <form action={deleteDraftAction}>
            <input type="hidden" name="draftId" value={draftId} />
            <button
              type="submit"
              className="rounded-[var(--radius)] border border-status-held px-3 py-1 text-sm text-status-held hover:bg-status-held hover:text-white"
            >
              Yes, delete draft
            </button>
          </form>
          <button
            type="button"
            popoverTarget={popoverId}
            popoverTargetAction="hide"
            className="text-sm text-muted underline underline-offset-2 hover:text-foreground"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function NotFound() {
  return (
    <main className="w-full px-4 py-8 sm:px-6 sm:py-10">
      <h1 className="text-xl font-semibold">Draft not found</h1>
      <p className="mt-2 max-w-[var(--measure)] text-sm text-muted">
        This draft does not exist, or has been deleted.
      </p>
    </main>
  );
}
