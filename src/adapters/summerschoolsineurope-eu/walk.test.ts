import { describe, expect, it } from 'vitest';
import type { ListingSplitFacet } from '../../policies/summerschoolsineurope-eu.js';
import type { CourseCard, FacetChoice, ParsedListingPage } from './listing.js';
import { chooseSplitFacet, coverListing, type Filters, packGroups } from './walk.js';

interface ModelCourse {
  id: string;
  facets: Partial<Record<ListingSplitFacet, string[]>>;
}

/** A deterministic shuffle, so a "random" listing is repeatable in a test. */
function rng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

/**
 * The site as measured on 2026-11-13: a filtered listing holds the courses
 * matching every facet (OR within one), shuffled anew on every request, 12 to
 * a page, with each facet's counts over the current set.
 */
function fakeSite(courses: ModelCourse[], seed = 7) {
  const random = rng(seed);
  const requests: Filters[] = [];
  const read = async (filters: Filters): Promise<ParsedListingPage | null> => {
    requests.push(filters);
    const matching = courses.filter((course) =>
      filters.every(([facet, values]) =>
        (course.facets[facet] ?? []).some((value) => values.includes(value)),
      ),
    );
    const shuffled = [...matching].sort(() => random() - 0.5);
    const facets: Record<string, FacetChoice[]> = {};
    for (const facet of [
      'course_country',
      'course_city',
      'course_starting',
      'course_duration',
      'course_discipline',
    ] as const) {
      const counts = new Map<string, number>();
      for (const course of matching) {
        for (const value of course.facets[facet] ?? []) {
          counts.set(value, (counts.get(value) ?? 0) + 1);
        }
      }
      facets[facet] = [...counts].map(([value, count]) => ({ value, label: value, count }));
    }
    return {
      cards: shuffled.slice(0, 12).map((course) => ({ postId: course.id }) as CourseCard),
      pager: {
        page: 1,
        perPage: 12,
        totalRows: matching.length,
        totalPages: Math.ceil(matching.length / 12),
      },
      facets,
    };
  };
  return { read, requests };
}

function course(
  id: number,
  country: string,
  city: string,
  starting: string,
  duration = 'short',
): ModelCourse {
  return {
    id: String(id),
    facets: {
      course_country: [country],
      course_city: [city],
      course_starting: [starting],
      course_duration: [duration],
      course_discipline: ['natural-sciences'],
    },
  };
}

describe('packGroups', () => {
  it('packs small values into OR-groups of up to 12 and leaves big ones alone', () => {
    const choices = [
      { value: 'uk', label: 'UK', count: 40 },
      { value: 'at', label: 'AT', count: 4 },
      { value: 'bg', label: 'BG', count: 2 },
      { value: 'hr', label: 'HR', count: 6 },
      { value: 'cy', label: 'CY', count: 1 },
      { value: 'ge', label: 'GE', count: 11 },
      { value: 'none', label: 'None', count: 0 },
    ];
    const { groups, big } = packGroups(choices, 12);
    expect(big.map((choice) => choice.value)).toEqual(['uk']);
    expect(groups.every((group) => group.reduce((sum, c) => sum + c.count, 0) <= 12)).toBe(true);
    expect(
      groups
        .flat()
        .map((choice) => choice.value)
        .sort(),
    ).toEqual(['at', 'bg', 'cy', 'ge', 'hr']);
    expect(groups).toHaveLength(2);
  });
});

describe('chooseSplitFacet', () => {
  it('passes over a facet that cannot split the set, or that leaves courses out', () => {
    const facets = {
      course_country: [{ value: 'it', label: 'Italy', count: 30 }],
      course_city: [
        { value: 'pisa', label: 'Pisa', count: 20 },
        { value: 'milan', label: 'Milan', count: 5 },
      ],
      course_starting: [
        { value: '06_june', label: 'June', count: 12 },
        { value: '07_july', label: 'July', count: 10 },
        { value: '08_august', label: 'August', count: 8 },
      ],
    };
    // Country is one value for the whole set; city covers 25 of 30, so it
    // comes only after a facet that covers all of them.
    expect(chooseSplitFacet(facets, new Set(), 30, 12)).toBe('course_starting');
    expect(chooseSplitFacet(facets, new Set(['course_starting']), 30, 12)).toBe('course_city');
    expect(
      chooseSplitFacet(facets, new Set(['course_starting', 'course_city']), 30, 12),
    ).toBeNull();
  });
});

describe('coverListing', () => {
  it('reads every course once, from result sets of 12 or fewer', async () => {
    const courses: ModelCourse[] = [];
    let id = 1;
    for (const [country, cities] of [
      ['uk', ['oxford', 'leeds', 'london']],
      ['it', ['pisa', 'milan']],
      ['ge', ['tbilisi']],
      ['at', ['vienna']],
    ] as const) {
      for (const city of cities) {
        for (const month of ['06_june', '07_july', '01_january']) {
          const perMonth = country === 'uk' || city === 'pisa' ? 7 : 2;
          for (let n = 0; n < perMonth; n++) courses.push(course(id++, country, city, month));
        }
      }
    }
    const site = fakeSite(courses);
    const result = await coverListing(site.read, { capacity: 12 });
    expect(result.complete).toBe(true);
    expect(result.uncovered).toBe(0);
    expect(result.rootTotal).toBe(courses.length);
    expect([...result.cards.keys()].sort()).toEqual(courses.map((c) => c.id).sort());
    // No request after the root reads more than one page's worth.
    expect(site.requests.length).toBeLessThan(courses.length / 2);
    expect(site.requests[0]).toEqual([]);
  });

  it('asks a set no facet splits again until it reaches its count', async () => {
    const courses = Array.from({ length: 14 }, (_, n) => course(n + 1, 'it', 'pisa', '07_july'));
    const site = fakeSite(courses, 3);
    const result = await coverListing(site.read, { capacity: 12, maxResamples: 10 });
    expect(result.complete).toBe(true);
    expect(result.cards.size).toBe(14);
    expect(result.resamples).toBeGreaterThan(0);
  });

  it('a course with no value of any facet leaves the walk incomplete', async () => {
    // 51 courses: too many to find the orphan by asking the root again.
    const courses = Array.from({ length: 50 }, (_, n) =>
      course(
        n + 1,
        n < 15 ? 'uk' : 'it',
        n < 15 ? 'oxford' : 'pisa',
        n % 2 ? '06_june' : '07_july',
      ),
    );
    courses.push({ id: 'orphan', facets: {} });
    const site = fakeSite(courses);
    // Counted by the root but never among its first 12, as a shuffle may well do.
    const read = async (filters: Filters) => {
      const page = await site.read(filters);
      return page && { ...page, cards: page.cards.filter((card) => card.postId !== 'orphan') };
    };
    const result = await coverListing(read, { capacity: 12 });
    expect(result.complete).toBe(false);
    expect(result.uncovered).toBeGreaterThan(0);
  });

  it('a failed request leaves the walk incomplete, and the budget stops it', async () => {
    const courses = Array.from({ length: 40 }, (_, n) =>
      course(n + 1, ['uk', 'it', 'ge', 'at'][n % 4] as string, 'x', '07_july'),
    );
    const site = fakeSite(courses);
    let calls = 0;
    const failing = async (filters: Filters) => (++calls === 3 ? null : site.read(filters));
    const failed = await coverListing(failing, { capacity: 12 });
    expect(failed.complete).toBe(false);
    expect(failed.requestsOk).toBe(false);

    const capped = await coverListing(fakeSite(courses).read, { capacity: 12, maxRequests: 2 });
    expect(capped.complete).toBe(false);
    expect(capped.requests).toBe(2);
  });

  it('an empty root is complete with no courses, and a page short of its own count is not', async () => {
    const empty = await coverListing(fakeSite([]).read, { capacity: 12 });
    expect(empty).toMatchObject({ complete: true, rootTotal: 0 });
    expect(empty.cards.size).toBe(0);

    const short = async (): Promise<ParsedListingPage> => ({
      cards: [{ postId: '1' } as CourseCard],
      pager: { page: 1, perPage: 12, totalRows: 3, totalPages: 1 },
      facets: {},
    });
    expect((await coverListing(short, { capacity: 12, maxResamples: 2 })).complete).toBe(false);
  });
});
