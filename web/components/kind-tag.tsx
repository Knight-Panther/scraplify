import { opportunityTypeLabel } from '../lib/labels.js';

/**
 * The kind of a non-vacancy row ("tender"), as a small outlined tag.
 *
 * Vacancies get none: a word printed on every row is noise, so rows never say
 * "job", and a tag on the rare other kind is how a job seeker tells a tender
 * apart in a shared list (`docs/addEtender.md` §14.7). An outline rather than
 * a fill keeps it quieter than the status beside it. `label` replaces the
 * English word on the bilingual landing page.
 */
export function KindTag({ type, label: shown }: { type: string; label?: string | undefined }) {
  if (type === 'job') return null;
  const label = opportunityTypeLabel(type);
  return (
    <span
      className="inline-flex items-center rounded-full border border-[var(--color-browse-accent)] px-2 text-xs leading-5 text-[var(--color-browse-accent)]"
      title={label.explanation}
    >
      {shown ?? label.short}
    </span>
  );
}
