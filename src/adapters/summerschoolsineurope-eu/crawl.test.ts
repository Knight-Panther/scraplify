import { and, eq, isNotNull } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../db/client.js';
import { getSourceBackoffUntil } from '../../db/ingest.js';
import { parserIncidents, sourceListingRevisions, sourceListings } from '../../db/schema/index.js';
import { cleanupTestSource } from '../../db/test-support.js';
import {
  type HttpFetcher,
  type HttpFetchResult,
  UrlNotAllowedError,
} from '../../net/http-fetcher.js';
import {
  isSummerSchoolsEuUrlAllowed,
  summerSchoolsEuSource,
} from '../../policies/summerschoolsineurope-eu.js';
import { listingUrl, runSummerSchoolsCrawl } from './crawl.js';

// Every write goes to a disposable source: only the ids and slug change, so
// URLs and the allow-list behave exactly as in production.
const testIds = vi.hoisted(() => ({
  sourceId: crypto.randomUUID(),
  policyId: crypto.randomUUID(),
}));

vi.mock('../../policies/summerschoolsineurope-eu.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../policies/summerschoolsineurope-eu.js')>();
  return {
    ...actual,
    summerSchoolsEuSource: {
      ...actual.summerSchoolsEuSource,
      id: testIds.sourceId,
      slug: `crawl-test-${testIds.sourceId}`,
    },
    summerSchoolsEuPolicy: {
      ...actual.summerSchoolsEuPolicy,
      id: testIds.policyId,
      sourceId: testIds.sourceId,
    },
  };
});

const BASE = 'https://www.summerschoolsineurope.eu';
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-13T16:10:00.000Z');

const PLACES: Record<string, [string, string, string]> = {
  pisa: ['italy', 'Italy', 'Pisa'],
  milan: ['italy', 'Italy', 'Milan'],
  tbilisi: ['georgia', 'Georgia', 'Tbilisi'],
  vienna: ['austria', 'Austria', 'Vienna'],
  // A facet value the allow-list rejects (a space), as a future site change might bring.
  'st petersburg': ['rus sia', 'Russia', 'St Petersburg'],
};

interface Course {
  id: string;
  city: keyof typeof PLACES;
  starting: string;
  when: string;
  deadline: string | null;
  online: boolean;
  fee: string;
  /** Sitemap lastmod and JSON-LD dateModified. */
  modified: string;
  /** The course page's slug, when not `course-<id>`. */
  slug?: string;
}

function course(id: number, city: keyof typeof PLACES, over: Partial<Course> = {}): Course {
  return {
    id: String(id),
    city,
    starting: '07_july',
    when: '05 July - 16 July 2027',
    deadline: null,
    online: false,
    fee: '500 EUR',
    modified: '2026-11-01T00:00:00+00:00',
    ...over,
  };
}

const slug = (c: Course) => c.slug ?? `course-${c.id}`;
const courseUrl = (c: Course) => `${BASE}/course/${slug(c)}/`;

function facetMarkup(values: Map<string, { label: string; count: number }>): string {
  return [...values]
    .map(
      ([value, { label, count }]) =>
        `<div class="facetwp-checkbox" data-value="${value}"><span class="facetwp-display-value">${label}</span><span class="facetwp-counter">(${count})</span></div>`,
    )
    .join('');
}

function cardHtml(c: Course): string {
  const [, country, city] = PLACES[c.city] as [string, string, string];
  const tags = [
    c.online ? '<span class="card-tag">Online</span>' : '',
    c.deadline ? `<span class="card-tag">Deadline: ${c.deadline}</span>` : '',
  ].join('');
  return `<article class="course-card" data-destination="School ${c.city}"><header><div>${tags}<button data-post-id="${c.id}"></button></div></header><div class="bg-white"><p class="text-sm">${city}, ${country}</p><h3>Course ${c.id}</h3><div class="grid"><p>When:</p><p>${c.when}</p><p>Fee:</p><p>${c.fee}</p></div></div><a href="${courseUrl(c)}" class="overlay-link"></a></article>`;
}

function detailHtml(c: Course): string {
  const [countrySlug, country, city] = PLACES[c.city] as [string, string, string];
  const jsonLd = JSON.stringify({
    '@graph': [
      { '@type': 'WebPage', datePublished: '2026-10-01T00:00:00+00:00', dateModified: c.modified },
    ],
  });
  return `<html><head><link rel="canonical" href="${courseUrl(c)}"><link rel="shortlink" href="${BASE}/?p=${c.id}"><script type="application/ld+json">${jsonLd}</script></head><body><main><section class="header"><p class="pretitle">Natural Sciences Summer Course</p><h1>Course ${c.id}</h1><div class="grid"><p>When:</p><p>${c.when}</p><p>School:</p><p><a href="${BASE}/destination/school-${c.city}/">School ${c.city}</a></p><p>City:</p><p><span><a href="${BASE}/courses/?_course_city=${c.city}">${city}</a></span></p><p>Country:</p><p><span><a href="${BASE}/courses/?_course_country=${countrySlug}">${country}</a></span></p><p>Fee:</p><p>${c.fee}</p></div><div class="button-group"><a class="btn" href="https://register.example/${c.id}">Learn more &amp; register</a><button data-post-id="${c.id}"></button></div></section><section class="text-only"><div class="content"><h2>About</h2><p>Course ${c.id} teaches things.</p></div></section></main></body></html>`;
}

function ok(url: string, body: string): HttpFetchResult {
  return {
    status: 200,
    headers: { 'content-type': 'text/html' },
    body,
    finalUrl: url,
    redirectCount: 0,
  };
}

/** The site as measured: filtered listings shuffled per request, 12 to a page, OR within a facet. */
class FakeSite implements HttpFetcher {
  readonly requested: string[] = [];
  /** Counted by the listing, never shown on a page (as a shuffle can do to an unlucky course). */
  readonly hidden = new Set<string>();
  /** Course pages that redirect off the allow-list, a hop the real fetcher refuses. */
  readonly redirectsOff = new Set<string>();
  challenge = false;
  private turn = 0;
  constructor(public courses: Course[]) {}

  async fetch(url: string): Promise<HttpFetchResult> {
    // As the real fetcher does: a URL outside the policy is never sent.
    if (!isSummerSchoolsEuUrlAllowed(url)) throw new UrlNotAllowedError(url);
    this.requested.push(url);
    if (this.challenge) {
      return {
        status: 403,
        headers: { 'cf-mitigated': 'challenge' },
        body: '<html>Just a moment...</html>',
        finalUrl: url,
        redirectCount: 0,
      };
    }
    const parsed = new URL(url);
    if (parsed.pathname === '/courses/') return ok(url, this.listing(parsed.searchParams));
    if (parsed.pathname === '/sitemap_index.xml') {
      return ok(
        url,
        `<sitemapindex><sitemap><loc>${BASE}/course-sitemap.xml</loc><lastmod>${this.newestChange}</lastmod></sitemap></sitemapindex>`,
      );
    }
    if (parsed.pathname === '/course-sitemap.xml') {
      const urls = this.courses
        .map((c) => `<url><loc>${courseUrl(c)}</loc><lastmod>${c.modified}</lastmod></url>`)
        .join('');
      return ok(url, `<urlset>${urls}</urlset>`);
    }
    const found = this.courses.find((c) => parsed.pathname === `/course/${slug(c)}/`);
    if (found !== undefined && this.redirectsOff.has(found.id)) {
      throw new UrlNotAllowedError(`${BASE}/?p=${found.id}`);
    }
    if (found !== undefined) return ok(url, detailHtml(found));
    return {
      status: 404,
      headers: {},
      body: '<html>Page not found</html>',
      finalUrl: url,
      redirectCount: 0,
    };
  }

  async close(): Promise<void> {}

  /** The index dates a course sitemap by its newest entry, as Yoast does. */
  private get newestChange(): string {
    return (
      this.courses
        .map((c) => c.modified)
        .sort()
        .at(-1) ?? '2026-11-01T00:00:00+00:00'
    );
  }

  get detailRequests(): string[] {
    return this.requested.filter((url) => url.includes('/course/'));
  }

  private listing(params: URLSearchParams): string {
    const facetOf = (c: Course, facet: string): string =>
      facet === 'course_country'
        ? (PLACES[c.city] as [string, string, string])[0]
        : facet === 'course_city'
          ? c.city
          : facet === 'course_starting'
            ? c.starting
            : '';
    const matching = this.courses.filter((c) =>
      [...params].every(([key, value]) =>
        key === '_course_status'
          ? value === 'future'
          : value.split(',').includes(facetOf(c, key.slice(1))),
      ),
    );
    this.turn++;
    const shuffled = [...matching].sort(
      (a, b) =>
        ((Number(a.id) * 7919 + this.turn * 104_729) % 97) -
        ((Number(b.id) * 7919 + this.turn * 104_729) % 97),
    );
    const facets: Record<string, string> = {};
    for (const facet of ['course_country', 'course_city', 'course_starting']) {
      const counts = new Map<string, { label: string; count: number }>();
      for (const c of matching) {
        const value = facetOf(c, facet);
        counts.set(value, { label: value, count: (counts.get(value)?.count ?? 0) + 1 });
      }
      facets[facet] = facetMarkup(counts);
    }
    const fwp = {
      prefix: '_',
      preload_data: {
        facets,
        settings: {
          pager: {
            page: 1,
            per_page: 12,
            total_rows: matching.length,
            total_rows_unfiltered: 9999,
            total_pages: Math.ceil(matching.length / 12),
          },
        },
      },
    };
    const cards = shuffled
      .filter((c) => !this.hidden.has(c.id))
      .slice(0, 12)
      .map(cardHtml)
      .join('');
    return `<html><body>${cards}<script>window.FWP_JSON = ${JSON.stringify(fwp)};</script></body></html>`;
  }
}

function clock(start: number): () => string {
  let t = start;
  return () => {
    t += 1000;
    return new Date(t).toISOString();
  };
}

async function listing(id: string) {
  const [row] = await db
    .select()
    .from(sourceListings)
    .where(
      and(
        eq(sourceListings.sourceId, summerSchoolsEuSource.id),
        eq(sourceListings.sourceRecordId, id),
      ),
    );
  return row;
}

async function revision(id: string) {
  const row = await listing(id);
  if (row?.currentRevisionId == null) return undefined;
  const [rev] = await db
    .select()
    .from(sourceListingRevisions)
    .where(eq(sourceListingRevisions.id, row.currentRevisionId));
  return rev;
}

function run(site: FakeSite, at: number) {
  return runSummerSchoolsCrawl({ db, httpFetcher: site, now: clock(at) });
}

/** 30 courses: Italy 14 (Pisa 8, Milan 6), Georgia 5, Austria 11. */
function catalogue(): Course[] {
  const courses: Course[] = [];
  for (let n = 1; n <= 30; n++) {
    const city = n <= 8 ? 'pisa' : n <= 14 ? 'milan' : n <= 19 ? 'tbilisi' : 'vienna';
    courses.push(course(n, city));
  }
  return courses;
}

describe('runSummerSchoolsCrawl', () => {
  afterEach(async () => {
    await cleanupTestSource(summerSchoolsEuSource.id);
  });

  it('builds listing URLs with the upcoming filter first and OR-ed values', () => {
    expect(listingUrl([])).toBe(`${BASE}/courses/?_course_status=future`);
    expect(listingUrl([['course_country', ['austria', 'georgia']]])).toBe(
      `${BASE}/courses/?_course_status=future&_course_country=austria%2Cgeorgia`,
    );
  });

  it('reads every course once through the covering walk and writes it with its card facts', async () => {
    const courses = catalogue();
    (courses[19] as Course).deadline = '01 June';
    (courses[20] as Course).online = true;
    const site = new FakeSite(courses);
    const { crawlRun, stats } = await run(site, NOW);

    expect(crawlRun.status).toBe('completed');
    expect(crawlRun.fullCoverage).toBe(true);
    expect(stats).toMatchObject({
      rootTotal: 30,
      coursesSeen: 30,
      uncovered: 0,
      detailFetches: 30,
    });
    expect(stats.listingRequests).toBeLessThan(10);
    const rows = await db
      .select()
      .from(sourceListings)
      .where(eq(sourceListings.sourceId, summerSchoolsEuSource.id));
    expect(rows).toHaveLength(30);
    expect(rows.every((row) => row.status === 'active')).toBe(true);

    const withDeadline = await listing('20');
    expect(Date.parse(withDeadline?.sourceDeadlineAt ?? '')).toBe(
      Date.parse('2027-06-01T19:59:59.000Z'),
    );
    const online = await revision('21');
    expect(online?.locations).toEqual([]);
    expect(online?.structuredAttributes).toMatchObject({
      opportunityKind: 'summer_school',
      format: 'online',
      countrySlug: 'austria',
    });
  });

  it('the second run fetches only changed courses; a newer sitemap lastmod fetches an unchanged card', async () => {
    const courses = catalogue();
    const site = new FakeSite(courses);
    await run(site, NOW);

    (courses[0] as Course).fee = '550 EUR';
    (courses[1] as Course).modified = '2026-11-14T08:00:00+00:00';
    const before = site.detailRequests.length;
    const second = await run(site, NOW + DAY_MS);

    expect(second.crawlRun.status).toBe('completed');
    expect(site.detailRequests.slice(before).sort()).toEqual(
      [courseUrl(courses[0] as Course), courseUrl(courses[1] as Course)].sort(),
    );
    expect(second.stats).toMatchObject({ fetchedCardChanged: 1, fetchedSitemapChanged: 1 });
    expect((await revision('1'))?.structuredAttributes).toMatchObject({
      fee: { amount: 550, currency: 'EUR' },
    });
  });

  it('a badge that vanishes after its day keeps the stored deadline, so the course stays expired', async () => {
    const courses = catalogue();
    (courses[0] as Course).deadline = '01 June';
    const site = new FakeSite(courses);
    await run(site, NOW);
    const stored = (await listing('1'))?.sourceDeadlineAt;

    // Two days after 1 June 2027 the badge is gone from the card.
    (courses[0] as Course).deadline = null;
    const before = site.detailRequests.length;
    await run(site, Date.parse('2027-06-03T16:10:00.000Z'));
    expect(site.detailRequests.slice(before)).toEqual([]);
    expect((await listing('1'))?.status).toBe('expired');

    // A page change brings a fetch, and the deadline survives it as stored.
    (courses[0] as Course).modified = '2027-06-04T08:00:00+00:00';
    await run(site, Date.parse('2027-06-04T16:10:00.000Z'));
    expect((await revision('1'))?.deadlineDate).toEqual({
      raw: '01 June',
      parsed: '2027-06-01T19:59:59.000Z',
    });
    expect((await listing('1'))?.sourceDeadlineAt).toBe(stored);
    expect((await listing('1'))?.status).toBe('expired');
  });

  it('a badge removed before its day drops the deadline, and the course stays open', async () => {
    const courses = catalogue();
    (courses[0] as Course).deadline = '01 June';
    const site = new FakeSite(courses);
    await run(site, NOW);

    (courses[0] as Course).deadline = null;
    await run(site, NOW + DAY_MS);
    expect((await listing('1'))?.sourceDeadlineAt).toBeNull();
    expect((await revision('1'))?.deadlineDate).toEqual({ raw: null, parsed: null });
    expect((await listing('1'))?.status).toBe('active');
  });

  it('a page whose only change is its date is read once, not on every later run', async () => {
    const courses = catalogue();
    const site = new FakeSite(courses);
    await run(site, NOW);

    (courses[3] as Course).modified = '2026-11-14T08:00:00+00:00';
    let before = site.detailRequests.length;
    await run(site, NOW + DAY_MS);
    expect(site.detailRequests.slice(before)).toEqual([courseUrl(courses[3] as Course)]);

    before = site.detailRequests.length;
    const third = await run(site, NOW + 2 * DAY_MS);
    expect(site.detailRequests.slice(before)).toEqual([]);
    expect(third.stats.fetchedSitemapChanged).toBe(0);
  });

  it('a page read within two hours of its change is read once more, as the page cache may have served the old one', async () => {
    const courses = catalogue();
    const site = new FakeSite(courses);
    await run(site, NOW);

    // Changed 40 minutes before the next run reads it.
    (courses[3] as Course).modified = '2026-11-14T15:30:00+00:00';
    const reads: string[][] = [];
    for (let day = 1; day <= 3; day++) {
      const before = site.detailRequests.length;
      await run(site, NOW + day * DAY_MS);
      reads.push(site.detailRequests.slice(before));
    }
    expect(reads).toEqual([
      [courseUrl(courses[3] as Course)],
      [courseUrl(courses[3] as Course)],
      [],
    ]);
  });

  it('a course page the policy rejects fails alone, with an incident, and the run goes on', async () => {
    const courses = catalogue();
    courses.push(course(31, 'pisa', { slug: 'odd.slug' }));
    const site = new FakeSite(courses);
    const { crawlRun, stats } = await run(site, NOW);

    expect(crawlRun.status).toBe('completed');
    expect(crawlRun.failedCount).toBe(1);
    expect(stats.coursesSeen).toBe(31);
    expect(stats.refusedUrls).toBe(1);
    expect(site.detailRequests).toHaveLength(30);
    expect((await listing('31'))?.currentRevisionId).toBeNull();
    expect((await listing('30'))?.currentRevisionId).not.toBeNull();
    const incidents = await db
      .select()
      .from(parserIncidents)
      .where(eq(parserIncidents.sourceId, summerSchoolsEuSource.id));
    expect(incidents.map((incident) => incident.evidence)).toContainEqual(
      expect.objectContaining({ reason: 'url_not_allowed', url: `${BASE}/course/odd.slug/` }),
    );
  });

  it('a course page that redirects off the allow-list fails alone, and the run goes on', async () => {
    const site = new FakeSite(catalogue());
    site.redirectsOff.add('5');
    const { crawlRun } = await run(site, NOW);

    expect(crawlRun.status).toBe('completed');
    expect(crawlRun.failedCount).toBe(1);
    expect(site.detailRequests).toHaveLength(30);
    expect((await listing('5'))?.currentRevisionId).toBeNull();
    expect((await listing('6'))?.currentRevisionId).not.toBeNull();
  });

  it('a facet value the policy rejects leaves its courses unseen, the run partial, and the rest read', async () => {
    const courses = catalogue();
    // Ten courses only the refused city and country values reach, beyond
    // the root's page 1; forty in all, too many for the root to be asked again.
    for (let n = 31; n <= 40; n++) courses.push(course(n, 'st petersburg'));
    const site = new FakeSite(courses);
    const { crawlRun, stats } = await run(site, NOW);

    expect(crawlRun.status).toBe('partial');
    expect(stats.rootTotal).toBe(40);
    expect(stats.uncovered).toBeGreaterThan(0);
    expect(stats.coursesSeen).toBe(40 - stats.uncovered);
    const read = await db
      .select({ id: sourceListings.sourceRecordId })
      .from(sourceListings)
      .where(
        and(
          eq(sourceListings.sourceId, summerSchoolsEuSource.id),
          isNotNull(sourceListings.currentRevisionId),
        ),
      );
    expect(read.map((row) => row.id)).toEqual(expect.arrayContaining(catalogue().map((c) => c.id)));
    const incidents = await db
      .select()
      .from(parserIncidents)
      .where(eq(parserIncidents.sourceId, summerSchoolsEuSource.id));
    expect(incidents.map((incident) => incident.evidence)).toContainEqual(
      expect.objectContaining({ reason: 'facet_value_not_allowed', value: 'st petersburg' }),
    );
    expect(incidents.map((incident) => incident.evidence)).toContainEqual(
      expect.objectContaining({ reason: 'facet_value_not_allowed', value: 'rus sia' }),
    );
  });

  it('a started course closes by date without a request, and stays closed while the site still lists it', async () => {
    const courses = catalogue();
    (courses[2] as Course).when = '20 November - 27 November 2026';
    const site = new FakeSite(courses);
    await run(site, NOW);
    expect((await listing('3'))?.status).toBe('active');

    const before = site.detailRequests.length;
    const after = await run(site, Date.parse('2026-11-21T16:10:00.000Z'));
    expect((await listing('3'))?.status).toBe('expired');
    expect(after.stats.startedClosed).toBe(1);
    expect(site.detailRequests.slice(before)).toEqual([]);

    await run(site, Date.parse('2026-11-22T16:10:00.000Z'));
    expect((await listing('3'))?.status).toBe('expired');
  });

  it('a course absent from three complete walks closes', async () => {
    const courses = catalogue();
    const site = new FakeSite(courses);
    await run(site, NOW);
    site.courses = courses.filter((c) => c.id !== '5');

    await run(site, NOW + DAY_MS);
    expect((await listing('5'))?.status).toBe('missing_suspected');
    await run(site, NOW + 2 * DAY_MS);
    expect((await listing('5'))?.status).toBe('missing_suspected');
    const third = await run(site, NOW + 3 * DAY_MS);
    expect(third.crawlRun.status).toBe('completed');
    expect((await listing('5'))?.status).toBe('closed');
  });

  it('short coverage leaves the run partial and closes nothing', async () => {
    const courses = Array.from({ length: 40 }, (_, n) => course(n + 1, n < 20 ? 'pisa' : 'vienna'));
    const site = new FakeSite(courses);
    await run(site, NOW);

    site.hidden.add('7');
    site.courses = courses.filter((c) => c.id !== '30');
    for (let day = 1; day <= 3; day++) {
      const partial = await run(site, NOW + day * DAY_MS);
      expect(partial.crawlRun.status).toBe('partial');
      expect(partial.stats.uncovered).toBeGreaterThan(0);
    }
    expect((await listing('30'))?.status).toBe('active');
    expect((await listing('7'))?.status).toBe('active');
  });

  it('a 403 or a challenge page stops the run and backs the source off', async () => {
    const site = new FakeSite(catalogue());
    site.challenge = true;
    const { crawlRun } = await run(site, NOW);
    expect(crawlRun.status).toBe('partial');
    expect(site.requested).toHaveLength(1);
    expect(await getSourceBackoffUntil(db, summerSchoolsEuSource.id)).not.toBeNull();

    // The next run inside the back-off asks nothing.
    site.challenge = false;
    await run(site, NOW + 60_000);
    expect(site.requested).toHaveLength(1);
  });
});
