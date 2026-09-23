// '.js', for the reason web/types.d.ts records about next/font: `next`
// ships no exports map, and nodenext resolution does no directory-index
// lookup, so the bare specifier has no types. Unlike next/font this is an
// ordinary runtime import with no compile-time transform keyed on the
// specifier, so the explicit path is safe as well as necessary.
import { notFound } from 'next/navigation.js';
import { getOpportunity } from '../../../../../src/browse/queries.js';
import { db } from '../../../../../src/db/client.js';
import { decisionsByOpportunity } from '../../../../../src/shortlist/decisions.js';
import { DecisionControl } from '../../../../components/decision-control.js';
import { StatusChip } from '../../../../components/status-chip.js';
import {
  absoluteTime,
  relativeTime,
  score,
  sourceDate,
  sourceDateTime,
} from '../../../../lib/format.js';
import {
  dedupeDecidedByLabel,
  dedupeDecisionLabel,
  extractionMethodLabel,
  listingStatusLabel,
  opportunityTypeLabel,
  sourceLabel,
} from '../../../../lib/labels.js';
import { writesEnabled } from '../../../../lib/writes.js';
import { detachFromOpportunity } from './actions.js';
import {
  type BoardColumn,
  type Cell,
  type OpportunityDetail,
  toDetail,
} from '../../../../lib/opportunity-detail.js';

/**
 * One opportunity in full.
 *
 * The screen's whole job is to keep the boards distinguishable. A canonical
 * opportunity is a claim that two listings are the same vacancy, and §14.2
 * requires the places they disagree to be visible rather than resolved away —
 * so nothing here averages, merges or picks a winner:
 *
 *   - the fields are laid out board against board, with the differences marked;
 *   - each board's description is its own section, attributed, never joined;
 *   - the grouping decision itself is shown, with its confidence and who made it.
 *
 * The last of those matters more than it looks. Every visible row on the list
 * screen is the output of a dedupe pass, and this is the only screen where a
 * reader can see why two listings were put together and disagree with it.
 *
 * **This route deliberately has no `loading.tsx`**, unlike every other screen
 * here. A loading fallback is a Suspense boundary, and a Suspense boundary
 * starts streaming the response — after which the status code has already been
 * sent, so `notFound()` below would render the not-found page under a 200 and
 * report a dead link as a live one. Measured, the trade is one-sided: this
 * screen's query runs in about 60ms against the live corpus, against the
 * list's 3.8 seconds, so there is very little for a fallback to cover.
 */

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Opportunity · Xtelo' };

export default async function OpportunityPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ back?: string | string[]; conflict?: string | string[] }>;
}) {
  const { id } = await params;
  const view = await getOpportunity(db, id);
  // Covers both "no such id" and "not a uuid at all" — see getOpportunity,
  // which refuses to hand a malformed id to Postgres.
  if (view === null) notFound();

  const detail = toDetail(view);
  const query = await searchParams;
  const conflict = Array.isArray(query.conflict) ? query.conflict[0] : query.conflict;

  // The one screen with enough context to decide from: the boards compared,
  // the descriptions, and what the grouping rests on are all on this page.
  const decisions = await decisionsByOpportunity(db, [detail.opportunityId]);
  const decision = decisions.get(detail.opportunityId) ?? null;

  return (
    <main className="w-full px-4 py-8 sm:px-6 sm:py-10">
      <BackLink back={query.back} opportunityId={detail.opportunityId} />
      {conflict !== undefined && conflict !== '' && <ConflictNotice message={conflict} />}
      <Header detail={detail} />
      <section className="mt-4">
        <DecisionControl
          opportunityId={detail.opportunityId}
          decision={decision?.decision ?? null}
          note={decision?.note ?? null}
          withNote
        />
      </section>
      <Comparison detail={detail} />
      <Apply detail={detail} />
      <Descriptions detail={detail} />
      <Extras detail={detail} />
      <FormerBoards detail={detail} />
      <Provenance detail={detail} revision={view.revision} updatedAt={view.updatedAt} />
    </main>
  );
}

/**
 * Back to the list the reader came from — filters, sort, depth and place.
 *
 * The list keeps its entire state in the URL, so returning to a bare
 * `/opportunities` would silently discard a filter someone had just set and
 * drop them at the top of a list they may have grown to several thousand rows.
 * The row that was clicked passes its own query string as `back`; without it
 * this still works and lands on the unfiltered list.
 *
 * `back` is rebuilt rather than trusted — it is only ever used as the query
 * part of this app's own list route, so a crafted value cannot redirect
 * anywhere else. The fragment is this opportunity's id, which comes from the
 * database rather than the URL and so needs no validation at all.
 */

/**
 * An expected refusal from `detachFromOpportunity`, shown inline where it
 * happened rather than sent to the generic error boundary — the same reason
 * and the same pattern as the review screen's own `ConflictNotice`. Most
 * often: the listing moved since this page was loaded, so undoing it here
 * would have touched a cluster nobody reviewed.
 */
function ConflictNotice({ message }: { message: string }) {
  return (
    <p className="mt-4 max-w-[var(--measure)] rounded-[var(--radius)] border border-status-held bg-surface px-4 py-3 text-sm">
      {message}
    </p>
  );
}

function BackLink({
  back,
  opportunityId,
}: {
  back: string | string[] | undefined;
  opportunityId: string;
}) {
  const rawBack = Array.isArray(back) ? back[0] : back;
  const search = rawBack === undefined || rawBack === '' ? '' : `?${rawBack.replace(/^\?/, '')}`;

  // This opportunity's own id, not the position it happened to occupy.
  // A crawl running while the detail page is open adds, removes and reorders
  // rows, so row 37 on the way back is a different vacancy from row 37 on the
  // way in — the URL-state promise failing precisely while the corpus moves,
  // which is when someone is most likely to be reading. The id needs nothing
  // passed from the list and cannot go stale.
  const anchor = `#opp-${opportunityId}`;

  return (
    <a
      className="text-sm text-accent underline underline-offset-2 hover:text-foreground"
      href={`/opportunities${search}${anchor}`}
    >
      Back to opportunities
    </a>
  );
}

function Header({ detail }: { detail: OpportunityDetail }) {
  const type = detail.type === 'job' ? null : opportunityTypeLabel(detail.type);
  const employers = [
    ...new Set(
      detail.comparison
        .find((row) => row.key === 'employer')
        ?.cells.flatMap((cell) => (cell === null || cell.kind !== 'text' ? [] : [cell.value])) ??
        [],
    ),
  ];

  return (
    <header className="mt-4">
      <h1 className="max-w-[var(--measure)] text-pretty text-2xl font-semibold leading-[var(--leading-heading)]">
        {detail.title}
      </h1>
      <p className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm text-muted">
        <StatusChip status={detail.status} />
        {employers.length > 0 && <span>{employers.join(' · ')}</span>}
        {type !== null && (
          <span className="text-accent" title={type.explanation}>
            {type.short}
          </span>
        )}
      </p>
      {/* Currency, not correctness. The title and state above come from the
          last dedupe pass; `resolveCanonicalOpportunity` does not run after
          every crawl, so a board may have changed what it says since. §12.4
          requires that a stale canonical view be distinguishable from a
          current one, and `sourceMembershipVersions` was being stored for
          exactly this comparison and never read. Said plainly, next to the
          values it is about, rather than hidden in a tooltip. */}
      {detail.canonicalIsStale && (
        <p className="mt-2 max-w-[var(--measure)] text-sm text-status-unconfirmed">
          A board has been re-crawled since these canonical fields were worked out, so the title and
          state above may lag what each board states below.
        </p>
      )}
      <p className="mt-2 text-sm text-faint">
        {detail.columns.length === 0 ? (
          detail.formerBoards.length > 0 ? (
            'No listings are currently grouped into this record. What was detached from it is listed below.'
          ) : (
            'No listings are currently grouped into this record, and nothing is recorded about what was.'
          )
        ) : detail.crossPosted ? (
          <>
            Carried by{' '}
            <span translate="no">
              {detail.columns.map((column) => sourceLabel(column.sourceSlug)).join(' and ')}
            </span>
            . The two listings are compared below rather than merged.
          </>
        ) : (
          <>
            Seen on <span translate="no">{sourceLabel(detail.columns[0]?.sourceSlug ?? '')}</span>{' '}
            only.
          </>
        )}
      </p>
    </header>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h2 className="text-sm font-semibold text-muted">{children}</h2>;
}

/** A board's own listing page, which every member must link back to. */
function BoardLink({ column, title }: { column: BoardColumn; title: string }) {
  return (
    <a
      href={column.url}
      target="_blank"
      rel="noreferrer"
      // A board name is an identifier; machine translation turns "jobs.ge"
      // into something that no longer names anything.
      translate="no"
      aria-label={`${title} on ${sourceLabel(column.sourceSlug)} (opens in a new tab)`}
      className="text-accent underline underline-offset-2 hover:text-foreground"
    >
      {sourceLabel(column.sourceSlug)}
    </a>
  );
}

function CellValue({ cell }: { cell: Cell | null }) {
  // Absence, not a conflict, and not an error: jobs.ge records no location and
  // no pay at all. It gets a word rather than a dash, so a column of blanks
  // does not read as missing data.
  if (cell === null) return <span className="text-faint">not stated</span>;
  switch (cell.kind) {
    case 'text':
      return <span>{cell.value}</span>;
    case 'status':
      return <StatusChip status={cell.value} />;
    case 'date':
      return (
        <time className="numeric" dateTime={cell.iso} title={sourceDateTime(cell.iso)}>
          {sourceDate(cell.iso)}
        </time>
      );
  }
}

/**
 * The boards side by side, one row per field, differences marked.
 *
 * A table rather than two stacked panels, because the point is that values sit
 * adjacent: two nearly identical Georgian strings are hard to diff by eye, and
 * aligning them is what makes the difference findable at all.
 *
 * The marker is visible text, not a colour or a tooltip. Colour alone fails a
 * contrast requirement and a tooltip is unavailable on touch — the list screen
 * already learned this about its own conflict marker.
 */
function Comparison({ detail }: { detail: OpportunityDetail }) {
  if (detail.columns.length === 0 || detail.comparison.length === 0) return null;

  return (
    <section className="mt-8">
      <SectionHeading>What each board states</SectionHeading>
      <div className="mt-3 overflow-x-auto">
        {/* Capped, not full-width. Left to stretch, the two value columns came
            to 687px each at 1600 for values that are a few Georgian words
            long — the values a reader is trying to compare ended up half a
            screen apart, which is the opposite of what putting them in a table
            was for. The cap is per column and scales with however many boards
            carry the vacancy rather than being a fixed number that a third
            source would break. */}
        {/* 24rem, not 30: the comparison only works while the two values sit
            adjacent, so the mobile answer is to keep them adjacent and let the
            table scroll inside its own box rather than stacking the boards —
            stacking puts the values a screen apart and there is nothing left
            to compare. At 24rem the two columns fit a 390px screen outright,
            so the scroll is a fallback rather than the normal case. */}
        <table
          className="w-full min-w-[24rem] border-collapse text-sm"
          style={{ maxWidth: `calc(10rem + ${detail.columns.length} * 22rem)` }}
        >
          <thead>
            <tr className="border-b border-border-strong text-left align-bottom">
              {/* Narrower on a phone, where 160px of label is space the two
                  values need more. */}
              <th scope="col" className="w-24 py-2 pr-3 font-medium text-faint sm:w-40 sm:pr-4">
                Field
              </th>
              {detail.columns.map((column) => (
                <th key={column.sourceListingId} scope="col" className="py-2 pr-4 font-medium">
                  <BoardLink column={column} title={detail.title} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {detail.comparison.map((row) => (
              <tr key={row.key} className="border-b border-border align-baseline">
                <th scope="row" className="py-2 pr-3 text-left font-normal text-muted sm:pr-4">
                  {row.label}
                  {row.differs && (
                    <span className="mt-0.5 block text-xs text-status-unconfirmed">{row.note}</span>
                  )}
                </th>
                {row.cells.map((cell, index) => (
                  <td
                    // The column index IS the identity here: cells are
                    // positional and parallel to `detail.columns`.
                    key={detail.columns[index]?.sourceListingId ?? index}
                    className="py-2 pr-3 break-words sm:pr-4"
                  >
                    <CellValue cell={cell} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * How to apply, per board.
 *
 * All four routes the schema allows occur in the corpus, and each gets its own
 * treatment. `form` is not a missing value — it means the board hosts the
 * application itself, so the instruction is to open the listing. Only
 * `unstated` is genuinely absent, and it says so rather than showing a dead
 * control.
 */
/**
 * The host an application link actually points at.
 *
 * Shown instead of "the employer's site", which `applicationMethod` cannot
 * support: `type: 'url'` establishes only that an external URL exists, and in
 * this corpus most of them are ATS vendors — smrtr.io (SmartRecruiters),
 * hel-ai.com, selfrecruit.ge — not the employer's own domain. Naming the
 * destination is both honest and more useful, since it tells a reader where
 * their application is about to go.
 */
function applicationHost(href: string): string {
  try {
    return new URL(href).host;
  } catch {
    // A stored value that will not parse is still shown rather than hidden;
    // the link is what the board gave us either way.
    return href;
  }
}

function Apply({ detail }: { detail: OpportunityDetail }) {
  if (detail.apply.length === 0) return null;

  return (
    <section className="mt-8">
      <SectionHeading>How to apply</SectionHeading>
      <ul className="mt-3 flex flex-col gap-2 text-sm">
        {detail.apply.map(({ column, route }) => (
          <li
            key={column.sourceListingId}
            className="flex flex-wrap items-baseline gap-x-2 gap-y-1"
          >
            <span className="text-faint">
              via <BoardLink column={column} title={detail.title} />
            </span>
            {route.kind === 'email' && (
              <a
                href={route.href}
                translate="no"
                className="numeric break-all text-accent underline underline-offset-2 hover:text-foreground"
              >
                {route.address}
              </a>
            )}
            {route.kind === 'url' && (
              <a
                href={route.href}
                target="_blank"
                rel="noreferrer"
                translate="no"
                aria-label={`Apply for ${detail.title} at ${applicationHost(route.href)} (opens in a new tab)`}
                className="break-all text-accent underline underline-offset-2 hover:text-foreground"
              >
                {applicationHost(route.href)}
              </a>
            )}
            {route.kind === 'onSource' && (
              <span className="text-muted">
                through a form on the listing itself — open it to apply
              </span>
            )}
            {route.kind === 'unstated' && (
              <span className="text-muted">this board does not say how to apply</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Each board's description, separately and attributed.
 *
 * Never concatenated. The ranking layer joins them internally because it scores
 * text, but each board may carry facts the other lacks and a merged block
 * destroys which one said what — `anti-patterns.md` classes that as lost
 * provenance.
 *
 * `whitespace-pre-wrap` preserves the line breaks the source wrote and adds
 * nothing: the text has no reliable internal structure, so it is presented as
 * the prose it is rather than split into invented headings or bullets. The
 * measure is capped because these run to 6,657 characters at worst.
 */
function Descriptions({ detail }: { detail: OpportunityDetail }) {
  if (detail.descriptions.length === 0) return null;

  return (
    <section className="mt-8">
      {/* Not "what each board says" — that is a line away from the comparison
          table's own heading, and the two read as the same section twice. */}
      <SectionHeading>
        {detail.descriptions.length > 1 ? 'Full text, board by board' : 'Full text'}
      </SectionHeading>
      <div className="mt-3 flex flex-col gap-6">
        {detail.descriptions.map(({ column, text }) => (
          <article key={column.sourceListingId}>
            <h3 className="text-xs text-faint">
              as posted on <BoardLink column={column} title={detail.title} />
            </h3>
            <p className="mt-2 max-w-[var(--measure)] whitespace-pre-wrap text-sm">{text}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

/**
 * Fields a board records that this schema has no column for.
 *
 * Real stored data, not a guess: hr.ge persists these for all 100 of its
 * listings and jobs.ge persists none, so this section is present for one board
 * and absent for the other. Values are printed as the board wrote them, in
 * Georgian — normalising them here would be inventing data, and the taxonomy
 * work that maps them properly is a later stage.
 */
function Extras({ detail }: { detail: OpportunityDetail }) {
  if (detail.extras.length === 0) return null;

  return (
    <section className="mt-8">
      <SectionHeading>Also recorded by the board</SectionHeading>
      <div className="mt-3 flex flex-col gap-5">
        {detail.extras.map(({ column, fields }) => (
          <div key={column.sourceListingId}>
            <h3 className="text-xs text-faint">
              on <BoardLink column={column} title={detail.title} />
            </h3>
            <dl className="mt-2 grid grid-cols-[minmax(8rem,10rem)_1fr] gap-x-4 gap-y-1.5 text-sm">
              {fields.map((field) => (
                <div key={field.label} className="col-span-2 grid grid-cols-subgrid">
                  <dt className="text-muted">{field.label}</dt>
                  <dd className="max-w-[var(--measure)]">{field.values.join(' · ')}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * Listings that were in this cluster and are not any more.
 *
 * The section that makes "a record of what was seen" true. An opportunity
 * whose last live member is detached is kept on purpose — the audit trail
 * §12.5 requires lives in the retired membership rows — but with only live
 * members on screen, that page showed no source link, no title and no reason,
 * which is an audit trail asserting itself and displaying nothing.
 *
 * Rendered as history rather than as current state: past tense, the date it
 * was detached, and the reasons recorded at the time.
 */
function FormerBoards({ detail }: { detail: OpportunityDetail }) {
  if (detail.formerBoards.length === 0) return null;

  return (
    <section className="mt-8">
      <SectionHeading>No longer part of this record</SectionHeading>
      <ul className="mt-3 flex flex-col gap-3 text-sm">
        {/* Keyed on the MEMBERSHIP, not the listing. Detach, restore and
            detach again is a supported reversible workflow, so one listing can
            hold several retired rows here and keying on its id would collapse
            them into one. */}
        {detail.formerBoards.map((former) => (
          <li key={former.membershipId}>
            <span className="block max-w-[var(--measure)]">{former.title}</span>
            <span className="mt-0.5 block text-faint">
              on <BoardLink column={former.column} title={former.title} />, detached{' '}
              <time dateTime={former.detachedAt} title={absoluteTime(former.detachedAt)}>
                {relativeTime(former.detachedAt)}
              </time>
            </span>
            {/* The same audit line a live membership gets. When every member
                has been detached these rows are the ONLY record of who
                grouped this listing and how confidently — the case the audit
                trail exists for. */}
            <span className="mt-0.5 block text-faint">
              grouped as{' '}
              <span title={dedupeDecisionLabel(former.decision).explanation}>
                {dedupeDecisionLabel(former.decision).short}
              </span>
              ,{' '}
              <span title={dedupeDecidedByLabel(former.decidedBy).explanation}>
                {dedupeDecidedByLabel(former.decidedBy).short}
              </span>{' '}
              at confidence <span className="numeric">{score(former.confidence)}</span> using rules{' '}
              <span className="numeric">{former.dedupeRulesetVersion}</span> on{' '}
              <time dateTime={former.decidedAt} title={absoluteTime(former.decidedAt)}>
                {relativeTime(former.decidedAt)}
              </time>
            </span>
            {/* Named for what it is. A retired membership keeps the evidence
                that GROUPED the listing here — retiring only stamps a
                tombstone — so printing it under a detachment date without
                saying so would attribute the original match to the removal. */}
            {former.groupingReasons.length > 0 && (
              <>
                <span className="mt-1 block text-faint">originally grouped here because:</span>
                <ul className="mt-0.5 ml-4 max-w-[var(--measure)] list-disc text-faint marker:text-nontext">
                  {former.groupingReasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * How this record came to exist — Xtelo's own observations, kept apart from
 * what the boards claim.
 *
 * The separation is the point. First-seen, last-seen and fetched-at are facts
 * about this system's crawling, not statements by a board, and mixing them
 * into the comparison above would let a crawl artefact read as a source
 * disagreement.
 *
 * The grouping decision sits here too, with its confidence and who made it,
 * because this is the only screen where a reader can judge whether two
 * listings should have been put together at all.
 */
/**
 * The undo for a merge, next to the decision it undoes.
 *
 * One click, no confirmation dialog — matching `DecisionControl`'s own
 * reasoning: `anti-patterns.md` forbids a scary confirmation for a reversible
 * action, and a detach is exactly that. Nothing is destroyed: `detachListing`
 * retires the membership rather than deleting it, so the record of the
 * original merge — its evidence, its confidence, who made it — survives in
 * "No longer part of this record" below.
 */
function DetachControl({
  sourceListingId,
  opportunityId,
}: {
  sourceListingId: string;
  opportunityId: string;
}) {
  if (!writesEnabled()) {
    return (
      <p className="mt-1 text-xs text-faint">This instance is read-only, so it cannot undo this.</p>
    );
  }
  return (
    <form action={detachFromOpportunity} className="mt-1">
      <input type="hidden" name="sourceListingId" value={sourceListingId} />
      {/* The opportunity THIS PAGE is showing, checked against the listing's
          current one before anything moves — a stale page left open while
          something else moved the listing must not detach it from a cluster
          the reviewer never looked at. */}
      <input type="hidden" name="expectedOpportunityId" value={opportunityId} />
      <button
        type="submit"
        className="text-xs text-muted underline underline-offset-2 hover:text-foreground"
      >
        Undo this merge
      </button>
    </form>
  );
}

function Provenance({
  detail,
  revision,
  updatedAt,
}: {
  detail: OpportunityDetail;
  revision: { resolutionRulesetVersion: string; createdAt: string } | null;
  updatedAt: string;
}) {
  return (
    <section className="mt-10 border-t border-border pt-6">
      <SectionHeading>How this record was built</SectionHeading>
      <div className="mt-3 flex flex-col gap-5 text-sm">
        {detail.observations.map((observation) => {
          const decision = dedupeDecisionLabel(observation.decision);
          const decidedBy = dedupeDecidedByLabel(observation.decidedBy);
          const method = extractionMethodLabel(observation.extractionMethod);
          const state = listingStatusLabel(observation.column.status);
          return (
            <div key={observation.column.sourceListingId}>
              <h3 className="text-xs text-faint">
                <BoardLink column={observation.column} title={detail.title} />
              </h3>
              <ul className="mt-1.5 flex max-w-[var(--measure)] flex-col gap-1 text-muted">
                <li>
                  First seen{' '}
                  <time
                    dateTime={observation.firstSeenAt}
                    title={absoluteTime(observation.firstSeenAt)}
                  >
                    {relativeTime(observation.firstSeenAt)}
                  </time>
                  , last seen{' '}
                  <time
                    dateTime={observation.lastSeenAt}
                    title={absoluteTime(observation.lastSeenAt)}
                  >
                    {relativeTime(observation.lastSeenAt)}
                  </time>
                  {' — '}
                  {state.explanation}
                </li>
                <li>
                  Read{' '}
                  <time
                    dateTime={observation.fetchedAt}
                    title={absoluteTime(observation.fetchedAt)}
                  >
                    {relativeTime(observation.fetchedAt)}
                  </time>{' '}
                  by <span title={method.explanation}>{method.short}</span>, parser{' '}
                  <span className="numeric">{observation.parserVersion}</span>
                </li>
                {/* Gated on whether a GROUPING happened, not on whether two
                    boards are involved. Two live listings from one board is a
                    supported cluster shape, and gating on cross-posting hid
                    the decision and evidence behind a real merge whenever both
                    came from the same source. */}
                {detail.grouped && (
                  <li>
                    Grouped as <span title={decision.explanation}>{decision.short}</span>,{' '}
                    <span title={decidedBy.explanation}>{decidedBy.short}</span> at confidence{' '}
                    <span className="numeric">{score(observation.confidence)}</span> using rules{' '}
                    <span className="numeric">{observation.dedupeRulesetVersion}</span>
                    {/* The stored reasons, not the label's generic wording.
                        A membership from a human reassignment or an older
                        ruleset can rest on entirely different evidence, and
                        the label alone would then misstate it. */}
                    {observation.reasons.length > 0 && (
                      <ul className="mt-1 ml-4 list-disc text-faint marker:text-nontext">
                        {observation.reasons.map((reason) => (
                          <li key={reason}>{reason}</li>
                        ))}
                      </ul>
                    )}
                  </li>
                )}
              </ul>
              {/* The undo for whatever grouped this listing here — a review-
                  screen merge above all, since accepting a pair had no way
                  back until this button existed. Gated on `detail.grouped`
                  like the decision it undoes, so it never shows on a
                  single-member opportunity with nothing to detach FROM. */}
              {detail.grouped && (
                <DetachControl
                  sourceListingId={observation.column.sourceListingId}
                  opportunityId={detail.opportunityId}
                />
              )}
            </div>
          );
        })}
        <p className="max-w-[var(--measure)] text-xs text-faint">
          {revision === null ? (
            <>This record has never been resolved from its listings.</>
          ) : (
            <>
              Resolved by rules <span className="numeric">{revision.resolutionRulesetVersion}</span>{' '}
              <time dateTime={revision.createdAt} title={absoluteTime(revision.createdAt)}>
                {relativeTime(revision.createdAt)}
              </time>
              ; record last touched{' '}
              <time dateTime={updatedAt} title={absoluteTime(updatedAt)}>
                {relativeTime(updatedAt)}
              </time>
              .
            </>
          )}
        </p>
      </div>
    </section>
  );
}
