import { describe, expect, it } from 'vitest';
import { browseView, checkFor, countMatches, suggestCounts } from './browse-engine.js';
import { asKind, type BrowseForm, emptyForm, normalize } from './browse-form.js';
import type { BrowseItem, BrowseMember } from './browse-index.js';

const NOW = Date.parse('2026-11-14T10:00:00Z');
const DAY = 24 * 3600_000;
const local = { nowMs: NOW, surface: 'local' as const };
const pub = { nowMs: NOW, surface: 'public' as const };

let seq = 0;
function member(over: Partial<BrowseMember> = {}): BrowseMember {
  seq++;
  const deadlineMs = over.deadlineMs === undefined ? NOW + 10 * DAY : over.deadlineMs;
  return {
    sourceListingId: `l${seq}`,
    sourceSlug: 'hr-ge',
    status: 'active',
    title: 'title',
    organization: null,
    url: 'https://example.invalid',
    deadlineAt: deadlineMs === null ? null : new Date(deadlineMs).toISOString(),
    deadlineMs,
    firstSeenAt: new Date(NOW - 5 * DAY).toISOString(),
    firstSeenMs: NOW - 5 * DAY,
    ...over,
  };
}

/** A row with every fact unstated; tests set what they need. */
function item(over: Partial<BrowseItem> = {}): BrowseItem {
  seq++;
  const members = over.members ?? [member()];
  const deadlines = members.map((m) => m.deadlineMs).filter((d): d is number => d !== null);
  return {
    id: `o${String(seq).padStart(4, '0')}`,
    type: 'job',
    kind: 'job',
    title: `title ${seq}`,
    status: 'active',
    members,
    boards: [...new Set(members.map((m) => m.sourceSlug))].sort(),
    orgs: [],
    firstSeenMs: Math.min(...members.map((m) => m.firstSeenMs)),
    firstSeenAt: '',
    deadlineMs: deadlines.length ? Math.max(...deadlines) : null,
    deadlineAt: null,
    deadlinesDisagree: false,
    hay: 'title',
    cities: [],
    places: [],
    fields: [],
    fieldGuessed: false,
    industries: [],
    salary: null,
    contract: null,
    hours: null,
    workplace: null,
    seniority: [],
    education: [],
    languages: null,
    licences: null,
    benefits: null,
    bonus: null,
    students: null,
    cpvLabel: null,
    method: null,
    submission: null,
    value: null,
    valueGel: null,
    tenderNumber: null,
    country: null,
    city: null,
    online: false,
    start: null,
    end: null,
    days: null,
    disciplines: [],
    fee: null,
    feeEur: null,
    credits: null,
    teaching: [],
    earlyBird: null,
    ...over,
  };
}

const jobsGe = (over: Partial<BrowseItem> = {}) =>
  item({ members: [member({ sourceSlug: 'jobs-ge' })], ...over });
const form = (over: Partial<BrowseForm> = {}): BrowseForm => ({ ...emptyForm(), ...over });
const ids = (rows: readonly BrowseItem[]) => rows.map((r) => r.id);

describe('one filter, one rule', () => {
  // Each case: a form, a row that fits, a row that states the fact and does not fit, and
  // (for a fact only some listings state) a row that does not state it.
  const cases: [
    string,
    Partial<BrowseForm>,
    Partial<BrowseItem>,
    Partial<BrowseItem>,
    Partial<BrowseItem> | null,
  ][] = [
    [
      'place',
      { kind: 'job', place: ['g:ბათუმი'] },
      { places: ['g:ბათუმი'] },
      { places: ['g:თბილისი'] },
      {},
    ],
    [
      'field',
      { kind: 'job', field: ['j:გაყიდვები'] },
      { fields: ['j:გაყიდვები'] },
      { fields: ['j:IT'] },
      {},
    ],
    [
      'ind',
      { kind: 'job', ind: ['ფინანსები'] },
      { industries: ['ფინანსები'] },
      { industries: ['წარმოება'] },
      {},
    ],
    [
      'emp',
      { kind: 'job', emp: ['ფრილანსი'] },
      { contract: 'ფრილანსი' },
      { contract: 'სეზონური' },
      {},
    ],
    [
      'wf',
      { kind: 'job', wf: ['სამუშაო სახლიდან'] },
      { workplace: 'სამუშაო სახლიდან' },
      { workplace: 'საველე' },
      {},
    ],
    [
      'sched',
      { kind: 'job', sched: ['ნაწილობრივი განაკვეთი'] },
      { hours: 'ნაწილობრივი განაკვეთი' },
      { hours: 'სრული განაკვეთი' },
      {},
    ],
    [
      'salary overlap',
      { kind: 'job', salary: { min: 1500, max: null } },
      { salary: [1000, 2000] },
      { salary: [800, 1200] },
      {},
    ],
    [
      'salary "from"',
      { kind: 'job', salary: { min: null, max: 1200 } },
      { salary: [1000, null] },
      { salary: [1500, null] },
      {},
    ],
    ['bonus', { kind: 'job', bonus: true }, { bonus: true }, { bonus: false }, {}],
    [
      'sen',
      { kind: 'job', sen: ['უფროსი რგოლი'] },
      { seniority: ['უფროსი რგოლი'] },
      { seniority: ['საწყისი რგოლი'] },
      {},
    ],
    [
      'edu',
      { kind: 'job', edu: 'ბაკალავრი' },
      { education: ['ბაკალავრი', 'მაგისტრი'] },
      { education: ['მაგისტრი'] },
      {},
    ],
    [
      'lang: none beyond those ticked',
      { kind: 'job', lang: ['ქართული'] },
      { languages: [] },
      { languages: ['ქართული', 'ინგლისური'] },
      {},
    ],
    ['nolic', { kind: 'job', nolic: true }, { licences: [] }, { licences: ['B'] }, {}],
    ['stud', { kind: 'job', stud: true }, { students: true }, { students: false }, {}],
    [
      'ben: every one ticked',
      { kind: 'job', ben: ['a', 'b'] },
      { benefits: ['a', 'b', 'c'] },
      { benefits: ['a'] },
      {},
    ],
    [
      'method',
      { kind: 'tender', method: ['m1'] },
      { kind: 'tender', method: 'm1' },
      { kind: 'tender', method: 'm2' },
      { kind: 'tender' },
    ],
    [
      'subm',
      { kind: 'tender', subm: 'platform' },
      { kind: 'tender', submission: 'platform' },
      { kind: 'tender', submission: 'off_platform' },
      { kind: 'tender' },
    ],
    [
      'value',
      { kind: 'tender', value: { min: 50_000, max: 200_000 } },
      { kind: 'tender', valueGel: 60_000 },
      { kind: 'tender', valueGel: 300_000 },
      { kind: 'tender' },
    ],
    [
      'fee',
      { kind: 'course', fee: { min: null, max: 500 } },
      { kind: 'course', feeEur: 400 },
      { kind: 'course', feeEur: 900 },
      { kind: 'course' },
    ],
    [
      'ects',
      { kind: 'course', ects: ['lo'] },
      { kind: 'course', credits: 3 },
      { kind: 'course', credits: 10 },
      { kind: 'course' },
    ],
    [
      'starts',
      { kind: 'course', starts: ['2027-07'] },
      { kind: 'course', start: '2027-07-05' },
      { kind: 'course', start: '2027-08-01' },
      { kind: 'course' },
    ],
    [
      'dur',
      { kind: 'course', dur: ['w1'] },
      { kind: 'course', days: 5 },
      { kind: 'course', days: 20 },
      { kind: 'course' },
    ],
    [
      'clang',
      { kind: 'course', clang: ['German'] },
      { kind: 'course', teaching: ['English', 'German'] },
      { kind: 'course', teaching: ['French'] },
      { kind: 'course' },
    ],
    [
      'online',
      { kind: 'course', online: 'online' },
      { kind: 'course', online: true },
      { kind: 'course', online: false },
      null,
    ],
    ['board', { board: ['jobs-ge'] }, { members: [member({ sourceSlug: 'jobs-ge' })] }, {}, null],
    [
      'cross',
      { cross: true },
      { members: [member(), member({ sourceSlug: 'jobs-ge' })] },
      {},
      null,
    ],
    ['status (local)', { status: ['closed'] }, { status: 'closed' }, {}, null],
    ['types (older address)', { types: ['tender'] }, { type: 'tender', kind: 'tender' }, {}, null],
    ['org', { org: ['შპს ა'] }, { orgs: ['შპს ა'] }, { orgs: ['შპს ბ'] }, null],
    ['q', { q: 'გამყიდველი' }, { hay: 'უფროსი გამყიდველი' }, { hay: 'მძღოლი' }, null],
  ];

  for (const [name, set, fits, misses, unstated] of cases) {
    it(name, () => {
      const f = normalize(form(set), 'local');
      const yes = item(fits);
      const no = item(misses);
      const unknown = unstated === null ? null : item(unstated);
      const rows = [yes, no, ...(unknown === null ? [] : [unknown])];
      const view = browseView(rows, f, local);
      expect(ids(view.rows)).toEqual([yes.id]);
      if (unknown === null) return;
      // Never hidden silently: the filter says it left one out for not stating it.
      const key = Object.keys(view.leftOut)[0];
      expect(key).toBeDefined();
      expect(view.leftOut[key as keyof typeof view.leftOut]?.n).toBe(1);
      expect(view.extra).toBe(1);
      // Kept, it comes after the match, marked as not stating it.
      const kept = browseView(rows, normalize({ ...f, keep: [key as string] }, 'local'), local);
      expect(ids(kept.rows)).toEqual([yes.id, unknown.id]);
      expect(kept.unstated).toEqual([unknown.id]);
      expect(kept.leftOut[key as keyof typeof kept.leftOut]?.kept).toBe(true);
    });
  }
});

describe('the deadline and first-seen windows', () => {
  it('closing: a member closing in the window; one with no deadline is left out, not failed', () => {
    const soon = item({ members: [member({ deadlineMs: NOW + 2 * DAY })] });
    const later = item({ members: [member({ deadlineMs: NOW + 20 * DAY })] });
    const none = item({ members: [member({ deadlineMs: null })] });
    const view = browseView([soon, later, none], form({ closing: '3' }), local);
    expect(ids(view.rows)).toEqual([soon.id]);
    expect(view.leftOut.closing?.n).toBe(1);
  });

  it('public closing: the closing member must itself be open', () => {
    const cross = item({
      members: [
        member({ deadlineMs: NOW + 2 * DAY, status: 'expired' }),
        member({ deadlineMs: NOW + 20 * DAY }),
      ],
    });
    expect(browseView([cross], form({ closing: '3' }), pub).total).toBe(0);
    expect(browseView([cross], form({ closing: '30' }), pub).total).toBe(1);
  });

  it('since: by the earliest member', () => {
    const fresh = item({ members: [member({ firstSeenMs: NOW - DAY / 2 })] });
    const old = item({
      members: [member({ firstSeenMs: NOW - DAY / 2 }), member({ firstSeenMs: NOW - 9 * DAY })],
    });
    expect(ids(browseView([fresh, old], form({ since: '1' }), local).rows)).toEqual([fresh.id]);
  });
});

describe('the public catalogue', () => {
  it('lists only rows with an open member, now', () => {
    const open = item();
    const passed = item({ members: [member({ deadlineMs: NOW - DAY })] });
    const closed = item({ members: [member({ status: 'closed' })] });
    expect(ids(browseView([open, passed, closed], form(), pub).rows)).toEqual([open.id]);
    expect(browseView([open, passed, closed], form(), local).total).toBe(3);
  });
});

describe('what a filter leaves out, said by board', () => {
  it('names jobs.ge as the board that never states a city', () => {
    const rows = [
      item({ places: ['g:ბათუმი'] }),
      item({}),
      jobsGe(),
      jobsGe(),
      item({ members: [member(), member({ sourceSlug: 'jobs-ge' })] }),
    ];
    const view = browseView(rows, form({ kind: 'job', place: ['g:ბათუმი'] }), local);
    expect(view.leftOut.place?.n).toBe(4);
    expect(view.leftOut.place?.parts).toEqual([
      { boards: ['jobs-ge'], n: 2, never: true },
      { boards: ['hr-ge'], n: 1, never: false },
      { boards: ['hr-ge', 'jobs-ge'], n: 1, never: false },
    ]);
  });

  it('counts "extra" over every unstated filter at once', () => {
    const rows = [jobsGe(), item({ places: ['g:ბათუმი'], salary: [2000, null] })];
    const view = browseView(
      rows,
      form({ kind: 'job', place: ['g:ბათუმი'], salary: { min: 1500, max: null } }),
      local,
    );
    expect(view.total).toBe(1);
    // The jobs.ge row states neither: one row, though two filters leave it out.
    expect(view.extra).toBe(1);
    expect(view.leftOut.place).toBeUndefined();
    expect(view.leftOut.salary).toBeUndefined();
  });
});

describe('option counts', () => {
  const rows = [
    item({ places: ['g:თბილისი'], fields: ['j:a'] }),
    item({ places: ['g:თბილისი'], fields: ['j:b'] }),
    item({ places: ['g:ბათუმი'], fields: ['j:a'] }),
  ];

  it('count each option under every other filter, not under its own', () => {
    const view = browseView(rows, form({ kind: 'job', place: ['g:ბათუმი'] }), local);
    expect(Object.fromEntries(view.options.place?.options ?? [])).toEqual({
      'g:თბილისი': 2,
      'g:ბათუმი': 1,
    });
    expect(Object.fromEntries(view.options.field?.options ?? [])).toEqual({ 'j:a': 1, 'j:b': 0 });
  });

  it('languages: what adding one would allow', () => {
    const langs = [
      item({ languages: [] }),
      item({ languages: ['ქართული'] }),
      item({ languages: ['ქართული', 'ინგლისური'] }),
    ];
    const view = browseView(langs, form({ kind: 'job', lang: ['ქართული'] }), local);
    expect(Object.fromEntries(view.options.lang?.options ?? [])).toEqual({
      ქართული: 2,
      ინგლისური: 3,
    });
  });

  it('presets and toggles say what they would show', () => {
    const pay = [
      item({ salary: [1000, null] }),
      item({ salary: [2500, null] }),
      item({ bonus: true }),
    ];
    const view = browseView(pay, form({ kind: 'job' }), local);
    expect(view.ranges.salary?.presets['2000-']).toBe(1);
    expect(view.ranges.salary?.presets['1000-']).toBe(2);
    expect(view.toggles.bonus).toBe(1);
  });

  it('the kind counts drop what does not fit the kind', () => {
    const mixed = [
      item({ salary: [2000, null] }),
      item({ kind: 'tender', type: 'tender' }),
      jobsGe(),
    ];
    const view = browseView(mixed, form({ kind: 'job', salary: { min: 1500, max: null } }), local);
    expect(view.kindCounts).toEqual({ '': 3, job: 1, tender: 1, course: 0 });
  });
});

describe('order', () => {
  it('newest first by default, ties by id', () => {
    const a = item({ members: [member({ firstSeenMs: NOW - DAY })] });
    const b = item({ members: [member({ firstSeenMs: NOW - 2 * DAY })] });
    expect(ids(browseView([b, a], form(), local).rows)).toEqual([a.id, b.id]);
  });

  it('closing soonest puts rows with no deadline last', () => {
    const none = item({ members: [member({ deadlineMs: null })] });
    const soon = item({ members: [member({ deadlineMs: NOW + DAY })] });
    expect(ids(browseView([none, soon], form({ sort: 'deadline' }), local).rows)).toEqual([
      soon.id,
      none.id,
    ]);
  });

  it('salary, highest first, unstated last', () => {
    const lo = item({ salary: [1000, 1200] });
    const hi = item({ salary: [3000, null] });
    const none = item();
    expect(
      ids(browseView([lo, none, hi], form({ kind: 'job', sort: 'salary' }), local).rows),
    ).toEqual([hi.id, lo.id, none.id]);
  });
});

describe('empty answers', () => {
  it('say what dropping one filter would show', () => {
    const rows = [item({ places: ['g:ბათუმი'] }), item({ salary: [3000, null] })];
    const view = browseView(
      rows,
      form({ kind: 'job', place: ['g:ბათუმი'], salary: { min: 2000, max: null } }),
      local,
    );
    expect(view.total).toBe(0);
    expect(view.drops).toEqual([
      { key: 'place', n: 1 },
      { key: 'salary', n: 1 },
    ]);
  });
});

describe('the form under another kind', () => {
  it('drops what the kind does not offer', () => {
    const f = asKind(
      form({
        kind: 'job',
        place: ['g:ბათუმი', 'c:Italy'],
        salary: { min: 1, max: null },
        keep: ['salary'],
        sort: 'salary',
      }),
      'course',
      'local',
    );
    expect(f.place).toEqual(['c:Italy']);
    expect(f.salary).toEqual({ min: null, max: null });
    expect(f.keep).toEqual([]);
    expect(f.sort).toBe('recent');
  });
});

describe('search box counts', () => {
  it('count a city as jobs would show it, a field under its own kind', () => {
    const rows = [
      item({ places: ['g:ბათუმი'], fields: ['j:a'] }),
      item({ kind: 'course', type: 'summer_school', places: ['c:Italy'], fields: ['c:Law'] }),
    ];
    const c = suggestCounts(rows, form({ kind: 'course' }), local);
    expect(c.places.get('c:Italy')).toBe(1);
    expect(c.fields.get('j:a')).toBe(1);
    expect(c.fields.get('c:Law')).toBe(1);
  });

  it('count organisations with the others set aside', () => {
    const rows = [item({ orgs: ['ა'] }), item({ orgs: ['ბ'] })];
    const c = suggestCounts(rows, form({ org: ['ა'] }), local);
    expect(c.orgs.get('ბ')?.n).toBe(1);
  });
});

describe('checkFor', () => {
  it('matches words in any member, every word', () => {
    const check = checkFor('q', form({ q: 'ბანკი ოპერატორი' }), local);
    expect(check.test(item({ hay: 'ოპერატორი\nსილქ ბანკი' }))).toBe(true);
    expect(check.test(item({ hay: 'ოპერატორი' }))).toBe(false);
  });

  it('countMatches agrees with the view', () => {
    const rows = [item(), jobsGe()];
    expect(countMatches(rows, form({ board: ['jobs-ge'] }), local)).toBe(1);
  });
});
