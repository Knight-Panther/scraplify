'use client';

import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import type { FacetKey } from '../../../src/realestate/facets.js';
import type { RealEstateForm } from '../../lib/real-estate-form.js';
import {
  chipFilters,
  clearAll,
  detailFiltersOn,
  FILTER,
  FILTER_GROUPS,
  FILTERS,
  type FilterGroup,
  type FilterKey,
  fmt,
  KIND_NAMES,
  PROMOTED,
} from '../../lib/real-estate-registry.js';
import {
  AreaBody,
  DealSeg,
  FACET_OF,
  FloorBody,
  KindChips,
  KitchenBody,
  MetroBody,
  Note,
  OptionChips,
  PriceBody,
  SortSelect,
  UncertainBody,
  ViewSeg,
  YardBody,
} from './bodies.js';
import { ClearLink, CloseButton, PILL, Scrim, trapTab, useBodyLock } from '../filter-ui.js';
import { Caret, Icon, type IconName } from './icons.js';
import { useShell, useWide } from './shell.js';
import { useFacets } from './use-facets.js';
import { WhereBox } from './where-box.js';

/**
 * The Real estate filter bar (Phase 16B, the approved mockup): the deal, the
 * kind and the Where box on the first row; under them the filters people
 * narrow by first for the chosen kind, and "All filters". On a wide screen a
 * pill opens a popover under itself; on a phone, a sheet from the bottom.
 */

const PILL_ICON: Readonly<Partial<Record<FilterKey, IconName>>> = {
  price: 'price',
  rooms: 'rooms',
  metro: 'metro',
  area: 'area',
  floor: 'floor',
  yard: 'yard',
  ctype: 'space',
  ltype: 'plot',
};

const GROUP_ICON: Readonly<Record<FilterGroup | 'Display', IconName>> = {
  Type: 'any',
  Location: 'pin',
  Price: 'price',
  'Size and layout': 'layout',
  Building: 'building',
  Features: 'sparkle',
  Listing: 'tag',
  Display: 'sliders',
};

/** The facets a filter's panel shows counts from. */
function facetsFor(key: FilterKey | 'kind'): FacetKey[] {
  switch (key) {
    case 'metro':
      return ['metroStations', 'metroCoverage'];
    case 'price':
      return ['price'];
    case 'uncertain':
      return ['uncertain'];
    default: {
      const facet = FACET_OF[key];
      return facet === undefined ? [] : [facet as FacetKey];
    }
  }
}

type Facets = ReturnType<typeof useFacets>;

/** A filter's controls, the same wherever they are drawn. */
function FilterBody({
  filterKey,
  facets,
  inSheet,
}: {
  filterKey: FilterKey;
  facets: Facets;
  inSheet: boolean;
}) {
  const wide = useWide();
  switch (filterKey) {
    case 'deal':
      return <DealSeg stretch={inSheet} />;
    case 'kind':
      return <KindChips facets={facets} />;
    case 'where':
      return <WhereBox inSheet />;
    case 'metro':
      return <MetroBody facets={facets} foldStations={inSheet || !wide} />;
    case 'uncertain':
      return <UncertainBody facets={facets} />;
    case 'price':
      return <PriceBody facets={facets} />;
    case 'area':
      return <AreaBody />;
    case 'yard':
      return <YardBody />;
    case 'kitchen':
      return <KitchenBody />;
    case 'floor':
      return <FloorBody />;
    case 'proj':
      return <OptionChips filterKey={filterKey} facets={facets} fold={inSheet ? 8 : undefined} />;
    case 'am':
      return <OptionChips filterKey={filterKey} facets={facets} fold={inSheet ? 10 : undefined} />;
    default:
      return <OptionChips filterKey={filterKey} facets={facets} />;
  }
}

export function FilterBar() {
  const { form } = useShell();
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

  const toggle = (key: FilterKey, button: HTMLButtonElement) => {
    if (open?.key === key) close(true);
    else setOpen({ key, button });
  };

  // A change of screen width swaps a popover for a sheet: close it instead.
  const lastWide = useRef(wide);
  useEffect(() => {
    if (lastWide.current !== wide) setOpen(null);
    lastWide.current = wide;
  }, [wide]);

  const promoted = (PROMOTED[form.kind] ?? PROMOTED[''] ?? []).filter((key) =>
    FILTER[key].applies(form),
  );
  const badge = chipFilters(form).length;

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
      <Icon name="sliders" className="size-4 text-faint" />
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
      onClick={(button) => toggle(key, button)}
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
            <DealSeg stretch={!wide} />
          </div>
          <KindButton
            expanded={open?.key === 'kind'}
            onClick={(button) => toggle('kind' as FilterKey, button)}
          />
          <WhereBox />
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
            sheetFrom.focus();
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
  const { form, placeNames } = useShell();
  const filter = FILTER[filterKey];
  const on = filter.active(form);
  const names = new Map([...placeNames].map(([value, label]) => [value, label.nameKa]));
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      aria-expanded={expanded}
      onClick={(event) => onClick(event.currentTarget)}
      className={`${PILL} ${on ? 'border-accent-line bg-brand-soft' : ''}`}
    >
      <Icon
        name={PILL_ICON[filterKey] ?? 'sliders'}
        className={`size-4 ${on ? 'text-accent' : 'text-faint'}`}
      />
      {filter.short ?? filter.title(form)}
      {on ? (
        <span className="max-w-64 truncate text-accent">
          {filter.summary(form, { placeNames: names })}
        </span>
      ) : null}
      <Caret open={expanded} />
    </button>
  );
}

const KIND_ICON: Readonly<Record<string, IconName>> = {
  '': 'any',
  flat: 'flat',
  house: 'house',
  cottage: 'cottage',
  commercial: 'commercial',
  land: 'land',
  hotel: 'hotel',
};

function KindButton({
  expanded,
  onClick,
}: {
  expanded: boolean;
  onClick: (button: HTMLButtonElement) => void;
}) {
  const { form } = useShell();
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      aria-expanded={expanded}
      aria-label={`Kind: ${form.kind === '' ? 'any kind' : KIND_NAMES[form.kind]}`}
      onClick={(event) => onClick(event.currentTarget)}
      className={`${PILL} h-10 flex-none rounded-[var(--radius)]`}
    >
      <Icon name={KIND_ICON[form.kind] ?? 'any'} className="size-[18px] text-faint" />
      {form.kind === '' ? 'Any kind' : KIND_NAMES[form.kind]}
      <Caret open={expanded} />
    </button>
  );
}

/** "Show 1,234 properties": the server's count for the form it last answered. */
function ShowButton({ onClick, long }: { onClick: () => void; long: boolean }) {
  const { total, exact, form, pending } = useShell();
  const noun =
    form.view === 'all'
      ? total === 1
        ? 'listing'
        : 'listings'
      : total === 1
        ? 'property'
        : 'properties';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-busy={pending}
      className="inline-flex items-center gap-2 whitespace-nowrap rounded-[var(--radius)] border border-brand bg-brand px-3.5 py-[7px] text-sm font-semibold text-ink hover:border-brand-hover hover:bg-brand-hover"
    >
      Show{' '}
      <span className={`numeric ${pending ? 'opacity-60' : ''}`}>
        {exact ? fmt(total) : `${fmt(total)}+`}
      </span>
      {long ? ` ${noun}` : null}
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
  const { form, update } = useShell();
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const facets = useFacets(form, facetsFor(filterKey), true);
  const filter = FILTER[filterKey];
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);

  // Under the pill, kept inside the page's width.
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

  // Into the panel once it is placed: a hidden element cannot take focus.
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

  const clear = () => update(filter.clear(form));
  const title = filterKey === 'kind' ? 'Kind' : filter.title(form);
  const body = (
    <>
      <FilterBody filterKey={filterKey} facets={facets} inSheet={false} />
      {filter.detail ? <DetailNote /> : null}
    </>
  );

  if (wide) {
    return createPortal(
      <div
        ref={panel}
        role="dialog"
        aria-labelledby={titleId}
        style={place === null ? { visibility: 'hidden' } : { left: place.left, top: place.top }}
        className={`absolute z-50 rounded-2xl border border-border-strong bg-surface p-4 text-foreground shadow-pop motion-safe:animate-[re-pop_140ms_cubic-bezier(0.2,0.8,0.2,1)] ${
          filterKey === 'metro'
            ? 'w-[min(620px,calc(100vw-32px))]'
            : 'w-[min(440px,calc(100vw-32px))]'
        }`}
      >
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 id={titleId} className="m-0 text-[15px] font-semibold">
            {title}
          </h2>
          {filterKey === 'kind' ? null : <ClearLink onClick={clear} />}
        </div>
        {body}
        {filterKey === 'kind' ? null : (
          <div className="mt-4 flex items-center justify-between gap-3 border-t border-border pt-3">
            <span className="text-[13px] text-faint">Changes apply at once.</span>
            <ShowButton onClick={() => onClose(true)} long={false} />
          </div>
        )}
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
        <footer className="flex items-center justify-between gap-3 border-t border-border px-[18px] pt-3 pb-[calc(12px+env(safe-area-inset-bottom))]">
          {filterKey === 'kind' ? <span /> : <ClearLink onClick={clear} label="Clear" />}
          <ShowButton onClick={() => onClose(true)} long />
        </footer>
      </div>
    </>,
    document.body,
  );
}

/** Under a filter read from the listing's own page: how many listings it can judge. */
function DetailNote() {
  const { coverage } = useShell();
  return (
    <Note warn>
      Read from the listing’s own page
      {coverage === null
        ? ', so it sees only listings whose page has been read.'
        : `: read for ${fmt(coverage.read)} of the ${fmt(coverage.total)} listings matching everything else.`}
    </Note>
  );
}

/** Every facet the sheet's sections show, for the filters the form's kind offers. */
function sheetFacets(form: RealEstateForm): FacetKey[] {
  const keys: FacetKey[] = ['kind'];
  for (const filter of FILTERS) {
    if (filter.applies(form)) keys.push(...facetsFor(filter.key));
  }
  return keys;
}

/** "All filters": every filter in its group, with jump links and a live "Show N". */
function AllFilters({ onClose }: { onClose: () => void }) {
  const { form, update } = useShell();
  const titleId = useId();
  const sheet = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const facets = useFacets(form, sheetFacets(form), true);
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

  const groups = [...FILTER_GROUPS, 'Display' as const]
    .map((group) => ({
      group,
      keys:
        group === 'Display'
          ? []
          : FILTERS.filter((f) => f.group === group && f.applies(form)).map((f) => f.key),
    }))
    .filter(({ group, keys }) => group === 'Display' || keys.length > 0);
  const anchor = (group: string) => `re-group-${group.replace(/\W+/g, '-').toLowerCase()}`;
  const detailOn = detailFiltersOn(form).length > 0;

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
              const set = keys.some((key) => !FILTER[key].noChip && FILTER[key].active(form));
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
                  <Icon
                    name={GROUP_ICON[group]}
                    className="mr-1.5 inline size-[15px] align-[-2px]"
                  />
                  {group}
                  {set ? (
                    <span className="ml-[5px] inline-block size-1.5 rounded-full bg-accent-line align-[2px]">
                      <span className="sr-only"> (set)</span>
                    </span>
                  ) : null}
                </a>
              );
            })}
          </nav>
        </header>
        <div
          ref={body}
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
                className="sticky top-0 z-[2] -mx-5 bg-gradient-to-b from-surface from-80% to-transparent px-5 pt-3.5 pb-2 text-xs font-semibold tracking-[0.02em] text-faint"
              >
                <Icon name={GROUP_ICON[group]} className="mr-1.5 inline size-[15px] align-[-2px]" />
                {group}
              </div>
              {group === 'Display' ? (
                <>
                  <Section title="Look-alike listings">
                    <ViewSeg long />
                    <Note>
                      The same home posted by its owner and by agents is one row, unless you want
                      each copy.
                    </Note>
                  </Section>
                  <Section title="Order">
                    <SortSelect className="w-full" />
                  </Section>
                </>
              ) : (
                keys.map((key) => (
                  <Section
                    key={key}
                    title={FILTER[key].title(form)}
                    detail={FILTER[key].detail === true}
                    onClear={
                      key === 'deal' || !FILTER[key].active(form)
                        ? undefined
                        : () => update(FILTER[key].clear(form))
                    }
                  >
                    <FilterBody filterKey={key} facets={facets} inSheet />
                  </Section>
                ))
              )}
              {group === 'Features' && form.kind === '' ? (
                <Note>Amenities depend on the kind: pick one under Type to see its list.</Note>
              ) : null}
            </div>
          ))}
        </div>
        {detailOn ? (
          <div className="border-t border-border bg-warn-soft px-5 py-2">
            <SheetCoverage />
          </div>
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

function SheetCoverage() {
  const { coverage } = useShell();
  return (
    <p className="m-0 text-[13px] text-warn">
      Filters marked “from the listing page” see only listings whose own page has been read
      {coverage === null
        ? '.'
        : `: ${fmt(coverage.read)} of the ${fmt(coverage.total)} matching everything else.`}
    </p>
  );
}

function Section({
  title,
  detail = false,
  onClear,
  children,
}: {
  title: string;
  detail?: boolean;
  onClear?: (() => void) | undefined;
  children: ReactNode;
}) {
  return (
    <section className="border-b border-border pt-2.5 pb-4 last:border-b-0">
      <h3 className="mb-2.5 flex items-baseline justify-between gap-3 text-sm font-semibold">
        <span>
          {title}
          {detail ? (
            <span className="text-xs font-normal text-faint"> · from the listing page</span>
          ) : null}
        </span>
        {onClear === undefined ? null : <ClearLink onClick={onClear} />}
      </h3>
      {children}
    </section>
  );
}

export type { RefObject };
