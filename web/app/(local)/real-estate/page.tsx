import { db } from '../../../../src/db/client.js';
import {
  COUNT_CEILING,
  countRealEstate,
  type RealEstateLocations,
  type RealEstateRow,
  realEstateLocations,
  searchRealEstate,
} from '../../../../src/realestate/queries.js';
import { absoluteTime, count, relativeTime } from '../../../lib/format.js';
import {
  buildRealEstateHref,
  isFiltered,
  parseRealEstateQuery,
  REAL_ESTATE_CHUNK,
  REAL_ESTATE_MAX_SHOWN,
  type RealEstateQuery,
} from '../../../lib/real-estate-params.js';
import {
  type Currency,
  DEAL_LABELS,
  floorText,
  KIND_LABELS,
  listingLabel,
  money,
  perMetre,
  placeText,
  posterText,
  priceOf,
  streetText,
} from '../../../lib/real-estate-row.js';
import type { RawSearchParams } from '../../../lib/search-params.js';

/**
 * Homes for sale and rent, one row per listing as ss.ge shows it, each row a
 * link to the listing there. A domain of its own beside vacancies: nothing
 * here is merged, ranked or matched (concept §31).
 *
 * It reads the same on every surface, through the one database view that
 * holds active listings without their description. The description is
 * searched and never shown: the reader should go to the source for it.
 */

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Real estate · Xtelo' };

/** The most the query layer returns at once. */
const FETCH_CHUNK = 500;

export default async function RealEstatePage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const raw = await searchParams;
  const now = new Date().toISOString();

  const places = await realEstateLocations(db, {}, now);
  const query = parseRealEstateQuery(raw, places, Date.parse(now));

  const total = await countRealEstate(db, query.filters, now);
  const rows = await fetchRows(query, Math.min(query.show, total), now);
  const currency = query.filters.currency ?? 'usd';

  return (
    <main className="w-full px-4 py-8 sm:px-6 sm:py-10">
      <header>
        <h1 className="text-xl font-semibold">Real estate</h1>
        <p className="mt-2 max-w-[var(--measure)] text-sm text-muted">
          Flats, houses and summer cottages for sale and for rent, as{' '}
          <span translate="no">ss.ge</span> lists them. Each row opens the listing there, where its
          photos, description and contact are.
        </p>
      </header>

      <Filters query={query} places={places} />

      <p className="mt-4 text-sm text-faint" aria-live="polite">
        <span className="numeric">
          {total > COUNT_CEILING ? `${count(COUNT_CEILING)}+` : count(total)}
        </span>
        {total === 1 ? ' listing' : ' listings'}
      </p>

      {rows.length === 0 ? (
        <EmptyState filtered={isFiltered(query)} />
      ) : (
        <ResultsTable rows={rows} currency={currency} />
      )}

      <ShowMore query={query} shown={rows.length} total={total} />
    </main>
  );
}

/** Read in chunks, so the query layer keeps its own limit. Safe under OFFSET because every order ends in the id. */
async function fetchRows(
  query: RealEstateQuery,
  wanted: number,
  now: string,
): Promise<RealEstateRow[]> {
  const rows: RealEstateRow[] = [];
  for (let offset = 0; offset < wanted; offset += FETCH_CHUNK) {
    const batch = await searchRealEstate(
      db,
      { ...query.filters, limit: Math.min(FETCH_CHUNK, wanted - offset), offset },
      now,
    );
    rows.push(...batch);
    if (batch.length === 0) break;
  }
  return rows;
}

const CONTROL =
  'w-full rounded-[var(--radius)] border border-border bg-surface px-3 py-1.5 text-sm text-foreground placeholder:text-faint';
const FIELD = 'flex min-w-0 flex-col gap-1 text-xs text-faint';

const ROOM_LABELS: readonly (readonly [string, string])[] = [
  ['1', '1'],
  ['2', '2'],
  ['3', '3'],
  ['4', '4'],
  ['5+', '5 or more'],
];
const FLOOR_LABELS: readonly (readonly [string, string])[] = [
  ['not-first', 'not the first'],
  ['not-last', 'not the last'],
  ['middle', 'neither first nor last'],
];
const POSTER_LABELS: readonly (readonly [string, string])[] = [
  ['business', 'agency or developer'],
  ['other', 'not marked as a business'],
];
const UPDATED_LABELS: readonly (readonly [string, string])[] = [
  ['1', 'last 24 hours'],
  ['3', 'last 3 days'],
  ['7', 'last 7 days'],
  ['30', 'last 30 days'],
];
const SORT_LABELS: readonly (readonly [string, string])[] = [
  ['newest', 'newest first'],
  ['price-asc', 'price, lowest first'],
  ['price-desc', 'price, highest first'],
  ['ppm2-asc', 'price per m², lowest first'],
  ['area-desc', 'area, largest first'],
];

/**
 * A plain GET form: no JavaScript, and the address it produces is the one a
 * link would. The area list belongs to the chosen city, so it appears once a
 * city has been applied.
 */
function Filters({ query, places }: { query: RealEstateQuery; places: RealEstateLocations }) {
  const { form } = query;
  const inCity = places.subdistricts.filter((entry) => String(entry.cityRef) === form.city);
  const districts = new Map<number, string>();
  for (const entry of inCity) {
    if (entry.districtRef !== null && entry.districtName !== null) {
      districts.set(entry.districtRef, entry.districtName);
    }
  }
  const outsideDistricts = inCity.filter((entry) => entry.districtRef === null);

  return (
    <form
      method="get"
      action="/real-estate"
      className="mt-6 grid grid-cols-2 items-end gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-8"
    >
      <label className={`${FIELD} col-span-2`}>
        Search
        <input
          type="search"
          name="q"
          defaultValue={form.q}
          // No maxLength: it counts UTF-16 code units and would cut a Georgian
          // letter in half. The cap is applied server-side, by character.
          spellCheck={false}
          autoComplete="off"
          placeholder="street, district or a word from the listing…"
          className={CONTROL}
        />
      </label>

      <Select label="Deal" name="deal" value={form.deal} any="sale or rent">
        {Object.entries(DEAL_LABELS).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </Select>

      <Select label="Kind" name="kind" value={form.kind} any="any kind">
        {Object.entries(KIND_LABELS).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </Select>

      <Select label="City" name="city" value={form.city} any="anywhere in Georgia">
        {places.cities.map((city) => (
          <option key={city.ref} value={city.ref}>
            {city.name} ({count(city.count)})
          </option>
        ))}
      </Select>

      {inCity.length > 0 && (
        <Select label="Area" name="area" value={form.area} any="the whole city">
          {[...districts].map(([ref, name]) => (
            <optgroup key={ref} label={name}>
              <option value={`d${ref}`}>all of {name}</option>
              {inCity
                .filter((entry) => entry.districtRef === ref)
                .map((entry) => (
                  <option key={entry.ref} value={`s${entry.ref}`}>
                    {entry.name} ({count(entry.count)})
                  </option>
                ))}
            </optgroup>
          ))}
          {outsideDistricts.map((entry) => (
            <option key={entry.ref} value={`s${entry.ref}`}>
              {entry.name} ({count(entry.count)})
            </option>
          ))}
        </Select>
      )}

      <Select label="Rooms" name="rooms" value={form.rooms} any="any number">
        {ROOM_LABELS.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </Select>

      <Range
        label="Price"
        minName="pmin"
        maxName="pmax"
        min={form.pmin}
        max={form.pmax}
        className="col-span-2"
      >
        <select
          name="cur"
          defaultValue={form.cur}
          aria-label="Currency"
          className="shrink-0 rounded-[var(--radius)] border border-border bg-surface px-2 py-1.5 text-sm text-foreground"
        >
          <option value="usd">$</option>
          <option value="gel">₾</option>
        </select>
      </Range>

      <Range
        label="Area, m²"
        minName="amin"
        maxName="amax"
        min={form.amin}
        max={form.amax}
        className="col-span-2"
      />

      <Select label="Floor" name="floor" value={form.floor} any="any floor">
        {FLOOR_LABELS.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </Select>

      <Select label="Posted by" name="by" value={form.by} any="anyone">
        {POSTER_LABELS.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </Select>

      <Select label="Updated" name="since" value={form.since} any="any time">
        {UPDATED_LABELS.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </Select>

      <label className={FIELD}>
        Order
        <select name="sort" defaultValue={form.sort} className={CONTROL}>
          {SORT_LABELS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>

      <div className="col-span-2 flex items-baseline gap-4">
        <button
          type="submit"
          className="rounded-[var(--radius)] border border-border-strong bg-surface-raised px-4 py-1.5 text-sm hover:bg-surface-active"
        >
          Apply
        </button>
        <a className="py-1.5 text-sm text-accent underline underline-offset-2" href="/real-estate">
          Clear
        </a>
      </div>
    </form>
  );
}

function Select({
  label,
  name,
  value,
  any,
  children,
}: {
  label: string;
  name: string;
  value: string;
  /** What the empty choice is called. */
  any: string;
  children: React.ReactNode;
}) {
  return (
    <label className={FIELD}>
      {label}
      <select name={name} defaultValue={value} className={CONTROL}>
        <option value="">{any}</option>
        {children}
      </select>
    </label>
  );
}

function Range({
  label,
  minName,
  maxName,
  min,
  max,
  className,
  children,
}: {
  label: string;
  minName: string;
  maxName: string;
  min: string;
  max: string;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <fieldset className={`min-w-0 ${className ?? ''}`}>
      <legend className="mb-1 text-xs text-faint">{label}</legend>
      <div className="flex items-center gap-2">
        <input
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          name={minName}
          defaultValue={min}
          aria-label={`${label}, from`}
          placeholder="from"
          autoComplete="off"
          className={`${CONTROL} numeric min-w-0`}
        />
        <input
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          name={maxName}
          defaultValue={max}
          aria-label={`${label}, to`}
          placeholder="to"
          autoComplete="off"
          className={`${CONTROL} numeric min-w-0`}
        />
        {children}
      </div>
    </fieldset>
  );
}

function ResultsTable({ rows, currency }: { rows: RealEstateRow[]; currency: Currency }) {
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full table-fixed border-collapse text-sm leading-[var(--leading-body)]">
        <thead>
          <tr className="border-b border-border text-left text-xs text-faint">
            <Th className="w-[46%] sm:w-[30%] md:w-[20%] xl:w-[14%]">Listing</Th>
            <Th className="hidden text-right xl:table-cell xl:w-[6%]">Rooms</Th>
            <Th className="hidden text-right md:table-cell md:w-[10%] xl:w-[7%]">Area</Th>
            <Th className="hidden text-right xl:table-cell xl:w-[8%]">Floor</Th>
            <Th className="w-[30%] text-right sm:w-[18%] md:w-[14%] xl:w-[10%]">Price</Th>
            <Th className="hidden text-right md:table-cell md:w-[12%] xl:w-[8%]">Per m²</Th>
            <Th className="hidden pl-4 sm:table-cell sm:w-[32%] md:w-[26%] xl:w-[17%]">Location</Th>
            <Th className="hidden xl:table-cell xl:w-[12%]">Street</Th>
            <Th className="hidden xl:table-cell xl:w-[8%]">Posted by</Th>
            <Th className="w-[24%] sm:w-[20%] md:w-[18%] xl:w-[10%]">Updated</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <Row key={row.id} row={row} position={index + 1} currency={currency} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children, className, ...rest }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th scope="col" className={`py-1.5 pr-4 font-normal ${className ?? ''}`} {...rest}>
      {children}
    </th>
  );
}

function Row({
  row,
  position,
  currency,
}: {
  row: RealEstateRow;
  position: number;
  currency: Currency;
}) {
  const label = listingLabel(row);
  const price = priceOf(row, currency);
  const metre = perMetre(row, currency);
  const floor = floorText(row);
  const place = placeText(row);
  const street = streetText(row);
  const poster = posterText(row);

  return (
    <tr id={`row-${position}`} className="border-b border-border align-baseline hover:bg-surface">
      <td className="py-1.5 pr-4">
        {/* The listing on ss.ge is the only place a row leads: this screen
            keeps no page of its own for one, and the description, photos and
            contact are the source's to show. */}
        <a
          href={row.canonicalUrl}
          target="_blank"
          rel="noreferrer"
          aria-label={`${label}${place === null ? '' : `, ${place}`}, on ss.ge (opens in a new tab)`}
          className="block truncate text-foreground underline decoration-border-strong underline-offset-2 hover:decoration-accent"
        >
          {label}
        </a>
        <NarrowMeta row={row} floor={floor} place={place} street={street} />
      </td>

      <td className="numeric hidden py-1.5 pr-4 text-right xl:table-cell">{row.rooms}</td>

      <td className="hidden py-1.5 pr-4 text-right md:table-cell">
        {row.areaM2 === null ? null : (
          <>
            <span className="numeric">{count(Math.round(row.areaM2))}</span> m²
          </>
        )}
      </td>

      <td className="numeric hidden py-1.5 pr-4 text-right text-muted xl:table-cell">{floor}</td>

      <td className="numeric py-1.5 pr-4 text-right">
        {price === null ? null : money(price, currency)}
      </td>

      <td className="numeric hidden py-1.5 pr-4 text-right text-muted md:table-cell">
        {metre === null ? null : money(metre, currency)}
      </td>

      <td className="hidden py-1.5 pl-4 pr-4 text-muted sm:table-cell">
        {place === null ? null : (
          <span className="block truncate" title={place}>
            {place}
          </span>
        )}
      </td>

      <td className="hidden py-1.5 pr-4 text-muted xl:table-cell">
        {street === null ? null : (
          <span className="block truncate" title={street}>
            {street}
          </span>
        )}
      </td>

      <td className="hidden py-1.5 pr-4 text-muted xl:table-cell">{poster}</td>

      <td className="truncate py-1.5 pr-4 text-muted">
        <time dateTime={row.sourceUpdatedAt} title={absoluteTime(row.sourceUpdatedAt)}>
          {relativeTime(row.sourceUpdatedAt)}
        </time>
      </td>
    </tr>
  );
}

/** What the narrower widths drop from the columns, restated under the link where it is hidden. */
function NarrowMeta({
  row,
  floor,
  place,
  street,
}: {
  row: RealEstateRow;
  floor: string | null;
  place: string | null;
  street: string | null;
}) {
  const facts = [
    row.rooms === null ? null : row.rooms === 1 ? '1 room' : `${row.rooms} rooms`,
    row.areaM2 === null ? null : `${count(Math.round(row.areaM2))} m²`,
    floor === null ? null : floor.includes('floor') ? floor : `floor ${floor}`,
  ];
  // Area has its own column from `md`, the location from `sm`.
  const narrowest = [...facts, place].filter((fact) => fact !== null);
  const small = facts.filter((fact) => fact !== null);
  const medium = [facts[0], facts[2], street].filter((fact) => fact != null);

  return (
    <span className="mt-0.5 block text-xs text-faint xl:hidden">
      <span className="sm:hidden">{narrowest.join(' · ')}</span>
      <span className="hidden sm:inline md:hidden">{small.join(' · ')}</span>
      <span className="hidden md:inline">{medium.join(' · ')}</span>
    </span>
  );
}

/** Empty is a real answer: a filter can match nothing, and before the first crawl there is nothing. */
function EmptyState({ filtered }: { filtered: boolean }) {
  return (
    <div className="mt-3 max-w-[var(--measure)] rounded-[var(--radius)] border border-border bg-surface px-4 py-6 text-sm text-muted">
      {filtered ? (
        <p>
          No listing matches these filters.{' '}
          <a className="text-accent underline underline-offset-2" href="/real-estate">
            Clear them
          </a>{' '}
          to see everything.
        </p>
      ) : (
        <p>No listings have been collected yet.</p>
      )}
    </div>
  );
}

/** The same growing list as the other screens, up to the most one page will hold. */
function ShowMore({
  query,
  shown,
  total,
}: {
  query: RealEstateQuery;
  shown: number;
  total: number;
}) {
  const more = total - shown;
  if (more <= 0 || shown === 0) return null;
  const totalText = total > COUNT_CEILING ? `${count(COUNT_CEILING)}+` : count(total);

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
    <div className="mt-6 flex flex-wrap items-baseline gap-x-4 gap-y-2 text-sm">
      <a
        className="rounded-[var(--radius)] border border-border-strong bg-surface-raised px-4 py-1.5 hover:bg-surface-active"
        href={`${buildRealEstateHref(query, { show: next })}#row-${shown + 1}`}
      >
        Show <span className="numeric">{count(Math.min(REAL_ESTATE_CHUNK, more))}</span> more
      </a>
      <p className="text-faint">
        <span className="numeric">{count(shown)}</span> of{' '}
        <span className="numeric">{totalText}</span> shown
      </p>
    </div>
  );
}
