import { describe, expect, it } from 'vitest';
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
    expect(jobsGePolicy.disallowedPathPatterns).toContain('/data/clients/');
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
    expect(hrGePolicy.allowedPathPatterns).toEqual(
      expect.arrayContaining(['/search-posting', '/announcement/', '/customer/']),
    );
    expect(hrGePolicy.allowedPathPatterns).not.toContain('/jobseeker/sign-in');
    expect(hrGePolicy.allowedPathPatterns).not.toContain('/subscriber/subscription');
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
