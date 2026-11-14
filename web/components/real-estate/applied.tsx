'use client';

import { applicable } from '../../lib/real-estate-form.js';
import { chipFilters, clearAll, FILTER } from '../../lib/real-estate-registry.js';
import { SortSelect, ViewSeg } from './bodies.js';
import { useShell } from './shell.js';

/**
 * Above the results: a chip for each filter in force, each with its own ×,
 * and "Clear all" (the mockup's applied row). The deal, the kind and the
 * places show in their own controls, so they have no chip.
 */
export function AppliedFilters() {
  const { form, update, placeNames } = useShell();
  const names = new Map([...placeNames].map(([value, label]) => [value, label.nameKa]));
  const chips = chipFilters(form);
  if (chips.length === 0 && !FILTER.where.active(form)) return null;
  return (
    <fieldset
      aria-label="Filters in use"
      className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5"
    >
      {chips.map((filter) => (
        <span
          key={filter.key}
          className="inline-flex items-center gap-0.5 rounded-full border border-border-strong bg-surface py-px pr-0.5 pl-[11px] text-[13px] motion-safe:animate-[re-token_160ms_cubic-bezier(0.2,0.8,0.2,1)]"
        >
          <b className="mr-1 font-medium text-faint">{filter.short ?? filter.title(form)}</b>
          {filter.summary(form, { placeNames: names })}
          <button
            type="button"
            aria-label={`Remove filter: ${filter.title(form)}`}
            onClick={() => update(applicable(filter.clear(form)))}
            className="inline-grid size-6 place-items-center rounded-full text-base leading-none text-faint hover:bg-hover-strong hover:text-foreground"
          >
            ×
          </button>
        </span>
      ))}
      <button
        type="button"
        onClick={() => update(clearAll(form))}
        className="px-0.5 py-1 text-sm underline decoration-border-hover underline-offset-[3px] hover:decoration-foreground"
      >
        Clear all
      </button>
    </fieldset>
  );
}

/** Beside the count: one row per home or every listing, and the order. */
export function ResultsTools() {
  return (
    <div className="flex items-center gap-2.5">
      <span className="hidden min-[481px]:inline">
        <ViewSeg />
      </span>
      <SortSelect className="max-w-[10.5rem] min-[481px]:max-w-none" />
    </div>
  );
}
