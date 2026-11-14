'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { PlaceSuggestion, PlaceSuggestions } from '../../../src/realestate/facets.js';
import { MAX_PLACES, METRO_STATIONS, stationLine } from '../../lib/real-estate-form.js';
import { fmt } from '../../lib/real-estate-registry.js';
import { Icon } from './icons.js';
import { useShell, useWide } from './shell.js';
import { fetchPlaces } from './use-facets.js';

/**
 * One box for every kind of place (plan 16B "Where"): a neighbourhood, an
 * ss.ge or official district, a city, a street or a metro station, in
 * Georgian or English, several at once. Enter on its own looks for the words
 * in the listing instead. A combobox with a list box, keyboard first.
 */

const GROUP_TITLES: Readonly<Record<string, string>> = {
  area: 'Neighbourhoods',
  district: 'Districts (ss.ge)',
  official: 'Official districts',
  city: 'Cities and towns',
  metro: 'Metro stations',
  street: 'Streets',
};

const LEVEL_WORD: Readonly<Record<string, string>> = {
  city: 'city',
  municipality: 'municipality',
  district: 'district',
  subdistrict: '',
  neighbourhood: '',
  official_district: 'official',
  street: 'street',
};

interface Option {
  place: PlaceSuggestion;
  id: string;
}

export function WhereBox({ inSheet = false }: { inSheet?: boolean }) {
  const { form, update, placeNames, rememberPlace } = useShell();
  const wide = useWide();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [answer, setAnswer] = useState<PlaceSuggestions | null>(null);

  // Ask the server a moment after the last key; the newest answer wins.
  const formRef = useRef(form);
  formRef.current = form;
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetchPlaces(formRef.current, text.trim(), controller.signal)
        .then((suggestions) => {
          setAnswer(suggestions);
          setActive(-1);
        })
        .catch(() => {});
    }, 140);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [text, open]);

  const chosen = new Set([...form.pl, ...form.ms.map((code) => `metro_station:${code}`)]);
  const options: Option[] = [];
  const groups = (answer?.groups ?? []).map((group) => ({
    group: group.group,
    places: group.places
      .filter((place) => !chosen.has(keyOf(place)))
      .map((place) => {
        const option = { place, id: `${id}-o${options.length}` };
        options.push(option);
        return option;
      }),
  }));

  const choose = (place: PlaceSuggestion) => {
    if (place.level === 'metro_station') {
      const code = place.code ?? '';
      if (!form.ms.includes(code)) {
        // A station on its own means within a walk: 15 minutes unless a time is set.
        update({ ...form, ms: [...form.ms, code], mm: form.mm === '' ? '15' : form.mm });
      }
    } else if (form.pl.length < MAX_PLACES) {
      const value = `${place.level}:${place.ref}`;
      rememberPlace({
        value,
        nameKa: place.nameKa,
        nameEn: place.nameEn,
        kind: LEVEL_WORD[place.level] ?? '',
      });
      update({ ...form, pl: [...form.pl, value] });
    }
    setText('');
    input.current?.focus();
  };

  const tokens = [
    ...form.pl.map((value) => {
      const label = placeNames.get(value);
      return {
        key: value,
        text: label?.nameKa ?? value,
        kind: label?.kind ?? '',
        line: null as 1 | 2 | null,
        remove: () => update({ ...form, pl: form.pl.filter((v) => v !== value) }),
      };
    }),
    ...form.ms.map((code) => ({
      key: `metro:${code}`,
      text: METRO_STATIONS.find((station) => station.code === code)?.ka ?? code,
      kind: 'metro',
      line: stationLine(code),
      remove: () => update({ ...form, ms: form.ms.filter((c) => c !== code) }),
    })),
    ...(form.q === ''
      ? []
      : [
          {
            key: 'words',
            text: form.q,
            kind: 'words',
            line: null as 1 | 2 | null,
            remove: () => update({ ...form, q: '' }),
          },
        ]),
  ];

  const move = (step: number) => {
    if (options.length === 0) return;
    const next = (active + step + options.length) % options.length;
    setActive(next);
    document.getElementById(options[next]?.id ?? '')?.scrollIntoView({ block: 'nearest' });
  };

  const placeholder =
    tokens.length > 0
      ? 'Add a place…'
      : inSheet
        ? 'Neighbourhood, district, street, metro…'
        : wide
          ? 'Where? Neighbourhood, street, metro…'
          : 'Where?';

  return (
    <div
      className={`relative min-w-0 ${inSheet ? '' : 'flex-[1_1_200px] min-[900px]:flex-[1_1_360px]'}`}
    >
      {/* A click on the box's empty part focuses the input, as a text field would. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the input inside is the control */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the input inside takes the keys */}
      <div
        onClick={(event) => {
          if (event.target === event.currentTarget) input.current?.focus();
        }}
        className="flex min-h-10 cursor-text flex-wrap items-center gap-1 rounded-[var(--radius)] border border-border-strong bg-surface py-[3px] pr-1.5 pl-9 hover:border-border-hover focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring"
      >
        <span className="pointer-events-none absolute top-[11px] left-[11px] text-faint">
          <Icon name="search" className="size-[17px]" />
        </span>
        {tokens.map((token) => (
          <span
            key={token.key}
            className="inline-flex max-w-full items-center gap-0.5 rounded-lg border border-border-strong bg-surface-raised py-0 pr-0.5 pl-[9px] text-[13px] motion-safe:animate-[re-token_160ms_cubic-bezier(0.2,0.8,0.2,1)]"
          >
            {token.line === null ? null : (
              <i
                aria-hidden="true"
                className={`mr-[3px] size-2 rounded-full ${token.line === 1 ? 'bg-metro-1' : 'bg-metro-2'}`}
              />
            )}
            <span className="truncate">{token.text}</span>
            {token.kind === '' ? null : (
              <span className="ml-1 text-[11px] text-faint">{token.kind}</span>
            )}
            <button
              type="button"
              aria-label={`Remove ${token.text}`}
              onClick={() => {
                token.remove();
                input.current?.focus();
              }}
              className="inline-grid size-[22px] place-items-center rounded-md text-base leading-none text-faint hover:bg-hover-strong hover:text-foreground"
            >
              ×
            </button>
          </span>
        ))}
        <input
          ref={input}
          type="text"
          role="combobox"
          aria-label="Where"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={`${id}-list`}
          aria-activedescendant={active >= 0 ? options[active]?.id : undefined}
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setOpen(true);
              move(1);
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              move(-1);
            } else if (event.key === 'Enter') {
              event.preventDefault();
              const option = options[active];
              if (option !== undefined) choose(option.place);
              else if (text.trim() !== '') {
                update({ ...form, q: text.trim() });
                setText('');
              }
            } else if (event.key === 'Escape') {
              if (open) {
                event.stopPropagation();
                setOpen(false);
              }
            } else if (event.key === 'Backspace' && text === '' && tokens.length > 0) {
              tokens[tokens.length - 1]?.remove();
            }
          }}
          className="min-w-28 flex-[1_1_9rem] border-0 bg-transparent p-1 text-sm text-foreground outline-none placeholder:text-faint"
        />
      </div>
      {open ? (
        <div
          id={`${id}-list`}
          role="listbox"
          aria-label="Places"
          className="absolute top-[calc(100%+6px)] right-0 left-0 z-[60] max-h-[min(60vh,460px)] overflow-auto rounded-2xl border border-border-strong bg-surface p-1.5 shadow-pop motion-safe:animate-[re-pop_140ms_cubic-bezier(0.2,0.8,0.2,1)]"
        >
          {text.trim() === '' ? (
            <div className="px-2.5 py-2 text-[13px] text-faint">
              A neighbourhood, district, street or metro station, in Georgian or English. Pick
              several to see them together.
            </div>
          ) : null}
          {groups.map(({ group, places }) =>
            places.length === 0 ? null : (
              // biome-ignore lint/a11y/useSemanticElements: a group of options inside a list box, as ARIA has it
              <div key={group} role="group" aria-label={GROUP_TITLES[group] ?? group}>
                <div role="presentation" className="px-2.5 pt-2 pb-0.5 text-xs text-faint">
                  {text.trim() === '' && group === 'area'
                    ? 'Popular'
                    : (GROUP_TITLES[group] ?? group)}
                </div>
                {places.map((option) => {
                  const index = options.indexOf(option);
                  const { place } = option;
                  return (
                    <div
                      key={option.id}
                      id={option.id}
                      role="option"
                      tabIndex={-1}
                      aria-selected={index === active}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        choose(place);
                      }}
                      className={`flex cursor-pointer items-baseline justify-between gap-3 rounded-lg px-2.5 py-1.5 ${
                        index === active
                          ? 'bg-surface-raised shadow-[inset_2px_0_0_var(--color-accent-line)]'
                          : 'hover:bg-hover'
                      }`}
                    >
                      <span className={`min-w-0 truncate ${place.count === 0 ? 'text-faint' : ''}`}>
                        {place.level === 'metro_station' ? (
                          <i
                            aria-hidden="true"
                            className={`mr-1.5 inline-block size-2 rounded-full ${
                              stationLine(place.code ?? '') === 1 ? 'bg-metro-1' : 'bg-metro-2'
                            }`}
                          />
                        ) : null}
                        {place.nameKa}
                        {place.nameEn === null || place.nameEn === '' ? null : (
                          <span className="ml-1.5 text-[13px] text-faint">{place.nameEn}</span>
                        )}
                        {place.parentKa === null ? null : (
                          <span className="ml-1.5 text-[13px] text-faint">{place.parentKa}</span>
                        )}
                      </span>
                      <span className="numeric shrink-0 text-xs text-faint">
                        {place.count === null ? '' : fmt(place.count)}
                      </span>
                    </div>
                  );
                })}
              </div>
            ),
          )}
          {text.trim() === '' ? null : (
            <div className="px-2.5 py-2 text-[13px] text-faint">
              {options.length > 0
                ? `Enter on its own looks for “${text.trim()}” in the listings.`
                : `No place matches “${text.trim()}”. Press Enter to look for these words in the listings.`}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function keyOf(place: PlaceSuggestion): string {
  return place.level === 'metro_station'
    ? `metro_station:${place.code}`
    : `${place.level}:${place.ref}`;
}
