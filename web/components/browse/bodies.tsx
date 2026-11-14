'use client';

import { useId, useState } from 'react';
import { presetKey, RANGE_PRESETS } from '../../../src/browse/browse-engine.js';
import {
  asKind,
  type BrowseForm,
  type FilterKey,
  type KindChoice,
  type Range,
  sortsFor,
} from '../../../src/browse/browse-form.js';
import {
  FILTER_UI,
  fmt,
  KIND_TABS,
  kindWord,
  RANGE_SIGN,
  rangeText,
  titleOf,
  unitNote,
} from '../../lib/browse-registry.js';
import { Chip, DualSlider, Histogram, Note, NumberField, nice, Seg } from '../filter-ui.js';
import { BrowseIconSvg } from './icons.js';
import { useBrowse } from './shell.js';

/*
 * The insides of each Browse filter, the same in a popover, a bottom sheet
 * and "All filters": every change goes straight to the address ("Changes
 * apply at once", as the mockup says).
 */

const SINGLE: ReadonlySet<FilterKey> = new Set(['subm', 'online', 'edu', 'closing', 'since']);

/** All · Jobs · Tenders · Courses, each with what it would show. */
export function KindSeg({ big = false, stretch = false }: { big?: boolean; stretch?: boolean }) {
  const { form, update, data } = useBrowse();
  return (
    <Seg
      label="Kind"
      big={big}
      stretch={stretch}
      value={form.kind}
      onChange={(kind: KindChoice) => update(asKind(form, kind, data.surface))}
      options={KIND_TABS.map(
        ([kind, text, icon]) =>
          [
            kind,
            <>
              <BrowseIconSvg name={icon} className="size-4" />
              {text}
              <span className="numeric hidden text-[11px] text-faint group-has-checked:text-ink/70 min-[900px]:inline">
                {fmt(data.kindCounts[kind] ?? 0)}
                <span className="sr-only"> {kindWord(kind, data.kindCounts[kind] ?? 0)}</span>
              </span>
            </>,
          ] as const,
      )}
    />
  );
}

/** A list filter's chips, each with what picking it would show. */
export function OptionChips({
  filterKey,
  fold,
}: {
  filterKey: FilterKey;
  fold?: number | undefined;
}) {
  const { form, update, data } = useBrowse();
  const name = useId();
  const [open, setOpen] = useState(false);
  const options = data.options[filterKey] ?? [];
  const single = SINGLE.has(filterKey);
  const value = form[filterKey as keyof BrowseForm];
  const chosen: readonly string[] = single ? [value as string] : (value as string[]);
  const toggle = (option: string) => {
    if (single) {
      update({ ...form, [filterKey]: option });
      return;
    }
    const rest = chosen.filter((v) => v !== option);
    update({ ...form, [filterKey]: chosen.includes(option) ? rest : [...rest, option] });
  };
  const folded = fold !== undefined && options.length > fold && !open;
  const groups = [...new Set(options.map((o) => o.group ?? ''))];
  const ui = FILTER_UI[filterKey];
  if (options.length === 0) return <Note>Nothing here states it yet.</Note>;
  let shown = 0;
  return (
    <div>
      {groups.map((group) => (
        <div key={group}>
          {group !== '' && groups.length > 1 ? (
            <div className="mt-3 mb-1.5 text-xs text-faint first:mt-0">{group}</div>
          ) : null}
          {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: the role is set, a radiogroup or a group */}
          <div
            role={single ? 'radiogroup' : 'group'}
            aria-label={group === '' ? titleOf(filterKey, form.kind) : group}
            className="flex flex-wrap gap-1.5"
          >
            {options
              .filter((o) => (o.group ?? '') === group)
              .map((option) => {
                const on = chosen.includes(option.value);
                const index = shown++;
                if (folded && index >= (fold ?? 0) && !on) return null;
                return (
                  <Chip
                    key={option.value}
                    type={single ? 'radio' : 'checkbox'}
                    name={name}
                    checked={on}
                    onChange={() => toggle(option.value)}
                    label={option.label}
                    hint={option.hint}
                    lang={option.lang}
                    title={option.hint === '' ? undefined : `${option.label} · ${option.hint}`}
                    count={option.n}
                    noun={kindWord(form.kind, option.n)}
                  />
                );
              })}
          </div>
        </div>
      ))}
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
      {ui?.hint === undefined ? null : <Note>{ui.hint}</Note>}
    </div>
  );
}

/** An on/off filter, with what it would show switched on. */
export function ToggleBody({ filterKey }: { filterKey: FilterKey }) {
  const { form, update, data } = useBrowse();
  const on = form[filterKey as keyof BrowseForm] === true;
  const n = data.toggles[filterKey];
  return (
    <Switch
      checked={on}
      onChange={(checked) => update({ ...form, [filterKey]: checked })}
      text={FILTER_UI[filterKey]?.toggle ?? titleOf(filterKey, form.kind)}
      small={n === undefined ? '' : `${fmt(n)} would match`}
    />
  );
}

export function Switch({
  checked,
  onChange,
  text,
  small,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  text: string;
  small: string;
}) {
  return (
    <label className="group relative flex cursor-pointer items-center gap-3 text-sm">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="peer absolute opacity-0"
      />
      <span
        aria-hidden="true"
        className="relative h-[22px] w-10 flex-none rounded-full bg-border-strong transition-colors duration-150 after:absolute after:top-[3px] after:left-[3px] after:size-4 after:rounded-full after:bg-foreground after:transition-transform after:duration-150 peer-checked:bg-brand peer-checked:after:translate-x-[18px] peer-checked:after:bg-ink peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring motion-reduce:transition-none motion-reduce:after:transition-none"
      />
      <span>
        {text}
        {small === '' ? null : <small className="block text-xs text-faint">{small}</small>}
      </span>
    </label>
  );
}

/**
 * The switch that brings back what a filter leaves out for not stating the
 * fact, shown while it leaves some out ("never hide silently").
 */
export function UnknownBox({ filterKey }: { filterKey: FilterKey }) {
  const { form, update, data } = useBrowse();
  const out = data.leftOut[filterKey];
  const what = FILTER_UI[filterKey]?.what?.(form.kind);
  if (out === undefined || what === undefined) return null;
  const kept = form.keep.includes(filterKey);
  return (
    <div className="mt-3 rounded-[var(--radius)] border border-dashed border-warn/60 bg-warn-soft px-3 py-2.5">
      <Switch
        checked={kept}
        onChange={(checked) =>
          update({
            ...form,
            keep: checked
              ? [...form.keep.filter((k) => k !== filterKey), filterKey]
              : form.keep.filter((k) => k !== filterKey),
          })
        }
        text={`Also show the ${fmt(out.n)} that don’t state ${what}`}
        small={kept ? 'They are in the list, after the ones that match.' : out.parts.join(' · ')}
      />
    </div>
  );
}

/** Salary, value and fee: a histogram, two handles, two boxes and quick ranges (the price panel). */
export function RangeBody({ filterKey }: { filterKey: 'salary' | 'value' | 'fee' }) {
  const { form, update, data } = useBrowse();
  const name = useId();
  const range = form[filterKey];
  const facts = data.ranges[filterKey];
  const edges = facts?.edges ?? [];
  const counts = facts?.counts ?? [];
  const bins = counts.length;
  const sign = RANGE_SIGN[filterKey] ?? '';
  const ranged = range.min !== null || range.max !== null;
  const indexOf = (value: number | null, fallback: number) => {
    if (value === null || bins === 0) return fallback;
    let i = 0;
    while (i < bins && (edges[i + 1] ?? Number.POSITIVE_INFINITY) <= value) i++;
    return Math.min(bins, Math.max(0, i));
  };
  const lo = indexOf(range.min, 0);
  const hi = indexOf(range.max, bins);
  const set = (next: Range, debounce = false) =>
    update({ ...form, [filterKey]: next }, { debounce });
  const title = titleOf(filterKey, form.kind).toLowerCase();
  return (
    <div>
      <p className="mt-0 mb-1 max-w-[62ch] text-[13px] text-faint">
        {unitNote(filterKey, data.ratesDate)}
      </p>
      {bins >= 5 ? (
        <>
          <Histogram counts={counts} lo={lo} hi={hi} ranged={ranged} />
          <DualSlider
            bins={bins}
            lo={lo}
            hi={hi}
            ranged={ranged}
            lowLabel={`Lowest ${title}`}
            highLabel={`Highest ${title}`}
            onLow={(i) => set({ ...range, min: i === 0 ? null : nice(edges[i] ?? 0) }, true)}
            onHigh={(i) => set({ ...range, max: i === bins ? null : nice(edges[i] ?? 0) }, true)}
          />
        </>
      ) : null}
      <div className="mt-2 grid grid-cols-2 gap-2">
        <NumberField
          label={`Lowest, ${sign}`}
          placeholder="from"
          value={range.min === null ? '' : String(range.min)}
          onChange={(v) => set({ ...range, min: v === '' ? null : Number(v) }, true)}
        />
        <NumberField
          label={`Highest, ${sign}`}
          placeholder="to"
          value={range.max === null ? '' : String(range.max)}
          onChange={(v) => set({ ...range, max: v === '' ? null : Number(v) }, true)}
        />
      </div>
      <fieldset
        aria-label={`${titleOf(filterKey, form.kind)} ranges`}
        className="mt-2.5 flex min-w-0 flex-wrap gap-1.5"
      >
        {(RANGE_PRESETS[filterKey] ?? []).map((preset) => {
          const on = range.min === preset.min && range.max === preset.max;
          const n = facts?.presets[presetKey(preset)];
          const text = rangeText(preset, sign);
          return (
            <Chip
              key={presetKey(preset)}
              type="radio"
              name={name}
              checked={on}
              onChange={() => set(on ? { min: null, max: null } : preset)}
              label={text.charAt(0).toUpperCase() + text.slice(1)}
              count={n}
              noun={kindWord(form.kind, n ?? 0)}
            />
          );
        })}
      </fieldset>
    </div>
  );
}

const SORT_LABELS: Readonly<Record<string, string>> = {
  recent: 'Newest first',
  deadline: 'Closing soonest',
  title: 'Title, A to Z',
  salary: 'Salary, highest first',
  starts: 'Starts soonest',
  fee: 'Fee, lowest first',
};

export function SortSelect({ className = '' }: { className?: string }) {
  const { form, update } = useBrowse();
  return (
    <select
      aria-label="Order"
      value={form.sort}
      onChange={(event) =>
        update({ ...form, sort: event.target.value as BrowseForm['sort'] }, { keepShow: true })
      }
      className={`rounded-[var(--radius)] border border-border-strong bg-surface px-[11px] py-[7px] text-sm text-foreground hover:border-border-hover ${className}`}
    >
      {sortsFor(form.kind).map((sort) => (
        <option key={sort} value={sort}>
          {SORT_LABELS[sort]}
        </option>
      ))}
    </select>
  );
}

/** A filter's controls, the same wherever they are drawn. */
export function FilterBody({ filterKey, inSheet }: { filterKey: FilterKey; inSheet: boolean }) {
  switch (filterKey) {
    case 'salary':
    case 'value':
    case 'fee':
      return <RangeBody filterKey={filterKey} />;
    case 'bonus':
    case 'nolic':
    case 'stud':
    case 'cross':
      return <ToggleBody filterKey={filterKey} />;
    default:
      return (
        <OptionChips
          filterKey={filterKey}
          fold={inSheet ? FILTER_UI[filterKey]?.fold : undefined}
        />
      );
  }
}
