import { describe, expect, it } from 'vitest';
import { isPathAllowed } from '../domain/index.js';
import { hrGePolicy, hrGeSource, jobsGePolicy, jobsGeSource, sourcePolicies } from './index.js';

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

  it('exposes both records by slug, matching each source’s own slug field', () => {
    expect(Object.keys(sourcePolicies).sort()).toEqual(['hr-ge', 'jobs-ge']);
    expect(sourcePolicies['jobs-ge'].source.id).toBe(jobsGeSource.id);
    expect(sourcePolicies['jobs-ge'].source.slug).toBe('jobs-ge');
    expect(sourcePolicies['hr-ge'].source.id).toBe(hrGeSource.id);
    expect(sourcePolicies['hr-ge'].source.slug).toBe('hr-ge');
  });
});
