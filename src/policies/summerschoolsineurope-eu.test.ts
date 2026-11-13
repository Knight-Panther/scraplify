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
  it('allows the course listing bare and its numbered pages', () => {
    expect(isSummerSchoolsEuUrlAllowed(`${BASE}/courses/`)).toBe(true);
    expect(isSummerSchoolsEuUrlAllowed(`${BASE}/courses/?_paged=2`)).toBe(true);
    expect(isSummerSchoolsEuUrlAllowed(`${BASE}/courses/?_paged=200`)).toBe(true);
  });

  it('rejects page numbers out of shape and any other listing parameter', () => {
    expect(isSummerSchoolsEuUrlAllowed(`${BASE}/courses/?_paged=0`)).toBe(false);
    expect(isSummerSchoolsEuUrlAllowed(`${BASE}/courses/?_paged=201`)).toBe(false);
    expect(isSummerSchoolsEuUrlAllowed(`${BASE}/courses/?_paged=02`)).toBe(false);
    expect(isSummerSchoolsEuUrlAllowed(`${BASE}/courses/?_paged=x`)).toBe(false);
    expect(isSummerSchoolsEuUrlAllowed(`${BASE}/courses/?_paged=2&_paged=3`)).toBe(false);
    expect(isSummerSchoolsEuUrlAllowed(`${BASE}/courses/?s=summer`)).toBe(false);
    expect(isSummerSchoolsEuUrlAllowed(`${BASE}/courses/?_paged=2#top`)).toBe(false);
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
