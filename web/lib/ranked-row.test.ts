import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ListingView } from '../../src/browse/queries.js';
import type { RankedOpportunityView } from '../../src/ranking/run-ranking.js';
import { componentLabel, toRankedRow } from './ranked-row.js';

/**
 * The payloads here are copied from the live `rankings` table rather than
 * composed, including the weights the scorer actually uses (0.45 / 0.35 /
 * 0.15 / 0.05) and the Georgian terms it records.
 */

const REAL_COMPONENTS = [
  {
    score: 0.3333333333333333,
    weight: 0.45,
    matched: ['Excel'],
    missing: ['ბიუჯეტირება', 'რეპორტინგი'],
    component: 'skills',
  },
  {
    score: 1,
    weight: 0.35,
    matched: ['ანალიტიკოსი ~ ბიუჯეტირებისა და რეპორტინგის უფროსი ანალიტიკოსი (1.00)'],
    missing: [],
    component: 'role',
  },
  { score: 0, weight: 0.05, matched: [], missing: ['English'], component: 'language' },
  {
    score: 1,
    weight: 0.15,
    matched: ['ანალიტიკოსი'],
    missing: [],
    component: 'professionPreference',
  },
];

function ranked(overrides: Partial<RankedOpportunityView> = {}): RankedOpportunityView {
  return {
    opportunityId: randomUUID(),
    canonicalTitle: 'ბიუჯეტირებისა და რეპორტინგის უფროსი ანალიტიკოსი',
    canonicalStatus: 'active',
    score: 0.65,
    eligible: true,
    hardFilterReasons: [],
    componentScores: REAL_COMPONENTS,
    ...overrides,
  };
}

function member(overrides: Partial<ListingView> = {}): ListingView {
  return {
    sourceListingId: randomUUID(),
    sourceSlug: 'jobs-ge',
    status: 'active',
    title: 'ბიუჯეტირებისა და რეპორტინგის უფროსი ანალიტიკოსი',
    organization: 'ჯიაიჯი ჰოლდინგი',
    canonicalUrl: 'https://jobs.ge/ge/?view=jobs&id=1',
    publishedAt: null,
    deadlineAt: null,
    firstSeenAt: '2026-09-04T00:00:00.000Z',
    lastSeenAt: '2026-09-07T00:00:00.000Z',
    applicationMethod: null,
    ...overrides,
  };
}

describe('toRankedRow — why a result ranks where it does', () => {
  /**
   * Ordered by CONTRIBUTION, not raw score. A component scoring 1.00 at
   * weight 0.05 moved the result far less than one scoring 0.33 at weight
   * 0.45, and leading with the raw score invites exactly that misreading.
   */
  it('orders components by what each actually contributed', () => {
    const row = toRankedRow(ranked());

    expect(row.components.map((component) => component.key)).toEqual([
      'role', // 1.00 × 0.35 = 0.350
      // Exactly tied at 0.150 with the next one — 0.3333… × 0.45 === 1 × 0.15
      // in IEEE 754, verified, not approximately. Skills wins the tie on
      // weight: between two factors that contributed the same, the more
      // heavily weighted one is the bigger lever.
      'skills', // 0.33 × 0.45 = 0.150, weight 0.45
      'professionPreference', // 1.00 × 0.15 = 0.150, weight 0.15
      'language', // 0.00 × 0.05 = 0.000
    ]);
    expect(row.components[0]?.contribution).toBeCloseTo(0.35);
    expect(row.components.at(-1)?.contribution).toBe(0);
  });

  it('keeps the scorer’s own matched and missing terms verbatim', () => {
    const row = toRankedRow(ranked());
    const skills = row.components.find((component) => component.key === 'skills');

    expect(skills?.matched).toEqual(['Excel']);
    expect(skills?.missing).toEqual(['ბიუჯეტირება', 'რეპორტინგი']);
  });

  /**
   * A component with no key, score or weight cannot be explained honestly, so
   * it is dropped rather than rendered with a guessed value.
   */
  it('drops a component it cannot explain instead of guessing', () => {
    const row = toRankedRow(
      ranked({
        componentScores: [
          { component: 'skills', score: 0.5, weight: 0.45, matched: [], missing: [] },
          { component: 'role', weight: 0.35 },
          { score: 1, weight: 0.2 },
          'not an object',
        ],
      }),
    );

    expect(row.components.map((component) => component.key)).toEqual(['skills']);
  });

  /** jsonb is `unknown` at the type level and arbitrary at runtime. */
  it('survives a malformed payload rather than taking out the list', () => {
    for (const payload of [null, 'text', 42, {}, [null], [{ component: 5 }]]) {
      expect(() => toRankedRow(ranked({ componentScores: payload }))).not.toThrow();
      expect(toRankedRow(ranked({ componentScores: payload })).components).toEqual([]);
    }
  });
});

describe('toRankedRow — hard filters', () => {
  /** A real payload: the scorer writes a readable sentence, so it is shown. */
  it('reads the filter and the scorer’s own explanation', () => {
    const row = toRankedRow(
      ranked({
        eligible: false,
        score: null,
        hardFilterReasons: [
          {
            detail: 'listing mentions excluded profession "მძღოლი"',
            filter: 'excluded_profession',
          },
        ],
      }),
    );

    expect(row.eligible).toBe(false);
    expect(row.score).toBeNull();
    expect(row.hardFilters).toEqual([
      { filter: 'excluded_profession', detail: 'listing mentions excluded profession "მძღოლი"' },
    ]);
  });

  it('has no filters for an eligible result', () => {
    expect(toRankedRow(ranked()).hardFilters).toEqual([]);
  });
});

describe('toRankedRow — the boards behind a result', () => {
  it('links out once per board, not once per listing', () => {
    const row = toRankedRow(ranked(), [
      member({ sourceSlug: 'jobs-ge' }),
      member({ sourceSlug: 'jobs-ge' }),
      member({ sourceSlug: 'hr-ge' }),
    ]);

    expect(row.sources.map((source) => source.sourceSlug)).toEqual(['jobs-ge', 'hr-ge']);
  });

  it('collapses repeated employer names and ignores blank ones', () => {
    const row = toRankedRow(ranked(), [
      member({ organization: 'თიბისი' }),
      member({ organization: '  ' }),
      member({ organization: 'თიბისი' }),
      member({ organization: null }),
    ]);

    expect(row.employers).toEqual(['თიბისი']);
  });

  /** A ranked opportunity with no live member still has to render. */
  it('handles a result with no members', () => {
    const row = toRankedRow(ranked());

    expect(row.sources).toEqual([]);
    expect(row.employers).toEqual([]);
  });
});

describe('componentLabel', () => {
  /** `professionPreference` is an internal key, not a label a person reads. */
  it('names every key the scorer produces', () => {
    for (const key of ['skills', 'role', 'language', 'professionPreference']) {
      expect(componentLabel(key).short).not.toBe('unrecognised factor');
    }
    // The one that matters: a camelCase internal identifier must never reach a
    // reader, and this is the only key whose raw form would be obviously wrong
    // on screen.
    expect(componentLabel('professionPreference').short).toBe('preferred field');
  });

  it('marks a key it does not know rather than printing it raw', () => {
    expect(componentLabel('seniorityFit').short).toBe('unrecognised factor');
  });
});
