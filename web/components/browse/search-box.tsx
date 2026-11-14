'use client';

import { useEffect, useId, useRef, useState } from 'react';
import {
  asKind,
  type BrowseForm,
  type BrowseKind,
  formSearch,
} from '../../../src/browse/browse-form.js';
import { fmt } from '../../lib/browse-registry.js';
import { BrowseIconSvg } from './icons.js';
import { useBrowse } from './shell.js';

/**
 * One box for words, places, fields and organisations (the approved
 * mockup): typing offers cities, countries, fields, employers, buyers and
 * schools, each with what it would show; Enter on its own searches the words.
 * Picking a field switches to its kind; a city under "Courses" switches to
 * jobs, where cities are.
 */

export interface Suggestion {
  type: 'place' | 'field' | 'org';
  value: string;
  kind: BrowseKind | null;
  label: string;
  hint: string;
  lang: 'ka' | 'en';
  n: number;
}

interface SuggestAnswer {
  groups: { title: string; entries: Suggestion[] }[];
}

const KIND_DOT: Readonly<Record<string, string>> = {
  job: 'bg-kind-job',
  tender: 'bg-kind-tender',
  course: 'bg-kind-course',
};
const ORG_WORD: Readonly<Record<string, string>> = {
  job: 'employer',
  tender: 'buyer',
  course: 'school',
};

const PAUSE_MS = 140;

export function SearchBox({ inSheet = false }: { inSheet?: boolean }) {
  const { form, update, data, label, remember } = useBrowse();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [answer, setAnswer] = useState<SuggestAnswer | null>(null);

  // What to offer: asked of the server for the typed text under the current form.
  const formKey = formSearch({ ...form, show: 0 });
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const params = new URLSearchParams(formKey);
      params.set('typed', text.trim());
      fetch(`/opportunities/suggest?${params}`, { signal: controller.signal })
        .then((r) => (r.ok ? (r.json() as Promise<SuggestAnswer>) : null))
        .then((a) => {
          if (a === null) return;
          // A new list: nothing in it is highlighted yet.
          setAnswer(a);
          setActive(-1);
        })
        .catch(() => {});
    }, PAUSE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, text, formKey]);

  const options = (answer?.groups ?? []).flatMap((g) => g.entries);

  const choose = (s: Suggestion) => {
    let next: BrowseForm = form;
    if (s.type === 'place') {
      const kind = s.value.startsWith('g:') ? 'job' : 'course';
      if (next.kind !== '' && next.kind !== kind)
        next = asKind(next, next.kind === 'tender' ? '' : kind, data.surface);
      if (!next.place.includes(s.value)) next = { ...next, place: [...next.place, s.value] };
      remember('place', { value: s.value, label: s.label, hint: s.hint, n: s.n, lang: s.lang });
    } else if (s.type === 'field' && s.kind !== null) {
      next = asKind(next, s.kind, data.surface);
      if (!next.field.includes(s.value)) next = { ...next, field: [...next.field, s.value] };
      remember('field', { value: s.value, label: s.label, hint: s.hint, n: s.n, lang: s.lang });
    } else if (!next.org.includes(s.value)) {
      next = { ...next, org: [...next.org, s.value] };
    }
    setText('');
    setActive(-1);
    update(next);
    input.current?.focus();
  };

  const searchWords = () => {
    const words = text.trim();
    if (words === '') return;
    setText('');
    update({ ...form, q: form.q === '' ? words : `${form.q} ${words}` });
  };

  const tokens: { key: string; text: string; word: string; remove: () => BrowseForm }[] = [
    ...(form.q === ''
      ? []
      : [{ key: 'q', text: form.q, word: 'words', remove: () => ({ ...form, q: '' }) }]),
    ...form.org.map((org) => ({
      key: `o|${org}`,
      text: org,
      word: ORG_WORD[data.orgKinds[org] ?? ''] ?? 'organisation',
      remove: () => ({ ...form, org: form.org.filter((o) => o !== org) }),
    })),
    ...form.field.map((f) => ({
      key: `f|${f}`,
      text: label('field', f),
      word: f.startsWith('t:') ? 'category' : 'field',
      remove: () => ({ ...form, field: form.field.filter((x) => x !== f) }),
    })),
    ...form.place.map((p) => ({
      key: `p|${p}`,
      text: label('place', p),
      word: p.startsWith('g:') ? 'city' : 'country',
      remove: () => ({ ...form, place: form.place.filter((x) => x !== p) }),
    })),
  ];

  const move = (delta: number) => {
    if (options.length === 0) return;
    setActive((current) => (current + delta + options.length) % options.length);
  };
  const activeId = active >= 0 && active < options.length ? `${id}-o${active}` : undefined;

  useEffect(() => {
    if (activeId === undefined) return;
    document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' });
  }, [activeId]);

  const placeholder =
    tokens.length > 0
      ? 'Add…'
      : inSheet
        ? 'Words, employer, city, field…'
        : 'Search titles, employers, cities, fields…';

  let index = -1;
  return (
    <div
      className={`relative min-w-0 ${inSheet ? '' : 'flex-[1_1_100%] min-[900px]:flex-[1_1_360px]'}`}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a click on the box's empty space focuses its input */}
      <div
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) {
            event.preventDefault();
            input.current?.focus();
          }
        }}
        className="flex min-h-10 cursor-text flex-wrap items-center gap-1 rounded-[var(--radius)] border border-border-strong bg-surface py-[3px] pr-1.5 pl-9 hover:border-border-hover focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring"
      >
        <BrowseIconSvg
          name="search"
          className="pointer-events-none absolute top-[11px] left-[11px] size-[17px] text-faint"
        />
        {tokens.map((token) => (
          <span
            key={token.key}
            className="inline-flex max-w-full items-center gap-0.5 rounded-lg border border-border-strong bg-surface-raised py-0 pr-0.5 pl-[9px] text-[13px] motion-safe:animate-[re-token_160ms_cubic-bezier(0.2,0.8,0.2,1)]"
          >
            <span className="truncate" lang={/[Ⴀ-ჿ]/u.test(token.text) ? 'ka' : undefined}>
              {token.text}
            </span>
            <span className="ml-1 text-[11px] text-faint">{token.word}</span>
            <button
              type="button"
              aria-label={`Remove ${token.text}`}
              onClick={() => {
                update(token.remove());
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
          name="q"
          aria-label="Search"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={`${id}-list`}
          aria-activedescendant={activeId}
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          value={text}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onChange={(event) => {
            setText(event.target.value);
            setActive(-1);
            setOpen(true);
          }}
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
              if (active >= 0 && option !== undefined) choose(option);
              else searchWords();
            } else if (event.key === 'Escape') {
              if (open) {
                event.stopPropagation();
                setOpen(false);
              }
            } else if (event.key === 'Backspace' && text === '' && tokens.length > 0) {
              const last = tokens[tokens.length - 1];
              if (last !== undefined) update(last.remove());
            }
          }}
          className="min-w-28 flex-[1_1_9rem] border-0 bg-transparent p-1 text-sm text-foreground outline-none placeholder:text-faint"
        />
      </div>
      {open ? (
        <div
          id={`${id}-list`}
          role="listbox"
          aria-label="Suggestions"
          className="absolute top-[calc(100%+6px)] right-0 left-0 z-60 max-h-[min(60vh,460px)] overflow-auto rounded-2xl border border-border-strong bg-surface p-1.5 shadow-pop motion-safe:animate-[re-pop_140ms_cubic-bezier(0.2,0.8,0.2,1)]"
        >
          {text.trim() === '' ? (
            <div className="px-2.5 py-2 text-[13px] text-faint">
              A job title, an employer, a city or country, a field. Georgian or English. Enter
              searches the words as typed.
            </div>
          ) : null}
          {(answer?.groups ?? []).map((group) => (
            <div key={group.title} role="presentation">
              <div className="px-2.5 pt-2 pb-0.5 text-xs text-faint">{group.title}</div>
              {group.entries.map((s) => {
                index++;
                const i = index;
                return (
                  <div
                    key={`${s.type}|${s.value}`}
                    id={`${id}-o${i}`}
                    role="option"
                    tabIndex={-1}
                    aria-selected={i === active}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      choose(s);
                    }}
                    className={`flex cursor-pointer items-baseline justify-between gap-3 rounded-lg px-2.5 py-1.5 ${
                      i === active
                        ? 'bg-surface-raised shadow-[inset_2px_0_0_var(--color-accent-line)]'
                        : ''
                    }`}
                  >
                    <span
                      className={`flex min-w-0 items-baseline gap-1.5 overflow-hidden whitespace-nowrap ${s.n === 0 ? 'text-faint' : ''}`}
                    >
                      <i
                        aria-hidden="true"
                        className={`size-2 flex-none self-center rounded-full ${KIND_DOT[s.kind ?? ''] ?? 'bg-faint'}`}
                      />
                      <span lang={s.lang} className="min-w-0 truncate">
                        {s.label}
                      </span>
                      {s.hint === '' ? null : (
                        <span className="flex-none text-[13px] text-faint">{s.hint}</span>
                      )}
                    </span>
                    <span className="numeric flex-none text-xs text-faint">{fmt(s.n)}</span>
                  </div>
                );
              })}
            </div>
          ))}
          {text.trim() === '' ? null : (
            <div className="px-2.5 py-2 text-[13px] text-faint">
              {options.length > 0
                ? `Enter on its own searches titles for “${text.trim()}”.`
                : `Nothing to pick for “${text.trim()}”. Press Enter to search titles, employers and places for it.`}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
