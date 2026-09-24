import type { ListingView, ReviewQueueEntry } from '../../../../../src/browse/queries.js';
import { countReviewQueue, listReviewQueue } from '../../../../../src/browse/queries.js';
import { db } from '../../../../../src/db/client.js';
import { StatusChip } from '../../../../components/status-chip.js';
import { requireAdmin } from '../../../../lib/admin-auth.js';
import { absoluteTime, count, relativeTime, score, sourceDate } from '../../../../lib/format.js';
import { sourceLabel } from '../../../../lib/labels.js';
import {
  evidenceReasons,
  isStaleLinkPair,
  pickSurvivor,
  reviewerReasons,
} from '../../../../lib/review-pair.js';
import type { RawSearchParams } from '../../../../lib/search-params.js';
import { writesEnabled } from '../../../../lib/writes.js';
import { acceptReviewPair, rejectReviewPair } from './actions.js';

/**
 * The admin surface's duplicate-review screen (Stage 8, change.md §5's route
 * table). Reads via the same `listReviewQueue`/`countReviewQueue`
 * `(local)/review/page.tsx` uses; its mutations go through this route's own
 * `./actions.js` (`requireAdmin()`-guarded, redirecting back to
 * `/admin/duplicates`), not `(local)/review/actions.ts` directly.
 */

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Duplicates · Admin · Xtelo' };

const QUEUE_LIMIT = 500;

export default async function AdminDuplicatesPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  await requireAdmin();

  const [total, pairs, raw] = await Promise.all([
    countReviewQueue(db),
    listReviewQueue(db, { limit: QUEUE_LIMIT }),
    searchParams,
  ]);
  const conflict = Array.isArray(raw.conflict) ? raw.conflict[0] : raw.conflict;

  return (
    <main className="w-full px-4 py-8 sm:px-6 sm:py-10">
      <header>
        <h1 className="text-xl font-semibold">Duplicates</h1>
        <p className="mt-2 max-w-[var(--measure)] text-sm text-muted">
          Pairs the scorer proposes as the same vacancy but will not link automatically. A merge
          moves one listing into the other&apos;s opportunity. Rejecting usually just records the
          verdict — except for a pair already merged (an automatic link whose evidence has since
          weakened), where rejecting splits the two listings apart.
        </p>
      </header>

      {conflict !== undefined && conflict !== '' && <ConflictNotice message={conflict} />}

      {!writesEnabled() && <ReadOnlyNotice />}

      <p className="mt-6 text-sm text-faint">
        <span className="numeric">{count(total)}</span> {total === 1 ? 'pair is' : 'pairs are'}{' '}
        awaiting a decision
        {total > pairs.length && (
          <>
            {' '}
            — <span className="numeric">{count(total - pairs.length)}</span>{' '}
            {total - pairs.length === 1 ? "isn't" : "aren't"} shown below. Settle those directly
            with <span className="numeric">npm run browse</span>.
          </>
        )}
        {total === pairs.length && '.'}
      </p>

      {pairs.length === 0 ? <EmptyState total={total} /> : <Queue pairs={pairs} />}

      {pairs.length > 0 && (
        <p className="mt-4 text-xs text-faint">
          No action is required to move past a pair — leave it and continue; it stays in the queue
          until you decide.
        </p>
      )}
    </main>
  );
}

function ConflictNotice({ message }: { message: string }) {
  return (
    <p className="mt-4 max-w-[var(--measure)] rounded-[var(--radius)] border border-status-held bg-surface px-4 py-3 text-sm">
      {message}
    </p>
  );
}

function ReadOnlyNotice() {
  return (
    <p className="mt-4 max-w-[var(--measure)] rounded-[var(--radius)] border border-border bg-surface px-4 py-3 text-sm text-muted">
      This instance cannot write, so pairs can be read here but not settled. Set{' '}
      <span className="numeric">XTELO_WRITES_ENABLED=true</span> to enable admin mutations.
    </p>
  );
}

function EmptyState({ total }: { total: number }) {
  if (total > 0) {
    return (
      <div className="mt-4 max-w-[var(--measure)] rounded-[var(--radius)] border border-status-held bg-surface px-4 py-6 text-sm text-muted">
        <p>
          <span className="numeric">{count(total)}</span> {total === 1 ? 'pair is' : 'pairs are'}{' '}
          recorded as awaiting a decision, but none could be shown here — each one&apos;s listing
          has no readable current revision.
        </p>
        <p className="mt-2">
          Settle {total === 1 ? 'it' : 'them'} directly with{' '}
          <span className="numeric">npm run browse</span>.
        </p>
      </div>
    );
  }
  return (
    <div className="mt-4 max-w-[var(--measure)] rounded-[var(--radius)] border border-border bg-surface px-4 py-6 text-sm text-muted">
      <p>No listing has a pending duplicate proposed against it right now.</p>
      <p className="mt-2">
        New pairs appear after the next <span className="numeric">npm run dedupe</span> pass finds
        one.
      </p>
    </div>
  );
}

function Queue({ pairs }: { pairs: ReviewQueueEntry[] }) {
  return (
    <ul className="mt-4 flex flex-col gap-4">
      {pairs.map((pair) => (
        <PairCard key={pair.candidateId} pair={pair} />
      ))}
    </ul>
  );
}

function BoardLink({ listing }: { listing: ListingView }) {
  return (
    <a
      href={listing.canonicalUrl}
      target="_blank"
      rel="noreferrer"
      translate="no"
      aria-label={`${listing.title} on ${sourceLabel(listing.sourceSlug)} (opens in a new tab)`}
      className="text-accent underline underline-offset-2 hover:text-foreground"
    >
      {sourceLabel(listing.sourceSlug)}
    </a>
  );
}

function ComparisonTable({ a, b }: { a: ListingView; b: ListingView }) {
  return (
    <div className="mt-2 overflow-x-auto">
      <table className="w-full min-w-[24rem] border-collapse text-sm">
        <thead>
          <tr className="text-left align-bottom">
            <th scope="col" className="w-20 pr-3 pb-1 font-normal text-faint sm:w-28">
              <span className="sr-only">Field</span>
            </th>
            {[a, b].map((listing) => (
              <th key={listing.sourceListingId} scope="col" className="pr-3 pb-1 font-medium">
                <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
                  <BoardLink listing={listing} />
                  <StatusChip status={listing.status} />
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <ComparisonRow label="title">
            {[a, b].map((listing) => (
              <td
                key={listing.sourceListingId}
                className="max-w-[var(--measure)] break-words py-1 pr-3"
              >
                {listing.title}
              </td>
            ))}
          </ComparisonRow>
          <ComparisonRow label="employer">
            {[a, b].map((listing) => (
              <td key={listing.sourceListingId} className="py-1 pr-3 text-muted">
                {listing.organization ?? <span className="text-faint">not stated</span>}
              </td>
            ))}
          </ComparisonRow>
          <ComparisonRow label="closes">
            {[a, b].map((listing) => (
              <td key={listing.sourceListingId} className="py-1 pr-3 text-faint">
                {listing.deadlineAt === null ? (
                  <span className="text-faint">not stated</span>
                ) : (
                  <time dateTime={listing.deadlineAt} title={absoluteTime(listing.deadlineAt)}>
                    {sourceDate(listing.deadlineAt)}
                  </time>
                )}
              </td>
            ))}
          </ComparisonRow>
          <ComparisonRow label="first seen">
            {[a, b].map((listing) => (
              <td key={listing.sourceListingId} className="py-1 pr-3 text-faint">
                <time dateTime={listing.firstSeenAt} title={absoluteTime(listing.firstSeenAt)}>
                  {relativeTime(listing.firstSeenAt)}
                </time>
              </td>
            ))}
          </ComparisonRow>
        </tbody>
      </table>
    </div>
  );
}

function ComparisonRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <tr className="border-t border-border align-baseline">
      <th scope="row" className="py-1 pr-3 text-left font-normal text-faint">
        {label}
      </th>
      {children}
    </tr>
  );
}

function PairCard({ pair }: { pair: ReviewQueueEntry }) {
  const reasons = evidenceReasons(pair.evidence);
  const displayReasons = reviewerReasons(pair.evidence);
  const { survivor, moving } = pickSurvivor(pair);
  const titlesDiffer = pair.a.title !== pair.b.title;
  const staleLink = isStaleLinkPair(pair.evidence);

  return (
    <li className="rounded-[var(--radius)] border border-border bg-surface px-4 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-xs text-faint">
          similarity <span className="numeric">{score(pair.similarityScore)}</span>
        </p>
      </div>

      {staleLink && (
        <p className="mt-2 max-w-[var(--measure)] rounded-[var(--radius)] border border-status-held bg-surface px-3 py-2 text-xs text-status-held">
          These two are already merged into one record. The link that merged them no longer scores
          as strongly as it did — confirming keeps them together, rejecting splits them apart.
        </p>
      )}

      <ComparisonTable a={pair.a} b={pair.b} />

      {titlesDiffer && (
        <p className="mt-3 max-w-[var(--measure)] text-xs text-status-unconfirmed">
          The two boards give this vacancy different titles — read both before deciding.
        </p>
      )}

      {reasons.length > 0 ? (
        <div className="mt-3">
          <p className="text-xs text-faint">why the scorer proposed this pair:</p>
          <ul className="mt-1 ml-4 max-w-[var(--measure)] list-disc text-xs text-muted marker:text-nontext">
            {reasons.map((rawReason, index) => (
              <li key={rawReason}>{displayReasons[index]}</li>
            ))}
          </ul>
        </div>
      ) : (
        <MissingEvidenceNotice />
      )}

      <div className="mt-4">
        <PairActions
          candidateId={pair.candidateId}
          survivor={survivor}
          moving={moving}
          hasEvidence={reasons.length > 0}
          staleLink={staleLink}
        />
      </div>
    </li>
  );
}

function MissingEvidenceNotice() {
  return (
    <p className="mt-3 max-w-[var(--measure)] rounded-[var(--radius)] border border-status-held bg-surface px-3 py-2 text-xs text-status-held">
      No evidence is recorded for why the scorer proposed this pair, so a decision made here would
      have nothing behind it. Re-run <span className="numeric">npm run dedupe</span> to regenerate
      it, or settle this pair from <span className="numeric">npm run browse</span>.
    </p>
  );
}

function PairActions({
  candidateId,
  survivor,
  moving,
  hasEvidence,
  staleLink,
}: {
  candidateId: string;
  survivor: ListingView;
  moving: ListingView;
  hasEvidence: boolean;
  staleLink: boolean;
}) {
  if (!hasEvidence) return null;

  if (!writesEnabled()) {
    return (
      <p className="text-xs text-faint">
        Awaiting a decision. This instance is read-only, so it cannot make one.
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <form action={acceptReviewPair}>
        <input type="hidden" name="candidateId" value={candidateId} />
        <input type="hidden" name="survivorListingId" value={survivor.sourceListingId} />
        <input type="hidden" name="movingListingId" value={moving.sourceListingId} />
        <button
          type="submit"
          className="rounded-[var(--radius)] border border-border-strong bg-surface-raised px-3 py-1 text-sm hover:bg-surface-active"
        >
          {staleLink ? 'Same vacancy — keep merged' : 'Same vacancy — merge'}
        </button>
      </form>
      <form action={rejectReviewPair}>
        <input type="hidden" name="candidateId" value={candidateId} />
        <input type="hidden" name="movingListingId" value={moving.sourceListingId} />
        <button
          type="submit"
          className="rounded-[var(--radius)] px-3 py-1 text-sm text-muted underline underline-offset-2 hover:text-foreground"
        >
          {staleLink ? 'Different vacancies — split apart' : 'Different vacancies'}
        </button>
      </form>
    </div>
  );
}
