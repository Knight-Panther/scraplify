import { describe, expect, it } from 'vitest';
import { etendersGeSource, hrGeSource, jobsGeSource, sourcePolicies, ssGeSource } from './index.js';
import {
  isSummerSchoolsEuUrlAllowed,
  summerSchoolsEuPolicy,
  summerSchoolsEuSource,
} from './summerschoolsineurope-eu.js';

const BASE = 'https://www.summerschoolsineurope.eu';

describe('summerschoolsineurope.eu source policy', () => {
  it('is registered under its own id and slug, distinct from every other source', () => {
    expect(summerSchoolsEuSource.slug).toBe('summerschoolsineurope-eu');
    expect(summerSchoolsEuPolicy.sourceId).toBe(summerSchoolsEuSource.id);
    expect(sourcePolicies['summerschoolsineurope-eu'].source.id).toBe(summerSchoolsEuSource.id);
    const ids = [
      summerSchoolsEuSource.id,
      jobsGeSource.id,
      hrGeSource.id,
      etendersGeSource.id,
      ssGeSource.id,
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps to the robots.txt Crawl-delay of 15 s, one request at a time, http only, no login, no linked resources', () => {
    expect(summerSchoolsEuPolicy.allowedAcquisitionModes).toEqual(['http']);
    expect(summerSchoolsEuPolicy.authenticationScope).toBe('none');
    expect(summerSchoolsEuPolicy.rateLimit).toMatchObject({
      crawlDelaySeconds: 15,
      maxConcurrency: 1,
    });
    expect(summerSchoolsEuPolicy.linkedResources.retention).toBe('none');
    expect(summerSchoolsEuPolicy.linkedResources.mayFetchExternalApplicationPages).toBe(false);
  });

  it('shows facts, an excerpt and links only, and says its terms are not reviewed yet', () => {
    expect(summerSchoolsEuPolicy.display.mayRepublishFullContent).toBe(false);
    expect(summerSchoolsEuPolicy.termsUrl).toBeNull();
    expect(summerSchoolsEuPolicy.notes).toMatch(/terms/i);
    expect(summerSchoolsEuPolicy.evidence.join('\n')).toMatch(/robots\.txt/);
  });
});

describe('isSummerSchoolsEuUrlAllowed', () => {
  const FUTURE = `${BASE}/courses/?_course_status=future`;

  it('allows the upcoming-course listing, filtered by the facets the covering walk splits on', () => {
    expect(isSummerSchoolsEuUrlAllowed(FUTURE)).toBe(true);
    expect(isSummerSchoolsEuUrlAllowed(`${FUTURE}&_course_country=georgia`)).toBe(true);
    expect(
      isSummerSchoolsEuUrlAllowed(`${FUTURE}&_course_country=austria%2Cbulgaria%2Ccroatia`),
    ).toBe(true);
    expect(isSummerSchoolsEuUrlAllowed(`${FUTURE}&_course_country=austria,bulgaria`)).toBe(true);
    expect(
      isSummerSchoolsEuUrlAllowed(
        `${FUTURE}&_course_country=italy&_course_city=pisa&_course_starting=07_july&_course_duration=short-0-1-week&_course_discipline=natural-sciences`,
      ),
    ).toBe(true);
  });

  it('rejects the listing without the upcoming filter, paging, other facets and malformed values', () => {
    expect(isSummerSchoolsEuUrlAllowed(`${BASE}/courses/`)).toBe(false);
    expect(isSummerSchoolsEuUrlAllowed(`${BASE}/courses/?_paged=2`)).toBe(false);
    expect(isSummerSchoolsEuUrlAllowed(`${FUTURE}&_paged=2`)).toBe(false);
    expect(isSummerSchoolsEuUrlAllowed(`${BASE}/courses/?_course_status=past`)).toBe(false);
    expect(isSummerSchoolsEuUrlAllowed(`${BASE}/courses/?_course_country=italy`)).toBe(false);
    expect(isSummerSchoolsEuUrlAllowed(`${FUTURE}&_course_type=online`)).toBe(false);
    expect(isSummerSchoolsEuUrlAllowed(`${FUTURE}&_course_search=summer`)).toBe(false);
    expect(
      isSummerSchoolsEuUrlAllowed(`${FUTURE}&_course_country=italy&_course_country=spain`),
    ).toBe(false);
    expect(isSummerSchoolsEuUrlAllowed(`${FUTURE}&_course_country=`)).toBe(false);
    expect(isSummerSchoolsEuUrlAllowed(`${FUTURE}&_course_country=Italy`)).toBe(false);
    expect(isSummerSchoolsEuUrlAllowed(`${FUTURE}&_course_country=italy,,spain`)).toBe(false);
    expect(isSummerSchoolsEuUrlAllowed(`${FUTURE}&_course_country=it aly`)).toBe(false);
    expect(isSummerSchoolsEuUrlAllowed(`${FUTURE}#top`)).toBe(false);
  });

  it('allows a course page only as /course/<slug>/ with no query', () => {
    expect(isSummerSchoolsEuUrlAllowed(`${BASE}/course/mindfulness-and-compassion-2/`)).toBe(true);
    expect(isSummerSchoolsEuUrlAllowed(`${BASE}/course/mindfulness-and-compassion-2`)).toBe(false);
    expect(isSummerSchoolsEuUrlAllowed(`${BASE}/course/mindfulness/?p=1`)).toBe(false);
    expect(isSummerSchoolsEuUrlAllowed(`${BASE}/course/a/b/`)).toBe(false);
    expect(isSummerSchoolsEuUrlAllowed(`${BASE}/course/Upper-Case/`)).toBe(false);
  });

  it('allows the sitemap index and the course sitemaps, no other sitemap', () => {
    expect(isSummerSchoolsEuUrlAllowed(`${BASE}/sitemap_index.xml`)).toBe(true);
    expect(isSummerSchoolsEuUrlAllowed(`${BASE}/course-sitemap.xml`)).toBe(true);
    expect(isSummerSchoolsEuUrlAllowed(`${BASE}/course-sitemap10.xml`)).toBe(true);
    expect(isSummerSchoolsEuUrlAllowed(`${BASE}/post-sitemap.xml`)).toBe(false);
    expect(isSummerSchoolsEuUrlAllowed(`${BASE}/course-sitemap.xml?x=1`)).toBe(false);
  });

  it('rejects the REST API, the admin, login, the apex host, another scheme or port, and garbage', () => {
    expect(isSummerSchoolsEuUrlAllowed(`${BASE}/wp-json/wp/v2/course`)).toBe(false);
    expect(isSummerSchoolsEuUrlAllowed(`${BASE}/wp-admin/`)).toBe(false);
    expect(isSummerSchoolsEuUrlAllowed(`${BASE}/login/`)).toBe(false);
    expect(isSummerSchoolsEuUrlAllowed(`${BASE}/`)).toBe(false);
    expect(isSummerSchoolsEuUrlAllowed('https://summerschoolsineurope.eu/courses/')).toBe(false);
    expect(isSummerSchoolsEuUrlAllowed('http://www.summerschoolsineurope.eu/courses/')).toBe(false);
    expect(isSummerSchoolsEuUrlAllowed('https://www.summerschoolsineurope.eu:8443/courses/')).toBe(
      false,
    );
    expect(isSummerSchoolsEuUrlAllowed('http://')).toBe(false);
  });
});
