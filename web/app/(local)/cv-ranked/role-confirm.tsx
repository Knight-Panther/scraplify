'use client';

import { type Ref, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  type MatchProfile,
  narrowerRoles,
  type ProfileTerm,
  type RoleOption,
  roleOptions,
  roleOptionTerm,
  userTerm,
  type Vocabulary,
} from '../../../../src/matching/lexical/profile.js';

/**
 * "Your roles" (the owner's CV-matching doc, "confirm your roles"): the
 * roles ranking compares vacancy titles with, as chips to switch on and
 * off, above the results. Correcting them is the biggest lever on quality
 * the model study found, bigger than any model: correcting the roles of 13
 * of its 34 CVs the way a person would took the English and Georgian ones
 * from nDCG@10 .822 to .867.
 *
 * Three kinds of suggestion, all off until chosen: roles the CV names only
 * in older posts, more specific kinds of a broad role in use ("Designer" →
 * "Graphic designer"), and any role picked from the list, lexicon rows and
 * recurring vacancy titles alike. Picked roles carry the same ids a CV
 * would yield, so they meet their precomputed title vectors.
 *
 * The profile column keeps each role's CV quote; this is the same state,
 * shown where the choice matters.
 */
export function RoleConfirm({
  profile,
  vocabulary,
  onChange,
}: {
  profile: MatchProfile;
  vocabulary: Vocabulary;
  onChange: (profile: MatchProfile) => void;
}) {
  const options = useMemo(() => roleOptions(vocabulary), [vocabulary]);
  // One list in profile order: a chip changes state in place rather than
  // moving between lists, so it keeps keyboard focus when toggled.
  const roles = profile.terms.filter((term) => term.kind === 'role');
  const narrower = narrowerRoles(profile, options);
  const listRef = useRef<HTMLUListElement>(null);
  // A chosen suggestion leaves its row; focus follows it to its new chip.
  const [focusId, setFocusId] = useState<string | null>(null);
  useEffect(() => {
    if (focusId === null) return;
    const chip = [...(listRef.current?.querySelectorAll('button') ?? [])].find(
      (button) => button.dataset.roleId === focusId,
    );
    chip?.focus();
    setFocusId(null);
  }, [focusId]);

  const toggle = (id: string) =>
    onChange({
      terms: profile.terms.map((term) =>
        term.id === id ? { ...term, active: !term.active } : term,
      ),
    });
  const add = (term: ProfileTerm) =>
    onChange({
      terms: profile.terms.some((candidate) => candidate.id === term.id)
        ? profile.terms.map((candidate) =>
            candidate.id === term.id ? { ...candidate, active: true } : candidate,
          )
        : [...profile.terms, term],
    });

  return (
    <section
      aria-labelledby="roles-confirm-heading"
      className="rounded-[var(--radius)] border border-border bg-surface px-4 py-4"
    >
      <h2 id="roles-confirm-heading" className="text-base font-semibold">
        Your roles
      </h2>
      <p className="mt-1 text-xs text-faint">
        Vacancy titles are compared with the roles switched on. Check they name the job you want; a
        more specific role usually ranks better.
      </p>

      {/* Wide screens put the picker beside the chips, so results start higher. */}
      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(18rem,26rem)] lg:gap-10">
        <div className="min-w-0">
          {roles.length === 0 ? (
            <p className="mt-3 text-sm text-muted">
              No role was found in the CV. Add the job you are looking for.
            </p>
          ) : (
            <ChipRow
              label="Ticked roles are used for matching; select one to switch it on or off"
              terms={roles}
              onToggle={toggle}
              listRef={listRef}
            />
          )}
          {roles.length > 0 && !roles.some((term) => term.active) && (
            <p className="mt-2 text-sm text-muted">
              No role is switched on, so only fields and skills are matched.
            </p>
          )}
          {narrower.length > 0 && (
            <ChipRow
              label="More specific — select to add"
              terms={narrower.map((option) => ({ ...roleOptionTerm(option), active: false }))}
              onToggle={(id) => {
                const option = narrower.find((candidate) => candidate.id === id);
                if (option === undefined) return;
                add(roleOptionTerm(option));
                setFocusId(option.id);
              }}
            />
          )}
        </div>
        <RolePicker options={options} vocabulary={vocabulary} onAdd={add} />
      </div>
    </section>
  );
}

function ChipRow({
  label,
  terms,
  onToggle,
  listRef,
}: {
  label: string;
  terms: ProfileTerm[];
  onToggle: (id: string) => void;
  listRef?: Ref<HTMLUListElement>;
}) {
  const labelId = useId();
  return (
    <div className="mt-3">
      <p id={labelId} className="text-xs text-faint">
        {label}
      </p>
      <ul ref={listRef} aria-labelledby={labelId} className="mt-1.5 flex flex-wrap gap-2">
        {terms.map((term) => (
          <li key={term.id} className="min-w-0 max-w-full">
            <button
              type="button"
              aria-pressed={term.active}
              data-role-id={term.id}
              onClick={() => onToggle(term.id)}
              className={`inline-flex min-h-9 max-w-full items-center gap-1.5 rounded-[var(--radius)] border px-3 py-1 text-left text-sm leading-[1.5] ${
                term.active
                  ? 'border-accent bg-surface-active text-foreground hover:bg-surface-raised'
                  : 'border-border-strong text-muted hover:bg-surface-raised hover:text-foreground'
              }`}
            >
              {term.active ? <CheckIcon /> : <PlusIcon />}
              <span className="min-w-0 break-words">{term.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RolePicker({
  options,
  vocabulary,
  onAdd,
}: {
  options: RoleOption[];
  vocabulary: Vocabulary;
  onAdd: (term: ProfileTerm) => void;
}) {
  const [text, setText] = useState('');
  const inputId = useId();
  const listId = useId();
  const hintId = useId();
  const typed = text.trim().replace(/\s+/g, ' ');
  const picked = options.find((option) => option.label === typed);
  const term = picked !== undefined ? roleOptionTerm(picked) : userTerm('role', typed, vocabulary);
  return (
    <form
      className="mt-4 flex max-w-xl flex-col gap-1.5 lg:mt-3"
      onSubmit={(event) => {
        // Never submitted anywhere: this only adds a role in memory.
        event.preventDefault();
        if (term === null) return;
        onAdd(term);
        setText('');
      }}
    >
      <label htmlFor={inputId} className="text-xs text-faint">
        Add a role
      </label>
      <div className="flex gap-2">
        <input
          id={inputId}
          name="role"
          type="text"
          list={listId}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="e.g. graphic designer…"
          aria-describedby={hintId}
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-[var(--radius)] border border-border bg-background px-3 py-1.5 text-sm text-foreground"
        />
        <button
          type="submit"
          disabled={term === null}
          className="shrink-0 rounded-[var(--radius)] border border-border-strong bg-surface-raised px-3 py-1.5 text-sm hover:bg-surface-active disabled:cursor-not-allowed disabled:text-faint disabled:hover:bg-surface-raised"
        >
          Add
        </button>
      </div>
      <datalist id={listId}>
        {options.map((option) => (
          <option key={option.id} value={option.label} />
        ))}
      </datalist>
      <p id={hintId} className="text-xs text-faint">
        In English or Georgian. Roles from the list are also matched by meaning.
      </p>
    </form>
  );
}

function CheckIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3.5 shrink-0 text-accent">
      <path
        d="M3 8.5 6.5 12 13 4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3.5 shrink-0">
      <path
        d="M8 3v10M3 8h10"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
