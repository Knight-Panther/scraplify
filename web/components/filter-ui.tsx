'use client';

import { type ReactNode, useEffect, useId, useState } from 'react';
import { count } from '../lib/format.js';

/*
 * The filter screens' shared controls (Real estate since Phase 16B, Browse
 * since 16C): chips over hidden radios and checkboxes, a segmented switch,
 * a typed number, a two-thumb slider, and the pieces of a sheet. Drawn once
 * here so both tabs look and behave the same.
 */

const CHIP_TEXT =
  'inline-flex flex-1 items-baseline justify-center gap-1.5 whitespace-nowrap rounded-[var(--radius)] border border-border-strong bg-surface px-3 py-[5px] text-sm transition-[background-color,border-color,transform] duration-100 motion-reduce:transition-none group-hover:border-border-hover group-active:scale-[0.97] peer-checked:border-brand peer-checked:bg-brand peer-checked:font-semibold peer-checked:text-ink peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring';

/** One choice: a hidden radio or checkbox under a chip, so the keyboard and screen readers get the real control. */
export function Chip({
  type,
  name,
  checked,
  onChange,
  label,
  hint,
  count: n,
  noun = 'listings',
  icon,
  lang,
  title,
  className = '',
}: {
  type: 'radio' | 'checkbox';
  name: string;
  checked: boolean;
  onChange: () => void;
  label: string;
  /** A second, quieter name (the English of a Georgian word). */
  hint?: string | undefined;
  /** Undefined: no count for this option; null: not known yet. */
  count?: number | null | undefined;
  /** What the count counts, for screen readers. */
  noun?: string;
  icon?: ReactNode;
  lang?: string | undefined;
  title?: string | undefined;
  className?: string;
}) {
  const none = n === 0 && !checked;
  return (
    <label className={`group relative inline-flex max-w-full ${className}`} title={title}>
      <input
        type={type}
        name={name}
        checked={checked}
        onChange={onChange}
        className="peer absolute inset-0 m-0 cursor-pointer opacity-0"
      />
      <span className={`${CHIP_TEXT} min-w-0 ${none ? 'border-dashed text-faint' : ''}`}>
        {icon ?? null}
        <span lang={lang} className="min-w-0 truncate">
          {label}
        </span>
        {hint === undefined || hint === '' || hint === label ? null : (
          <span className={`text-xs ${checked ? 'text-ink/70' : 'text-faint'}`}>{hint}</span>
        )}
        {n === undefined ? null : (
          <>
            <span
              aria-hidden="true"
              className={`numeric text-[11px] ${checked ? 'text-ink/70' : 'text-faint'}`}
            >
              {n === null ? '' : count(n)}
            </span>
            {n === null ? null : (
              <span className="sr-only">
                , {count(n)} {noun}
              </span>
            )}
          </>
        )}
      </span>
    </label>
  );
}

/** A segmented switch, one choice of a few. */
export function Seg<T extends string>({
  label,
  options,
  value,
  onChange,
  big = false,
  stretch = false,
}: {
  label: string;
  options: readonly (readonly [T, ReactNode])[];
  value: T;
  onChange: (value: T) => void;
  big?: boolean;
  stretch?: boolean;
}) {
  const name = useId();
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={`${stretch ? 'flex w-full' : 'inline-flex'} max-w-full gap-0.5 rounded-[calc(var(--radius)+3px)] border border-border-strong bg-surface p-[3px]`}
    >
      {options.map(([option, text]) => (
        <label key={option} className="group relative flex-1">
          <input
            type="radio"
            name={name}
            value={option}
            checked={value === option}
            onChange={() => onChange(option)}
            className="peer absolute inset-0 m-0 cursor-pointer opacity-0"
          />
          <span
            className={`flex items-center justify-center gap-[7px] whitespace-nowrap rounded-[var(--radius)] text-center text-muted transition-colors duration-150 motion-reduce:transition-none group-hover:text-foreground peer-checked:bg-brand peer-checked:font-semibold peer-checked:text-ink peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring ${
              big
                ? 'px-2 py-[7px] text-[15px] min-[900px]:px-[18px]'
                : 'px-2 py-[5px] text-sm min-[900px]:px-3.5'
            }`}
          >
            {text}
          </span>
        </label>
      ))}
    </div>
  );
}

export function Note({ children, warn = false }: { children: ReactNode; warn?: boolean }) {
  return (
    <p className={`mt-2 max-w-[62ch] text-[13px] ${warn ? 'text-warn' : 'text-faint'}`}>
      {children}
    </p>
  );
}

const INPUT =
  'numeric w-full rounded-[var(--radius)] border border-border-strong bg-surface px-[11px] py-[7px] text-sm placeholder:text-faint hover:border-border-hover';

/** A typed whole number; shown with thousands separators once the field is left. */
export function NumberField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  const [focused, setFocused] = useState(false);
  const shown = focused || value === '' ? value : count(Number(value));
  return (
    <label className="flex flex-col gap-1 text-xs text-faint">
      {label}
      <input
        type="text"
        inputMode="numeric"
        autoComplete="off"
        placeholder={placeholder}
        value={shown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(event) => {
          const digits = event.target.value.replace(/[^\d]/g, '').replace(/^0+/, '').slice(0, 9);
          onChange(digits);
        }}
        className={`${INPUT} text-foreground`}
      />
    </label>
  );
}

const THUMB =
  '[&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:size-5 [&::-webkit-slider-thumb]:cursor-grab [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-[3px] [&::-webkit-slider-thumb]:border-thumb-border [&::-webkit-slider-thumb]:bg-thumb [&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:size-5 [&::-moz-range-thumb]:cursor-grab [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-[3px] [&::-moz-range-thumb]:border-thumb-border [&::-moz-range-thumb]:bg-thumb focus-visible:[&::-webkit-slider-thumb]:outline-2 focus-visible:[&::-webkit-slider-thumb]:outline-offset-2 focus-visible:[&::-webkit-slider-thumb]:outline-ring focus-visible:outline-none';

/** Two thumbs on one track, over a histogram's bins. */
export function DualSlider({
  bins,
  lo,
  hi,
  ranged,
  onLow,
  onHigh,
  lowLabel = 'Lowest price',
  highLabel = 'Highest price',
}: {
  bins: number;
  lo: number;
  hi: number;
  ranged: boolean;
  onLow: (index: number) => void;
  onHigh: (index: number) => void;
  lowLabel?: string;
  highLabel?: string;
}) {
  const left = lo / bins;
  const right = hi / bins;
  const input = `pointer-events-none absolute inset-0 m-0 h-7 w-full appearance-none bg-transparent ${THUMB}`;
  return (
    <div className="relative -mt-0.5 h-7">
      <div className="absolute top-3 right-[9px] left-[9px] h-1 rounded-sm bg-fill" />
      {ranged ? (
        <div
          className="absolute top-3 h-1 rounded-sm bg-brand-bar"
          style={{
            left: `calc(9px + (100% - 18px) * ${left})`,
            width: `calc((100% - 18px) * ${right - left})`,
          }}
        />
      ) : null}
      <input
        type="range"
        min={0}
        max={bins}
        step={1}
        value={lo}
        aria-label={lowLabel}
        onChange={(event) => onLow(Math.min(Number(event.target.value), hi))}
        className={input}
      />
      <input
        type="range"
        min={0}
        max={bins}
        step={1}
        value={hi}
        aria-label={highLabel}
        onChange={(event) => onHigh(Math.max(Number(event.target.value), lo))}
        className={input}
      />
    </div>
  );
}

/** Bars over a histogram's bins, the chosen span in the brand colour. */
export function Histogram({
  counts,
  lo,
  hi,
  ranged,
}: {
  counts: readonly number[];
  lo: number;
  hi: number;
  ranged: boolean;
}) {
  const peak = Math.max(1, ...counts);
  return (
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
  );
}

/** A round number near a histogram edge, so a dragged bound reads like a typed one. */
export function nice(value: number): number {
  const step =
    value >= 1e5 ? 5000 : value >= 1e4 ? 1000 : value >= 1e3 ? 100 : value >= 100 ? 10 : 1;
  return Math.max(step, Math.round(value / step) * step);
}

export function ClearLink({ onClick, label = 'Clear' }: { onClick: () => void; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="px-0.5 py-1 text-sm underline decoration-border-hover underline-offset-[3px] hover:decoration-foreground"
    >
      {label}
    </button>
  );
}

export function CloseButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label="Close"
      onClick={onClick}
      className="inline-grid size-9 place-items-center rounded-[var(--radius)] border border-border-strong text-[19px] leading-none hover:border-border-hover"
    >
      ×
    </button>
  );
}

export function Scrim({ onClick }: { onClick: () => void }) {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a click outside a sheet closes it; Escape and the close button do too
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes the sheet
    <div
      onClick={onClick}
      className="fixed inset-0 z-70 bg-scrim motion-safe:animate-[re-fade_160ms_cubic-bezier(0.2,0.8,0.2,1)]"
    />
  );
}

/** Keeps Tab inside an open sheet. */
export function trapTab(event: React.KeyboardEvent<HTMLElement>) {
  if (event.key !== 'Tab') return;
  const items = [
    ...event.currentTarget.querySelectorAll<HTMLElement>('button, input, select, a[href], summary'),
  ].filter((el) => !(el as HTMLButtonElement).disabled && el.offsetParent !== null);
  const first = items[0];
  const last = items[items.length - 1];
  if (first === undefined || last === undefined) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/** The page under a sheet does not scroll. */
export function useBodyLock(locked: boolean) {
  useEffect(() => {
    if (!locked) return;
    const before = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = before;
    };
  }, [locked]);
}

/** A filter pill's look; `aria-expanded` lifts it while its panel is open. */
export const PILL =
  'inline-flex h-9 shrink-0 cursor-pointer touch-manipulation items-center gap-2 whitespace-nowrap rounded-full border border-border-strong bg-surface px-3.5 text-sm transition-colors duration-100 motion-reduce:transition-none hover:border-border-hover aria-expanded:bg-surface-raised';

export const FILTER_WIDE = '(min-width: 900px)';
