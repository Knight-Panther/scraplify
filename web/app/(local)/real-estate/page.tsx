import { db } from '../../../../src/db/client.js';
import {
  BUILDING_STATUSES,
  CONDITIONS,
  type DealType,
  FLOOR_TYPES,
  PROJECTS,
  type PropertyType,
} from '../../../../src/realestate/kinds.js';
import {
  COUNT_CEILING,
  countRealEstate,
  type DetailsCoverage,
  detailsCoverage,
  hasDetailFilter,
  type RealEstateLocations,
  type RealEstateRow,
  realEstateLocations,
  searchRealEstate,
} from '../../../../src/realestate/queries.js';
import { absoluteTime, count, relativeTime } from '../../../lib/format.js';
import {
  AMENITY_LABELS,
  amenitiesFor,
  BUILDING_STATUS_LABELS,
  CONDITION_LABELS,
  COUNT_CHOICES,
  type CountGroup,
  countLabel,
  FLOOR_TYPE_LABELS,
  GROUP_LABELS,
  LISTING_TYPE_LABELS,
  LISTING_TYPES,
  OTHER_INFO,
  PANELS,
  type PanelGroup,
  PROJECT_LABELS,
} from '../../../lib/real-estate-panels.js';
import {
  buildRealEstateHref,
  countValue,
  isFiltered,
  parseRealEstateQuery,
  REAL_ESTATE_CHUNK,
  REAL_ESTATE_MAX_SHOWN,
  type RealEstateForm,
  type RealEstateQuery,
} from '../../../lib/real-estate-params.js';
import {
  COMMERCIAL_TYPE_LABELS,
  type Currency,
  DEAL_LABELS,
  detailText,
  floorText,
  KIND_LABELS,
  LAND_TYPE_LABELS,
  listingLabel,
  money,
  perMetre,
  placeText,
  posterText,
  priceOf,
  priceUnit,
  streetText,
} from '../../../lib/real-estate-row.js';
import type { RawSearchParams } from '../../../lib/search-params.js';

/**
 * Property for sale, rent, daily rent and pledge, one row per listing as ss.ge shows it, each row a
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
  // A filter on a listing's own page sees only listings whose page was read: say how many.
  const coverage = hasDetailFilter(query.filters)
    ? await detailsCoverage(db, query.filters, now)
    : null;

  return (
    <main className="w-full px-4 py-8 sm:px-6 sm:py-10">
      <header>
        <h1 className="text-xl font-semibold">Real estate</h1>
        <p className="mt-2 max-w-[var(--measure)] text-sm text-muted">
          Flats, houses, summer cottages, commercial spaces, land and hotels, for sale, for rent, by
          the night and for pledge, as <span translate="no">ss.ge</span> lists them. Each row opens
          the listing there, where its photos, description and contact are. The same home posted
          more than once, by its owner and by agents, is one row; “Every listing” shows each copy.
        </p>
      </header>

      <Filters query={query} places={places} />

      {query.form.group === '' ? (
        <div className="mt-4 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 text-sm">
          <p className="text-faint" aria-live="polite">
            <span className="numeric">{upTo(total)}</span>
            {query.form.view === 'all'
              ? total === 1
                ? ' listing'
                : ' listings'
              : total === 1
                ? ' property'
                : ' properties'}
          </p>
          <ViewSwitch query={query} />
        </div>
      ) : (
        <GroupHeading query={query} total={total} />
      )}

      {coverage === null || coverage.total === 0 ? null : <Coverage coverage={coverage} />}

      {rows.length === 0 ? (
        <EmptyState filtered={isFiltered(query)} />
      ) : (
        <ResultsTable rows={rows} currency={currency} query={query} />
      )}

      <ShowMore query={query} shown={rows.length} total={total} />
    </main>
  );
}

/** A count as the page writes it: past the ceiling, "10,000+". */
function upTo(total: number): string {
  return total > COUNT_CEILING ? `${count(COUNT_CEILING)}+` : count(total);
}

/**
 * Under a filter on a listing's own page: how many of the listings matching
 * everything else had their page read, since only those can match it.
 */
function Coverage({ coverage }: { coverage: DetailsCoverage }) {
  return (
    <p className="mt-1 max-w-[var(--measure)] text-sm text-faint">
      Details read for <span className="numeric">{upTo(coverage.read)}</span> of{' '}
      <span className="numeric">{upTo(coverage.total)}</span> matching listings. Filters on details
      see only those.
    </p>
  );
}

/**
 * Folded or every listing: two links, since the state is in the address. The
 * current one is marked for assistive technology as well as by its look.
 */
function ViewSwitch({ query }: { query: RealEstateQuery }) {
  const options = [
    { view: '' as const, label: 'Look-alikes folded' },
    { view: 'all' as const, label: 'Every listing' },
  ];
  return (
    <nav
      aria-label="Look-alike listings"
      className="flex rounded-[var(--radius)] border border-border"
    >
      {options.map(({ view, label }) => {
        const current = query.form.view === view;
        return (
          <a
            key={label}
            href={buildRealEstateHref(query, { view })}
            aria-current={current ? 'page' : undefined}
            className={`px-3 py-1 first:rounded-l-[var(--radius)] last:rounded-r-[var(--radius)] ${
              current
                ? 'bg-surface-active text-foreground'
                : 'text-muted hover:bg-surface hover:text-foreground'
            }`}
          >
            {label}
          </a>
        );
      })}
    </nav>
  );
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

/** A whole row of the form's grid, at every width. */
const FULL_ROW = 'col-span-2 sm:col-span-3 md:col-span-4 xl:col-span-8';
/** Half a row on wide screens, where a short group of chips fits beside other fields. */
const HALF_ROW = 'col-span-2 sm:col-span-3 md:col-span-4 xl:col-span-4';
/** A compact select beside two number fields. */
const INLINE_SELECT =
  'shrink-0 rounded-[var(--radius)] border border-border bg-surface px-2 py-1.5 text-sm text-foreground';

/** Chip choices as `[value, label]`, in the order shown. */
type Options = readonly (readonly [string, string])[];

function pairs<T extends string>(
  values: readonly T[],
  labels: Readonly<Record<T, string>>,
): Options {
  return values.map((value) => [value, labels[value]] as const);
}

function countOptions(group: CountGroup): Options {
  return COUNT_CHOICES[group].map((n) => [countValue(group, n), countLabel(group, n)] as const);
}

/**
 * A plain GET form: no JavaScript, and the address it produces is the one a
 * link would. The area list belongs to the chosen city, so it appears once a
 * city has been applied; a kind's status, sub-types and "more filters" appear
 * once that kind has been applied, the way ss.ge swaps its panel.
 */
function Filters({ query, places }: { query: RealEstateQuery; places: RealEstateLocations }) {
  const { form } = query;
  const kind = form.kind === '' ? null : (form.kind as PropertyType);
  const panel: readonly PanelGroup[] = kind === null ? [] : PANELS[kind];
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
      {/* How the list is shown, and which group, outlast a change of filters. */}
      {form.view === '' ? null : <input type="hidden" name="view" value={form.view} />}
      {form.group === '' ? null : <input type="hidden" name="group" value={form.group} />}
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

      <Select label="Deal" name="deal" value={form.deal} any="any deal">
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

      {panel.includes('status') && (
        <Chips
          legend={GROUP_LABELS.status}
          name="st"
          options={pairs(Object.values(BUILDING_STATUSES), BUILDING_STATUS_LABELS)}
          checked={form.st}
          className={HALF_ROW}
        />
      )}
      {kind === 'commercial' && (
        <Chips
          legend="Space type"
          name="ct"
          options={Object.entries(COMMERCIAL_TYPE_LABELS)}
          checked={form.ct}
          className={FULL_ROW}
        />
      )}
      {kind === 'land' && (
        <Chips
          legend="Land type"
          name="lt"
          options={Object.entries(LAND_TYPE_LABELS)}
          checked={form.lt}
          className={FULL_ROW}
        />
      )}

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

      {/* With no kind, rooms still narrow; a kind without rooms (land, commercial) has none to pick. */}
      {(kind === null || panel.includes('rooms')) && (
        <Chips
          legend={GROUP_LABELS.rooms}
          name="rooms"
          options={countOptions('rooms')}
          checked={form.rooms}
          className={HALF_ROW}
        />
      )}

      <Range
        label="Price"
        minName="pmin"
        maxName="pmax"
        min={form.pmin}
        max={form.pmax}
        className="col-span-2"
      >
        <select name="cur" defaultValue={form.cur} aria-label="Currency" className={INLINE_SELECT}>
          <option value="usd">$</option>
          <option value="gel">₾</option>
        </select>
        <select
          name="pm2"
          defaultValue={form.pm2}
          aria-label="Price bounds are"
          className={INLINE_SELECT}
        >
          <option value="">total</option>
          <option value="1">per m²</option>
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

      {/* A flat's panel has a floor range, and this choice moves there beside it. */}
      {panel.includes('floor') ? null : (
        <Select label="Floor" name="floor" value={form.floor} any="any floor">
          <FloorOptions />
        </Select>
      )}

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

      {kind === null ? null : <MoreFilters kind={kind} form={form} />}

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

function FloorOptions() {
  return FLOOR_LABELS.map(([value, label]) => (
    <option key={value} value={value}>
      {label}
    </option>
  ));
}

/**
 * ss.ge's "more filters" for the applied kind, group for group and in its
 * order (`PANELS`). Status, rooms and area sit in the bar above, as on ss.ge.
 * Open whenever anything in it is chosen, so an applied filter is never
 * tucked away.
 */
function MoreFilters({ kind, form }: { kind: PropertyType; form: RealEstateForm }) {
  const groups = PANELS[kind];
  const deal = form.deal === '' ? undefined : (form.deal as DealType);
  const chosen =
    [form.hmin, form.hmax, form.ymin, form.ymax, form.kmin, form.kmax, form.fmin, form.fmax].filter(
      (bound) => bound !== '',
    ).length +
    (groups.includes('floor') && form.floor !== '' ? 1 : 0) +
    [form.cond, form.ftype, form.bal, form.bath, form.proj, form.ptype, form.am].reduce(
      (sum, list) => sum + list.length,
      0,
    );

  const group = (name: PanelGroup) => {
    const legend = GROUP_LABELS[name];
    switch (name) {
      case 'status':
      case 'rooms':
      case 'area':
        return null;
      case 'house-area':
        return <PanelRange key={name} label={`${legend}, m²`} name="h" form={form} />;
      case 'yard-area':
        return <PanelRange key={name} label={`${legend}, m²`} name="y" form={form} />;
      case 'kitchen-area':
        return <PanelRange key={name} label={`${legend}, m²`} name="k" form={form} />;
      case 'floor':
        return (
          <Range
            key={name}
            label={legend}
            minName="fmin"
            maxName="fmax"
            min={form.fmin}
            max={form.fmax}
            className="w-full sm:w-96"
          >
            <select
              name="floor"
              defaultValue={form.floor}
              aria-label="Which floor"
              className={INLINE_SELECT}
            >
              <option value="">any</option>
              <FloorOptions />
            </select>
          </Range>
        );
      case 'condition':
        return (
          <Chips
            key={name}
            legend={legend}
            name="cond"
            options={pairs(Object.values(CONDITIONS), CONDITION_LABELS)}
            checked={form.cond}
          />
        );
      case 'floor-type':
        return (
          <Chips
            key={name}
            legend={legend}
            name="ftype"
            options={pairs(Object.values(FLOOR_TYPES), FLOOR_TYPE_LABELS)}
            checked={form.ftype}
          />
        );
      case 'balconies':
        return (
          <Chips
            key={name}
            legend={legend}
            name="bal"
            options={countOptions('balconies')}
            checked={form.bal}
          />
        );
      case 'bathrooms':
        return (
          <Chips
            key={name}
            legend={legend}
            name="bath"
            options={countOptions('bathrooms')}
            checked={form.bath}
          />
        );
      case 'project':
        return (
          <Chips
            key={name}
            legend={legend}
            name="proj"
            options={pairs(Object.values(PROJECTS), PROJECT_LABELS)}
            checked={form.proj}
          />
        );
      case 'other-info':
        return (
          <Chips
            key={name}
            legend={legend}
            name="am"
            options={pairs(OTHER_INFO, AMENITY_LABELS)}
            checked={form.am}
          />
        );
      case 'listing-type':
        return (
          <Chips
            key={name}
            legend={legend}
            name="ptype"
            options={pairs(LISTING_TYPES, LISTING_TYPE_LABELS)}
            checked={form.ptype}
          />
        );
      case 'amenities':
        return (
          <Chips
            key={name}
            legend={legend}
            name="am"
            options={pairs(amenitiesFor(kind, deal), AMENITY_LABELS)}
            checked={form.am}
          />
        );
    }
  };

  return (
    <details open={chosen > 0} className={FULL_ROW}>
      <summary className="w-fit cursor-pointer rounded-[var(--radius)] border border-border bg-surface px-3 py-1.5 text-sm text-foreground hover:border-border-strong">
        More filters
        {chosen === 0 ? null : (
          <span className="text-faint">
            {' '}
            · <span className="numeric">{chosen}</span> chosen
          </span>
        )}
      </summary>
      <div className="mt-3 flex flex-wrap items-start gap-x-6 gap-y-4">{groups.map(group)}</div>
    </details>
  );
}

/** A from-to pair in the panel, its keys `<name>min` and `<name>max`. */
function PanelRange({
  label,
  name,
  form,
}: {
  label: string;
  name: 'h' | 'y' | 'k';
  form: RealEstateForm;
}) {
  return (
    <Range
      label={label}
      minName={`${name}min`}
      maxName={`${name}max`}
      min={form[`${name}min`]}
      max={form[`${name}max`]}
      className="w-full sm:w-64"
    />
  );
}

/**
 * Any number of choices at once, each a ticked box: none ticked narrows
 * nothing. Sub-types, status, rooms and every chip group of the panel.
 */
function Chips({
  legend,
  name,
  options,
  checked,
  className,
}: {
  legend: string;
  name: string;
  options: Options;
  checked: readonly string[];
  className?: string;
}) {
  return (
    <fieldset className={`min-w-0 ${className ?? ''}`}>
      <legend className="mb-1 text-xs text-faint">{legend}</legend>
      <div className="flex flex-wrap gap-1.5">
        {options.map(([value, label]) => (
          <label
            key={value}
            className="flex cursor-pointer items-center gap-1.5 rounded-[var(--radius)] border border-border bg-surface px-2 py-1.5 text-sm text-foreground hover:border-border-strong has-[:checked]:border-accent has-[:checked]:bg-surface-active has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[var(--color-ring)] has-[:focus-visible]:outline-solid"
          >
            <input
              type="checkbox"
              name={name}
              value={value}
              defaultChecked={checked.includes(value)}
              // The ring goes on the whole chip (above), not the box inside it;
              // important because the global focus rule in globals.css is unlayered.
              className="size-4 accent-[var(--color-accent-strong)] focus-visible:outline-none!"
            />
            {label}
          </label>
        ))}
      </div>
    </fieldset>
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

function ResultsTable({
  rows,
  currency,
  query,
}: {
  rows: RealEstateRow[];
  currency: Currency;
  query: RealEstateQuery;
}) {
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full table-fixed border-collapse text-sm leading-[var(--leading-body)]">
        <thead>
          <tr className="border-b border-border text-left text-xs text-faint">
            <Th className="w-[42%] sm:w-[30%] md:w-[20%] xl:w-[18%]">Listing</Th>
            <Th className="hidden text-right xl:table-cell xl:w-[6%]">Rooms</Th>
            <Th className="hidden text-right md:table-cell md:w-[10%] xl:w-[7%]">Area</Th>
            <Th className="hidden text-right xl:table-cell xl:w-[8%]">Floor</Th>
            <Th className="w-[27%] text-right sm:w-[18%] md:w-[14%] xl:w-[10%]">Price</Th>
            <Th className="hidden text-right md:table-cell md:w-[12%] xl:w-[8%]">Per m²</Th>
            <Th className="hidden pl-4 sm:table-cell sm:w-[32%] md:w-[26%] xl:w-[13%]">Location</Th>
            <Th className="hidden xl:table-cell xl:w-[12%]">Street</Th>
            <Th className="hidden xl:table-cell xl:w-[8%]">Posted by</Th>
            <Th className="w-[31%] sm:w-[20%] md:w-[18%] xl:w-[10%]">Updated</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <Row
              key={row.id}
              row={row}
              position={index + 1}
              currency={currency}
              groupHref={
                row.groupKey === null || row.alikeCount < 2
                  ? null
                  : buildRealEstateHref(query, { group: row.groupKey })
              }
            />
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
  groupHref,
}: {
  row: RealEstateRow;
  position: number;
  currency: Currency;
  /** Folded: the list of the group it stands for. */
  groupHref: string | null;
}) {
  const label = listingLabel(row);
  const price = priceOf(row, currency);
  const unit = priceUnit(row);
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
        {/* On the title's line, so a folded row is no taller than any other. */}
        <span className="flex min-w-0 items-baseline gap-2">
          <a
            href={row.canonicalUrl}
            target="_blank"
            rel="noreferrer"
            aria-label={`${label}${place === null ? '' : `, ${place}`}, on ss.ge (opens in a new tab)`}
            className="truncate text-foreground underline decoration-border-strong underline-offset-2 hover:decoration-accent"
          >
            {label}
          </a>
          {groupHref === null ? null : (
            <a
              href={groupHref}
              className="shrink-0 text-xs text-accent underline underline-offset-2"
              aria-label={`${row.alikeCount - 1} more ${row.alikeCount === 2 ? 'listing' : 'listings'} like this one`}
              title="The same home, posted again"
            >
              +<span className="numeric">{count(row.alikeCount - 1)}</span> alike
            </a>
          )}
        </span>
        <RowMeta row={row} floor={floor} place={place} street={street} />
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
        {/* Under the amount at every width, rather than wrapping wherever the column ends. */}
        {price === null || unit === null ? null : (
          <span className="block text-xs text-faint">{unit}</span>
        )}
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

/**
 * Under the link: what the narrower widths drop from the columns, and on a
 * line of its own at every width the condition and building status from the
 * listing's own page, which have no column. One line, so a known listing is
 * one line taller at most. Nothing at all when there is nothing to add.
 */
function RowMeta({
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
  const detail = detailText(row);
  // Area has its own column from `md`, the location from `sm`, the rest from `xl`.
  const narrowest = [...facts, place].filter((fact) => fact !== null);
  const small = facts.filter((fact) => fact !== null);
  const medium = [facts[0], facts[2], street].filter((fact) => fact != null);

  return (
    <span className={`mt-0.5 block text-xs text-faint ${detail === null ? 'xl:hidden' : ''}`}>
      <span className="block xl:hidden">
        <span className="sm:hidden">{narrowest.join(' · ')}</span>
        <span className="hidden sm:inline md:hidden">{small.join(' · ')}</span>
        <span className="hidden md:inline">{medium.join(' · ')}</span>
      </span>
      {detail === null ? null : (
        <span className="block truncate" title={detail}>
          {detail}
        </span>
      )}
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
  const totalText = upTo(total);

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
