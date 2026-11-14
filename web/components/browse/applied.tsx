'use client';

import { activeKeys, clearAll, clearFilter, STATED_KEYS } from '../../../src/browse/browse-form.js';
import { kindLabel } from '../../lib/kind-labels.js';
import { FILTER_UI, fmt, kindWord, summaryOf, titleOf } from '../../lib/browse-registry.js';
import { SortSelect } from './bodies.js';
import { chipKeys } from './filter-bar.js';
import { useBrowse } from './shell.js';

/**
 * Above the results: a chip for each filter in force, each with its own ×,
 * and "Clear all"; then the count, which never hides what a filter left out
 * for not stating it (the mockup's results head).
 */
export function AppliedFilters() {
  const { form, update, data, label } = useBrowse();
  const keys = chipKeys(form, data.surface);
  const any = keys.length > 0 || form.q !== '' || form.org.length > 0;
  if (!any) return null;
  return (
    <fieldset
      aria-label="Filters in use"
      className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5"
    >
      {keys.map((key) => (
        <span
          key={key}
          className="inline-flex max-w-full items-center gap-0.5 rounded-full border border-border-strong bg-surface py-px pr-0.5 pl-[11px] text-[13px] motion-safe:animate-[re-token_160ms_cubic-bezier(0.2,0.8,0.2,1)]"
        >
          <span className="min-w-0 truncate">
            <b className="mr-1 font-medium text-faint">
              {FILTER_UI[key]?.short ?? titleOf(key, form.kind)}
            </b>
            {key === 'types'
              ? form.types.map((t) => kindLabel(t, 'en')).join(', ')
              : summaryOf(key, form, label)}
            {form.keep.includes(key) ? ' + unstated' : ''}
          </span>
          <button
            type="button"
            aria-label={`Remove filter: ${titleOf(key, form.kind)}`}
            onClick={() => update(clearFilter(form, key))}
            className="inline-grid size-6 flex-none place-items-center rounded-full text-base leading-none text-faint hover:bg-hover-strong hover:text-foreground"
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

export function CountLine() {
  const { form, update, data } = useBrowse();
  const notKept = activeKeys(form, data.surface).filter(
    (key) => STATED_KEYS.has(key) && !form.keep.includes(key) && data.leftOut[key] !== undefined,
  );
  return (
    <div className="mt-3.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5">
      <p aria-live="polite" className="m-0 text-[15px] text-faint">
        <b className="numeric text-[17px] font-bold text-foreground">{fmt(data.total)}</b>{' '}
        {kindWord(form.kind, data.total)}
        {data.unstated > 0 ? (
          <span className="ml-2 text-[13px]">
            · {fmt(data.total - data.unstated)} match, {fmt(data.unstated)} don’t say
          </span>
        ) : null}
        {data.extra > 0 && notKept.length > 0 ? (
          <span className="ml-2 text-[13px] text-warn">
            · {fmt(data.extra)} left out for not stating it{' '}
            <button
              type="button"
              onClick={() => update({ ...form, keep: [...form.keep, ...notKept] })}
              className="p-0 text-[13px] text-warn underline underline-offset-[3px]"
            >
              show them too
            </button>
          </span>
        ) : null}
      </p>
      <SortSelect className="max-w-[10.5rem] min-[481px]:max-w-none" />
    </div>
  );
}
