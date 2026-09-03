import { describe, expect, it } from 'vitest';
import { isPathAllowed } from '../domain/index.js';
import {
  hrGePolicy,
  hrGeSource,
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

  it("hr.ge policy does not yet allow 'api' pending the acquisition-decision spike", () => {
    expect(hrGePolicy.allowedAcquisitionModes).not.toContain('api');
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

  it('exposes both records by slug, matching each source’s own slug field', () => {
    expect(Object.keys(sourcePolicies).sort()).toEqual(['hr-ge', 'jobs-ge']);
    expect(sourcePolicies['jobs-ge'].source.id).toBe(jobsGeSource.id);
    expect(sourcePolicies['jobs-ge'].source.slug).toBe('jobs-ge');
    expect(sourcePolicies['hr-ge'].source.id).toBe(hrGeSource.id);
    expect(sourcePolicies['hr-ge'].source.slug).toBe('hr-ge');
  });
});
