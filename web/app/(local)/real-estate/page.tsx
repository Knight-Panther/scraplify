import { db } from '../../../../src/db/client.js';
import { placeLabels } from '../../../../src/realestate/place-suggest.js';
import {
  COUNT_CEILING,
  type Counted,
  countExactly,
  countRealEstate,
  type DetailsCoverage,
  detailsCoverage,
  hasDetailFilter,
  type RealEstateFilters,
  type RealEstateRow,
  searchRealEstate,
} from '../../../../src/realestate/queries.js';
import { AppliedFilters, ResultsTools } from '../../../components/real-estate/applied.js';
import { FilterBar } from '../../../components/real-estate/filter-bar.js';
import { Results } from '../../../components/real-estate/results.js';
import {
  PendingBar,
  PendingResults,
  type PlaceLabel,
  RealEstateShell,
} from '../../../components/real-estate/shell.js';
import { cachedByKey } from '../../../lib/cached.js';
import { count } from '../../../lib/format.js';
import { applicable, formHref, type RealEstateForm } from '../../../lib/real-estate-form.js';
import {
  buildRealEstateHref,
  countCacheKey,
  filtersOf,
  isFiltered,
  keepPlaces,
  parseRealEstateQuery,
  placeOf,
  REAL_ESTATE_CHUNK,
  REAL_ESTATE_MAX_SHOWN,
  type RealEstateQuery,
} from '../../../lib/real-estate-params.js';
import { chipFilters, FILTER, type FilterDef } from '../../../lib/real-estate-registry.js';
import type { Currency } from '../../../lib/real-estate-row.js';
import type { RawSearchParams } from '../../../lib/search-params.js';

/**
 * Property for sale, rent, daily rent and pledge, one row per listing as ss.ge
 * shows it, each row a link to the listing there. A domain of its own beside
 * vacancies: nothing here is merged, ranked or matched (concept §31).
 *
 * It reads the same on every surface, through the one database view that
 * holds active listings without their description. The description is
 * searched and never shown: the reader should go to the source for it.
 *
 * Phase 16B: the filters are the approved mockup's (the deal, the kind, one
 * Where box, the kind's main filters as pills, and "All filters"), drawn in
 * the browser; the address is still the whole state, and this page answers it.
 */

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Real estate · Xtelo' };

/** The most the query layer returns at once. */
const FETCH_CHUNK = 500;

/**
 * The count above the results, and the details line's, exact (2026-11-12;
 * they said "10,000+" before). An exact count of a broad filter takes up to
 * about a second on the host, so one above the ceiling is kept ten minutes
 * per filter set: the same for every visitor and changed only by the crawl.
 * One at or under the ceiling is asked every time, as before, so a short
 * list's count is never stale beside its rows. A count that outlasts its time
 * limit falls back to "10,000+" and is kept too, so a slow search pays once.
 */
const COUNT_TTL_MS = 10 * 60_000;
/** Filter sets held per surface process: bounded, since the filters come from visitors. */
const COUNT_KEYS = 500;
const counts = cachedByKey<Counted<number>>(
  COUNT_TTL_MS,
  COUNT_KEYS,
  (c) => c.value > COUNT_CEILING,
);
const coverages = cachedByKey<Counted<DetailsCoverage>>(
  COUNT_TTL_MS,
  COUNT_KEYS,
  (c) => c.value.total > COUNT_CEILING,
);

function countListings(filters: RealEstateFilters, now: string): Promise<Counted<number>> {
  return counts(countCacheKey(filters, COUNT_TTL_MS), () =>
    countExactly(
      db,
      (tx) => countRealEstate(tx, filters, now, null),
      () => countRealEstate(db, filters, now),
    ),
  );
}

function countCoverage(filters: RealEstateFilters, now: string): Promise<Counted<DetailsCoverage>> {
  return coverages(countCacheKey(filters, COUNT_TTL_MS), () =>
    countExactly(
      db,
      (tx) => detailsCoverage(tx, filters, now, null),
      () => detailsCoverage(db, filters, now),
    ),
  );
}

const LEVEL_WORD: Readonly<Record<string, string>> = {
  city: 'city',
  municipality: 'municipality',
  district: 'district',
  official_district: 'official',
  street: 'street',
};

export default async function RealEstatePage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const raw = await searchParams;
  const now = new Date().toISOString();
  const nowMs = Date.parse(now);

  // A place C6 does not know (a hand-made or stale address) is dropped, as any unknown value is.
  const asked = parseRealEstateQuery(raw, nowMs);
  const labels =
    asked.form.pl.length === 0 ? [] : await placeLabels(db, asked.form.pl.map(placeOf));
  const places: PlaceLabel[] = labels.map((label) => ({
    value: `${label.level}:${label.ref}`,
    nameKa: label.nameKa,
    nameEn: label.nameEn,
    kind: LEVEL_WORD[label.level] ?? '',
  }));
  const query = keepPlaces(asked, new Set(places.map((place) => place.value)), nowMs);

  // The count, the rows and the details coverage do not wait for one another.
  const [counted, rows, coverage] = await Promise.all([
    countListings(query.filters, now),
    fetchRows(query, query.show, now),
    // A filter on a listing's own page sees only listings whose page was read: say how many.
    hasDetailFilter(query.filters) ? countCoverage(query.filters, now) : null,
  ]);
  const total = counted.value;
  const currency = (query.filters.currency ?? 'usd') as Currency;
  const shownCoverage = coverage === null || coverage.value.total === 0 ? null : coverage.value;
  const drops = rows.length === 0 && isFiltered(query) ? await withoutOne(query.form, now) : [];

  return (
    <main className="mx-auto w-full max-w-[1440px] [&_a]:scroll-mt-40 [&_button]:scroll-mt-40 px-4 pt-4 pb-20 min-[900px]:pt-[22px]">
      <h1 className="m-0 text-[22px] font-semibold">Real estate</h1>
      <p className="mt-1 hidden max-w-[70ch] text-sm text-faint min-[900px]:block">
        Flats, houses, cottages, commercial spaces, land and hotels, as{' '}
        <span translate="no">ss.ge</span> lists them. Each row opens the listing there. The same
        home posted more than once, by its owner and by agents, is one row.
      </p>

      <RealEstateShell
        form={query.form}
        total={counted.exact ? total : Math.min(total, COUNT_CEILING)}
        exact={counted.exact || total <= COUNT_CEILING}
        places={places}
        coverage={shownCoverage}
      >
        <FilterBar />
        <AppliedFilters />

        {query.form.group === '' ? (
          <div className="mt-3.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5 max-[480px]:flex-nowrap">
            <p className="m-0 text-[15px] text-faint" aria-live="polite">
              <b className="numeric text-[17px] font-bold text-foreground">{upTo(counted)}</b>{' '}
              {query.form.view === 'all'
                ? total === 1
                  ? 'listing'
                  : 'listings'
                : total === 1
                  ? 'property'
                  : 'properties'}
              {shownCoverage === null ? null : (
                <span className="ml-2 text-[13px]">
                  · details read for{' '}
                  <span className="numeric">
                    {upTo({ value: shownCoverage.read, exact: coverage?.exact ?? true })}
                  </span>{' '}
                  of{' '}
                  <span className="numeric">
                    {upTo({ value: shownCoverage.total, exact: coverage?.exact ?? true })}
                  </span>
                </span>
              )}
            </p>
            <ResultsTools />
          </div>
        ) : (
          <GroupHeading query={query} total={total} />
        )}

        <PendingBar />
        <PendingResults>
          {rows.length === 0 ? (
            <EmptyState filtered={isFiltered(query)} drops={drops} />
          ) : (
            <Results
              rows={rows}
              currency={currency}
              stations={query.form.ms}
              groupHref={(row) =>
                query.form.view === 'all' || row.groupKey === null || row.alikeCount < 2
                  ? null
                  : buildRealEstateHref(query, { group: row.groupKey })
              }
            />
          )}
          <ShowMore query={query} shown={rows.length} counted={counted} />
        </PendingResults>
      </RealEstateShell>
    </main>
  );
}

/** A count as the page writes it: exact, or "10,000+" when counting took too long. */
function upTo({ value, exact }: Counted<number>): string {
  return !exact && value > COUNT_CEILING ? `${count(COUNT_CEILING)}+` : count(value);
}

/** One look-alike group's own list: what it is, and the way back. */
function GroupHeading({ query, total }: { query: RealEstateQuery; total: number }) {
  return (
    <div className="mt-4 max-w-[var(--measure)] text-sm">
      <p className="text-muted" aria-live="polite">
        These <span className="numeric">{count(total)}</span> listings look like the same home: the
        same street, rooms, floor and building, an area within 0.6 m² and a price within 3%. Each
        opens its own page on <span translate="no">ss.ge</span>.
      </p>
      <a
        className="mt-2 inline-block text-accent underline underline-offset-2"
        href={buildRealEstateHref(query, { group: '' })}
      >
        Back to the list
      </a>
    </div>
  );
}

/**
 * Read in chunks, so the query layer keeps its own limit. Safe under OFFSET
 * because every order ends in the id. A short chunk is the last one, so it
 * needs no count first.
 */
async function fetchRows(
  query: RealEstateQuery,
  wanted: number,
  now: string,
): Promise<RealEstateRow[]> {
  const rows: RealEstateRow[] = [];
  for (let offset = 0; offset < wanted; offset += FETCH_CHUNK) {
    const limit = Math.min(FETCH_CHUNK, wanted - offset);
    const batch = await searchRealEstate(db, { ...query.filters, limit, offset }, now);
    rows.push(...batch);
    if (batch.length < limit) break;
  }
  return rows;
}

interface Drop {
  label: string;
  href: string;
  count: number;
}

/**
 * For an empty list: what dropping each filter in force would show, the
 * largest first, up to four (the mockup's empty state). Counted no further
 * than one past the ceiling, which is quick, since only an empty list asks.
 */
async function withoutOne(form: RealEstateForm, now: string): Promise<Drop[]> {
  const candidates: FilterDef[] = [
    ...chipFilters(form),
    ...(FILTER.where.active(form) ? [FILTER.where] : []),
    ...(FILTER.kind.active(form) ? [FILTER.kind] : []),
  ];
  const nowMs = Date.parse(now);
  const drops = await Promise.all(
    candidates.slice(0, 8).map(async (filter) => {
      const next = applicable(filter.clear(form));
      const n = await countRealEstate(db, filtersOf(next, nowMs), now);
      const label =
        filter.key === 'where'
          ? 'the places'
          : filter.key === 'kind'
            ? (FILTER.kind.summary(form, { placeNames: new Map() }) || 'the kind').toLowerCase()
            : (filter.short ?? filter.title(form)).toLowerCase();
      return { label, href: formHref(next), count: n };
    }),
  );
  return drops
    .filter((drop) => drop.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 4);
}

/** Empty is a real answer: a filter can match nothing, and before the first crawl there is nothing. */
function EmptyState({ filtered, drops }: { filtered: boolean; drops: Drop[] }) {
  if (!filtered) {
    return (
      <div className="mt-[22px] max-w-[70ch] rounded-2xl border border-dashed border-border-hover p-5 text-sm text-faint">
        No listings have been collected yet.
      </div>
    );
  }
  return (
    <div className="mt-[22px] max-w-[70ch] rounded-2xl border border-dashed border-border-hover p-5">
      <h2 className="m-0 mb-1 text-base font-semibold">No property matches all of these.</h2>
      <p className="m-0 mb-3 text-sm text-faint">
        {drops.length > 0 ? 'Dropping one filter would show:' : 'Try another deal or kind.'}
      </p>
      {drops.length === 0 ? null : (
        <div className="flex flex-wrap gap-1.5">
          {drops.map((drop) => (
            <a
              key={drop.href}
              href={drop.href}
              className="inline-flex items-center gap-2 rounded-[var(--radius)] border border-border-strong bg-surface px-3.5 py-[7px] text-sm whitespace-nowrap hover:border-border-hover"
            >
              Without {drop.label}
              <span className="numeric text-xs text-faint">
                {drop.count > COUNT_CEILING ? `${count(COUNT_CEILING)}+` : count(drop.count)}
              </span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

/** The same growing list as the other screens, up to the most one page will hold. */
function ShowMore({
  query,
  shown,
  counted,
}: {
  query: RealEstateQuery;
  shown: number;
  counted: Counted<number>;
}) {
  const more = counted.value - shown;
  if (more <= 0 || shown === 0) return null;
  const totalText = upTo(counted);

  if (shown >= REAL_ESTATE_MAX_SHOWN) {
    return (
      <p className="mt-6 max-w-[var(--measure)] text-sm text-faint">
        <span className="numeric">{count(shown)}</span> of{' '}
        <span className="numeric">{totalText}</span> shown, which is as many as one page holds.
        Narrow the filters to reach the rest.
      </p>
    );
  }

  const next = Math.min(query.show + REAL_ESTATE_CHUNK, REAL_ESTATE_MAX_SHOWN);
  return (
    <div className="mt-4 flex flex-wrap items-baseline gap-x-4 gap-y-2 text-sm">
      <a
        className="inline-flex items-center rounded-[var(--radius)] border border-border-strong bg-surface px-3.5 py-[7px] hover:border-border-hover"
        href={`${buildRealEstateHref(query, { show: next })}#row-${shown + 1}`}
      >
        Show <span className="numeric mx-1">{count(Math.min(REAL_ESTATE_CHUNK, more))}</span> more
      </a>
      <p className="text-faint">
        <span className="numeric">{count(shown)}</span> of{' '}
        <span className="numeric">{totalText}</span> shown
      </p>
    </div>
  );
}
