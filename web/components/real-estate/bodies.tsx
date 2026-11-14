'use client';

import { useId, useState } from 'react';
import type { FacetResult } from '../../../src/realestate/facets.js';
import {
  METRO_LINES,
  METRO_MINUTE_OPTIONS,
  METRO_STATIONS,
  type RealEstateForm,
} from '../../lib/real-estate-form.js';
import {
  areaPresets,
  DEAL_NAMES,
  FILTER,
  type FilterKey,
  FLOOR_RULE_LABELS,
  fmt,
  KIND_NAMES,
  KITCHEN_PRESETS,
  optionsOf,
  pricePresets,
  priceText,
  rangeText,
  YARD_PRESETS,
} from '../../lib/real-estate-registry.js';
import { Icon, type IconName } from './icons.js';
import { Chip, DualSlider, NumberField, Note, nice, Seg } from '../filter-ui.js';
import { useShell } from './shell.js';

/*
 * The insides of each filter, the same in a popover, a bottom sheet and the
 * "All filters" sheet: every change goes straight to the address (the
 * mockup's "Changes apply at once").
 */

type Facets = Partial<Record<string, FacetResult | null>>;

export { Note, Seg };

export function DealSeg({ stretch = false }: { stretch?: boolean }) {
  const { form, update } = useShell();
  const deals = (['sale', 'rent', 'daily', 'pledge', 'all'] as const).map(
    (deal) => [deal, DEAL_NAMES[deal] ?? deal] as const,
  );
  return (
    <Seg
      label="Deal"
      options={deals}
      value={form.deal as (typeof deals)[number][0]}
      big
      stretch={stretch}
      // A price means something else under another deal, so the bounds go with it.
      onChange={(deal) => update({ ...form, deal, pmin: '', pmax: '' })}
    />
  );
}

const KIND_ICONS: Readonly<Record<string, IconName>> = {
  '': 'any',
  flat: 'flat',
  house: 'house',
  cottage: 'cottage',
  commercial: 'commercial',
  land: 'land',
  hotel: 'hotel',
};

export function KindChips({ facets, onPicked }: { facets: Facets; onPicked?: () => void }) {
  const { form, update } = useShell();
  const name = useId();
  const counts = facets.kind?.type === 'counts' ? facets.kind.counts : null;
  const total = counts === null ? null : Object.values(counts).reduce((sum, n) => sum + n, 0);
  const kinds = [['', 'Any kind'], ...Object.entries(KIND_NAMES)] as const;
  return (
    <div role="radiogroup" aria-label="Kind" className="flex flex-wrap gap-1.5">
      {kinds.map(([kind, label]) => (
        <Chip
          key={kind}
          type="radio"
          name={name}
          checked={form.kind === kind}
          onChange={() => {
            update({ ...form, kind });
            onPicked?.();
          }}
          label={label}
          icon={<Icon name={KIND_ICONS[kind] ?? 'any'} className="size-4 self-center" />}
          count={kind === '' ? total : counts === null ? null : (counts[kind] ?? 0)}
        />
      ))}
    </div>
  );
}

/** A list filter's chips, each with what picking it would show. */
export function OptionChips({
  filterKey,
  facets,
  fold,
}: {
  filterKey: FilterKey;
  facets: Facets;
  /** Show this many until "Show all"; the chosen ones always show. */
  fold?: number | undefined;
}) {
  const { form, update } = useShell();
  const name = useId();
  const [open, setOpen] = useState(false);
  const options = optionsOf(filterKey, form);
  // Only list filters come here; every one has its field.
  const field: keyof RealEstateForm = FIELD_OF[filterKey] ?? 'am';
  const single = filterKey === 'by' || filterKey === 'since';
  const chosen: readonly string[] = single ? [form[field] as string] : (form[field] as string[]);
  const facet = FACET_OF[filterKey];
  const counts = facet === undefined ? undefined : facets[facet];
  const countFor = (value: string): number | null | undefined => {
    if (facet === undefined) return undefined;
    if (counts === undefined || counts === null || counts.type !== 'counts') return null;
    return counts.counts[value] ?? 0;
  };
  const toggle = (value: string) => {
    if (single) {
      update({ ...form, [field]: value });
      return;
    }
    const list = chosen.filter((item) => item !== value);
    update({ ...form, [field]: chosen.includes(value) ? list : [...list, value] });
  };
  const folded = fold !== undefined && options.length > fold && !open;
  const all = filterKey === 'am' || filterKey === 'other' || filterKey === 'ptype';
  return (
    <div>
      {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: the role is set, a radiogroup or a group */}
      <div
        role={single ? 'radiogroup' : 'group'}
        aria-label={FILTER[filterKey].title(form)}
        className={filterKey === 'rooms' ? 'grid grid-cols-5 gap-1.5' : 'flex flex-wrap gap-1.5'}
      >
        {options.map(([value, label], index) =>
          folded && index >= (fold ?? 0) && !chosen.includes(value) ? null : (
            <Chip
              key={value}
              type={single ? 'radio' : 'checkbox'}
              name={name}
              checked={chosen.includes(value)}
              onChange={() => toggle(value)}
              label={label}
              count={countFor(value)}
              className={filterKey === 'rooms' ? 'flex' : ''}
            />
          ),
        )}
      </div>
      {fold !== undefined && options.length > fold ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="mt-2 px-0.5 py-1 text-sm underline decoration-border-hover underline-offset-[3px] hover:decoration-foreground"
        >
          {open ? 'Show fewer' : `Show all ${options.length}`}
        </button>
      ) : null}
      {all ? <Note>A listing must have every one ticked.</Note> : null}
    </div>
  );
}

const FIELD_OF: Readonly<Partial<Record<FilterKey, keyof RealEstateForm>>> = {
  ctype: 'ct',
  ltype: 'lt',
  rooms: 'rooms',
  bath: 'bath',
  bal: 'bal',
  ftype: 'ftype',
  status: 'st',
  cond: 'cond',
  proj: 'proj',
  am: 'am',
  other: 'am',
  ptype: 'ptype',
  by: 'by',
  since: 'since',
};

/** The facet that counts each list filter's options. */
export const FACET_OF: Readonly<Partial<Record<FilterKey, string>>> = {
  kind: 'kind',
  ctype: 'commercialType',
  ltype: 'landType',
  rooms: 'rooms',
  bath: 'bathrooms',
  bal: 'balconies',
  ftype: 'floorType',
  status: 'buildingStatus',
  cond: 'condition',
  proj: 'project',
  am: 'amenities',
  other: 'amenities',
  ptype: 'listingType',
};

const cap = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** From and to, and a row of quick ranges. */
export function RangeFields({
  min,
  max,
  unit,
  presets,
  label,
}: {
  min: keyof RealEstateForm;
  max: keyof RealEstateForm;
  unit: string;
  presets: readonly (readonly [string, string])[];
  label: string;
}) {
  const { form, update } = useShell();
  const name = useId();
  const low = form[min] as string;
  const high = form[max] as string;
  return (
    <div>
      <div className="grid grid-cols-2 gap-2">
        <NumberField
          label={`From${unit === '' ? '' : `,${unit}`}`}
          placeholder="from"
          value={low}
          onChange={(value) => update({ ...form, [min]: value }, { debounce: true })}
        />
        <NumberField
          label={`To${unit === '' ? '' : `,${unit}`}`}
          placeholder="to"
          value={high}
          onChange={(value) => update({ ...form, [max]: value }, { debounce: true })}
        />
      </div>
      {presets.length === 0 ? null : (
        <fieldset aria-label={`${label} ranges`} className="mt-2.5 flex min-w-0 flex-wrap gap-1.5">
          {presets.map(([from, to]) => {
            const on = low === from && high === to;
            return (
              <Chip
                key={`${from}-${to}`}
                type="radio"
                name={name}
                checked={on}
                onChange={() => update({ ...form, [min]: from, [max]: to })}
                label={cap(rangeText(from, to, unit))}
              />
            );
          })}
        </fieldset>
      )}
    </div>
  );
}

export function AreaBody() {
  const { form } = useShell();
  return (
    <RangeFields
      min="amin"
      max="amax"
      unit=" m²"
      presets={areaPresets(form)}
      label={FILTER.area.title(form)}
    />
  );
}

export function YardBody() {
  return <RangeFields min="ymin" max="ymax" unit=" m²" presets={YARD_PRESETS} label="Yard area" />;
}

export function KitchenBody() {
  return (
    <RangeFields min="kmin" max="kmax" unit=" m²" presets={KITCHEN_PRESETS} label="Kitchen area" />
  );
}

export function FloorBody() {
  const { form, update } = useShell();
  const name = useId();
  const rules = [['', 'Any floor'], ...Object.entries(FLOOR_RULE_LABELS)] as const;
  return (
    <div>
      <div role="radiogroup" aria-label="Which floor" className="flex flex-wrap gap-1.5">
        {rules.map(([rule, label]) => (
          <Chip
            key={rule}
            type="radio"
            name={name}
            checked={form.floor === rule}
            onChange={() => update({ ...form, floor: rule })}
            label={label}
          />
        ))}
      </div>
      <div className="mt-2.5 grid grid-cols-2 gap-2">
        <NumberField
          label="From floor"
          placeholder="from"
          value={form.fmin}
          onChange={(value) => update({ ...form, fmin: value }, { debounce: true })}
        />
        <NumberField
          label="To floor"
          placeholder="to"
          value={form.fmax}
          onChange={(value) => update({ ...form, fmax: value }, { debounce: true })}
        />
      </div>
    </div>
  );
}

export function UncertainBody({ facets }: { facets: Facets }) {
  const { form, update } = useShell();
  const result = facets.uncertain;
  const count = result?.type === 'uncertain' ? result.count : null;
  return (
    <div>
      <label className="flex cursor-pointer items-center gap-3 text-sm">
        <input
          type="checkbox"
          role="switch"
          aria-checked={form.unc === '1'}
          checked={form.unc === '1'}
          onChange={(event) => update({ ...form, unc: event.target.checked ? '1' : '' })}
          className="peer absolute opacity-0"
        />
        <span
          aria-hidden="true"
          className="relative h-[22px] w-10 shrink-0 rounded-full bg-border-strong transition-colors duration-150 after:absolute after:top-[3px] after:left-[3px] after:size-4 after:rounded-full after:bg-foreground after:transition-transform after:duration-150 peer-checked:bg-brand peer-checked:after:translate-x-[18px] peer-checked:after:bg-ink peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring motion-reduce:transition-none motion-reduce:after:transition-none"
        />
        Hide listings whose location contradicts itself
      </label>
      <Note>
        {count === null
          ? 'Listings whose pin or metro claim contradicts their street.'
          : `${fmt(count)} matching ${count === 1 ? 'listing has' : 'listings have'} a pin or a metro claim that contradicts their street.`}
      </Note>
    </div>
  );
}

export function MetroBody({ facets, foldStations }: { facets: Facets; foldStations: boolean }) {
  const { form, update } = useShell();
  const name = useId();
  const counts = facets.metroStations?.type === 'counts' ? facets.metroStations.counts : null;
  const coverage = facets.metroCoverage?.type === 'metroCoverage' ? facets.metroCoverage : null;
  const minutes = [
    ['', 'Any distance'],
    ...METRO_MINUTE_OPTIONS.map((m) => [m, `${m} min`] as const),
  ] as const;
  const toggle = (code: string) =>
    update({
      ...form,
      ms: form.ms.includes(code) ? form.ms.filter((c) => c !== code) : [...form.ms, code],
    });
  const lines = (
    <div className="mt-3 grid grid-cols-1 gap-x-[22px] gap-y-2.5 min-[900px]:grid-cols-2">
      {METRO_LINES.map((line) => (
        <div key={line.line}>
          <h4 className="mb-1 text-xs font-medium text-faint">{line.name}</h4>
          <ol
            className={`relative before:absolute before:top-3 before:bottom-3 before:left-[7px] before:w-1 before:rounded-sm ${
              line.line === 1 ? 'before:bg-metro-1' : 'before:bg-metro-2'
            }`}
          >
            {line.codes.map((code) => {
              const station = METRO_STATIONS.find((s) => s.code === code);
              if (station === undefined) return null;
              const checked = form.ms.includes(code);
              const both = code === 'station_square';
              const own = line.line === 1 ? 'border-metro-1' : 'border-metro-2';
              const fill = line.line === 1 ? 'peer-checked:bg-metro-1' : 'peer-checked:bg-metro-2';
              return (
                <li key={code}>
                  <label className="group relative flex cursor-pointer items-center gap-2 rounded-lg py-0.5 pr-1.5 hover:bg-hover">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(code)}
                      aria-label={`${station.en} (${station.ka})`}
                      className="peer absolute inset-0 m-0 cursor-pointer opacity-0"
                    />
                    <span
                      aria-hidden="true"
                      className={`relative z-[1] size-[18px] shrink-0 rounded-full border-[3px] bg-background transition-colors duration-100 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-[3px] peer-focus-visible:outline-ring ${own} ${fill} ${
                        both
                          ? 'shadow-[0_0_0_3px_var(--color-surface),0_0_0_5px_var(--color-foreground)]'
                          : ''
                      }`}
                    />
                    <span
                      className={`min-w-0 text-sm leading-[1.35] ${checked ? 'font-semibold' : ''}`}
                    >
                      {station.ka}
                      <small className="block text-[11px] font-normal text-faint">
                        {station.en}
                      </small>
                    </span>
                    <span className="numeric ml-auto shrink-0 text-[11px] text-faint">
                      {counts === null ? '' : fmt(counts[code] ?? 0)}
                    </span>
                  </label>
                </li>
              );
            })}
          </ol>
        </div>
      ))}
    </div>
  );
  const names = form.ms.map((code) => METRO_STATIONS.find((s) => s.code === code)?.ka ?? code);
  return (
    <div>
      <div className="mb-1.5 text-xs text-faint">Walking time to the station, at most</div>
      <div role="radiogroup" aria-label="Walking time" className="flex flex-wrap gap-1.5">
        {minutes.map(([value, label]) => (
          <Chip
            key={value}
            type="radio"
            name={name}
            checked={form.mm === value}
            onChange={() => update({ ...form, mm: value })}
            label={label}
          />
        ))}
      </div>
      {foldStations ? (
        <details className="group/st">
          <summary className="mt-2.5 flex cursor-pointer list-none items-center justify-between gap-2 rounded-[var(--radius)] border border-border-strong px-3 py-[7px] text-sm after:size-[7px] after:shrink-0 after:rotate-45 after:border-r-[1.5px] after:border-b-[1.5px] after:border-muted group-open/st:after:rotate-[225deg] [&::-webkit-details-marker]:hidden">
            {names.length === 0
              ? 'Pick stations (any by default)'
              : `Stations: ${names.join(', ')}`}
          </summary>
          {lines}
        </details>
      ) : (
        lines
      )}
      <Note>
        Walking times are ours, from the street or the building, never the poster’s claim.
        {coverage === null
          ? null
          : ` ${fmt(coverage.unknown)} of the ${fmt(coverage.total)} matching listings have too vague a location${
              coverage.outside > 0 ? ` and ${fmt(coverage.outside)} are outside Tbilisi` : ''
            }; a metro filter leaves them out.`}
      </Note>
    </div>
  );
}

const PRICE_NOTE: Readonly<Record<string, string>> = {
  sale: 'Asking price.',
  rent: 'Rent a month.',
  daily: 'Price a night.',
  pledge: 'Pledge amount.',
  all: 'Across every deal, prices mean different things: pick a deal to compare like with like.',
};

/** Dollars to lari, for the presets: the rate the listings themselves carry, about 2.7. */
const GEL_PER_USD = 2.7;

export function PriceBody({ facets }: { facets: Facets }) {
  const { form, update } = useShell();
  const name = useId();
  const histogram = facets.price?.type === 'histogram' ? facets.price : null;
  const edges = histogram?.edges ?? [];
  const counts = histogram?.counts ?? [];
  const bins = counts.length;
  const sign = form.cur === 'gel' ? '₾' : '$';
  const per = form.pm2 === '1' ? ' per m²' : '';
  const ranged = form.pmin !== '' || form.pmax !== '';
  const indexOf = (value: string, fallback: number) => {
    if (value === '' || bins === 0) return fallback;
    let i = 0;
    while (i < bins && (edges[i + 1] ?? Infinity) <= Number(value)) i++;
    return Math.min(bins, Math.max(0, i));
  };
  const lo = indexOf(form.pmin, 0);
  const hi = indexOf(form.pmax, bins);
  const peak = Math.max(1, ...counts);
  const rate = form.cur === 'gel' ? GEL_PER_USD : 1;
  const presets = pricePresets(form.deal, form.pm2 === '1').map(
    ([from, to]) =>
      [
        from === null ? '' : String(nice(from * rate)),
        to === null ? '' : String(nice(to * rate)),
      ] as const,
  );
  return (
    <div>
      <p className="mt-0 mb-2 max-w-[62ch] text-[13px] text-faint">{PRICE_NOTE[form.deal]}</p>
      <div className="flex flex-wrap gap-2">
        <Seg
          label="Currency"
          options={[
            ['usd', '$ USD'],
            ['gel', '₾ GEL'],
          ]}
          value={form.cur as 'usd' | 'gel'}
          onChange={(cur) => {
            if (cur === form.cur) return;
            // The bounds keep their meaning in the other currency.
            const factor = cur === 'gel' ? GEL_PER_USD : 1 / GEL_PER_USD;
            const convert = (value: string) =>
              value === '' ? '' : String(Math.round(Number(value) * factor));
            update({ ...form, cur, pmin: convert(form.pmin), pmax: convert(form.pmax) });
          }}
        />
        <Seg
          label="Price is"
          options={[
            ['', 'Total'],
            ['1', 'Per m²'],
          ]}
          value={form.pm2 as '' | '1'}
          onChange={(pm2) => update({ ...form, pm2, pmin: '', pmax: '' })}
        />
      </div>
      {bins >= 5 ? (
        <>
          <div aria-hidden="true" className="mt-3.5 flex h-[60px] items-end gap-0.5">
            {counts.map((n, i) => (
              <i
                // biome-ignore lint/suspicious/noArrayIndexKey: bins are positions on one axis
                key={i}
                style={{ height: `${Math.max(3, (n / peak) * 100)}%` }}
                className={`min-h-0.5 flex-1 rounded-t-sm transition-[height] duration-200 motion-reduce:transition-none ${
                  ranged && i >= lo && i < hi ? 'bg-brand-bar' : 'bg-fill'
                }`}
              />
            ))}
          </div>
          <DualSlider
            bins={bins}
            lo={lo}
            hi={hi}
            ranged={ranged}
            onLow={(i) =>
              update(
                { ...form, pmin: i === 0 ? '' : String(nice(edges[i] ?? 0)) },
                { debounce: true },
              )
            }
            onHigh={(i) =>
              update(
                { ...form, pmax: i === bins ? '' : String(nice(edges[i] ?? 0)) },
                { debounce: true },
              )
            }
          />
        </>
      ) : null}
      <div className="mt-2 grid grid-cols-2 gap-2">
        <NumberField
          label={`Lowest, ${sign}${per}`}
          placeholder="from"
          value={form.pmin}
          onChange={(value) => update({ ...form, pmin: value }, { debounce: true })}
        />
        <NumberField
          label={`Highest, ${sign}${per}`}
          placeholder="to"
          value={form.pmax}
          onChange={(value) => update({ ...form, pmax: value }, { debounce: true })}
        />
      </div>
      {presets.length === 0 ? null : (
        <fieldset aria-label="Price ranges" className="mt-2.5 flex min-w-0 flex-wrap gap-1.5">
          {presets.map(([from, to]) => {
            const on = form.pmin === from && form.pmax === to;
            return (
              <Chip
                key={`${from}-${to}`}
                type="radio"
                name={name}
                checked={on}
                onChange={() => update({ ...form, pmin: from, pmax: to })}
                label={cap(priceText(from, to, form.cur, form.pm2 === '1'))}
              />
            );
          })}
        </fieldset>
      )}
    </div>
  );
}

export const SORT_LABELS: readonly (readonly [string, string])[] = [
  ['newest', 'Newest first'],
  ['price-asc', 'Price, lowest first'],
  ['price-desc', 'Price, highest first'],
  ['ppm2-asc', 'Price per m², lowest first'],
  ['area-desc', 'Area, largest first'],
  ['metro', 'Nearest metro first'],
];

export function SortSelect({ className = '' }: { className?: string }) {
  const { form, update } = useShell();
  return (
    <select
      aria-label="Order"
      value={form.sort}
      onChange={(event) => update({ ...form, sort: event.target.value })}
      className={`rounded-[var(--radius)] border border-border-strong bg-surface px-[11px] py-[7px] text-sm text-foreground hover:border-border-hover ${className}`}
    >
      {SORT_LABELS.map(([value, label]) => (
        <option key={value} value={value}>
          {label}
        </option>
      ))}
    </select>
  );
}

export function ViewSeg({ long = false }: { long?: boolean }) {
  const { form, update } = useShell();
  return (
    <Seg
      label="Look-alike listings"
      options={[
        ['', long ? 'One row per home' : 'One per home'],
        ['all', 'Every listing'],
      ]}
      value={form.view as '' | 'all'}
      onChange={(view) => update({ ...form, view, group: '' })}
    />
  );
}
