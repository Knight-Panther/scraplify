import type { ListingView, ReviewQueueEntry } from '../../../../src/browse/queries.js';
import { countReviewQueue, listReviewQueue } from '../../../../src/browse/queries.js';
import { db } from '../../../../src/db/client.js';
import { StatusChip } from '../../../components/status-chip.js';
import { absoluteTime, count, relativeTime, score, sourceDate } from '../../../lib/format.js';
import { sourceLabel } from '../../../lib/labels.js';
import {
  evidenceReasons,
  isStaleLinkPair,
  pickSurvivor,
  reviewerReasons,
} from '../../../lib/review-pair.js';
import type { RawSearchParams } from '../../../lib/search-params.js';
import { writesEnabled } from '../../../lib/writes.js';
import { acceptReviewPair, rejectReviewPair } from './actions.js';

/**
 * Duplicate review — the queue Stage 10 built the backend for, and the last
 * unbuilt half of "the stored corpus can be inspected and corrected without
 * direct database access" (Phase 3's own exit gate).
 *
 * A pair here is two listings the scorer thinks describe the same vacancy but
 * would not auto-link (§14.2: title-and-employer agreement alone is never
 * sufficient). A human looks at both and says which — the same comparison the
 * opportunity detail screen already renders for a CONFIRMED merge, applied
 * here to one still in question.
 *
 * **The queue can genuinely be small.** 11 real pairs exist today; a scorer
 * doing its job well queues few pairs, and consuming them is meant to shrink
 * it further. An empty queue is success, not a broken filter — the empty
 * state says so, the lesson Stage 7's "closing soon" view already wrote down
 * for a filter that legitimately has nothing to show.
 */

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Duplicate review · Xtelo' };

// The query layer's own max (`MAX_LIMIT` in `src/browse/queries.ts`) rather
// than an arbitrary page size — this screen has no pagination yet, and the
// ceiling Stage 8 removed from ranked results is not one to reintroduce here.
// A queue large enough to hit 500 is a different problem than this screen.
const QUEUE_LIMIT = 500;

export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const [total, pairs, raw] = await Promise.all([
    countReviewQueue(db),
    listReviewQueue(db, { limit: QUEUE_LIMIT }),
    searchParams,
  ]);
  const conflict = Array.isArray(raw.conflict) ? raw.conflict[0] : raw.conflict;

  return (
    <main className="w-full px-4 py-8 sm:px-6 sm:py-10">
      <header>
        <h1 className="text-xl font-semibold">Duplicate review</h1>
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
            {total - pairs.length === 1 ? "isn't" : "aren't"} shown below
            {/* Two different causes read the same from here: the page's own
                QUEUE_LIMIT, or `listReviewQueue` silently dropping a
                candidate whose listing has no readable current revision. The
                count is correct either way even when the reason isn't named —
                what matters is that this sentence never implies the total was
                fully rendered when it was not (commit gate, 2026-09-14: the
                empty-state text below used to say so unconditionally, which
                was simply false whenever every pending candidate happened to
                be unrenderable). */}
            . Settle those directly with <span className="numeric">npm run browse</span>.
          </>
        )}
        {total === pairs.length && '.'}
      </p>

      {/* Not gated on `pairs.length === 0` alone: a candidate can exist
          (`total > 0`) and still be unrenderable, in which case the correct
          message is "some pairs could not be shown," never "nothing is
          pending" — that sentence must stay true regardless of whether ANY
          row made it onto the page. */}
      {pairs.length === 0 ? <EmptyState total={total} /> : <Queue pairs={pairs} />}

      {pairs.length > 0 && (
        <p className="mt-4 text-xs text-faint">
          No action is required to move past a pair — leave it and continue, by keyboard or mouse
          alike; it stays in the queue until you decide.
        </p>
      )}
    </main>
  );
}

/**
 * An expected refusal from a decision, shown inline where it happened rather
 * than sent to the generic error boundary.
 *
 * `acceptReviewPair`/`rejectReviewPair` redirect here with the refusal's own
 * message (`?conflict=`) when `acceptDuplicateCandidate` or
 * `rejectDuplicateCandidate` throws a KNOWN business conflict — most often
 * the fan-out guard, real in this queue: several listings sit in more than
 * one pending pair, and accepting one can make a sibling stale. That is a
 * "resolve this by hand" moment, not "Postgres may be down."
 */
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
      This instance is pointed at the live corpus and cannot write, so pairs can be read here but
      not settled. <span className="numeric">npm run dev:web:qa</span> runs against a disposable
      copy where they can.
    </p>
  );
}

/**
 * `total` distinguishes two states that look identical from `pairs.length`
 * alone: genuinely nothing pending, versus something pending that this page
 * could not render (its listing has no readable current revision). The two
 * need different sentences — "nothing to do" is simply false in the second
 * case, and the empty state used to say it regardless (commit gate,
 * 2026-09-14).
 */
function EmptyState({ total }: { total: number }) {
  if (total > 0) {
    return (
      <div className="mt-4 max-w-[var(--measure)] rounded-[var(--radius)] border border-status-held bg-surface px-4 py-6 text-sm text-muted">
        <p>
          <span className="numeric">{count(total)}</span> {total === 1 ? 'pair is' : 'pairs are'}{' '}
          recorded as awaiting a decision, but none could be shown here — each one's listing has no
          readable current revision.
        </p>
        <p className="mt-2">
          Settle {total === 1 ? 'it' : 'them'} directly with{' '}
          <span className="numeric">npm run browse</span>, which reads the same rows without
          requiring a renderable title.
        </p>
      </div>
    );
  }
  return (
    <div className="mt-4 max-w-[var(--measure)] rounded-[var(--radius)] border border-border bg-surface px-4 py-6 text-sm text-muted">
      <p>No listing has a pending duplicate proposed against it right now.</p>
      <p className="mt-2">
        That is the queue working as intended, not a broken filter — a well-scored pair either
        auto-links (§14.2) or lands here for exactly as long as it takes a person to look at it. New
        pairs appear after the next <span className="numeric">npm run dedupe</span> pass finds one.
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

/** A board's own listing page — the same escape hatch the detail screen gives. */
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

/**
 * Board, status, title, organization, deadline and first-seen — one ROW per
 * field, one COLUMN per side, so corresponding values sit adjacent.
 *
 * The first version rendered each side as its own independent flex column,
 * conditionally omitting a field a side lacked (no organization, no
 * deadline). Independent flows don't stay aligned: when one side is missing
 * a field the other has, every field below it shifts, so a side's deadline
 * can end up next to the other side's organization — on the exact screen
 * whose job is to make differences between two listings visible (commit
 * gate, 2026-09-14). A real `<table>`, mirroring the opportunity detail
 * screen's own `Comparison` component, is what actually guarantees this:
 * every row names its field once, and a missing value renders "not stated"
 * in its own cell rather than closing the gap.
 */
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
  // The RAW list gates whether evidence exists at all (translation always
  // produces a sentence, even for a reason it does not recognise, so it
  // could never correctly detect "no evidence"); the TRANSLATED list is what
  // renders — see `reviewerReasons`'s own comment for why the raw one never
  // reaches this screen.
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

      {/* Ahead of the comparison table on purpose: a stale link is a
          DIFFERENT kind of decision than an ordinary pending pair — accepting
          confirms an existing merge, rejecting SPLITS it apart — and that has
          to be visible before a reader reaches the buttons, not discovered
          afterward in a bullet list (commit gate, 2026-09-14). */}
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
              // Keyed on the RAW reason, which `evidenceReasons` guarantees
              // distinct within one pair (`scorePair` never pushes the same
              // sentence twice) — the translated text it maps to can repeat,
              // so keying on that instead could collide.
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

/**
 * A duplicate suggestion with no evidence behind it — a row written before
 * `evidence` existed as a column, or a malformed one. `AGENTS.md` classes "a
 * duplicate suggestion shown without its evidence" as P1 lost provenance, and
 * that applies to letting a reviewer judge one blind just as much as to
 * hiding the evidence section silently while leaving the buttons live.
 */
function MissingEvidenceNotice() {
  return (
    <p className="mt-3 max-w-[var(--measure)] rounded-[var(--radius)] border border-status-held bg-surface px-3 py-2 text-xs text-status-held">
      No evidence is recorded for why the scorer proposed this pair, so a decision made here would
      have nothing behind it. Re-run <span className="numeric">npm run dedupe</span> to regenerate
      it, or settle this pair from <span className="numeric">npm run browse</span> with direct
      access to what is stored.
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
        {/* The side `rejectDuplicateCandidate` would split out if this turns
            out to be a stale-link pair (both sides already merged, and the
            evidence behind that merge has evaporated) rather than a fresh
            proposal. Reuses the same `moving` side accept does, for the same
            reason: which listing is the "mover" is decided once, by
            `pickSurvivor`, not re-chosen per action. */}
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
