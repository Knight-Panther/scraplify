import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ResourceId } from '../../domain/ids.js';
import {
  type CourseAttributes,
  type ParseCoursePageInput,
  parseCoursePage,
  SummerSchoolsDetailParseError,
} from './detail.js';

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf-8');
}

const PROVENANCE = {
  resourceId: '00000000-0000-4000-8000-000000000001' as ResourceId,
  fetchedAt: '2026-11-13T11:00:00.000Z',
  notes: null,
};

function parse(
  name: string,
  postId: string,
  overrides: Partial<ParseCoursePageInput> = {},
): ReturnType<typeof parseCoursePage> {
  return parseCoursePage({
    html: fixture(name),
    expectedPostId: postId,
    card: { deadlineRaw: null, online: false },
    disciplineSlugs: new Map([
      ['Social Sciences', 'social-sciences'],
      ['Psychology', 'psychology'],
      ['Business & Entrepreneurship', 'business-entrepreneurship'],
    ]),
    extractionMethod: 'http',
    provenance: PROVENANCE,
    ...overrides,
  });
}

function attributes(content: ReturnType<typeof parseCoursePage>): CourseAttributes {
  return content.structuredAttributes as unknown as CourseAttributes;
}

describe('parseCoursePage', () => {
  it('reads a course with an external register link and an early-bird line', () => {
    const content = parse('detail-48834-early-bird-register.html', '48834');
    expect(content.titleRaw).toBe('Mindfulness and Compassion-based Interventions');
    expect(content.organizationRaw).toBe('University of Amsterdam Summer School');
    expect(content.locations).toEqual(['Amsterdam, Netherlands']);
    expect(content.salaryRaw).toBeNull();
    expect(content.applicationMethod).toEqual({
      type: 'url',
      value:
        'https://summerschool.uva.nl/content/summer-courses/a-peaceful-mind/a-peaceful-mind.html?origin=PtN3uwswQquDlGtnNX3f',
    });
    expect(content.publishedDate).toEqual({
      raw: '2024-11-01T07:57:39+00:00',
      parsed: '2024-11-01T07:57:39.000Z',
    });
    expect(content.sourceCategories).toEqual(['Social Sciences', 'Psychology']);
    expect(attributes(content)).toMatchObject({
      kind: 'programme',
      opportunityKind: 'summer_school',
      audience: ['individuals'],
      postId: '48834',
      season: 'summer',
      startDate: '2027-07-18',
      endDate: '2027-08-05',
      durationDays: 19,
      datesSuspect: false,
      school: 'University of Amsterdam Summer School',
      schoolSlug: 'university-of-amsterdam-summer-school',
      institution: 'University of Amsterdam',
      city: 'Amsterdam',
      citySlugs: ['amsterdam'],
      country: 'Netherlands',
      countrySlug: 'netherlands',
      format: null,
      language: 'English',
      credits: { amount: 6, unit: 'EC' },
      fee: { amount: 1850, currency: 'EUR', raw: '1850 EUR' },
      feeOptions: [
        { amount: 1850, currency: 'EUR', label: 'Student' },
        { amount: 2200, currency: 'EUR', label: 'Professional' },
      ],
      earlyBirdDeadline: '2027-02-07',
      registration: 'external',
      schoolUrl: null,
      disciplines: [
        { slug: 'social-sciences', name: 'Social Sciences' },
        { slug: 'psychology', name: 'Psychology' },
      ],
      modifiedAt: '2026-10-22T09:47:40.000Z',
    });
  });

  it('early-bird is never the deadline', () => {
    const content = parse('detail-48834-early-bird-register.html', '48834');
    expect(content.deadlineDate).toEqual({ raw: null, parsed: null });
  });

  it("takes the registration deadline from the card, its year from the course's dates", () => {
    const content = parse('detail-72548-card-deadline-only.html', '72548', {
      card: { deadlineRaw: '30 November', online: false },
    });
    expect(content.deadlineDate).toEqual({
      raw: '30 November',
      parsed: '2026-11-30T19:59:59.000Z',
    });
  });

  it("reads the site's own form, the school's link, fee options and an unknown discipline slug", () => {
    const content = parse('detail-63043-interested-form-fee-options.html', '63043', {
      disciplineSlugs: new Map(),
    });
    expect(content.applicationMethod).toEqual({
      type: 'form',
      value:
        'https://www.summerschoolsineurope.eu/course/introduction-to-leadership-and-organisational-behaviour-a-global-perspective/',
    });
    expect(attributes(content)).toMatchObject({
      registration: 'on_source',
      schoolUrl:
        'https://vu.nl/en/education/summerschool?utm_source=ssie&utm_medium=affiliate&utm_campaign=summerschool2026',
      startDate: '2026-07-05',
      credits: { amount: 0, unit: 'EC' },
      feeOptions: [{ amount: 1295, currency: 'EUR', label: 'Student' }],
      disciplines: [
        { slug: null, name: 'Business & Entrepreneurship' },
        { slug: null, name: 'Psychology' },
      ],
    });
  });

  it('an online course has no location and no fee when none is printed', () => {
    const content = parse('detail-72851-online-no-fee.html', '72851', {
      card: { deadlineRaw: null, online: true },
    });
    expect(content.titleRaw).toBe('TÜ-VIP February 2027 It’s online, live and free!');
    expect(content.locations).toEqual([]);
    expect(attributes(content)).toMatchObject({
      format: 'online',
      fee: null,
      feeOptions: [],
      season: 'spring',
      city: 'Tübingen',
      country: 'Germany',
    });
  });

  it('keeps suspect dates raw, Institution N/A as none, and a fee with decimals', () => {
    expect(attributes(parse('detail-73181-end-before-start.html', '73181'))).toMatchObject({
      whenRaw: '28 June - 02 June 2027',
      datesSuspect: true,
      durationDays: null,
    });
    const tbilisi = attributes(parse('detail-73336-tbilisi.html', '73336'));
    expect(tbilisi).toMatchObject({ institution: null, city: 'Tbilisi', countrySlug: 'georgia' });
    expect(tbilisi.feeOptions).toContainEqual({
      amount: 1327.5,
      currency: 'EUR',
      label: 'Early registration with accommodation',
    });
  });

  it('a page whose shortlink names another post is refused', () => {
    const html = fixture('detail-48834-early-bird-register.html').replace('/?p=48834', '/?p=99999');
    expect(() =>
      parseCoursePage({
        html,
        expectedPostId: '48834',
        card: { deadlineRaw: null, online: false },
        extractionMethod: 'http',
        provenance: PROVENANCE,
      }),
    ).toThrow(/99999/);
    expect(() => parse('detail-48834-early-bird-register.html', '72366')).toThrow(
      SummerSchoolsDetailParseError,
    );
  });

  it('required fields or a typed error', () => {
    const noTitle = fixture('detail-48834-early-bird-register.html').replace(
      /<h1>[^<]*<\/h1>/,
      '<h1></h1>',
    );
    expect(() =>
      parseCoursePage({
        html: noTitle,
        expectedPostId: '48834',
        card: { deadlineRaw: null, online: false },
        extractionMethod: 'http',
        provenance: PROVENANCE,
      }),
    ).toThrow(/title/);
    expect(() =>
      parseCoursePage({
        html: fixture('not-found-404.html'),
        expectedPostId: '48834',
        card: { deadlineRaw: null, online: false },
        extractionMethod: 'http',
        provenance: PROVENANCE,
      }),
    ).toThrow(SummerSchoolsDetailParseError);
  });

  it('the excerpt is bounded and carries no email, phone or URL', () => {
    for (const [name, id] of [
      ['detail-48834-early-bird-register.html', '48834'],
      ['detail-63043-interested-form-fee-options.html', '63043'],
      ['detail-73336-tbilisi.html', '73336'],
      ['detail-64143-nok.html', '64143'],
    ] as const) {
      const excerpt = attributes(parse(name, id)).excerpt;
      expect(excerpt, name).not.toBeNull();
      expect(
        [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(excerpt ?? '')].length,
      ).toBeLessThanOrEqual(280);
      expect(excerpt).not.toMatch(/@|https?:\/\/|www\.|\+?\d[\d\s-]{7,}\d/);
    }
  });

  it('no attribute string exceeds 300 characters', () => {
    const strings = (value: unknown): string[] =>
      typeof value === 'string'
        ? [value]
        : Array.isArray(value)
          ? value.flatMap(strings)
          : value !== null && typeof value === 'object'
            ? Object.values(value).flatMap(strings)
            : [];
    for (const [name, id] of [
      ['detail-48834-early-bird-register.html', '48834'],
      ['detail-20152-fee-dot.html', '20152'],
      ['detail-63043-interested-form-fee-options.html', '63043'],
      ['detail-64143-nok.html', '64143'],
    ] as const) {
      for (const text of strings(parse(name, id).structuredAttributes)) {
        expect(text.length, `${name}: ${text.slice(0, 60)}`).toBeLessThanOrEqual(300);
      }
    }
  });

  it('keeps the full text, Course leader left out, and a content hash that ignores the fetch', () => {
    const first = parse('detail-48834-early-bird-register.html', '48834');
    expect(first.description).toMatch(/^About\n/);
    expect(first.description).toMatch(/Fee info/);
    expect(first.description).not.toMatch(/Course leader/);
    const again = parse('detail-48834-early-bird-register.html', '48834', {
      provenance: { ...PROVENANCE, fetchedAt: '2026-11-14T11:00:00.000Z' },
    });
    expect(again.meaningfulContentHash).toBe(first.meaningfulContentHash);
    const changed = parse('detail-48834-early-bird-register.html', '48834', {
      card: { deadlineRaw: '01 June', online: false },
    });
    expect(changed.meaningfulContentHash).not.toBe(first.meaningfulContentHash);
  });
});
