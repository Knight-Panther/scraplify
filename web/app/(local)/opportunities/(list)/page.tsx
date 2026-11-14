import { browseView } from '../../../../../src/browse/browse-engine.js';
import {
  type BrowseForm,
  clearFilter,
  formHref,
  formSearch,
} from '../../../../../src/browse/browse-form.js';
import { publicLastSeen, publicSourceOverview } from '../../../../../src/browse/public-queries.js';
import { getSourceHealth } from '../../../../../src/browse/queries.js';
import { suggestSearch } from '../../../../../src/browse/search-terms.js';
import { db } from '../../../../../src/db/client.js';
import { decisionsByOpportunity } from '../../../../../src/shortlist/decisions.js';
import { AppliedFilters, CountLine } from '../../../../components/browse/applied.js';
import { FilterBar } from '../../../../components/browse/filter-bar.js';
import { Results } from '../../../../components/browse/results.js';
import { BrowseShell, PendingBar, PendingResults } from '../../../../components/browse/shell.js';
import { browseData, isFiltered } from '../../../../lib/browse-data.js';
import { browseItems } from '../../../../lib/browse-index-cache.js';
import { parseBrowseQuery } from '../../../../lib/browse-params.js';
import { fmt, kindWord, titleOf } from '../../../../lib/browse-registry.js';
import { relativeTime } from '../../../../lib/format.js';
import { sourceLabel } from '../../../../lib/labels.js';
import type { RawSearchParams } from '../../../../lib/search-params.js';
import { currentSurface } from '../../../../lib/surface.js';
import { lastCompletedSync } from '../../../../lib/sync.js';

/**
 * Browse v2 (Phase 16C, the approved mockup): vacancies, tenders and courses,
 * one row per opportunity with every board that carries it.
 *
 * It lives in a `(list)` route group so its `loading.tsx` does not wrap the
 * detail page (`opportunities/[id]`).
 *
 * The address is the whole state. The filter bar runs in the browser and
 * asks for the next address on each change; this page answers it from the
 * in-memory index (`src/browse/browse-index.ts`, rebuilt each minute): the
 * rows, and every count the bar shows. A filter on a fact only some listings
 * state says how many it leaves out, and from which board, and can keep them.
 */

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Browse · Xtelo' };

export default async function OpportunitiesPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const raw = await searchParams;
  const surface = currentSurface() === 'public' ? 'public' : 'local';
  const form = parseBrowseQuery(raw, surface);
  const nowMs = Date.now();

  // The eyebrow's freshness. Public: the newest confirmation the public role
  // can see ("last confirmed"); local: a real full-coverage crawl ("synced").
  const [items, freshness] = await Promise.all([
    browseItems(surface),
    surface === 'public'
      ? publicSourceOverview(db).then((overview) => ({
          slugs: overview.map((s) => s.sourceSlug),
          at: publicLastSeen(overview),
          word: 'last confirmed',
        }))
      : getSourceHealth(db).then((health) => ({
          slugs: health.map((s) => s.sourceSlug),
          at: lastCompletedSync(health),
          word: 'synced',
        })),
  ]);

  const view = browseView(items, form, { nowMs, surface });
  const rows = view.rows.slice(0, form.show);
  const orgKinds: Record<string, string> = {};
  for (const org of form.org) {
    const item = items.find((i) => i.orgs.includes(org));
    if (item?.kind) orgKinds[org] = item.kind;
  }
  const data = browseData(view, surface, orgKinds);
  const decisions =
    surface === 'public'
      ? new Map<string, { decision: 'saved' | 'dismissed'; note: string | null }>()
      : await decisionsByOpportunity(
          db,
          rows.map((row) => row.id),
        );
  const unstated = new Set(view.unstated);
  const firstUnstated = rows.findIndex((row) => unstated.has(row.id));

  // A search that finds nothing may be one misspelt word away from one that does.
  const corrected = view.total === 0 && form.q !== '' ? suggestSearch(form.q) : null;
  const suggestion =
    corrected === null
      ? null
      : (() => {
          const fixed: BrowseForm = { ...form, q: corrected };
          return browseView(items, fixed, { nowMs, surface }).total > 0
            ? { text: corrected, href: formHref(fixed) }
            : null;
        })();

  return (
    <main className="mx-auto w-full max-w-[1440px] px-4 pt-4 pb-20 min-[900px]:pt-[22px] [&_a]:scroll-mt-40 [&_button]:scroll-mt-40">
      <p className="numeric m-0 mb-0.5 text-xs text-faint">
        <i
          aria-hidden="true"
          className="mr-1.5 inline-block size-[7px] rounded-full bg-accent-line align-[1px]"
        />
        <span translate="no">{freshness.slugs.map(sourceLabel).join(' · ')}</span>
        {freshness.at === undefined ? null : (
          <>
            {' '}
            · {freshness.word} {relativeTime(freshness.at)}
          </>
        )}
      </p>
      <h1 className="m-0 text-[22px] font-semibold">Browse</h1>
      <p className="mt-1 mb-0 hidden max-w-[74ch] text-sm text-faint min-[900px]:block">
        Vacancies, tenders and courses, one row per opportunity, with every board that carries it.
      </p>

      <BrowseShell form={form} data={data}>
        <FilterBar />
        <AppliedFilters />
        <CountLine />
        <PendingBar />
        <PendingResults>
          {rows.length === 0 ? (
            <Empty
              form={form}
              drops={view.drops}
              suggestion={suggestion}
              filtered={isFiltered(form)}
            />
          ) : (
            <>
              <Results
                rows={rows}
                firstUnstated={firstUnstated}
                unstatedCount={view.unstated.length}
                kind={form.kind}
                back={formSearch(form)}
                nowMs={nowMs}
                surface={surface}
                decisions={decisions}
              />
              <ShowMore form={form} shown={rows.length} total={view.rows.length} />
            </>
          )}
        </PendingResults>
      </BrowseShell>
    </main>
  );
}

/** Nothing matches: which filter to drop, with what each drop would show. */
function Empty({
  form,
  drops,
  suggestion,
  filtered,
}: {
  form: BrowseForm;
  drops: ReturnType<typeof browseView>['drops'];
  suggestion: { text: string; href: string } | null;
  filtered: boolean;
}) {
  if (!filtered) {
    return (
      <p className="mt-[22px] max-w-[70ch] rounded-2xl border border-dashed border-border-hover p-5 text-sm text-muted">
        There is nothing of this kind open right now. Rows appear once a crawl has run and listings
        have been grouped.
      </p>
    );
  }
  return (
    <div className="mt-[22px] max-w-[70ch] rounded-2xl border border-dashed border-border-hover p-5">
      <h2 className="m-0 mb-1 text-base font-semibold">Nothing matches all of these.</h2>
      {suggestion === null ? null : (
        <p className="m-0 mb-3 text-sm text-faint">
          Did you mean{' '}
          <a className="text-accent underline underline-offset-2" href={suggestion.href}>
            {suggestion.text}
          </a>
          ?
        </p>
      )}
      <p className="m-0 mb-3 text-sm text-faint">
        {drops.length > 0 ? 'Dropping one filter would show:' : 'Try another kind.'}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {drops.map((drop) => (
          <a
            key={drop.key}
            href={formHref(clearFilter(form, drop.key))}
            className="inline-flex items-center gap-2 rounded-[var(--radius)] border border-border-strong bg-surface px-3.5 py-[7px] text-sm whitespace-nowrap no-underline hover:border-border-hover"
          >
            Without{' '}
            {drop.key === 'q'
              ? 'the search'
              : drop.key === 'org'
                ? 'the organisation'
                : titleOf(drop.key, form.kind).toLowerCase()}
            <span className="numeric text-xs text-faint">{fmt(drop.n)}</span>
          </a>
        ))}
      </div>
    </div>
  );
}

/** The bottom of the list: what is shown, what is not, and a link to more. */
function ShowMore({ form, shown, total }: { form: BrowseForm; shown: number; total: number }) {
  const more = total - shown;
  if (more <= 0) return null;
  const next = form.show + Math.min(40, more);
  return (
    <div className="mt-4 flex flex-wrap items-baseline gap-x-4 gap-y-2 text-sm">
      <a
        className="inline-flex items-center rounded-[var(--radius)] border border-border-strong bg-surface px-3.5 py-[7px] no-underline hover:border-border-hover"
        href={`${formHref({ ...form, show: next })}#row-${shown + 1}`}
      >
        Show <span className="numeric mx-1">{fmt(Math.min(40, more))}</span> more
      </a>
      <p className="m-0 text-faint">
        <span className="numeric">{fmt(shown)}</span> of{' '}
        <span className="numeric">{fmt(total)}</span> {kindWord(form.kind, total)} shown
      </p>
    </div>
  );
}
