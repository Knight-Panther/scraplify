import { listingStatusLabel, opportunityTypeLabel, sourceLabel } from '../../../../lib/labels.js';
import {
  DEADLINE_OPTIONS,
  type OpportunityQuery,
  SINCE_OPTIONS,
  STATUS_OPTIONS,
  TYPE_OPTIONS,
} from '../../../../lib/search-params.js';

/**
 * One element, shown two ways, rather than two copies of the same controls.
 *
 * At `lg` and up this renders inline as the left rail. Below `lg` the
 * [popover] attribute's own default (hidden until opened) applies instead,
 * and the "Filters" button in the search row opens it as a native popover —
 * `popovertarget` needs no JavaScript, and light-dismiss/Escape-to-close come
 * from the browser. Rendering it once is not just economy: the fields inside
 * (`name="status"` etc.) belong to the one `<form>` that wraps this whole
 * page, and a second copy with the same names would submit duplicate or
 * conflicting values depending on which copy a reader had touched.
 *
 * `formId` associates each input with the page's filter `<form>` via the
 * HTML `form` attribute rather than DOM nesting: this rail sits outside that
 * form (a sibling of the results table, not a descendant), specifically so
 * the results table's own per-row write forms are never nested inside it.
 */
export function FacetRail({
  query,
  slugs,
  formId,
}: {
  query: OpportunityQuery;
  slugs: readonly string[];
  formId: string;
}) {
  return (
    <div
      id="mobile-filters"
      popover="auto"
      className="max-h-[85vh] w-[min(22rem,90vw)] overflow-y-auto rounded-[var(--radius)] border border-border bg-surface p-5 text-foreground lg:static lg:m-0 lg:block lg:h-auto lg:max-h-none lg:w-[276px] lg:overflow-visible lg:rounded-none lg:border-0 lg:border-r lg:bg-transparent lg:p-6"
    >
      <button
        type="button"
        popoverTarget="mobile-filters"
        popoverTargetAction="hide"
        className="mb-4 text-sm text-muted hover:text-foreground lg:hidden"
      >
        Close
      </button>

      <div className="flex flex-col gap-7">
        <Group name="Board" hint="any">
          <Option
            formId={formId}
            type="radio"
            name="source"
            value=""
            label="any"
            defaultChecked={query.form.source === ''}
          />
          {slugs.map((slug) => (
            <Option
              key={slug}
              formId={formId}
              type="radio"
              name="source"
              value={slug}
              label={sourceLabel(slug)}
              defaultChecked={query.form.source === slug}
            />
          ))}
        </Group>

        <Group name="State" hint="any">
          {STATUS_OPTIONS.map((status) => {
            const label = listingStatusLabel(status);
            return (
              <Option
                key={status}
                formId={formId}
                type="checkbox"
                name="status"
                value={status}
                label={label.short}
                title={label.explanation}
                defaultChecked={query.form.statuses.includes(status)}
              />
            );
          })}
        </Group>

        <Group name="Kind" hint="any">
          {TYPE_OPTIONS.map((type) => {
            const label = opportunityTypeLabel(type);
            return (
              <Option
                key={type}
                formId={formId}
                type="checkbox"
                name="type"
                value={type}
                label={label.short}
                title={label.explanation}
                defaultChecked={query.form.types.includes(type)}
              />
            );
          })}
        </Group>

        <Group name="First seen" hint="window">
          {SINCE_OPTIONS.map((option) => (
            <Option
              key={option.value}
              formId={formId}
              type="radio"
              name="since"
              value={option.value}
              label={option.label}
              defaultChecked={query.form.since === option.value}
            />
          ))}
        </Group>

        <Group name="Deadline" hint="window">
          {DEADLINE_OPTIONS.map((option) => (
            <Option
              key={option.value}
              formId={formId}
              type="radio"
              name="closing"
              value={option.value}
              label={option.label}
              defaultChecked={query.form.closing === option.value}
            />
          ))}
        </Group>

        <div className="border-t border-border pt-4">
          <Option
            formId={formId}
            type="checkbox"
            name="cross"
            value="1"
            label="On both boards"
            title="Only vacancies that more than one board carries."
            defaultChecked={query.form.crossPosted}
          />
        </div>
      </div>
    </div>
  );
}

function Group({
  name,
  hint,
  children,
}: {
  name: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <fieldset>
      <legend className="mb-2 flex w-full items-baseline justify-between text-xs text-faint">
        <span>{name}</span>
        <span className="numeric text-faint">{hint}</span>
      </legend>
      <div className="flex flex-col gap-1">{children}</div>
    </fieldset>
  );
}

function Option({
  formId,
  type,
  name,
  value,
  label,
  title,
  defaultChecked,
}: {
  formId: string;
  type: 'radio' | 'checkbox';
  name: string;
  value: string;
  label: string;
  title?: string;
  defaultChecked: boolean;
}) {
  return (
    <label
      className="flex items-center gap-2 py-1 text-sm text-muted hover:text-[var(--color-browse-accent)]"
      title={title}
    >
      <input
        form={formId}
        type={type}
        name={name}
        value={value}
        defaultChecked={defaultChecked}
        className="size-4 rounded-sm accent-[var(--color-browse-accent)]"
      />
      <span>{label}</span>
    </label>
  );
}
