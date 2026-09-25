'use client';

import { useId, useState } from 'react';
import {
  type MatchProfile,
  type ProfileTerm,
  type TermKind,
  userTerm,
  type Vocabulary,
  type VocabularyOption,
  vocabularyTerm,
} from '../../../../src/matching/lexical/profile.js';
import { count } from '../../../lib/format.js';

/**
 * The editable, local profile (change.md §7 "Local profile extraction"):
 * every term the CV suggested, with the CV line that suggested it, plus
 * whatever the visitor adds. Each edit re-ranks in the worker.
 *
 * Language and work mode are not offered: no vacancy in the index states
 * either, so a filter on them would silently do nothing (docs/STATUS.md,
 * Phase 8D).
 */

const GROUPS: readonly {
  kind: TermKind;
  title: string;
  hint: string;
  add: 'text' | 'fields' | 'locations';
}[] = [
  {
    kind: 'role',
    title: 'Roles',
    hint: 'Compared with vacancy titles.',
    add: 'text',
  },
  {
    kind: 'field',
    title: 'Fields',
    hint: 'hr.ge categories. jobs.ge vacancies have none, so they match on title only.',
    add: 'fields',
  },
  {
    kind: 'skill',
    title: 'Skills',
    hint: 'Found in vacancy titles and categories. The index has no descriptions.',
    add: 'text',
  },
  {
    kind: 'location',
    title: 'Locations',
    hint: 'A filter: vacancies naming only other places are hidden. Ones naming no place stay, marked. Locations found in the CV start switched off.',
    add: 'locations',
  },
];

export function ProfileEditor({
  profile,
  vocabulary,
  onChange,
}: {
  profile: MatchProfile;
  vocabulary: Vocabulary;
  onChange: (profile: MatchProfile) => void;
}) {
  const update = (terms: ProfileTerm[]) => onChange({ terms });
  const add = (term: ProfileTerm) => {
    const existing = profile.terms.find((candidate) => candidate.id === term.id);
    update(
      existing
        ? profile.terms.map((candidate) =>
            candidate.id === term.id ? { ...candidate, active: true } : candidate,
          )
        : [...profile.terms, term],
    );
  };

  return (
    <section aria-labelledby="profile-heading" className="flex flex-col gap-6">
      <div>
        <h2 id="profile-heading" className="text-base font-semibold">
          Profile
        </h2>
        <p className="mt-1 text-xs text-faint">
          Suggested from your CV; correct it here. Unticked terms are kept but not used.
        </p>
      </div>
      {GROUPS.map((group) => (
        <TermGroup
          key={group.kind}
          group={group}
          terms={profile.terms.filter((term) => term.kind === group.kind)}
          options={
            group.add === 'fields'
              ? vocabulary.fields
              : group.add === 'locations'
                ? vocabulary.locations
                : null
          }
          onToggle={(id) =>
            update(
              profile.terms.map((term) =>
                term.id === id ? { ...term, active: !term.active } : term,
              ),
            )
          }
          onRemove={(id) => update(profile.terms.filter((term) => term.id !== id))}
          onAdd={add}
        />
      ))}
    </section>
  );
}

function TermGroup({
  group,
  terms,
  options,
  onToggle,
  onRemove,
  onAdd,
}: {
  group: (typeof GROUPS)[number];
  terms: ProfileTerm[];
  options: VocabularyOption[] | null;
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
  onAdd: (term: ProfileTerm) => void;
}) {
  const headingId = useId();
  return (
    <fieldset aria-labelledby={headingId} className="min-w-0">
      <legend className="sr-only">{group.title}</legend>
      <h3 id={headingId} className="text-sm font-semibold">
        {group.title}
      </h3>
      <p className="mt-0.5 text-xs text-faint">{group.hint}</p>
      {terms.length === 0 ? (
        <p className="mt-2 text-xs text-muted">None found in the CV.</p>
      ) : (
        <ul className="mt-2 flex flex-col">
          {terms.map((term) => (
            <TermRow
              key={term.id}
              term={term}
              onToggle={() => onToggle(term.id)}
              onRemove={() => onRemove(term.id)}
            />
          ))}
        </ul>
      )}
      {options === null ? (
        <TextAdder kind={group.kind as 'role' | 'skill'} title={group.title} onAdd={onAdd} />
      ) : (
        <OptionAdder
          kind={group.kind as 'field' | 'location'}
          title={group.title}
          options={options.filter(
            (option) => !terms.some((term) => term.id === `${group.kind}:${option.key}`),
          )}
          onAdd={onAdd}
        />
      )}
    </fieldset>
  );
}

function TermRow({
  term,
  onToggle,
  onRemove,
}: {
  term: ProfileTerm;
  onToggle: () => void;
  onRemove: () => void;
}) {
  const checkboxId = useId();
  return (
    <li className="flex items-start gap-2 border-b border-border py-1.5 last:border-b-0">
      <input
        id={checkboxId}
        type="checkbox"
        checked={term.active}
        onChange={onToggle}
        className="mt-1 size-4 shrink-0 accent-[var(--color-accent-strong)]"
      />
      <div className="min-w-0 flex-1">
        <label
          htmlFor={checkboxId}
          className={`block text-sm leading-[1.6] ${term.active ? 'text-foreground' : 'text-faint'}`}
        >
          {term.label}
        </label>
        {term.evidence !== null ? (
          <p className="line-clamp-2 text-xs text-faint" title={term.evidence}>
            From your CV: <q className="text-muted">{term.evidence}</q>
          </p>
        ) : (
          <p className="text-xs text-faint">Added by you</p>
        )}
      </div>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${term.label}`}
        className="shrink-0 rounded-[var(--radius)] px-2 py-0.5 text-xs text-faint hover:bg-surface-raised hover:text-foreground"
      >
        Remove
      </button>
    </li>
  );
}

const inputClass =
  'min-w-0 flex-1 rounded-[var(--radius)] border border-border bg-surface px-3 py-1.5 text-sm text-foreground';
const buttonClass =
  'shrink-0 rounded-[var(--radius)] border border-border-strong bg-surface-raised px-3 py-1.5 text-sm hover:bg-surface-active disabled:cursor-not-allowed disabled:text-faint disabled:hover:bg-surface-raised';

function TextAdder({
  kind,
  title,
  onAdd,
}: {
  kind: 'role' | 'skill';
  title: string;
  onAdd: (term: ProfileTerm) => void;
}) {
  const [text, setText] = useState('');
  const inputId = useId();
  const term = userTerm(kind, text);
  return (
    <form
      className="mt-2 flex gap-2"
      onSubmit={(event) => {
        // Never submitted anywhere: this only adds a term in memory.
        event.preventDefault();
        if (term === null) return;
        onAdd(term);
        setText('');
      }}
    >
      <label htmlFor={inputId} className="sr-only">
        Add to {title.toLowerCase()}
      </label>
      <input
        id={inputId}
        type="text"
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={kind === 'role' ? 'Add a role…' : 'Add a skill…'}
        autoComplete="off"
        spellCheck={false}
        className={inputClass}
      />
      <button type="submit" disabled={term === null} className={buttonClass}>
        Add
      </button>
    </form>
  );
}

function OptionAdder({
  kind,
  title,
  options,
  onAdd,
}: {
  kind: 'field' | 'location';
  title: string;
  options: VocabularyOption[];
  onAdd: (term: ProfileTerm) => void;
}) {
  const [key, setKey] = useState('');
  const selectId = useId();
  const chosen = options.find((option) => option.key === key);
  if (options.length === 0) return null;
  return (
    <div className="mt-2 flex gap-2">
      <label htmlFor={selectId} className="sr-only">
        Add to {title.toLowerCase()}
      </label>
      <select
        id={selectId}
        value={key}
        onChange={(event) => setKey(event.target.value)}
        className={inputClass}
      >
        <option value="">{kind === 'field' ? 'Add a field…' : 'Add a location…'}</option>
        {options.map((option) => (
          <option key={option.key} value={option.key}>
            {option.label} ({count(option.count)})
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={chosen === undefined}
        onClick={() => {
          if (chosen === undefined) return;
          onAdd(vocabularyTerm(kind, chosen));
          setKey('');
        }}
        className={buttonClass}
      >
        Add
      </button>
    </div>
  );
}
