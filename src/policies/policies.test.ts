import { describe, expect, it } from 'vitest';
import { isPathAllowed } from '../domain/index.js';
import {
  hrGePolicy,
  hrGeSource,
  isHrGeUrlAllowed,
  isJobsGeUrlAllowed,
  jobsGePolicy,
  jobsGeSource,
  sourcePolicies,
} from './index.js';

describe('source policy records', () => {
  it('jobs.ge policy references the jobs.ge source', () => {
    expect(jobsGePolicy.sourceId).toBe(jobsGeSource.id);
  });

  it('hr.ge policy references the hr.ge source', () => {
    expect(hrGePolicy.sourceId).toBe(hrGeSource.id);
  });

  it('sources have distinct IDs', () => {
    expect(jobsGeSource.id).not.toBe(hrGeSource.id);
  });

  it('jobs.ge policy reflects its confirmed crawl-delay and disallowed path', () => {
    expect(jobsGePolicy.rateLimit.crawlDelaySeconds).toBe(5);
    expect(isPathAllowed(jobsGePolicy, '/data/clients/report.csv')).toBe(false);
    expect(isPathAllowed(jobsGePolicy, '/')).toBe(true);
  });

  it("hr.ge's acquisition-decision spike (2026-09-05) confirmed 'api' should not be adopted", () => {
    // The endpoint exists but was rejected on its merits (RECON_NOTES.md):
    // POST-only, undocumented, CORS-locked to hr.ge's own frontend, and its
    // data is already embedded verbatim in the public HTML. This is a
    // settled decision now, not a placeholder pending investigation.
    expect(hrGePolicy.allowedAcquisitionModes).not.toContain('api');
  });

  it('hr.ge policy authorizes both hosts the adapter needs: the site and the sitemap', () => {
    expect(hrGePolicy.allowedHosts).toEqual(['www.hr.ge', 'api.p.hr.ge']);
  });

  it('hr.ge policy records the measured 3-second rate limit (Ratelimit-Policy: 20;w=60)', () => {
    expect(hrGePolicy.rateLimit.crawlDelaySeconds).toBe(3);
  });

  it('both policies default to not republishing full source content while terms are unreviewed', () => {
    expect(jobsGePolicy.termsUrl).toBeNull();
    expect(jobsGePolicy.display.mayRepublishFullContent).toBe(false);
    expect(hrGePolicy.termsUrl).toBeNull();
    expect(hrGePolicy.display.mayRepublishFullContent).toBe(false);
  });

  it('both policies enumerate at least one allowed path — never allow-all-by-default', () => {
    expect(jobsGePolicy.allowedPathPatterns.length).toBeGreaterThan(0);
    expect(hrGePolicy.allowedPathPatterns.length).toBeGreaterThan(0);
  });

  it("hr.ge's allow-list covers detail/search/employer pages but excludes auth/account paths", () => {
    expect(
      isPathAllowed(hrGePolicy, '/announcement/491744/inglisurenovani-gayidvebis-agenti'),
    ).toBe(true);
    expect(isPathAllowed(hrGePolicy, '/customer/59550/avto-reg')).toBe(true);
    expect(isPathAllowed(hrGePolicy, '/search-posting')).toBe(true);
    expect(isPathAllowed(hrGePolicy, '/jobseeker/sign-in')).toBe(false);
    expect(isPathAllowed(hrGePolicy, '/subscriber/subscription')).toBe(false);
    expect(isPathAllowed(hrGePolicy, '/announcement/favorites')).toBe(false);
    // Descendants of the favorites route must be blocked too, not just the
    // exact path — a prior fix used an exact-match disallow that left
    // these still authorized by the '/announcement/' allow prefix.
    expect(isPathAllowed(hrGePolicy, '/announcement/favorites/491744')).toBe(false);
  });

  it('both policies default linked-resource fetching to fully disabled (§16)', () => {
    for (const policy of [jobsGePolicy, hrGePolicy]) {
      expect(policy.linkedResources.allowedDestinationHosts).toEqual([]);
      expect(policy.linkedResources.allowedRelationshipTypes).toEqual([]);
      expect(policy.linkedResources.maxTraversalDepth).toBe(0);
      expect(policy.linkedResources.maxResourcesPerOpportunity).toBe(0);
      expect(policy.linkedResources.mayFetchExternalApplicationPages).toBe(false);
      expect(policy.linkedResources.retention).toBe('none');
    }
  });

  it('isJobsGeUrlAllowed authorizes the homepage and the confirmed listing shape', () => {
    expect(isJobsGeUrlAllowed('https://www.jobs.ge/')).toBe(true);
    expect(isJobsGeUrlAllowed('https://www.jobs.ge/?view=jobs&id=491744')).toBe(true);
    // Relative form, resolved against the source's own baseUrl.
    expect(isJobsGeUrlAllowed('/?view=jobs&id=491744')).toBe(true);
  });

  it("isJobsGeUrlAllowed authorizes '/ge/' identically to bare '/' (confirmed 2026-09-03: same content, explicit locale)", () => {
    expect(isJobsGeUrlAllowed('https://www.jobs.ge/ge/')).toBe(true);
    expect(isJobsGeUrlAllowed('https://www.jobs.ge/ge/?view=jobs&id=491744')).toBe(true);
    expect(isJobsGeUrlAllowed('https://www.jobs.ge/ge/?view=admin')).toBe(false);
    expect(isJobsGeUrlAllowed('https://www.jobs.ge/ge/?view=jobs&id=abc')).toBe(false);
  });

  it("isJobsGeUrlAllowed authorizes '/ge/ads/' (the real discovery/browse page) and its pagination", () => {
    expect(isJobsGeUrlAllowed('https://www.jobs.ge/ge/ads/')).toBe(true);
    expect(isJobsGeUrlAllowed('https://www.jobs.ge/ge/ads/?page=2')).toBe(true);
    expect(isJobsGeUrlAllowed('https://www.jobs.ge/ge/ads/?page=19')).toBe(true);
    // Not the listing-identity shape — '/ge/ads/' only ever takes 'page'.
    expect(isJobsGeUrlAllowed('https://www.jobs.ge/ge/ads/?view=jobs&id=491744')).toBe(false);
    // Rejects the discovery-scope-expansion params found during recon but
    // deliberately not authorized: category/location filters are redundant
    // (the unfiltered walk already covers everything), and the
    // announcement-type filter is unused since all types are aggregated.
    expect(isJobsGeUrlAllowed('https://www.jobs.ge/ge/ads/?cid=6')).toBe(false);
    expect(isJobsGeUrlAllowed('https://www.jobs.ge/ge/ads/?jid=1')).toBe(false);
    expect(isJobsGeUrlAllowed('https://www.jobs.ge/ge/ads/?page=2&extra=1')).toBe(false);
    expect(isJobsGeUrlAllowed('https://www.jobs.ge/ge/ads/?page=0')).toBe(false); // not positive
    expect(isJobsGeUrlAllowed('https://www.jobs.ge/ge/ads/?page=01')).toBe(false); // leading zero
    expect(isJobsGeUrlAllowed('https://www.jobs.ge/ge/ads/?page=-1')).toBe(false);
    expect(isJobsGeUrlAllowed('https://www.jobs.ge/ge/ads/?page=1&page=1')).toBe(false); // duplicate
  });

  it("isJobsGeUrlAllowed does not authorize '/en/' — nothing in this codebase requests it", () => {
    expect(isJobsGeUrlAllowed('https://www.jobs.ge/en/')).toBe(false);
    expect(isJobsGeUrlAllowed('https://www.jobs.ge/en/?view=jobs&id=491744')).toBe(false);
  });

  it('isJobsGeUrlAllowed rejects what isPathAllowed alone cannot: query-based scope expansion', () => {
    // The exact gap the adversarial review found: isPathAllowed('/')
    // authorizes any query on root, since it never looks at the query
    // string at all.
    expect(isPathAllowed(jobsGePolicy, '/')).toBe(true);
    expect(isJobsGeUrlAllowed('https://www.jobs.ge/?view=admin')).toBe(false);
    expect(isJobsGeUrlAllowed('https://www.jobs.ge/?view=jobs&id=491744&extra=1')).toBe(false);
    expect(isJobsGeUrlAllowed('https://www.jobs.ge/?view=jobs')).toBe(false); // missing id
    expect(isJobsGeUrlAllowed('https://www.jobs.ge/?id=491744')).toBe(false); // missing view
    expect(isJobsGeUrlAllowed('https://www.jobs.ge/?view=jobs&id=abc')).toBe(false); // non-numeric id
    expect(isJobsGeUrlAllowed('https://www.jobs.ge/?view=jobs&view=jobs&id=1')).toBe(false); // duplicate param
  });

  it('isJobsGeUrlAllowed rejects a same-path URL on a different origin: host, scheme, or port', () => {
    // isPathAllowed never looks at the origin at all — an absolute URL to a
    // different origin would sail through it unchecked if this were the
    // only gate.
    expect(isJobsGeUrlAllowed('https://evil.example/?view=jobs&id=1')).toBe(false);
    // Same hostname, different scheme/port — a .hostname-only check (an
    // earlier version of this function) would have missed both of these.
    expect(isJobsGeUrlAllowed('file://www.jobs.ge/?view=jobs&id=1')).toBe(false);
    expect(isJobsGeUrlAllowed('https://www.jobs.ge:4444/?view=jobs&id=1')).toBe(false);
    expect(isJobsGeUrlAllowed('http://www.jobs.ge/?view=jobs&id=1')).toBe(false);
  });

  it('isJobsGeUrlAllowed fails closed on an unparseable URL', () => {
    // A relative-looking garbage string doesn't actually throw — new URL()
    // resolves it against baseUrl as a path, which correctly fails the
    // isPathAllowed check instead (covered by the previous test). This one
    // targets a string that genuinely throws: an explicit scheme with an
    // empty authority, confirmed empirically before writing the assertion.
    expect(() => isJobsGeUrlAllowed('http://')).not.toThrow();
    expect(isJobsGeUrlAllowed('http://')).toBe(false);
  });

  it('isHrGeUrlAllowed authorizes the discovery view and its ?pg= pagination', () => {
    expect(isHrGeUrlAllowed('https://www.hr.ge/search-posting')).toBe(true);
    expect(isHrGeUrlAllowed('https://www.hr.ge/search-posting?pg=2')).toBe(true);
    expect(isHrGeUrlAllowed('https://www.hr.ge/search-posting?pg=33')).toBe(true);
    // Relative form, resolved against the source's own baseUrl.
    expect(isHrGeUrlAllowed('/search-posting?pg=2')).toBe(true);
    expect(isHrGeUrlAllowed('https://www.hr.ge/search-posting?pg=0')).toBe(false); // not positive
    expect(isHrGeUrlAllowed('https://www.hr.ge/search-posting?pg=02')).toBe(false); // leading zero
    expect(isHrGeUrlAllowed('https://www.hr.ge/search-posting?pg=-1')).toBe(false);
    expect(isHrGeUrlAllowed('https://www.hr.ge/search-posting?pg=1&pg=1')).toBe(false); // duplicate
    expect(isHrGeUrlAllowed('https://www.hr.ge/search-posting?pg=2&extra=1')).toBe(false);
    // The filter-form defaults seen during recon are deliberately not
    // authorized — bare ?pg=N is sufficient (RECON_NOTES.md).
    expect(isHrGeUrlAllowed('https://www.hr.ge/search-posting?os=false&pg=2')).toBe(false);
  });

  it('isHrGeUrlAllowed authorizes detail pages by the confirmed /announcement/<id>/<slug> shape', () => {
    expect(
      isHrGeUrlAllowed('https://www.hr.ge/announcement/491744/inglisurenovani-gayidvebis-agenti'),
    ).toBe(true);
    // The slug is decorative (RECON_NOTES.md) but the shape is still
    // checked as a structural assertion, not left to isPathAllowed alone.
    expect(isHrGeUrlAllowed('https://www.hr.ge/announcement/491744')).toBe(false); // no slug
    expect(isHrGeUrlAllowed('https://www.hr.ge/announcement/abc/slug')).toBe(false); // non-numeric id
    expect(isHrGeUrlAllowed('https://www.hr.ge/announcement/491744/slug?x=1')).toBe(false); // no query
    // The favorites carve-out (disallowedPathPatterns) still applies.
    expect(isHrGeUrlAllowed('https://www.hr.ge/announcement/favorites')).toBe(false);
  });

  it('isHrGeUrlAllowed authorizes the sitemap on its own host, and nowhere else', () => {
    expect(
      isHrGeUrlAllowed('https://api.p.hr.ge/public-portal/tenant/1/api/v3/seo/sitemap'),
    ).toBe(true);
    expect(
      isHrGeUrlAllowed('https://api.p.hr.ge/public-portal/tenant/1/api/v3/seo/sitemap?x=1'),
    ).toBe(false);
    // The path-level rule is shared across hosts, but api.p.hr.ge must not
    // inherit www.hr.ge's other authorized paths — the exact gap a naive
    // "host allowed AND path allowed" check (evaluated independently)
    // would miss, since isPathAllowed never looks at which host matched.
    expect(isHrGeUrlAllowed('https://api.p.hr.ge/search-posting')).toBe(false);
    expect(
      isHrGeUrlAllowed('https://api.p.hr.ge/announcement/491744/slug'),
    ).toBe(false);
    // Nor may the sitemap path be fetched from the wrong host.
    expect(
      isHrGeUrlAllowed('https://www.hr.ge/public-portal/tenant/1/api/v3/seo/sitemap'),
    ).toBe(false);
  });

  it('isHrGeUrlAllowed rejects a same-path URL on a different origin: host, scheme, or port', () => {
    expect(isHrGeUrlAllowed('https://evil.example/search-posting')).toBe(false);
    expect(isHrGeUrlAllowed('file://www.hr.ge/search-posting')).toBe(false);
    expect(isHrGeUrlAllowed('https://www.hr.ge:4444/search-posting')).toBe(false);
    expect(isHrGeUrlAllowed('http://www.hr.ge/search-posting')).toBe(false);
  });

  it('isHrGeUrlAllowed authorizes the homepage and employer pages bare, not with a query', () => {
    expect(isHrGeUrlAllowed('https://www.hr.ge/')).toBe(true);
    expect(isHrGeUrlAllowed('https://www.hr.ge/?x=1')).toBe(false);
    expect(isHrGeUrlAllowed('https://www.hr.ge/customer/59550/avto-reg')).toBe(true);
    expect(isHrGeUrlAllowed('https://www.hr.ge/jobseeker/sign-in')).toBe(false);
  });

  it('isHrGeUrlAllowed fails closed on an unparseable URL', () => {
    expect(() => isHrGeUrlAllowed('http://')).not.toThrow();
    expect(isHrGeUrlAllowed('http://')).toBe(false);
  });

  it('exposes both records by slug, matching each source’s own slug field', () => {
    expect(Object.keys(sourcePolicies).sort()).toEqual(['hr-ge', 'jobs-ge']);
    expect(sourcePolicies['jobs-ge'].source.id).toBe(jobsGeSource.id);
    expect(sourcePolicies['jobs-ge'].source.slug).toBe('jobs-ge');
    expect(sourcePolicies['hr-ge'].source.id).toBe(hrGeSource.id);
    expect(sourcePolicies['hr-ge'].source.slug).toBe('hr-ge');
  });
});
