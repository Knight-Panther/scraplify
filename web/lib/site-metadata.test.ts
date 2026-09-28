import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type {
  PublicOpportunityDetailView,
  PublicOpportunityMemberDetail,
} from '../../src/browse/public-queries.js';
import {
  isIndexable,
  OG_IMAGE_ALT,
  opportunityDescription,
  siteDescription,
  siteOpenGraph,
  siteOrigin,
  siteTitle,
} from './site-metadata.js';

function member(
  overrides: Partial<PublicOpportunityMemberDetail> = {},
): PublicOpportunityMemberDetail {
  return {
    sourceListingId: 'sl-1',
    sourceSlug: 'jobs-ge',
    status: 'open',
    title: 'გაყიდვების მენეჯერი',
    organization: 'შპს მაგალითი',
    canonicalUrl: 'https://jobs.ge/?view=jobs&id=1',
    publishedAt: null,
    deadlineAt: null,
    firstSeenAt: '2026-09-20T00:00:00.000Z',
    lastSeenAt: '2026-09-28T00:00:00.000Z',
    applicationMethod: null,
    description: '',
    locations: ['თბილისი'],
    salaryRaw: null,
    sourceCategories: null,
    structuredAttributes: null,
    ...overrides,
  };
}

function view(members: PublicOpportunityMemberDetail[]): PublicOpportunityDetailView {
  return {
    opportunityId: '00000000-0000-4000-8000-000000000001',
    canonicalTitle: 'გაყიდვების მენეჯერი',
    canonicalStatus: 'open',
    type: 'job',
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:00.000Z',
    members,
  };
}

describe('siteOrigin', () => {
  it('reads XTELO_SITE_URL on public, reduced to its origin', () => {
    expect(
      siteOrigin({ XTELO_SITE_URL: 'https://jobster.fun/some/path?x=1' }, 'public')?.href,
    ).toBe('https://jobster.fun/');
  });

  it('reads AUTH_URL on admin, not XTELO_SITE_URL', () => {
    const env = { AUTH_URL: 'https://admin.jobster.fun', XTELO_SITE_URL: 'https://jobster.fun' };
    expect(siteOrigin(env, 'admin')?.href).toBe('https://admin.jobster.fun/');
  });

  it.each(['', '   ', 'jobster.fun', 'javascript:alert(1)', 'ftp://jobster.fun', 'not a url'])(
    'ignores %o rather than trusting it',
    (value) => {
      expect(siteOrigin({ XTELO_SITE_URL: value }, 'public')).toBeUndefined();
    },
  );

  it('is undefined when unset', () => {
    expect(siteOrigin({}, 'local')).toBeUndefined();
  });
});

describe('isIndexable', () => {
  it('lets search engines index only the public catalogue', () => {
    expect(isIndexable('public')).toBe(true);
    expect(isIndexable('admin')).toBe(false);
    expect(isIndexable('local')).toBe(false);
  });
});

describe('opportunityDescription', () => {
  it('states employer, place and boards from the members', () => {
    expect(opportunityDescription(view([member()]))).toBe('შპს მაგალითი · თბილისი · on jobs.ge');
  });

  it('names both boards once for a cross-posted vacancy', () => {
    const text = opportunityDescription(
      view([
        member(),
        member({ sourceListingId: 'sl-2', sourceSlug: 'hr-ge' }),
        member({ sourceListingId: 'sl-3' }),
      ]),
    );
    expect(text).toBe('შპს მაგალითი · თბილისი · on jobs.ge and hr.ge');
  });

  it('leaves out what no board states instead of inventing it', () => {
    expect(opportunityDescription(view([member({ organization: null, locations: [] })]))).toBe(
      'on jobs.ge',
    );
  });

  it('adds the start of the description and clips at a word boundary', () => {
    const long = 'ვეძებთ '.repeat(60);
    const text = opportunityDescription(view([member({ description: long })]));
    expect(text.startsWith('შპს მაგალითი · თბილისი · on jobs.ge. ვეძებთ')).toBe(true);
    expect(text.length).toBeLessThanOrEqual(160);
    expect(text.endsWith('…')).toBe(true);
    expect(text).not.toMatch(/\s…$/);
  });

  it('falls back to the site description when a vacancy has no members to describe', () => {
    expect(opportunityDescription(view([]))).toBe(siteDescription('en'));
  });
});

describe('siteOpenGraph', () => {
  it('always names the preview image, so a page override cannot drop it', () => {
    const og = siteOpenGraph({ title: 'T', url: '/opportunities/x' });
    expect(og.images).toEqual([
      { url: '/opengraph-image.jpg', width: 1200, height: 630, type: 'image/jpeg', alt: OG_IMAGE_ALT },
    ]);
    expect(og.title).toBe('T');
    expect(og.url).toBe('/opportunities/x');
    expect(og.description).toBe(siteDescription('ka'));
  });

  it('leaves url out unless a page states it', () => {
    expect('url' in siteOpenGraph()).toBe(false);
  });

  it('keeps the alt text in step with app/opengraph-image.alt.txt', () => {
    const file = readFileSync(new URL('../app/opengraph-image.alt.txt', import.meta.url), 'utf8');
    expect(file.trim()).toBe(OG_IMAGE_ALT);
  });
});

describe('site title and description', () => {
  it('are Georgian by default and come from the hero copy', () => {
    expect(siteTitle('ka')).toBe('Xtelo: არ გამოტოვო ვაკანსია, მოძებნე მარტივად!');
    expect(siteDescription('ka')).toMatch(/^ვაკანსიები jobs.ge-დან/);
  });

  it('read as a sentence in English, not in display capitals', () => {
    expect(siteTitle('en')).toBe('Xtelo: Do not miss your chance, keep yourself posted!');
  });

  it('fit where previews and search results cut them', () => {
    for (const locale of ['ka', 'en'] as const) {
      expect(siteDescription(locale).length).toBeLessThanOrEqual(160);
    }
  });

  it('tag the preview with its language, Georgian first', () => {
    expect(siteOpenGraph().locale).toBe('ka_GE');
    expect(siteOpenGraph().alternateLocale).toEqual(['en_US']);
    expect(siteOpenGraph({ locale: 'en' }).locale).toBe('en_US');
  });
});
