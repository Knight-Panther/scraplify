'use client';

import type { MatchReason } from '../../../../src/matching/lexical/rank.js';
import { count, score as formatScore, sourceDate } from '../../../lib/format.js';
import { sourceLabel } from '../../../lib/labels.js';
import type { RankedRow, RankingPayload } from '../../../lib/cv-ranked/protocol.js';

/**
 * Ranked vacancies and the case for each (change.md §7 "Ranking"). The
 * reasons are the ranker's own named matches; nothing here is recomputed or
 * embellished, and there is no percentage — a lexical score is not a
 * probability of fit.
 *
 * A list, like the operator `/ranked` screen, because each row is read for
 * its reasons rather than scanned as a column.
 */
export function Results({
  ranking,
  activeTerms,
  reranking,
  onShowMore,
}: {
  ranking: RankingPayload;
  activeTerms: number;
  reranking: boolean;
  onShowMore: () => void;
}) {
  const { stats } = ranking;
  return (
    <section aria-labelledby="results-heading" aria-busy={reranking} className="min-w-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="results-heading" className="text-base font-semibold">
          Matches
        </h2>
        <p className="text-xs text-faint" aria-live="polite">
          {reranking ? 'Updating…' : ''}
        </p>
      </div>
      <p className="mt-1 text-sm text-muted">
        <span className="numeric text-foreground">{count(stats.matched)}</span> of{' '}
        <span className="numeric">{count(stats.considered)}</span> vacancies match
        {stats.excludedDeadline > 0 && (
          <>
            {' '}
            · <span className="numeric">{count(stats.excludedDeadline)}</span> hidden, deadline
            passed since the index was built
          </>
        )}
        {stats.excludedLocation > 0 && (
          <>
            {' '}
            · <span className="numeric">{count(stats.excludedLocation)}</span> hidden, outside your
            locations
          </>
        )}
      </p>

      {ranking.results.length === 0 ? (
        <div className="mt-3 max-w-[var(--measure)] rounded-[var(--radius)] border border-border bg-surface px-4 py-6 text-sm text-muted">
          {activeTerms === 0 ? (
            <p>
              No role, field or skill is switched on, so there is nothing to match. Tick or add one.
            </p>
          ) : (
            <p>
              No vacancy matches the terms switched on. Try adding a role in the words a vacancy
              title would use, or switching off a location.
            </p>
          )}
        </div>
      ) : (
        <ol className="mt-3 flex flex-col">
          {ranking.results.map((result, index) => (
            <Row key={result.row.opportunityId} result={result} rank={index + 1} />
          ))}
        </ol>
      )}

      {ranking.total > ranking.results.length && (
        <div className="mt-6 flex flex-wrap items-baseline gap-x-4 gap-y-2 text-sm">
          <button
            type="button"
            onClick={onShowMore}
            disabled={reranking}
            className="rounded-[var(--radius)] border border-border-strong bg-surface-raised px-4 py-1.5 hover:bg-surface-active disabled:cursor-wait disabled:text-faint"
          >
            Show more
          </button>
          <p className="text-faint">
            <span className="numeric">{count(ranking.results.length)}</span> of{' '}
            <span className="numeric">{count(ranking.total)}</span> shown
          </p>
        </div>
      )}
      <p className="mt-6 text-xs text-faint">
        Ranked by <span className="numeric">{ranking.version}</span>: word and category matching on
        titles, hr.ge categories and locations. It does not read vacancy descriptions and is not a
        semantic or AI match.
      </p>
    </section>
  );
}

function Row({ result, rank }: { result: RankedRow; rank: number }) {
  const { row } = result;
  return (
    <li className="border-b border-border py-3 first:border-t">
      <div className="flex items-baseline gap-3">
        <span className="numeric w-8 shrink-0 text-right text-faint">{rank}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <a
              href={`/opportunities/${row.opportunityId}`}
              className="max-w-[var(--measure)] leading-[1.6] text-foreground underline decoration-border-strong underline-offset-2 hover:decoration-accent"
            >
              {row.title}
            </a>
            <span
              className="numeric text-sm"
              title="Weighted total of the role, field and skill matches below, out of 1.00"
            >
              {formatScore(result.score)}
            </span>
          </div>
          <p className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-muted">
            {row.organization !== null && <span>{row.organization}</span>}
            {row.locations.length > 0 && <span>{row.locations.join(' · ')}</span>}
            {row.deadlineAt !== null && (
              <span>
                Deadline <span className="numeric">{sourceDate(row.deadlineAt)}</span>
              </span>
            )}
            {row.sources.map((source) => (
              <a
                key={source.sourceListingId}
                href={source.canonicalUrl}
                target="_blank"
                rel="noreferrer"
                translate="no"
                aria-label={`${row.title} on ${sourceLabel(source.sourceSlug)} (opens in a new tab)`}
                className="text-accent underline underline-offset-2 hover:text-foreground"
              >
                {sourceLabel(source.sourceSlug)}
              </a>
            ))}
          </p>
          <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs">
            {result.reasons.map((reason) => (
              <li key={reasonKey(reason)} className="text-muted">
                <Reason reason={reason} />
              </li>
            ))}
            {result.locationUnstated && (
              <li className="text-status-unconfirmed">States no location</li>
            )}
          </ul>
        </div>
      </div>
    </li>
  );
}

function reasonKey(reason: MatchReason): string {
  return `${reason.kind}:${reason.term}:${'label' in reason ? reason.label : ''}`;
}

function Reason({ reason }: { reason: MatchReason }) {
  switch (reason.kind) {
    case 'role':
      return (
        <>
          <span className="text-faint">Role</span> {reason.term}
          {reason.exact ? ' (same title)' : ''}
        </>
      );
    case 'field':
      return (
        <>
          <span className="text-faint">Field</span> {reason.label}
        </>
      );
    case 'skill':
      return (
        <>
          <span className="text-faint">Skill</span> {reason.term}
          {reason.where === 'category' ? ' (in its category)' : ' (in its title)'}
        </>
      );
    case 'location':
      return (
        <>
          <span className="text-faint">Location</span> {reason.term}
        </>
      );
  }
}
