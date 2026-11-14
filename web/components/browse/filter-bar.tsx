'use client';

import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import {
  activeKeys,
  applies,
  clearAll,
  clearFilter,
  FILTER_KEYS,
  type FilterKey,
  isActive,
} from '../../../src/browse/browse-form.js';
import {
  FILTER_UI,
  fmt,
  GROUP_ICON,
  GROUPS,
  type Group,
  kindWord,
  PROMOTED,
  summaryOf,
  titleOf,
} from '../../lib/browse-registry.js';
import { ClearLink, CloseButton, Note, PILL, Scrim, trapTab, useBodyLock } from '../filter-ui.js';
import { FilterBody, KindSeg, SortSelect, UnknownBox } from './bodies.js';
import { BrowseIconSvg } from './icons.js';
import { SearchBox } from './search-box.js';
import { useBrowse, useWide } from './shell.js';

/**
 * Browse's filter bar (Phase 16C, the approved mockup): the kind and the
 * search box on the first row; under them the filters people narrow by
 * first for that kind, and "All filters". On a wide screen a pill opens a
 * popover under itself; on a phone, a sheet from the bottom.
 */

/** Filters with no chip: the kind and the search box show themselves. */
const NO_CHIP: ReadonlySet<FilterKey> = new Set(['q', 'org']);

export function chipKeys(form: ReturnType<typeof useBrowse>['form'], surface: 'local' | 'public') {
  return activeKeys(form, surface).filter((key) => !NO_CHIP.has(key));
}

function Caret({ open }: { open: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`size-[7px] border-r-[1.5px] border-b-[1.5px] border-current opacity-70 transition-transform duration-150 motion-reduce:transition-none ${
        open ? 'translate-y-px rotate-[225deg]' : '-translate-y-0.5 rotate-45'
      }`}
    />
  );
}

export function FilterBar() {
  const { form, data } = useBrowse();
  const wide = useWide();
  const [open, setOpen] = useState<{ key: FilterKey; button: HTMLButtonElement } | null>(null);
  const [sheetFrom, setSheetFrom] = useState<HTMLButtonElement | null>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    const target = sentinel.current;
    if (target === null) return;
    const observer = new IntersectionObserver(([entry]) =>
      setStuck(entry?.isIntersecting === false),
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, []);

  const close = useCallback((returnFocus: boolean) => {
    setOpen((current) => {
      if (current !== null && returnFocus) current.button.focus();
      return null;
    });
  }, []);

  // A change of screen width swaps a popover for a sheet: close it instead.
  const lastWide = useRef(wide);
  useEffect(() => {
    if (lastWide.current !== wide) setOpen(null);
    lastWide.current = wide;
  }, [wide]);

  // A kind change can take the open pill away.
  useEffect(() => {
    if (open !== null && !open.button.isConnected) setOpen(null);
  });

  const promoted = PROMOTED[form.kind].filter((key) => applies(key, form.kind, data.surface));
  // Places and fields show as tokens in the search box, but they are filters too.
  const badge = activeKeys(form, data.surface).filter((k) => !NO_CHIP.has(k)).length;

  const allButton = (
    <button
      key="all"
      type="button"
      aria-haspopup="dialog"
      aria-expanded={sheetFrom !== null}
      onClick={(event) => {
        setOpen(null);
        setSheetFrom(event.currentTarget);
      }}
      className={PILL}
    >
      <BrowseIconSvg name="sliders" className="size-4 text-faint" />
      All filters
      {badge === 0 ? null : (
        <span className="numeric h-5 min-w-5 rounded-full bg-brand px-1.5 text-center text-xs leading-5 text-ink">
          {badge}
          <span className="sr-only"> set</span>
        </span>
      )}
    </button>
  );

  const pills = promoted.map((key) => (
    <Pill
      key={key}
      filterKey={key}
      expanded={open?.key === key}
      onClick={(button) => {
        if (open?.key === key) close(true);
        else setOpen({ key, button });
      }}
    />
  ));

  return (
    <>
      <div ref={sentinel} className="h-px" />
      <section
        aria-label="Filters"
        className={`sticky top-0 z-20 -mx-4 mt-2.5 bg-background px-4 transition-[box-shadow,padding] duration-150 motion-reduce:transition-none min-[900px]:mt-[18px] ${
          stuck ? 'border-b border-border py-2 shadow-bar' : 'py-3'
        }`}
      >
        <div className="flex flex-wrap items-center gap-2 min-[900px]:gap-2.5">
          <div className="w-full min-[900px]:w-auto">
            <KindSeg stretch={!wide} />
          </div>
          <SearchBox />
        </div>
        <div
          role="toolbar"
          aria-label="Main filters"
          className="-mx-4 mt-2.5 flex flex-nowrap items-center gap-2 overflow-x-auto px-4 pb-0.5 [scrollbar-width:none] min-[900px]:mx-0 min-[900px]:flex-wrap min-[900px]:overflow-visible min-[900px]:px-0 [&::-webkit-scrollbar]:hidden"
        >
          {wide ? [...pills, allButton] : [allButton, ...pills]}
        </div>
      </section>

      {open === null ? null : (
        <OnePanel filterKey={open.key} anchor={open.button} wide={wide} onClose={close} />
      )}
      {sheetFrom === null ? null : (
        <AllFilters
          onClose={() => {
            if (sheetFrom.isConnected) sheetFrom.focus();
            setSheetFrom(null);
          }}
        />
      )}
    </>
  );
}

function Pill({
  filterKey,
  expanded,
  onClick,
}: {
  filterKey: FilterKey;
  expanded: boolean;
  onClick: (button: HTMLButtonElement) => void;
}) {
  const { form, label } = useBrowse();
  const ui = FILTER_UI[filterKey];
  const on = isActive(filterKey, form);
  const kept = form.keep.includes(filterKey);
  return (
    <button
      type="button"
      data-key={filterKey}
      aria-haspopup="dialog"
      aria-expanded={expanded}
      onClick={(event) => onClick(event.currentTarget)}
      className={`${PILL} ${on ? 'border-accent-line bg-brand-soft' : ''}`}
    >
      <BrowseIconSvg
        name={ui?.icon ?? 'sliders'}
        className={`size-4 ${on ? 'text-accent' : 'text-faint'}`}
      />
      {ui?.short ?? titleOf(filterKey, form.kind)}
      {on ? (
        <span className="max-w-64 truncate text-accent">
          {summaryOf(filterKey, form, label)}
          {kept ? ' + unstated' : ''}
        </span>
      ) : null}
      <Caret open={expanded} />
    </button>
  );
}

/** "Show 1,234 vacancies": the server's count for the form it last answered. */
function ShowButton({ onClick, long }: { onClick: () => void; long: boolean }) {
  const { data, form, pending } = useBrowse();
  return (
    <button
      type="button"
      onClick={onClick}
      aria-busy={pending}
      className="inline-flex items-center gap-2 whitespace-nowrap rounded-[var(--radius)] border border-brand bg-brand px-3.5 py-[7px] text-sm font-semibold text-ink hover:border-brand-hover hover:bg-brand-hover"
    >
      Show <span className={`numeric ${pending ? 'opacity-60' : ''}`}>{fmt(data.total)}</span>
      {long ? ` ${kindWord(form.kind, data.total)}` : null}
    </button>
  );
}

/** One filter: a popover under its pill on a wide screen, a sheet from the bottom on a phone. */
function OnePanel({
  filterKey,
  anchor,
  wide,
  onClose,
}: {
  filterKey: FilterKey;
  anchor: HTMLButtonElement;
  wide: boolean;
  onClose: (returnFocus: boolean) => void;
}) {
  const { form, update } = useBrowse();
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const ui = FILTER_UI[filterKey];

  const position = useCallback(() => {
    if (!wide || panel.current === null) return;
    const rect = anchor.getBoundingClientRect();
    const room = document.documentElement.clientWidth - panel.current.offsetWidth - 16;
    setPlace({
      left: Math.max(16, Math.min(rect.left, room)) + window.scrollX,
      top: rect.bottom + 8 + window.scrollY,
    });
  }, [anchor, wide]);
  useLayoutEffect(position, [position]);
  useEffect(() => {
    window.addEventListener('resize', position);
    return () => window.removeEventListener('resize', position);
  }, [position]);

  // The list scrolls inside the popover, so its footer stays on screen.
  const [maxBody, setMaxBody] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!wide || place === null) return;
    const bottom = anchor.getBoundingClientRect().bottom;
    setMaxBody(Math.max(180, window.innerHeight - bottom - 8 - 16 - 150));
  }, [anchor, wide, place]);

  const focused = useRef(false);
  useEffect(() => {
    if (focused.current || (wide && place === null) || panel.current === null) return;
    focused.current = true;
    const first =
      panel.current.querySelector<HTMLElement>('input:not([type=hidden]), select') ??
      panel.current.querySelector<HTMLElement>('button');
    first?.focus();
  }, [place, wide]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose(true);
    };
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (wide && !panel.current?.contains(target) && !anchor.contains(target)) onClose(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [anchor, onClose, wide]);

  useBodyLock(!wide);

  const clear = () => update(clearFilter(form, filterKey));
  const title = titleOf(filterKey, form.kind);
  const body = <FilterBody filterKey={filterKey} inSheet={false} />;

  if (wide) {
    return createPortal(
      <div
        ref={panel}
        role="dialog"
        aria-labelledby={titleId}
        style={place === null ? { visibility: 'hidden' } : { left: place.left, top: place.top }}
        className={`absolute z-50 rounded-2xl border border-border-strong bg-surface p-4 text-foreground shadow-pop motion-safe:animate-[re-pop_140ms_cubic-bezier(0.2,0.8,0.2,1)] ${
          ui?.wide ? 'w-[min(620px,calc(100vw-32px))]' : 'w-[min(460px,calc(100vw-32px))]'
        }`}
      >
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 id={titleId} className="m-0 text-[15px] font-semibold">
            {title}
          </h2>
          <ClearLink onClick={clear} />
        </div>
        <div
          className="-mx-4 overflow-auto overscroll-contain px-4"
          style={maxBody === null ? undefined : { maxHeight: maxBody }}
        >
          {body}
        </div>
        <UnknownBox filterKey={filterKey} />
        <div className="mt-4 flex items-center justify-between gap-3 border-t border-border pt-3">
          <span className="text-[13px] text-faint">Changes apply at once.</span>
          <ShowButton onClick={() => onClose(true)} long={false} />
        </div>
      </div>,
      document.body,
    );
  }

  return createPortal(
    <>
      <Scrim onClick={() => onClose(true)} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={trapTab}
        className="fixed right-0 bottom-0 left-0 z-80 flex max-h-[88vh] flex-col rounded-t-[18px] border-t border-border-strong bg-surface text-foreground motion-safe:animate-[re-slide-up_220ms_cubic-bezier(0.2,0.8,0.2,1)]"
      >
        <div aria-hidden="true" className="mx-auto mt-2 h-1 w-10 rounded-sm bg-border-hover" />
        <header className="flex items-center justify-between px-[18px] pt-2 pb-1.5">
          <h2 id={titleId} className="m-0 text-base font-semibold">
            {title}
          </h2>
          <CloseButton onClick={() => onClose(true)} />
        </header>
        <div className="overflow-auto overscroll-contain px-[18px] pt-1.5 pb-[18px]">{body}</div>
        <div className="px-[18px] empty:hidden [&>div]:mt-0 [&>div]:mb-2.5">
          <UnknownBox filterKey={filterKey} />
        </div>
        <footer className="flex items-center justify-between gap-3 border-t border-border px-[18px] pt-3 pb-[calc(12px+env(safe-area-inset-bottom))]">
          <ClearLink onClick={clear} label="Clear" />
          <ShowButton onClick={() => onClose(true)} long />
        </footer>
      </div>
    </>,
    document.body,
  );
}

/** "All filters": every filter in its group, with jump links and a live "Show N". */
function AllFilters({ onClose }: { onClose: () => void }) {
  const { form, update, data } = useBrowse();
  const titleId = useId();
  const sheet = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState<string | null>(null);
  useBodyLock(true);

  useEffect(() => {
    sheet.current?.querySelector<HTMLElement>('[aria-label="Close"]')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const groups: { group: Group | 'Type' | 'Display'; keys: FilterKey[] }[] = [
    { group: 'Type', keys: [] },
    ...GROUPS.map((group) => ({
      group,
      keys: FILTER_KEYS.filter(
        (key) =>
          key !== 'types' &&
          FILTER_UI[key]?.group === group &&
          applies(key, form.kind, data.surface),
      ),
    })).filter(({ keys }) => keys.length > 0),
    { group: 'Display', keys: [] },
  ];
  const anchor = (group: string) => `browse-group-${group.toLowerCase()}`;

  return createPortal(
    <>
      <Scrim onClick={onClose} />
      <div
        ref={sheet}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={trapTab}
        className="fixed top-0 right-0 bottom-0 z-80 flex w-screen flex-col bg-surface text-foreground motion-safe:animate-[re-slide-left_200ms_cubic-bezier(0.2,0.8,0.2,1)] min-[900px]:w-[min(600px,100vw)] min-[900px]:border-l min-[900px]:border-border-strong"
      >
        <header className="border-b border-border px-5 pt-3.5">
          <div className="flex items-center justify-between">
            <h2 id={titleId} className="m-0 text-[17px] font-semibold">
              All filters
            </h2>
            <CloseButton onClick={onClose} />
          </div>
          <nav
            aria-label="Filter groups"
            className="-mx-5 mt-2.5 flex gap-1 overflow-x-auto px-5 pb-2.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {groups.map(({ group, keys }) => {
              const set = keys.some((key) => isActive(key, form));
              return (
                <a
                  key={group}
                  href={`#${anchor(group)}`}
                  aria-current={current === group ? 'location' : undefined}
                  onClick={(event) => {
                    event.preventDefault();
                    document.getElementById(anchor(group))?.scrollIntoView({ block: 'start' });
                  }}
                  className={`flex-none rounded-full px-[11px] py-1 text-[13px] whitespace-nowrap ${
                    current === group
                      ? 'bg-surface-raised text-foreground shadow-[inset_0_0_0_1px_var(--color-border-strong)]'
                      : 'text-muted hover:bg-surface-raised hover:text-foreground'
                  }`}
                >
                  <BrowseIconSvg
                    name={GROUP_ICON[group]}
                    className="mr-1.5 inline size-[15px] align-[-2px]"
                  />
                  {group}
                  {set ? (
                    <>
                      <span
                        aria-hidden="true"
                        className="ml-[5px] inline-block size-1.5 rounded-full bg-accent-line align-[2px]"
                      />
                      <span className="sr-only"> (set)</span>
                    </>
                  ) : null}
                </a>
              );
            })}
          </nav>
        </header>
        <div
          onScroll={(event) => {
            const box = event.currentTarget;
            let seen: string | null = null;
            for (const { group } of groups) {
              const el = document.getElementById(anchor(group));
              if (el !== null && el.offsetTop - box.offsetTop <= box.scrollTop + 40) seen = group;
            }
            setCurrent(seen);
          }}
          className="flex-1 overflow-auto overscroll-contain px-5 pb-7 motion-safe:scroll-smooth"
        >
          {groups.map(({ group, keys }) => (
            <div key={group}>
              <div
                id={anchor(group)}
                className="sticky top-0 z-[2] -mx-5 bg-gradient-to-b from-surface from-80% to-transparent px-5 pt-3.5 pb-2 text-xs font-semibold text-faint"
              >
                <BrowseIconSvg
                  name={GROUP_ICON[group]}
                  className="mr-1.5 inline size-[15px] align-[-2px]"
                />
                {group === 'Requirements' ? 'Requirements · hr.ge' : group}
              </div>
              {group === 'Type' ? (
                <>
                  <Section title="Kind">
                    <KindSeg big stretch />
                  </Section>
                  <Section title="Search">
                    <SearchBox inSheet />
                  </Section>
                </>
              ) : group === 'Display' ? (
                <Section title="Order">
                  <SortSelect className="w-full" />
                </Section>
              ) : (
                keys.map((key) => (
                  <Section
                    key={key}
                    title={titleOf(key, form.kind)}
                    sub={FILTER_UI[key]?.source?.(form.kind) ?? ''}
                    onClear={isActive(key, form) ? () => update(clearFilter(form, key)) : undefined}
                  >
                    <FilterBody filterKey={key} inSheet />
                    <UnknownBox filterKey={key} />
                  </Section>
                ))
              )}
              {group === 'What' && form.kind === '' ? (
                <Note>
                  Fields, salary, fees and the rest depend on the kind: pick Jobs, Tenders or
                  Courses above.
                </Note>
              ) : null}
              {group === 'Listing' && data.surface === 'public' ? (
                <Note>
                  State (open, closed, expired) is not here: every row on this site is open.
                </Note>
              ) : null}
            </div>
          ))}
        </div>
        {data.extra > 0 ? (
          <p className="m-0 border-t border-border bg-warn-soft px-5 py-2 text-[13px] text-warn">
            {fmt(data.extra)} more would match if the listings that don’t state what a filter asks
            were kept. Each filter above says how many it leaves out.
          </p>
        ) : null}
        <footer className="flex items-center justify-between gap-3 border-t border-border bg-surface px-5 py-3">
          <ClearLink onClick={() => update(clearAll(form))} label="Clear all" />
          <ShowButton onClick={onClose} long />
        </footer>
      </div>
    </>,
    document.body,
  );
}

function Section({
  title,
  sub = '',
  onClear,
  children,
}: {
  title: string;
  sub?: string;
  onClear?: (() => void) | undefined;
  children: ReactNode;
}) {
  return (
    <section className="border-b border-border pt-2.5 pb-4 last:border-b-0">
      <h3 className="mb-2.5 flex items-baseline justify-between gap-3 text-sm font-semibold">
        <span>
          {title}
          {sub === '' ? null : <span className="text-xs font-normal text-faint"> · {sub}</span>}
        </span>
        {onClear === undefined ? null : <ClearLink onClick={onClear} />}
      </h3>
      {children}
    </section>
  );
}
