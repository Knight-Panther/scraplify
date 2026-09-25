import { and, isNull } from 'drizzle-orm';
import type { ListingView } from '../../../../src/browse/queries.js';
import { listLiveMembersByOpportunity } from '../../../../src/browse/queries.js';
import { db } from '../../../../src/db/client.js';
import { candidateProfiles } from '../../../../src/db/schema/index.js';
import {
  countRankedOpportunities,
  listRankedOpportunities,
} from '../../../../src/ranking/run-ranking.js';
import { StatusChip } from '../../../components/status-chip.js';
import { count, score as formatScore } from '../../../lib/format.js';
import { sourceLabel } from '../../../lib/labels.js';
import { componentLabel, type RankedRow, toRankedRow } from '../../../lib/ranked-row.js';
import { type RawSearchParams, ROW_CHUNK } from '../../../lib/search-params.js';
import { writesEnabled } from '../../../lib/writes.js';

/**
 * Ranked results — the feature the product exists for.
 *
 * The screen's job is the *why*, not the number. §17.2 chose a deterministic
 * scorer precisely so a rank could be explained, and a list of scores with no
 * visible reasoning throws that away: the reader cannot tell a good match from
 * a coincidence, and has no way to notice the profile is wrong rather than the
 * corpus. So every row carries what the scorer actually recorded — which
 * factor moved it, what matched, what was missing — and none of it is
 * recomputed here.
 *
 * Nothing on this screen is invented. The scores, the weights, the matched and
 * missing terms and the hard-filter sentences are all read from the ranking
 * row as stored; where a value is absent the screen says so rather than
 * filling it in.
 */

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Ranked · Xtelo' };

export default async function RankedPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const raw = await searchParams;
  const includeFiltered = one(raw.filtered) === '1';
  const show = parseShow(one(raw.show));

  // Profiles are listed from the database rather than assumed, so the screen
  // says "no profile" honestly instead of rendering an empty ranking.
  const profiles = await db
    .select({ id: candidateProfiles.id, label: candidateProfiles.label })
    .from(candidateProfiles)
    .where(and(isNull(candidateProfiles.deletedAt)))
    .orderBy(candidateProfiles.createdAt);

  const requested = one(raw.profile);
  const profile = profiles.find((entry) => entry.id === requested) ?? profiles[0];

  if (profile === undefined) return <NoProfile />;

  const total = await countRankedOpportunities(db, {
    profileId: profile.id,
    includeIneligible: includeFiltered,
  });
  const ranked = await listRankedOpportunities(db, {
    profileId: profile.id,
    includeIneligible: includeFiltered,
    limit: Math.min(show, ROW_CHUNK),
  });

  // Members come from a second query keyed by id rather than a join, for the
  // row-multiplication reason `listLiveMembersByOpportunity` documents.
  const members = await listLiveMembersByOpportunity(
    db,
    ranked.map((entry) => entry.opportunityId),
  );
  const rows = ranked.map((entry) =>
    toRankedRow(entry, members.get(entry.opportunityId) ?? ([] as ListingView[])),
  );

  const more = total - rows.length;

  return (
    <main className="w-full px-4 py-8 sm:px-6 sm:py-10">
      <header>
        <h1 className="text-xl font-semibold">Ranked</h1>
        <p className="mt-2 max-w-[var(--measure)] text-sm text-muted">
          Scored against <span className="text-foreground">{profile.label}</span> by a deterministic
          scorer, so every rank can be explained. Each row shows which factors moved it and what the
          listing asked for that the profile does not claim.
        </p>
      </header>

      <Controls
        profiles={profiles}
        activeProfileId={profile.id}
        includeFiltered={includeFiltered}
      />

      <p className="mt-4 text-sm text-faint">
        <span className="numeric">{count(total)}</span>
        {total === 1 ? ' result' : ' results'}
        {includeFiltered ? ', including the ones a hard filter excluded' : ''}
      </p>

      {rows.length === 0 ? (
        <EmptyState includeFiltered={includeFiltered} />
      ) : (
        <ol className="mt-3 flex flex-col">
          {rows.map((row, index) => (
            <Row
              key={row.opportunityId}
              row={row}
              rank={index + 1}
              profileId={profile.id}
              canDraft={writesEnabled()}
            />
          ))}
        </ol>
      )}

      <ShowMore
        shown={rows.length}
        more={more}
        includeFiltered={includeFiltered}
        show={show}
        profileId={profile.id}
      />
    </main>
  );
}

function one(value: string | string[] | undefined): string {
  if (value === undefined) return '';
  return (Array.isArray(value) ? (value[0] ?? '') : value).trim();
}

/**
 * Depth, clamped to the query layer's own maximum.
 *
 * Unlike the two list screens this does NOT grow without bound, and the reason
 * is the shape of the thing: a ranking is an ordered shortlist, and page 40 of
 * it is not a question anyone asks. The cap is the query layer's, so this
 * screen cannot quietly ask for more than the layer is willing to serve.
 */
function parseShow(raw: string): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1) return 25;
  return Math.min(parsed, ROW_CHUNK);
}

function Controls({
  profiles,
  activeProfileId,
  includeFiltered,
}: {
  profiles: readonly { id: string; label: string }[];
  activeProfileId: string;
  includeFiltered: boolean;
}) {
  return (
    <form method="get" action="/ranked" className="mt-4 flex flex-wrap items-end gap-3">
      {profiles.length > 1 && (
        <label className="flex min-w-0 flex-col gap-1 text-xs text-faint">
          Profile
          <select
            name="profile"
            defaultValue={activeProfileId}
            className="w-full max-w-64 rounded-[var(--radius)] border border-border bg-surface px-3 py-1.5 text-sm text-foreground"
          >
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {profiles.length === 1 && <input type="hidden" name="profile" value={activeProfileId} />}

      <label className="flex items-center gap-2 py-1.5 text-sm text-muted">
        <input
          type="checkbox"
          name="filtered"
          value="1"
          defaultChecked={includeFiltered}
          className="size-4 accent-[var(--color-accent-strong)]"
        />
        Include results a hard filter excluded
      </label>

      <button
        type="submit"
        className="rounded-[var(--radius)] border border-border-strong bg-surface-raised px-4 py-1.5 text-sm hover:bg-surface-active"
      >
        Apply
      </button>

      <a
        href="/profile"
        className="py-1.5 text-sm text-accent underline underline-offset-2 hover:text-foreground"
      >
        New profile
      </a>
    </form>
  );
}

/**
 * One result, and the case for it.
 *
 * A list rather than a table, which is a deliberate departure from the two
 * browse screens: those are scanned thirty rows at a time, while this one is
 * read a few rows at a time to decide whether a match is real. The reasoning
 * does not fit a table cell and would be reduced to a number if it had to.
 */
function Row({
  row,
  rank,
  profileId,
  canDraft,
}: {
  row: RankedRow;
  rank: number;
  profileId: string;
  canDraft: boolean;
}) {
  return (
    <li
      id={`rank-${rank}`}
      className="border-b border-border py-3 first:border-t first:border-border"
    >
      <div className="flex items-baseline gap-3">
        <span className="numeric w-8 shrink-0 text-right text-faint">{rank}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <a
              href={`/opportunities/${row.opportunityId}`}
              className="max-w-[var(--measure)] text-foreground underline decoration-border-strong underline-offset-2 hover:decoration-accent"
            >
              {row.title}
            </a>
            <Score row={row} />
          </div>

          <p className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-muted">
            <StatusChip status={row.status} />
            {row.employers.length > 0 && <span>{row.employers.join(' · ')}</span>}
            {row.sources.map((source) => (
              <a
                key={source.sourceSlug}
                href={source.url}
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

          {row.eligible ? <Why row={row} /> : <Excluded row={row} />}

          {canDraft && (
            <p className="mt-2 text-xs">
              <a
                href={`/drafts/new?profile=${profileId}&opportunity=${row.opportunityId}`}
                aria-label={`Draft application for ${row.title}`}
                className="text-accent underline underline-offset-2 hover:text-foreground"
              >
                Draft application
              </a>
            </p>
          )}
        </div>
      </div>
    </li>
  );
}

/**
 * The score, or an honest absence.
 *
 * A hard-filtered opportunity has `score: null` because §17.2 treats filtering
 * as a separate stage — there is no score to give, and printing 0 would assert
 * a bad match where the truth is "not evaluated".
 */
function Score({ row }: { row: RankedRow }) {
  if (row.score === null) {
    return <span className="text-xs text-status-held">excluded before scoring</span>;
  }
  return (
    <span className="numeric text-sm" title="Weighted total across every factor below, out of 1.00">
      {formatScore(row.score)}
    </span>
  );
}

/**
 * Why this result ranks where it does.
 *
 * Ordered by contribution — `score × weight` — rather than by raw score,
 * because that is what actually moved the rank. A factor scoring 1.00 at
 * weight 0.05 is nearly irrelevant, and leading with the raw number invites
 * exactly that misreading, so the contribution is what is shown and the raw
 * score sits beside it.
 */
function Why({ row }: { row: RankedRow }) {
  if (row.components.length === 0) {
    return (
      <p className="mt-1.5 text-xs text-faint">
        No breakdown was recorded for this result, so its score cannot be explained here.
      </p>
    );
  }

  return (
    <dl className="mt-1.5 grid grid-cols-[minmax(6rem,8rem)_1fr] gap-x-3 gap-y-1 text-xs">
      {row.components.map((component) => {
        const label = componentLabel(component.key);
        return (
          <div key={component.key} className="col-span-2 grid grid-cols-subgrid">
            <dt className="text-faint" title={label.explanation}>
              {label.short}{' '}
              <span className="numeric" title={`Weight ${component.weight}`}>
                {formatScore(component.contribution)}
              </span>
            </dt>
            <dd className="min-w-0">
              {component.matched.length > 0 && (
                <span className="text-muted">{component.matched.join(' · ')}</span>
              )}
              {component.missing.length > 0 && (
                <span className="text-status-unconfirmed">
                  {component.matched.length > 0 && ' · '}
                  missing: {component.missing.join(', ')}
                </span>
              )}
              {component.matched.length === 0 && component.missing.length === 0 && (
                <span className="text-faint">nothing to compare</span>
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

/** A hard filter's own sentence, not a paraphrase of it. */
function Excluded({ row }: { row: RankedRow }) {
  if (row.hardFilters.length === 0) {
    return (
      <p className="mt-1.5 text-xs text-status-held">
        Excluded before scoring, with no reason recorded.
      </p>
    );
  }
  return (
    <ul className="mt-1.5 flex flex-col gap-0.5 text-xs text-status-held">
      {row.hardFilters.map((filter) => (
        <li key={`${filter.filter}:${filter.detail}`}>
          {filter.detail === '' ? filter.filter : filter.detail}
        </li>
      ))}
    </ul>
  );
}

function NoProfile() {
  return (
    <main className="w-full px-4 py-8 sm:px-6 sm:py-10">
      <h1 className="text-xl font-semibold">Ranked</h1>
      <p className="mt-4 max-w-[var(--measure)] text-sm text-muted">
        There is no candidate profile to rank against yet.{' '}
        <a
          href="/profile"
          className="text-accent underline underline-offset-2 hover:text-foreground"
        >
          Upload a CV
        </a>{' '}
        to draft one — §17.1 asks for something the reader can correct before it is used, and the
        next screen is exactly that. A profile can also be built by hand with{' '}
        <span className="numeric">npm run rank -- profile create</span>.
      </p>
    </main>
  );
}

function EmptyState({ includeFiltered }: { includeFiltered: boolean }) {
  return (
    <div className="mt-3 max-w-[var(--measure)] rounded-[var(--radius)] border border-border bg-surface px-4 py-6 text-sm text-muted">
      <p>Nothing is ranked against this profile for the corpus as it stands.</p>
      {/* The specific, non-obvious cause, because it has already happened
          once: a dedupe pass rewrites canonical revisions, and rankings are
          pinned to the revision they scored. The stored rows are then real but
          no longer current, and the honest answer is to rank again — not to
          show a score computed against content that has changed. */}
      <p className="mt-2">
        Rankings are pinned to the opportunity revision they scored, so a dedupe pass since the last
        run leaves them behind. <span className="numeric">npm run rank -- rank</span> scores the
        corpus as it is now.
      </p>
      {!includeFiltered && (
        <p className="mt-2">
          Results excluded by a hard filter are hidden — tick the box above to see them and why.
        </p>
      )}
    </div>
  );
}

function ShowMore({
  shown,
  more,
  includeFiltered,
  show,
  profileId,
}: {
  shown: number;
  more: number;
  includeFiltered: boolean;
  show: number;
  /** Carried explicitly: the page falls back to profiles[0] without it. */
  profileId: string;
}) {
  if (more <= 0) return null;
  const next = Math.min(show + 25, ROW_CHUNK);
  // Already at the query layer's ceiling: say so rather than render a control
  // that would return the same rows.
  if (next <= show) {
    return (
      <p className="mt-6 max-w-[var(--measure)] text-sm text-faint">
        Showing the top <span className="numeric">{count(shown)}</span> of{' '}
        <span className="numeric">{count(shown + more)}</span>. A ranking is a shortlist, so it
        stops here rather than paging to the bottom of the corpus.
      </p>
    );
  }

  // The profile rides along. Without it the next request fell back to
  // profiles[0], so growing the list silently swapped which profile you were
  // looking at — a different ranking under the same heading.
  const params = new URLSearchParams({ show: String(next), profile: profileId });
  if (includeFiltered) params.set('filtered', '1');

  return (
    <div className="mt-6 flex flex-wrap items-baseline gap-x-4 gap-y-2 text-sm">
      <a
        className="rounded-[var(--radius)] border border-border-strong bg-surface-raised px-4 py-1.5 hover:bg-surface-active"
        href={`/ranked?${params}#rank-${shown + 1}`}
      >
        Show <span className="numeric">{count(Math.min(next - show, more))}</span> more
      </a>
      <p className="text-faint">
        <span className="numeric">{count(shown)}</span> of{' '}
        <span className="numeric">{count(shown + more)}</span> shown
      </p>
    </div>
  );
}
