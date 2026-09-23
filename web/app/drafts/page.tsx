import { db } from '../../../src/db/client.js';
import { listDrafts } from '../../../src/outreach/draft-store.js';
import { absoluteTime, count, relativeTime } from '../../lib/format.js';
import type { RawSearchParams } from '../../lib/search-params.js';
import { one } from '../../lib/search-params.js';

/**
 * Every outreach draft, newest change first, with whether it is approved right
 * now. The approval column is recomputed on every load (`listDrafts` →
 * `approvalState`), never read from a stored flag, so an edited draft or a
 * changed listing shows as no longer approved here too.
 */

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Drafts · Xtelo' };

export default async function DraftsPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const raw = await searchParams;
  const error = one(raw.error);
  const deleted = one(raw.deleted) === '1';
  const drafts = await listDrafts(db);

  return (
    <main className="w-full px-4 py-8 sm:px-6 sm:py-10">
      <header>
        <h1 className="text-xl font-semibold">
          Drafts
          {drafts.length > 0 && (
            <span className="numeric text-faint"> ({count(drafts.length)})</span>
          )}
        </h1>
        <p className="mt-2 max-w-[var(--measure)] text-sm text-muted">
          Application emails and cover letters written from your profile. Start one from a row on{' '}
          <a
            href="/ranked"
            className="text-accent underline underline-offset-2 hover:text-foreground"
          >
            Ranked
          </a>
          . Nothing here is ever sent.
        </p>
      </header>

      {error !== '' && (
        <div
          role="alert"
          className="mt-4 max-w-[var(--measure)] rounded-[var(--radius)] border border-status-held bg-surface px-4 py-3 text-sm"
        >
          {error}
        </div>
      )}
      {deleted && error === '' && (
        <p className="mt-4 text-sm text-status-open" aria-live="polite">
          Draft deleted.
        </p>
      )}

      {drafts.length === 0 ? (
        <p className="mt-8 max-w-[var(--measure)] rounded-[var(--radius)] border border-border bg-surface px-4 py-6 text-sm text-muted">
          No drafts yet.
        </p>
      ) : (
        <ul className="mt-6 flex flex-col">
          {drafts.map((draft) => (
            <li
              key={draft.id}
              className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border py-3 first:border-t"
            >
              <div className="min-w-0 max-w-[var(--measure)]">
                <a
                  href={`/drafts/${draft.id}`}
                  className="text-foreground underline decoration-border-strong underline-offset-2 hover:decoration-accent"
                >
                  {draft.opportunityTitle}
                </a>
                <p className="mt-1 text-xs text-muted">
                  {draft.kind === 'email' ? (
                    <>
                      Email to <span translate="no">{draft.recipient}</span>
                    </>
                  ) : (
                    'Cover letter'
                  )}{' '}
                  · {draft.profileLabel} ·{' '}
                  <time dateTime={draft.updatedAt} title={absoluteTime(draft.updatedAt)}>
                    {relativeTime(draft.updatedAt)}
                  </time>
                </p>
              </div>
              <ApprovalLabel status={draft.approval.status} />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

/** Word and shape, not colour alone — same rule as StatusChip. */
function ApprovalLabel({ status }: { status: 'none' | 'current' | 'stale' }) {
  const spec = {
    current: { label: 'Approved', className: 'text-status-open', shape: 'filled' },
    stale: {
      label: 'Approval no longer valid',
      className: 'text-status-unconfirmed',
      shape: 'hollow',
    },
    none: { label: 'Not approved', className: 'text-faint', shape: 'hollow' },
  }[status];
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 text-xs ${spec.className}`}>
      <svg width={8} height={8} viewBox="0 0 8 8" aria-hidden="true">
        {spec.shape === 'filled' ? (
          <circle cx="4" cy="4" r="3.5" fill="currentColor" />
        ) : (
          <circle cx="4" cy="4" r="3" fill="none" stroke="currentColor" strokeWidth="1.5" />
        )}
      </svg>
      {spec.label}
    </span>
  );
}
