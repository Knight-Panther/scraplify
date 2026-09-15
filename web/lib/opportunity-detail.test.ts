import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { OpportunityDetailView, OpportunityMemberDetail } from '../../src/browse/queries.js';
import { toDetail } from './opportunity-detail.js';

/**
 * The values here are the shapes the live corpus actually holds, not invented
 * ones: jobs.ge stores `locations: []`, `salaryRaw: null` and
 * `structuredAttributes: {}` on all 310 of its listings, while hr.ge stores a
 * populated object on all 100 of its own. Testing against tidier fixtures
 * would pass while the real distinction — absence versus disagreement — went
 * unchecked.
 */

function member(overrides: Partial<OpportunityMemberDetail> = {}): OpportunityMemberDetail {
  return {
    sourceListingId: randomUUID(),
    sourceSlug: 'jobs-ge',
    status: 'active',
    title: 'დიჯითალ კონსულტანტი',
    organization: 'თიბისი',
    canonicalUrl: 'https://jobs.ge/ge/?view=jobs&id=1',
    publishedAt: '2026-09-03T20:00:00.000Z',
    deadlineAt: '2026-09-13T20:00:00.000Z',
    firstSeenAt: '2026-09-04T00:00:00.000Z',
    lastSeenAt: '2026-09-07T00:00:00.000Z',
    applicationMethod: { type: 'url', value: 'https://smrtr.io/BB-Nd' },
    description: 'ვაკანსიის აღწერა.',
    locations: [],
    salaryRaw: null,
    sourceCategories: [],
    structuredAttributes: {},
    revisionId: randomUUID(),
    parserVersion: 'jobs-ge-v1',
    extractionMethod: 'http',
    fetchedAt: '2026-09-04T00:00:00.000Z',
    decision: 'confirmed_same',
    confidence: 0.97,
    decidedBy: 'ruleset',
    decidedAt: '2026-09-06T00:00:00.000Z',
    dedupeRulesetVersion: 'v1',
    evidence: { reasons: ['shared vacancy-level application value (carried by 2 listings)'] },
    supersededAt: null,
    membershipId: randomUUID(),
    ...overrides,
  };
}

function view(
  members: OpportunityMemberDetail[],
  formerMembers: OpportunityMemberDetail[] = [],
): OpportunityDetailView {
  return {
    opportunityId: 'opp-1',
    canonicalTitle: 'დიჯითალ კონსულტანტი',
    canonicalStatus: 'active',
    type: 'job',
    createdAt: '2026-09-06T00:00:00.000Z',
    updatedAt: '2026-09-06T00:00:00.000Z',
    revision: null,
    members,
    formerMembers,
    canonicalIsStale: false,
  };
}

function row(detail: ReturnType<typeof toDetail>, key: string) {
  return detail.comparison.find((entry) => entry.key === key);
}

describe('toDetail — disagreement versus absence', () => {
  /**
   * The distinction the whole screen rests on. All four cross-posted clusters
   * in the corpus look exactly like this: hr.ge states a location, jobs.ge
   * states none. Calling that a conflict would mark every one of them as
   * contradictory when the boards simply record different fields.
   */
  it('does not treat one board saying nothing as a disagreement', () => {
    const detail = toDetail(
      view([
        member({ sourceSlug: 'jobs-ge', locations: [] }),
        member({ sourceSlug: 'hr-ge', locations: ['თბილისი'] }),
      ]),
    );

    const location = row(detail, 'location');
    expect(location?.differs).toBe(false);
    expect(location?.cells[0]).toBeNull();
    expect(location?.cells[1]).toEqual({ kind: 'text', value: 'თბილისი' });
  });

  /**
   * The defect that made this screen invent conflicts, kept as a test because
   * it is invisible in any fixture written in UTC.
   *
   * These are the real stored values for a live cross-posted cluster. jobs.ge
   * publishes a calendar date and the adapter stores it as Tbilisi local
   * midnight, which is 20:00 UTC the day BEFORE; hr.ge stores an end-of-day
   * minute. Both boards printed 20 September. Compared as instants they look
   * different, and the screen said so on four clusters out of four when only
   * two actually differ.
   */
  it('does not invent a conflict from two precisions of the same Georgian day', () => {
    const detail = toDetail(
      view([
        member({ sourceSlug: 'jobs-ge', deadlineAt: '2026-09-19T20:00:00.000Z' }),
        member({ sourceSlug: 'hr-ge', deadlineAt: '2026-09-20T15:59:00.000Z' }),
      ]),
    );

    expect(row(detail, 'deadline')?.differs).toBe(false);
  });

  it('marks two boards stating different values as a disagreement', () => {
    const detail = toDetail(
      view([
        // 14 September and 3 October in Tbilisi — genuinely different days.
        member({ sourceSlug: 'jobs-ge', deadlineAt: '2026-09-13T20:00:00.000Z' }),
        member({ sourceSlug: 'hr-ge', deadlineAt: '2026-10-03T15:59:00.000Z' }),
      ]),
    );

    expect(row(detail, 'deadline')?.differs).toBe(true);
    expect(row(detail, 'deadline')?.note).toContain('different closing dates');
  });

  it('does not mark agreement as a disagreement', () => {
    const detail = toDetail(
      view([member({ sourceSlug: 'jobs-ge' }), member({ sourceSlug: 'hr-ge' })]),
    );

    expect(row(detail, 'title')?.differs).toBe(false);
    expect(row(detail, 'employer')?.differs).toBe(false);
  });

  /**
   * Every cross-posted cluster in the corpus is `active` on jobs.ge and
   * `missing_suspected` on hr.ge, so this is the difference a reader most
   * needs to see — and the one a canonical status of "open" hides.
   */
  it('surfaces a differing lifecycle state', () => {
    const detail = toDetail(
      view([
        member({ sourceSlug: 'jobs-ge', status: 'active' }),
        member({ sourceSlug: 'hr-ge', status: 'missing_suspected' }),
      ]),
    );

    expect(row(detail, 'state')?.differs).toBe(true);
    expect(row(detail, 'state')?.cells).toEqual([
      { kind: 'status', value: 'active' },
      { kind: 'status', value: 'missing_suspected' },
    ]);
  });

  /** A field no board states is not rendered as a line of blanks. */
  it('omits a row every board is silent about', () => {
    const detail = toDetail(
      view([
        member({ sourceSlug: 'jobs-ge', salaryRaw: null }),
        member({ sourceSlug: 'hr-ge', salaryRaw: null }),
      ]),
    );

    expect(row(detail, 'salary')).toBeUndefined();
  });

  it('treats a whitespace-only value as nothing stated', () => {
    const detail = toDetail(view([member({ organization: '   ' })]));

    expect(row(detail, 'employer')).toBeUndefined();
  });
});

describe('toDetail — descriptions', () => {
  /**
   * `anti-patterns.md` classes a merged description as lost provenance. The
   * ranking layer concatenates internally precisely so this does not have to.
   */
  it('keeps each board’s description separate and attributed', () => {
    const detail = toDetail(
      view([
        member({ sourceSlug: 'jobs-ge', description: 'მოკლე აღწერა' }),
        member({ sourceSlug: 'hr-ge', description: 'გრძელი აღწერა' }),
      ]),
    );

    expect(detail.descriptions).toHaveLength(2);
    expect(detail.descriptions[0]?.column.sourceSlug).toBe('jobs-ge');
    expect(detail.descriptions[0]?.text).toBe('მოკლე აღწერა');
    expect(detail.descriptions[1]?.text).toBe('გრძელი აღწერა');
  });

  it('drops a board with no description rather than showing an empty section', () => {
    const detail = toDetail(
      view([
        member({ sourceSlug: 'jobs-ge', description: '' }),
        member({ sourceSlug: 'hr-ge', description: 'აღწერა' }),
      ]),
    );

    expect(detail.descriptions).toHaveLength(1);
    expect(detail.descriptions[0]?.column.sourceSlug).toBe('hr-ge');
  });
});

describe('toDetail — how to apply', () => {
  /** All four occur in the corpus: 225 email, 128 url, 35 form, 22 unspecified. */
  it('reads an email route', () => {
    const detail = toDetail(
      view([member({ applicationMethod: { type: 'email', value: 'hr@example.ge' } })]),
    );

    expect(detail.apply[0]?.route).toEqual({
      kind: 'email',
      address: 'hr@example.ge',
      href: 'mailto:hr@example.ge',
    });
  });

  it('reads a url route', () => {
    const detail = toDetail(
      view([member({ applicationMethod: { type: 'url', value: 'https://smrtr.io/BB-Nd' } })]),
    );

    expect(detail.apply[0]?.route).toEqual({ kind: 'url', href: 'https://smrtr.io/BB-Nd' });
  });

  /** A form is an instruction to open the listing, not a missing value. */
  it('reads a form route as “apply on the board itself”', () => {
    const detail = toDetail(view([member({ applicationMethod: { type: 'form', value: null } })]));

    expect(detail.apply[0]?.route).toEqual({ kind: 'onSource' });
  });

  it('reads an unspecified route as genuinely absent', () => {
    const detail = toDetail(
      view([member({ applicationMethod: { type: 'unspecified', value: null } })]),
    );

    expect(detail.apply[0]?.route).toEqual({ kind: 'unstated' });
  });

  it('treats a null application method as absent', () => {
    const detail = toDetail(view([member({ applicationMethod: null })]));

    expect(detail.apply[0]?.route).toEqual({ kind: 'unstated' });
  });

  /**
   * A typed route with no value cannot be followed. Rendering it as a link
   * would produce `mailto:` — a control that looks live and goes nowhere.
   */
  it('degrades a valueless email or url to absent rather than a dead link', () => {
    expect(
      toDetail(view([member({ applicationMethod: { type: 'email', value: null } })])).apply[0]
        ?.route,
    ).toEqual({ kind: 'unstated' });
    expect(
      toDetail(view([member({ applicationMethod: { type: 'url', value: '  ' } })])).apply[0]?.route,
    ).toEqual({ kind: 'unstated' });
  });
});

describe('toDetail — what a board also records', () => {
  /**
   * A real hr.ge `structuredAttributes` object, copied from the corpus rather
   * than composed, including the bookkeeping keys that must NOT be shown.
   */
  const HR_GE_ATTRIBUTES = {
    bonusTo: null,
    benefits: [],
    industry: ['ფინანსები', 'საბანკო საქმიანობა'],
    bonusFrom: null,
    languages: ['ქართული'],
    specialty: ['საბანკო', 'ციფრული ბანკინგის კონსულტაცია'],
    isPriority: true,
    isAnonymous: false,
    isWithBonus: false,
    renewalDate: null,
    attachmentUrl: null,
    hasAttachment: false,
    isWorkFromHome: false,
    listingSection: -1,
    drivingLicenses: [],
    educationLevels: ['ბაკალავრი'],
    seniorityLevels: ['საშუალო რგოლი'],
    workExperienceTo: null,
    workScheduleName: 'სრული განაკვეთი',
    hideContactPerson: true,
    employmentTypeName: 'ვადიანი კონტრაქტი',
    workExperienceFrom: null,
    employmentFormTypeName: 'ოფისიდან/სამუშაო ადგილიდან',
  };

  it('shows the fields about the vacancy, in the board’s own words', () => {
    const detail = toDetail(
      view([member({ sourceSlug: 'hr-ge', structuredAttributes: HR_GE_ATTRIBUTES })]),
    );

    const labels = detail.extras[0]?.fields.map((field) => field.label) ?? [];
    expect(labels).toContain('Hours');
    expect(labels).toContain('Languages');
    expect(detail.extras[0]?.fields.find((field) => field.label === 'Hours')?.values).toEqual([
      'სრული განაკვეთი',
    ]);
  });

  /**
   * Phase 3C-2's corrected hr.ge parser (v3) stores specialty/industry as
   * real nested nodes — `{ sourceTermId, code, name, children }` — instead
   * of the flat string array v2 revisions still carry (HR_GE_ATTRIBUTES
   * above). A first version of this screen read both fields with the plain
   * string-array reader, which silently returned an empty list for every
   * node object and made these fields disappear the moment a listing was
   * re-crawled (caught by the commit gate before any re-crawl had run).
   * This proves both shapes render the same flattened names.
   */
  it('shows specialty/industry from the v3 tree shape too, not only the old flat strings', () => {
    const detail = toDetail(
      view([
        member({
          sourceSlug: 'hr-ge',
          structuredAttributes: {
            ...HR_GE_ATTRIBUTES,
            specialty: [
              {
                sourceTermId: '674ef639d86ecbd541ca78f2',
                code: '739',
                name: 'გაყიდვები',
                children: [
                  {
                    sourceTermId: '674ef639d86ecbd541ca7db8',
                    code: '1961',
                    name: 'გაყიდვების კონსულტაცია და რჩევა',
                    children: null,
                  },
                ],
              },
            ],
            industry: [
              {
                advancedIndustryId: '671a2a5cce45a6eaf88cad7c',
                code: null,
                name: 'საცალო ვაჭრობა',
                children: null,
              },
            ],
          },
        }),
      ]),
    );

    const specialtyField = detail.extras[0]?.fields.find(
      (field) => field.label === 'Filed by the board under',
    );
    expect(specialtyField?.values).toEqual(['გაყიდვები', 'გაყიდვების კონსულტაცია და რჩევა']);
    const industryField = detail.extras[0]?.fields.find(
      (field) => field.label === 'Board’s industry',
    );
    expect(industryField?.values).toEqual(['საცალო ვაჭრობა']);
  });

  /**
   * `listingSection: -1`, `isAnonymous` and `hideContactPerson` describe how
   * hr.ge runs its own site. Printing them would put raw internals on screen,
   * which `anti-patterns.md` forbids alongside raw enums.
   */
  it('does not surface the board’s own bookkeeping', () => {
    const detail = toDetail(
      view([member({ sourceSlug: 'hr-ge', structuredAttributes: HR_GE_ATTRIBUTES })]),
    );

    const rendered = JSON.stringify(detail.extras);
    for (const internal of ['listingSection', 'isAnonymous', 'hideContactPerson', 'isPriority']) {
      expect(rendered).not.toContain(internal);
    }
  });

  /** An empty list is the board's default, not a statement about this vacancy. */
  it('omits empty lists and false flags', () => {
    const detail = toDetail(
      view([member({ sourceSlug: 'hr-ge', structuredAttributes: HR_GE_ATTRIBUTES })]),
    );

    const labels = detail.extras[0]?.fields.map((field) => field.label) ?? [];
    expect(labels).not.toContain('Benefits');
    expect(labels).not.toContain('Driving licence');
    expect(labels).not.toContain('Remote');
  });

  it('shows a flag only when the board sets it', () => {
    const detail = toDetail(
      view([
        member({
          sourceSlug: 'hr-ge',
          structuredAttributes: { ...HR_GE_ATTRIBUTES, isWorkFromHome: true },
        }),
      ]),
    );

    expect(detail.extras[0]?.fields.map((field) => field.label)).toContain('Remote');
  });

  it('omits the section entirely for a board that records nothing', () => {
    const detail = toDetail(view([member({ sourceSlug: 'jobs-ge', structuredAttributes: {} })]));

    expect(detail.extras).toHaveLength(0);
  });

  /** Experience is absent throughout the corpus, so both bounds are handled. */
  it('reads an experience range from either bound alone', () => {
    const from = toDetail(
      view([member({ structuredAttributes: { workExperienceFrom: 3, workExperienceTo: null } })]),
    );
    const both = toDetail(
      view([member({ structuredAttributes: { workExperienceFrom: 3, workExperienceTo: 5 } })]),
    );

    expect(from.extras[0]?.fields[0]).toEqual({ label: 'Experience', values: ['3+ years'] });
    expect(both.extras[0]?.fields[0]).toEqual({ label: 'Experience', values: ['3–5 years'] });
  });

  /** jsonb is `unknown` at the type level and arbitrary at runtime. */
  it('survives structured attributes of the wrong shape', () => {
    for (const attributes of [null, 'text', 42, ['a'], { languages: 'not a list' }]) {
      expect(() => toDetail(view([member({ structuredAttributes: attributes })]))).not.toThrow();
    }
  });
});

describe('toDetail — cross-posting', () => {
  /**
   * Counted by SOURCE, matching the list screen. Two memberships from one
   * board is a data problem, not a second board carrying the vacancy — and it
   * must not make a single-board opportunity claim to be cross-posted.
   */
  it('counts boards, not memberships', () => {
    expect(
      toDetail(view([member({ sourceSlug: 'jobs-ge' }), member({ sourceSlug: 'jobs-ge' })]))
        .crossPosted,
    ).toBe(false);
    expect(
      toDetail(view([member({ sourceSlug: 'jobs-ge' }), member({ sourceSlug: 'hr-ge' })]))
        .crossPosted,
    ).toBe(true);
  });

  /** An opportunity whose last member was detached still has to render. */
  it('handles an opportunity with no live members', () => {
    const detail = toDetail(view([]));

    expect(detail.columns).toEqual([]);
    expect(detail.comparison).toEqual([]);
    expect(detail.descriptions).toEqual([]);
    expect(detail.crossPosted).toBe(false);
  });

  /**
   * The screen goes on rendering an opportunity whose last member was
   * detached, calling itself the record of what was seen. With live members
   * alone that record held no source link, no title and no reason — an audit
   * trail asserting itself while showing nothing.
   */
  it('keeps a detached listing as history rather than dropping it', () => {
    const detached = member({
      sourceSlug: 'hr-ge',
      title: 'დიჯითალ კონსულტანტი',
      supersededAt: '2026-09-07T00:00:00.000Z',
      evidence: { reasons: ['reassigned by review'] },
    });
    const detail = toDetail(view([], [detached]));

    expect(detail.columns).toEqual([]);
    expect(detail.formerBoards).toHaveLength(1);
    expect(detail.formerBoards[0]?.title).toBe('დიჯითალ კონსულტანტი');
    expect(detail.formerBoards[0]?.detachedAt).toBe('2026-09-07T00:00:00.000Z');
    expect(detail.formerBoards[0]?.column.url).toContain('https://');
    // Named 'groupingReasons', not `reasons`: a retired row still carries
    // the evidence that GROUPED the listing here, since retiring only stamps
    // a tombstone. Presenting it as the reason for removal would attribute
    // the original match to an act it had nothing to do with.
    expect(detail.formerBoards[0]?.groupingReasons).toEqual(['reassigned by review']);
    // The audit metadata a live membership carries, kept because when every
    // member has been detached these rows are the only record of who grouped
    // the listing and how confidently.
    expect(detail.formerBoards[0]?.decidedBy).toBe('ruleset');
    expect(detail.formerBoards[0]?.confidence).toBeCloseTo(0.97);
    expect(detail.formerBoards[0]?.dedupeRulesetVersion).toBe('v1');
    expect(detail.formerBoards[0]?.decidedAt).toBeTruthy();
  });

  /** A detached listing is history, never a current member. */
  it('does not let a detached listing back into the live comparison', () => {
    const detail = toDetail(
      view(
        [member({ sourceSlug: 'jobs-ge' })],
        [member({ sourceSlug: 'hr-ge', supersededAt: '2026-09-07T00:00:00.000Z' })],
      ),
    );

    expect(detail.columns).toHaveLength(1);
    expect(detail.crossPosted).toBe(false);
    expect(detail.formerBoards).toHaveLength(1);
  });
});

describe('toDetail — why a listing is in this cluster', () => {
  /**
   * The decision enum is this build's generic wording; the evidence is what
   * the dedupe pass actually recorded. They diverge the moment a membership
   * comes from a human reassignment or an older ruleset, and showing only the
   * label would let the screen misstate the grouping it exists to explain.
   */
  it('carries the reasons the dedupe pass recorded', () => {
    const detail = toDetail(
      view([
        member({
          evidence: {
            reasons: ['titles agree (similarity 1.00)', 'same normalized organization'],
            signals: { titleSimilarity: 1 },
          },
        }),
      ]),
    );

    expect(detail.observations[0]?.reasons).toEqual([
      'titles agree (similarity 1.00)',
      'same normalized organization',
    ]);
  });

  it('falls back to no reasons rather than printing a raw object', () => {
    for (const evidence of [null, {}, 'text', 42, { reasons: 'not a list' }, { reasons: [1, 2] }]) {
      const detail = toDetail(view([member({ evidence })]));
      expect(detail.observations[0]?.reasons).toEqual([]);
    }
  });
});

describe('toDetail — an application route must be safe to click', () => {
  /**
   * Neither the schema nor the adapters constrain this value to a web
   * address, and both failure modes are silent. A relative value resolves
   * against Xtelo's own origin, so the link would point at this app rather
   * than the source; a custom scheme reaches the operating system's protocol
   * handlers. All 128 url routes in the current corpus are absolute https,
   * which is why this is checked rather than assumed to stay so.
   */
  it('refuses a relative url instead of resolving it against this app', () => {
    const detail = toDetail(
      view([member({ applicationMethod: { type: 'url', value: '/apply/123' } })]),
    );

    expect(detail.apply[0]?.route).toEqual({ kind: 'unstated' });
  });

  it('refuses a non-web scheme', () => {
    for (const value of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x']) {
      const detail = toDetail(view([member({ applicationMethod: { type: 'url', value } })]));
      expect(detail.apply[0]?.route).toEqual({ kind: 'unstated' });
    }
  });

  it('accepts http and https', () => {
    for (const value of ['https://smrtr.io/BB-Nd', 'http://example.ge/jobs/1']) {
      const detail = toDetail(view([member({ applicationMethod: { type: 'url', value } })]));
      expect(detail.apply[0]?.route.kind).toBe('url');
    }
  });

  /**
   * Whitespace is what is being excluded, not RFC compliance: a stored value
   * carrying a line break could append headers or a body to the message the
   * reader is about to send.
   */
  it('refuses an address that could carry more than an address', () => {
    for (const value of ['hr@example.ge\nBcc: someone@else.ge', 'hr@ex ample.ge', 'not-an-email']) {
      const detail = toDetail(view([member({ applicationMethod: { type: 'email', value } })]));
      expect(detail.apply[0]?.route).toEqual({ kind: 'unstated' });
    }
  });

  /**
   * The case "no whitespace and one @" lets through, and the reason that
   * check was not enough. Percent-encoding hides the second address from any
   * counting rule, so `victim@example.ge?bcc=attacker%40example.ge` passes it
   * and produces a mailto: with a BCC the sender never sees — on a link whose
   * purpose is sending a CV.
   */
  it('refuses mailto parameters, including percent-encoded ones', () => {
    const injections = [
      'victim@example.ge?bcc=attacker%40example.ge',
      'victim@example.ge?subject=x&body=y',
      'a@b.ge,c@d.ge',
      'a@b.ge;c@d.ge',
      'a@b.ge%0ABcc:x@y.ge',
      'a@b.ge<script>',
    ];
    for (const value of injections) {
      const detail = toDetail(view([member({ applicationMethod: { type: 'email', value } })]));
      expect(detail.apply[0]?.route).toEqual({ kind: 'unstated' });
    }
  });

  /** Measured: all 227 addresses stored in the corpus still pass. */
  it('still accepts the address shapes the corpus actually holds', () => {
    for (const value of [
      'hr@example.ge',
      'first.last@example.com',
      'jobs+careers@sub.example.co.uk',
      "o'brien@example.ge",
      'recruitment_georgia@wvi.org',
    ]) {
      const detail = toDetail(view([member({ applicationMethod: { type: 'email', value } })]));
      expect(detail.apply[0]?.route.kind).toBe('email');
    }
  });
});

describe('toDetail — history keyed by membership', () => {
  /**
   * Detach, restore, detach again is a supported reversible workflow, so one
   * listing can hold several retired memberships in the same opportunity.
   * Keyed on `sourceListingId` these collapse into one entry — and in React,
   * into duplicate keys that can reuse the wrong history item.
   */
  it('keeps both detachments when the same listing left twice', () => {
    const listingId = randomUUID();
    const detail = toDetail(
      view(
        [],
        [
          member({
            sourceListingId: listingId,
            membershipId: 'membership-second',
            supersededAt: '2026-09-07T00:00:00.000Z',
          }),
          member({
            sourceListingId: listingId,
            membershipId: 'membership-first',
            supersededAt: '2026-09-05T00:00:00.000Z',
          }),
        ],
      ),
    );

    expect(detail.formerBoards).toHaveLength(2);
    expect(detail.formerBoards.map((former) => former.membershipId)).toEqual([
      'membership-second',
      'membership-first',
    ]);
  });
});

describe('toDetail — a grouping is more than one listing, not more than one board', () => {
  /**
   * The schema permits two live listings from the SAME board in one cluster:
   * transitive linking and manual reassignment both produce it, since the only
   * uniqueness is one live membership per listing. Gating the grouping
   * evidence on cross-posting hid the decision, confidence and recorded
   * reasons behind a real merge whenever both listings came from one source,
   * leaving that merge uninspectable on the screen built to inspect merges.
   */
  it('reports a same-board merge as grouped even though it is not cross-posted', () => {
    const detail = toDetail(
      view([member({ sourceSlug: 'jobs-ge' }), member({ sourceSlug: 'jobs-ge' })]),
    );

    expect(detail.crossPosted).toBe(false);
    expect(detail.grouped).toBe(true);
  });

  it('does not call a single listing a grouping', () => {
    expect(toDetail(view([member({})])).grouped).toBe(false);
    expect(toDetail(view([])).grouped).toBe(false);
  });

  it('reports a cross-posted cluster as both', () => {
    const detail = toDetail(
      view([member({ sourceSlug: 'jobs-ge' }), member({ sourceSlug: 'hr-ge' })]),
    );

    expect(detail.crossPosted).toBe(true);
    expect(detail.grouped).toBe(true);
  });
});
