import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  type CourseCard,
  cardFingerprint,
  extractFwpJson,
  parseListingPage,
  SummerSchoolsListingParseError,
} from './listing.js';

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf-8');
}

describe('parseListingPage', () => {
  it('reads 12 cards, post id, school, place and the pager from FWP_JSON', () => {
    const page = parseListingPage(fixture('listing-p1.html'));
    expect(page.cards).toHaveLength(12);
    expect(page.pager).toEqual({ page: 1, perPage: 12, totalRows: 625, totalPages: 53 });
    expect(page.cards[0]).toMatchObject({
      postId: '48834',
      url: 'https://www.summerschoolsineurope.eu/course/mindfulness-and-compassion-based-interventions-2/',
      title: 'Mindfulness and Compassion-based Interventions',
      school: 'University of Amsterdam Summer School',
      placeRaw: 'Amsterdam, Netherlands',
      whenRaw: '18 July - 05 August 2027',
      creditsRaw: '6 EC',
      feeRaw: '1850 EUR',
      languageRaw: 'English',
      deadlineRaw: null,
      online: false,
      topCourse: false,
    });
  });

  it('reads the Online, Top course and deadline tags, and decodes entities', () => {
    const page = parseListingPage(fixture('listing-p10.html'));
    const byId = new Map(page.cards.map((card) => [card.postId, card]));
    expect(byId.get('72548')).toMatchObject({ deadlineRaw: '30 November', online: false });
    expect(byId.get('52478')).toMatchObject({ deadlineRaw: '01 December', topCourse: true });
    expect(byId.get('72851')).toMatchObject({
      title: 'TÜ-VIP February 2027 It’s online, live and free!',
      school: 'Tübingen International & European Studies (T-IES)',
      online: true,
      topCourse: true,
      feeRaw: null,
    });
  });

  it('a deadline badge is kept raw', () => {
    const page = parseListingPage(fixture('listing-p10.html'));
    const deadlines = page.cards.map((card) => card.deadlineRaw).filter((raw) => raw !== null);
    expect(deadlines.sort()).toEqual(['01 December', '30 November']);
  });

  it('reads every facet choice with its value, label and count', () => {
    const page = parseListingPage(fixture('listing-p1.html'));
    expect(page.facets.course_country?.find((choice) => choice.value === 'italy')).toEqual({
      value: 'italy',
      label: 'Italy',
      count: 87,
    });
    expect(page.facets.course_country?.reduce((sum, choice) => sum + choice.count, 0)).toBe(626);
    expect(page.facets.course_starting?.[0]).toEqual({
      value: '01_january',
      label: 'January',
      count: 86,
    });
  });

  it('refuses a page with no FWP_JSON, or a card with no post id', () => {
    expect(() => parseListingPage('<html><body>maintenance</body></html>')).toThrow(
      SummerSchoolsListingParseError,
    );
    const broken = fixture('listing-p1.html').replace('data-post-id="48834"', 'data-x="48834"');
    expect(() => parseListingPage(broken)).toThrow(/post id/);
  });
});

describe('extractFwpJson', () => {
  it('reads the object even when a string inside it holds braces and quotes', () => {
    const html = '<script>window.FWP_JSON = {"a":"}{\\"","b":{"c":1}};</script>';
    expect(extractFwpJson(html)).toEqual({ a: '}{"', b: { c: 1 } });
  });
});

describe('cardFingerprint', () => {
  it('the fingerprint ignores "Top course" and card order', () => {
    const page = parseListingPage(fixture('listing-p10.html'));
    const card = page.cards.find((c) => c.postId === '52478');
    if (card === undefined) throw new Error('fixture card missing');
    const unpromoted: CourseCard = { ...card, topCourse: !card.topCourse };
    expect(cardFingerprint(unpromoted)).toBe(card.fingerprint);
    expect(cardFingerprint({ ...card, deadlineRaw: '02 December' })).not.toBe(card.fingerprint);
    expect(cardFingerprint({ ...card, online: true })).not.toBe(card.fingerprint);
    expect(cardFingerprint({ ...card, feeRaw: '360 EUR' })).not.toBe(card.fingerprint);
  });

  // Trial run 2 (2026-11-13): 11 of the 34 courses held in two cities were read
  // again with nothing changed, because their card names one of the cities,
  // not always the same one (an Atlas course read "Oxford" on Cambridge's page).
  it('ignores which of its cities a card names, and the order of its languages', () => {
    const card = {
      title: 'Atlas Summer Courses: Law',
      school: 'Atlas Summer Courses',
      placeRaw: 'Cambridge, United Kingdom',
      whenRaw: '27 June - 29 August 2027',
      creditsRaw: '0 EC',
      feeRaw: '6995 GBP',
      languageRaw: 'French, English',
      deadlineRaw: null,
      online: false,
    };
    expect(cardFingerprint({ ...card, placeRaw: 'Oxford, United Kingdom' })).toBe(
      cardFingerprint(card),
    );
    expect(cardFingerprint({ ...card, languageRaw: 'English, French' })).toBe(
      cardFingerprint(card),
    );
    expect(cardFingerprint({ ...card, languageRaw: 'English' })).not.toBe(cardFingerprint(card));
    expect(cardFingerprint({ ...card, whenRaw: '04 July - 29 August 2027' })).not.toBe(
      cardFingerprint(card),
    );
  });
});
