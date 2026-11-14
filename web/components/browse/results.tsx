import type { ReactNode } from 'react';
import type { BrowseItem } from '../../../src/browse/browse-index.js';
import type { KindChoice } from '../../../src/browse/browse-form.js';
import type { BrowseIcon } from '../../lib/browse-registry.js';
import { fmt } from '../../lib/browse-registry.js';
import {
  CPV_DIVISION_EN,
  cityEnglish,
  FIELD_EN,
  SENIORITY,
  SOURCE_NAMES,
  VOCAB,
} from '../../lib/browse-vocab.js';
import { sourceDateTime } from '../../lib/format.js';
import { kindLabel } from '../../lib/kind-labels.js';
import { listingStatusLabel } from '../../lib/labels.js';
import { DecisionControl } from '../decision-control.js';
import { StatusChip } from '../status-chip.js';
import { BrowseIconSvg } from './icons.js';

/**
 * Browse v2's rows (the approved mockup): a kind icon, the title, the
 * organisation and a facts line that depends on the kind; a pay, value or
 * fee column left blank where nothing is stated; "Closes", or when a course
 * starts; and a chip per board, each a link to that board's listing.
 * On a phone, pay, dates and boards share one line under the text.
 *
 * Absent facts are simply absent: jobs.ge states no city, salary or field,
 * and its rows show none, never a column of "not stated".
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** A calendar day (`YYYY-MM-DD`, no time zone) read at noon UTC, so no zone can move it. */
const DAY_MONTH = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});
const MONTH = new Intl.DateTimeFormat('en-GB', { month: 'short', timeZone: 'UTC' });
const noon = (day: string) => Date.parse(`${day.slice(0, 10)}T12:00:00Z`);
const MON = Array.from({ length: 12 }, (_, i) => MONTH.format(Date.UTC(2026, i, 15)));
const SIGN: Readonly<Record<string, string>> = { EUR: '€', GBP: '£', USD: '$', GEL: '₾' };
const KIND_ICON: Readonly<Record<string, BrowseIcon>> = {
  job: 'job',
  tender: 'tender',
  course: 'course',
};
const KIND_COLOUR: Readonly<Record<string, string>> = {
  job: 'text-kind-job',
  tender: 'text-kind-tender',
  course: 'text-kind-course',
};
const METHOD_EN = VOCAB.method;
const SENIORITY_EN = new Map(SENIORITY);

/** The Tbilisi calendar day of an instant, `YYYY-MM-DD`. */
const tbilisiDay = (ms: number) => new Date(ms + 4 * 3600_000).toISOString().slice(0, 10);
const dayMonth = (day: string) => DAY_MONTH.format(noon(day));

function span(start: string | null, end: string | null): string | null {
  if (start === null) return null;
  const a = {
    d: Number(start.slice(8)),
    m: MON[Number(start.slice(5, 7)) - 1],
    y: start.slice(0, 4),
  };
  if (end === null) return `from ${a.d} ${a.m} ${a.y}`;
  const b = { d: Number(end.slice(8)), m: MON[Number(end.slice(5, 7)) - 1], y: end.slice(0, 4) };
  if (a.y !== b.y) return `${a.d} ${a.m} ${a.y} – ${b.d} ${b.m} ${b.y}`;
  return a.m === b.m ? `${a.d}–${b.d} ${a.m} ${a.y}` : `${a.d} ${a.m} – ${b.d} ${b.m} ${a.y}`;
}

const weeks = (days: number | null) => {
  if (days === null) return null;
  if (days < 7) return `${days} ${days === 1 ? 'day' : 'days'}`;
  const w = Math.round(days / 7);
  return `${w} ${w === 1 ? 'week' : 'weeks'}`;
};

function Fact({
  icon,
  children,
  title,
}: {
  icon: BrowseIcon;
  children: ReactNode;
  title?: string | undefined;
}) {
  return (
    <span className="inline-flex min-w-0 items-center gap-[5px]" title={title}>
      <BrowseIconSvg name={icon} className="size-[13px]" />
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}

function facts(item: BrowseItem, surface: 'local' | 'public'): ReactNode[] {
  const out: ReactNode[] = [];
  if (surface === 'local' && item.status !== 'active') {
    out.push(
      <span key="state" className="inline-flex items-center">
        <StatusChip status={item.status} />
      </span>,
    );
  }
  if (item.kind === 'job') {
    if (item.cities.length > 0) {
      out.push(
        <Fact key="city" icon="pin">
          {item.cities.map(cityEnglish).join(', ')}
        </Fact>,
      );
    }
    const field = item.fields[0]?.slice(2);
    if (field !== undefined) {
      out.push(
        <Fact key="field" icon="field" title={field}>
          {FIELD_EN.get(field) ?? field}
        </Fact>,
      );
    }
    if (item.workplace !== null && item.workplace !== 'ოფისიდან/სამუშაო ადგილიდან') {
      out.push(
        <Fact key="wf" icon="house">
          {VOCAB.wf?.get(item.workplace) ?? item.workplace}
        </Fact>,
      );
    }
    if (item.hours !== null && item.hours !== 'სრული განაკვეთი') {
      out.push(
        <Fact key="hours" icon="clock">
          {VOCAB.sched?.get(item.hours) ?? item.hours}
        </Fact>,
      );
    }
    if (item.seniority.length > 0) {
      out.push(
        <Fact key="sen" icon="person">
          {item.seniority.map((s) => SENIORITY_EN.get(s) ?? s).join(', ')}
        </Fact>,
      );
    }
    if (item.students === true) {
      out.push(
        <Fact key="stud" icon="course">
          suits students
        </Fact>,
      );
    }
  } else if (item.kind === 'tender') {
    const division = item.fields[0]?.slice(2);
    if (division !== undefined) {
      out.push(
        <Fact key="cpv" icon="field" title={item.cpvLabel ?? undefined}>
          {CPV_DIVISION_EN.get(division) ?? `CPV ${division}`}
        </Fact>,
      );
    }
    if (item.method !== null) {
      out.push(
        <Fact key="method" icon="list">
          {METHOD_EN?.get(item.method) ?? item.method}
        </Fact>,
      );
    }
    if (item.submission === 'off_platform') {
      out.push(
        <Fact key="subm" icon="globe">
          bids off etenders.ge
        </Fact>,
      );
    }
    if (item.tenderNumber !== null) {
      out.push(
        <Fact key="num" icon="hash">
          <span className="numeric">{item.tenderNumber}</span>
        </Fact>,
      );
    }
    if (division === undefined && item.cities.length > 0) {
      out.push(
        <Fact key="city" icon="pin">
          {item.cities.map(cityEnglish).join(', ')}
        </Fact>,
      );
    }
  } else if (item.kind === 'course') {
    const where = item.online ? 'Online' : [item.city, item.country].filter(Boolean).join(', ');
    if (where !== '') {
      out.push(
        <Fact key="where" icon="pin">
          {where}
        </Fact>,
      );
    }
    const when = [span(item.start, item.end), weeks(item.days)].filter(Boolean).join(' · ');
    if (when !== '') {
      out.push(
        <Fact key="when" icon="calendar">
          {when}
        </Fact>,
      );
    }
    if (item.disciplines.length > 0) {
      out.push(
        <Fact key="disc" icon="field">
          {item.disciplines.slice(0, 2).join(', ')}
        </Fact>,
      );
    }
    if (item.credits !== null && item.credits > 0) {
      out.push(
        <Fact key="ects" icon="award">
          {item.credits} ECTS
        </Fact>,
      );
    }
  }
  return out;
}

function Money({ item }: { item: BrowseItem }) {
  const cell =
    'numeric whitespace-nowrap text-[13px] font-bold min-[900px]:text-right min-[900px]:text-sm';
  const small = 'block font-[family-name:var(--font-sans)] text-xs font-normal text-faint';
  if (item.kind === 'job' && item.salary !== null) {
    const [lo, hi] = item.salary;
    const text =
      lo !== null && hi !== null
        ? `₾${fmt(lo)}–${fmt(hi)}`
        : lo !== null
          ? `from ₾${fmt(lo)}`
          : `up to ₾${fmt(hi ?? 0)}`;
    return (
      <div className={cell}>
        {text}
        <small className={small}>a month</small>
      </div>
    );
  }
  if (item.kind === 'tender' && item.value !== null) {
    const sign = SIGN[item.value.currency] ?? `${item.value.currency} `;
    return (
      <div className={cell}>
        {sign}
        {fmt(item.value.amount)}
        <small className={small}>
          {item.value.vat === 'excluded'
            ? 'before VAT'
            : item.value.vat === 'included'
              ? 'with VAT'
              : 'estimate'}
        </small>
      </div>
    );
  }
  if (item.kind === 'course') {
    if (item.fee === null) {
      return (
        <div className="text-[13px] whitespace-nowrap text-faint min-[900px]:text-right">
          fee not stated
        </div>
      );
    }
    const sign = SIGN[item.fee.currency] ?? `${item.fee.currency} `;
    return (
      <div className={cell}>
        {item.fee.amount === 0 ? 'Free' : `${sign}${fmt(item.fee.amount)}`}
        <small className={small}>tuition</small>
      </div>
    );
  }
  // Nothing stated: the cell stays empty, and on a phone it takes no room.
  return <div className="max-[899px]:hidden" />;
}

function Closes({ item, nowMs }: { item: BrowseItem; nowMs: number }) {
  const small = 'block text-xs text-faint max-[899px]:inline max-[899px]:ml-1.5';
  if (item.deadlineMs !== null && item.deadlineAt !== null) {
    // Calendar days in Tbilisi, the way the boards print a deadline: 23:59 today is "today".
    const left = Math.round(
      (Date.parse(tbilisiDay(item.deadlineMs)) - Date.parse(tbilisiDay(nowMs))) / DAY_MS,
    );
    const rel =
      left < 0 ? 'closed' : left === 0 ? 'today' : left === 1 ? 'tomorrow' : `in ${left} days`;
    return (
      <div
        className={`text-[13px] whitespace-nowrap min-[900px]:text-sm ${left >= 0 && left <= 3 ? 'text-warn' : ''}`}
      >
        <time dateTime={item.deadlineAt} title={sourceDateTime(item.deadlineAt)}>
          {rel}
        </time>
        <small className={small}>
          {dayMonth(tbilisiDay(item.deadlineMs))}
          {item.deadlinesDisagree ? ' · boards differ' : ''}
        </small>
      </div>
    );
  }
  if (item.kind === 'course') {
    return (
      <div className="text-[13px] whitespace-nowrap min-[900px]:text-sm">
        {item.start === null ? (
          <span className="text-faint">no dates stated</span>
        ) : (
          `starts ${dayMonth(item.start)}`
        )}
        <small className="block text-xs text-faint">
          {item.earlyBird === null
            ? 'no deadline stated'
            : `early bird to ${dayMonth(item.earlyBird)}`}
        </small>
      </div>
    );
  }
  return <div className="text-[13px] whitespace-nowrap text-faint">no deadline stated</div>;
}

function Boards({ item }: { item: BrowseItem }) {
  const seen = new Set<string>();
  return (
    <div className="relative z-[1] flex min-w-0 max-w-full flex-wrap gap-1 min-[900px]:justify-end">
      {item.members.map((member) => {
        if (seen.has(member.sourceSlug)) return null;
        seen.add(member.sourceSlug);
        const name = SOURCE_NAMES[member.sourceSlug] ?? member.sourceSlug;
        const differs = member.status !== item.status;
        return (
          <a
            key={member.sourceListingId}
            href={member.url}
            target="_blank"
            rel="noreferrer"
            translate="no"
            title={
              differs ? listingStatusLabel(member.status).explanation : `Open on ${name} (new tab)`
            }
            aria-label={`${item.title} on ${name}${differs ? `, ${listingStatusLabel(member.status).short} there` : ''} (opens in a new tab)`}
            className="numeric max-w-full min-w-0 truncate rounded-full border border-border-strong px-[9px] py-px text-xs text-muted no-underline hover:border-accent-line hover:text-accent"
          >
            {name}
            {differs ? ` · ${listingStatusLabel(member.status).short}` : ''}
          </a>
        );
      })}
    </div>
  );
}

const isGeorgian = (text: string) => /[Ⴀ-ჿ]/u.test(text);

export function Results({
  rows,
  firstUnstated,
  unstatedCount,
  kind,
  back,
  nowMs,
  surface,
  decisions,
}: {
  rows: readonly BrowseItem[];
  /** The index of the first kept row that does not state a kept fact, or -1. */
  firstUnstated: number;
  unstatedCount: number;
  kind: KindChoice;
  back: string;
  nowMs: number;
  surface: 'local' | 'public';
  decisions: ReadonlyMap<string, { decision: 'saved' | 'dismissed'; note: string | null }>;
}) {
  const moneyHead = { '': 'Pay, value or fee', job: 'Salary', tender: 'Value', course: 'Fee' }[
    kind
  ];
  const grid =
    surface === 'local'
      ? 'min-[900px]:grid-cols-[34px_minmax(0,1fr)_8rem_8rem_9rem_9.5rem] min-[1100px]:grid-cols-[34px_minmax(0,1fr)_8.5rem_8.5rem_11.5rem_10rem]'
      : 'min-[900px]:grid-cols-[34px_minmax(0,1fr)_8rem_8rem_9rem] min-[1100px]:grid-cols-[34px_minmax(0,1fr)_8.5rem_8.5rem_11.5rem]';
  return (
    <>
      <div
        aria-hidden="true"
        className={`hidden gap-x-[18px] border-b border-border-strong px-2.5 pt-2.5 pb-2 text-xs text-faint min-[900px]:grid ${grid}`}
      >
        <span />
        <span>Opportunity</span>
        <span className="text-right">{moneyHead}</span>
        <span>{kind === 'job' || kind === 'tender' ? 'Closes' : 'Closes or starts'}</span>
        <span className="text-right">Boards</span>
        {surface === 'local' ? <span /> : null}
      </div>
      <ol className="m-0 list-none p-0">
        {rows.map((item, index) => {
          const href = `/opportunities/${item.id}?${new URLSearchParams({ back })}`;
          const decision = decisions.get(item.id) ?? null;
          const isNew = nowMs - item.firstSeenMs < DAY_MS;
          return [
            index === firstUnstated ? (
              <li
                key="divider"
                className="mt-[18px] rounded-[var(--radius)] border border-dashed border-warn/60 bg-warn-soft px-3 py-2.5 text-[13px] text-warn"
              >
                These {fmt(unstatedCount)} don’t state what a filter asks, so they may or may not
                fit. Shown because you asked for them.
              </li>
            ) : null,
            <li
              key={item.id}
              id={`opp-${item.id}`}
              className={`group relative grid grid-cols-[34px_minmax(0,1fr)] items-start gap-x-3.5 gap-y-2 border-b border-border py-[13px] transition-colors duration-100 hover:bg-hover has-[a.row-link:focus-visible]:rounded-lg has-[a.row-link:focus-visible]:outline-2 has-[a.row-link:focus-visible]:-outline-offset-2 has-[a.row-link:focus-visible]:outline-ring min-[900px]:gap-x-[18px] min-[900px]:gap-y-0.5 min-[900px]:px-2.5 max-[1099px]:min-[900px]:gap-x-3.5 ${grid}`}
            >
              <span
                id={`row-${index + 1}`}
                title={
                  item.kind === 'course'
                    ? 'Course / school'
                    : item.kind === null
                      ? kindLabel(item.type, 'en')
                      : item.kind === 'job'
                        ? 'Vacancy'
                        : 'Tender'
                }
                className={`grid size-[34px] place-items-center rounded-[10px] border border-border-strong bg-surface ${KIND_COLOUR[item.kind ?? ''] ?? 'text-faint'}`}
              >
                <BrowseIconSvg name={KIND_ICON[item.kind ?? ''] ?? 'any'} className="size-[18px]" />
              </span>
              <div className="col-[2/-1] min-w-0 min-[900px]:col-auto">
                <a
                  href={href}
                  lang={isGeorgian(item.title) ? 'ka' : 'en'}
                  className="row-link font-medium [overflow-wrap:anywhere] text-foreground no-underline after:absolute after:inset-0 hover:text-accent focus-visible:outline-none"
                >
                  {item.title}
                </a>
                {isNew ? (
                  <span className="numeric ml-2 inline-block rounded-md border border-accent-line px-1.5 align-[2px] text-[11px] text-accent">
                    new
                  </span>
                ) : null}
                {item.orgs.length > 0 ? (
                  <div className="truncate text-[13.5px] text-muted" title={item.orgs.join(' · ')}>
                    {item.orgs.join(' · ')}
                  </div>
                ) : null}
                <div className="mt-1 flex flex-wrap gap-x-3.5 gap-y-0.5 text-[12.5px] text-faint empty:hidden">
                  {facts(item, surface)}
                </div>
              </div>
              {/* A phone: pay, dates and boards on one line, the boards wrapping under when
                  there is no room; from 900px each is a column of the row's grid. */}
              <div className="col-[2/-1] row-start-2 flex min-w-0 flex-wrap items-start gap-x-3.5 gap-y-1.5 min-[900px]:contents">
                <Money item={item} />
                <Closes item={item} nowMs={nowMs} />
                <Boards item={item} />
              </div>
              {surface === 'local' ? (
                <div className="relative z-[1] col-[2/-1] row-start-3 min-[900px]:col-auto min-[900px]:row-auto min-[900px]:opacity-35 min-[900px]:transition-opacity min-[900px]:group-hover:opacity-100 min-[900px]:group-focus-within:opacity-100">
                  <DecisionControl
                    opportunityId={item.id}
                    decision={decision?.decision ?? null}
                    note={decision?.note ?? null}
                  />
                </div>
              ) : null}
            </li>,
          ];
        })}
      </ol>
    </>
  );
}
