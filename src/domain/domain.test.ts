import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CrawlRunSchema,
  DuplicateCandidateSchema,
  isHostAllowed,
  isPathAllowed,
  matchesPathRule,
  OpportunityRevisionSchema,
  OpportunitySchema,
  OpportunitySourceMembershipSchema,
  OrganizationSchema,
  ParserIncidentSchema,
  ResourceSchema,
  SourceListingRevisionSchema,
  SourceListingSchema,
  SourcePolicySchema,
  TaxonomyTermSchema,
} from './index.js';

const now = new Date().toISOString();
const uuid = () => randomUUID();
const sha256 = 'a'.repeat(64);

describe('SourceListingSchema', () => {
  it('accepts a valid discovered listing with no revision yet', () => {
    const result = SourceListingSchema.safeParse({
      id: uuid(),
      sourceId: uuid(),
      sourceRecordId: '491744',
      canonicalSourceUrl: 'https://www.hr.ge/announcement/491744/inglisurenovani-gayidvebis-agenti',
      currentRevisionId: null,
      firstSeenAt: now,
      lastSeenAt: now,
      status: 'discovered',
      missingStreak: 0,
      sourcePublishedAt: null,
      sourceDeadlineAt: null,
      lastReconciledAt: null,
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown status value', () => {
    const result = SourceListingSchema.safeParse({
      id: uuid(),
      sourceId: uuid(),
      sourceRecordId: '491744',
      canonicalSourceUrl: 'https://www.hr.ge/announcement/491744/x',
      currentRevisionId: null,
      firstSeenAt: now,
      lastSeenAt: now,
      status: 'archived', // not a real lifecycle state (§13)
      missingStreak: 0,
      sourcePublishedAt: null,
      sourceDeadlineAt: null,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a negative missingStreak', () => {
    const result = SourceListingSchema.safeParse({
      id: uuid(),
      sourceId: uuid(),
      sourceRecordId: '491744',
      canonicalSourceUrl: 'https://www.hr.ge/announcement/491744/x',
      currentRevisionId: null,
      firstSeenAt: now,
      lastSeenAt: now,
      status: 'active',
      missingStreak: -1,
      sourcePublishedAt: null,
      sourceDeadlineAt: null,
    });
    expect(result.success).toBe(false);
  });
});

describe('SourceListingRevisionSchema', () => {
  it('accepts a valid revision with structured attributes', () => {
    const result = SourceListingRevisionSchema.safeParse({
      id: uuid(),
      sourceListingId: uuid(),
      parserVersion: 'jobs-ge@1',
      extractionMethod: 'http',
      rawResourceHash: sha256,
      meaningfulContentHash: sha256,
      titleRaw: 'გაყიდვების მენეჯერი',
      titleNormalized: 'gayidvebis menejeri',
      organizationRaw: 'ქარმოლი',
      description: 'Full job description text.',
      locations: ['Tbilisi'],
      salaryRaw: null,
      publishedDate: { raw: '27 აგვისტო', parsed: now },
      deadlineDate: { raw: '27 სექტემბერი', parsed: null },
      applicationMethod: { type: 'email', value: 'jobs@example.ge' },
      sourceCategories: ['Sales'],
      structuredAttributes: { workMode: 'on-site' },
      createdAt: now,
      provenance: { fetchedAt: now, resourceId: uuid(), notes: null },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a hash that is not 64 lowercase hex characters', () => {
    const result = SourceListingRevisionSchema.safeParse({
      id: uuid(),
      sourceListingId: uuid(),
      parserVersion: 'jobs-ge@1',
      extractionMethod: 'http',
      rawResourceHash: 'not-a-hash',
      meaningfulContentHash: sha256,
      titleRaw: 'x',
      titleNormalized: 'x',
      organizationRaw: null,
      description: '',
      locations: [],
      salaryRaw: null,
      publishedDate: { raw: null, parsed: null },
      deadlineDate: { raw: null, parsed: null },
      applicationMethod: null,
      sourceCategories: [],
      structuredAttributes: {},
      createdAt: now,
      provenance: { fetchedAt: now, resourceId: uuid(), notes: null },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a null provenance.resourceId (§6.2: every revision must be traceable)', () => {
    const result = SourceListingRevisionSchema.safeParse({
      id: uuid(),
      sourceListingId: uuid(),
      parserVersion: 'jobs-ge@1',
      extractionMethod: 'http',
      rawResourceHash: sha256,
      meaningfulContentHash: sha256,
      titleRaw: 'x',
      titleNormalized: 'x',
      organizationRaw: null,
      description: '',
      locations: [],
      salaryRaw: null,
      publishedDate: { raw: null, parsed: null },
      deadlineDate: { raw: null, parsed: null },
      applicationMethod: null,
      sourceCategories: [],
      structuredAttributes: {},
      createdAt: now,
      provenance: { fetchedAt: now, resourceId: null, notes: null },
    });
    expect(result.success).toBe(false);
  });
});

describe('OpportunitySchema and OpportunitySourceMembershipSchema', () => {
  it('accepts a valid opportunity and a confirmed membership', () => {
    const opportunity = OpportunitySchema.safeParse({
      id: uuid(),
      type: 'job',
      canonicalTitle: 'Sales Manager',
      organizationId: uuid(),
      canonicalStatus: 'active',
      currentCanonicalRevisionId: uuid(),
      createdAt: now,
      updatedAt: now,
    });
    expect(opportunity.success).toBe(true);

    const membership = OpportunitySourceMembershipSchema.safeParse({
      id: uuid(),
      opportunityId: uuid(),
      sourceListingId: uuid(),
      decision: 'confirmed_same',
      confidence: 0.97,
      evidence: { titleSimilarity: 0.95, sameEmployerDomain: true },
      decidedBy: 'ruleset',
      decidedAt: now,
      dedupeModelOrRulesetVersion: 'ruleset@1',
    });
    expect(membership.success).toBe(true);
  });

  it('rejects a confidence outside 0–1', () => {
    const result = OpportunitySourceMembershipSchema.safeParse({
      id: uuid(),
      opportunityId: uuid(),
      sourceListingId: uuid(),
      decision: 'confirmed_same',
      confidence: 1.5,
      evidence: {},
      decidedBy: 'ruleset',
      decidedAt: now,
      dedupeModelOrRulesetVersion: 'ruleset@1',
    });
    expect(result.success).toBe(false);
  });
});

describe('OpportunityRevisionSchema', () => {
  it('accepts valid membership-version references and a real SHA-256 hash', () => {
    const listingId = uuid();
    const revisionId = uuid();
    const result = OpportunityRevisionSchema.safeParse({
      id: uuid(),
      opportunityId: uuid(),
      canonicalTitle: 'Sales Manager',
      canonicalStatus: 'active',
      organizationId: uuid(),
      resolvedFields: { title: 'Sales Manager' },
      sourceMembershipVersions: { [listingId]: revisionId },
      resolutionRulesetVersion: 'ruleset@1',
      meaningfulContentHash: sha256,
      createdAt: now,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a non-UUID key/value in sourceMembershipVersions', () => {
    const result = OpportunityRevisionSchema.safeParse({
      id: uuid(),
      opportunityId: uuid(),
      canonicalTitle: 'Sales Manager',
      canonicalStatus: 'active',
      organizationId: uuid(),
      resolvedFields: {},
      sourceMembershipVersions: { 'not-a-uuid': uuid() },
      resolutionRulesetVersion: 'ruleset@1',
      meaningfulContentHash: sha256,
      createdAt: now,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a truncated meaningfulContentHash', () => {
    const result = OpportunityRevisionSchema.safeParse({
      id: uuid(),
      opportunityId: uuid(),
      canonicalTitle: 'Sales Manager',
      canonicalStatus: 'active',
      organizationId: uuid(),
      resolvedFields: {},
      sourceMembershipVersions: {},
      resolutionRulesetVersion: 'ruleset@1',
      meaningfulContentHash: 'deadbeef',
      createdAt: now,
    });
    expect(result.success).toBe(false);
  });
});

describe('DuplicateCandidateSchema status/resultingDecision invariant', () => {
  const base = {
    id: uuid(),
    sourceListingIdA: uuid(),
    sourceListingIdB: uuid(),
    generatedAt: now,
    generationMethod: 'pg_trgm' as const,
    similarityScore: 0.62,
  };

  it('accepts pending with no decision', () => {
    expect(
      DuplicateCandidateSchema.safeParse({ ...base, status: 'pending', resultingDecision: null })
        .success,
    ).toBe(true);
  });

  it('accepts evaluated with a decision', () => {
    expect(
      DuplicateCandidateSchema.safeParse({
        ...base,
        status: 'evaluated',
        resultingDecision: 'confirmed_same',
      }).success,
    ).toBe(true);
  });

  it('rejects pending with a decision already set', () => {
    expect(
      DuplicateCandidateSchema.safeParse({
        ...base,
        status: 'pending',
        resultingDecision: 'confirmed_same',
      }).success,
    ).toBe(false);
  });

  it('rejects evaluated with no decision', () => {
    expect(
      DuplicateCandidateSchema.safeParse({ ...base, status: 'evaluated', resultingDecision: null })
        .success,
    ).toBe(false);
  });
});

describe('remaining domain schemas accept a minimal valid example', () => {
  it('OrganizationSchema', () => {
    expect(
      OrganizationSchema.safeParse({
        id: uuid(),
        canonicalName: 'ჯი თი გრუპი',
        kind: 'employer',
        domain: null,
        createdAt: now,
        updatedAt: now,
      }).success,
    ).toBe(true);
  });

  it('ResourceSchema accepts an absolute originalUrl', () => {
    expect(
      ResourceSchema.safeParse({
        id: uuid(),
        sourceId: uuid(),
        role: 'OPPORTUNITY',
        originalUrl: 'https://www.jobs.ge/?view=jobs&id=123',
        canonicalUrl: 'https://www.jobs.ge/?view=jobs&id=123',
        finalUrl: null,
        status: 'pending',
        fetchedAt: null,
        contentHash: null,
        byteSize: null,
        mimeType: null,
      }).success,
    ).toBe(true);
  });

  it('ResourceSchema accepts a relative originalUrl but requires absolute canonicalUrl', () => {
    // jobs.ge/hr.ge listing links are relative as found on the page (§11) —
    // originalUrl must preserve that exactly, unlike canonicalUrl/finalUrl.
    const relative = ResourceSchema.safeParse({
      id: uuid(),
      sourceId: uuid(),
      role: 'OPPORTUNITY',
      originalUrl: '?view=jobs&id=123',
      canonicalUrl: 'https://www.jobs.ge/?view=jobs&id=123',
      finalUrl: null,
      status: 'pending',
      fetchedAt: null,
      contentHash: null,
      byteSize: null,
      mimeType: null,
    });
    expect(relative.success).toBe(true);

    const relativeCanonical = ResourceSchema.safeParse({
      id: uuid(),
      sourceId: uuid(),
      role: 'OPPORTUNITY',
      originalUrl: '?view=jobs&id=123',
      canonicalUrl: '?view=jobs&id=123',
      finalUrl: null,
      status: 'pending',
      fetchedAt: null,
      contentHash: null,
      byteSize: null,
      mimeType: null,
    });
    expect(relativeCanonical.success).toBe(false);
  });

  it('ResourceSchema accepts localhost/IP canonicalUrl but rejects non-http(s) schemes', () => {
    const withLocalhost = ResourceSchema.safeParse({
      id: uuid(),
      sourceId: uuid(),
      role: 'INDEX',
      originalUrl: 'http://localhost:8080/announcements',
      canonicalUrl: 'http://localhost:8080/announcements',
      finalUrl: 'http://127.0.0.1:8080/announcements',
      status: 'pending',
      fetchedAt: null,
      contentHash: null,
      byteSize: null,
      mimeType: null,
    });
    expect(withLocalhost.success).toBe(true);

    const withFileScheme = ResourceSchema.safeParse({
      id: uuid(),
      sourceId: uuid(),
      role: 'ATTACHMENT',
      originalUrl: 'file:///etc/passwd',
      canonicalUrl: 'file:///etc/passwd',
      finalUrl: null,
      status: 'pending',
      fetchedAt: null,
      contentHash: null,
      byteSize: null,
      mimeType: null,
    });
    expect(withFileScheme.success).toBe(false);
  });

  it('TaxonomyTermSchema', () => {
    expect(
      TaxonomyTermSchema.safeParse({
        id: uuid(),
        axis: 'profession',
        code: 'sales-manager',
        label: 'Sales Manager',
        taxonomyVersion: 'v1',
        parentId: null,
      }).success,
    ).toBe(true);
  });

  it('CrawlRunSchema accepts a completed run', () => {
    expect(
      CrawlRunSchema.safeParse({
        id: uuid(),
        sourceId: uuid(),
        startedAt: now,
        finishedAt: now,
        reconciledAt: now,
        status: 'completed',
        fullCoverage: true,
        discoveredCount: 120,
        vipCount: 10,
        standardCount: 110,
        newCount: 5,
        changedCount: 2,
        unchangedCount: 110,
        missingCount: 3,
        expiredCount: 1,
        reopenedCount: 0,
        quarantinedCount: 0,
        failedCount: 0,
      }).success,
    ).toBe(true);
  });

  it('CrawlRunSchema accepts the run itself being quarantined (§21.3)', () => {
    // A count-collapse or similar anomaly quarantines the whole run, not
    // just individual listings — must not advance closure state.
    expect(
      CrawlRunSchema.safeParse({
        id: uuid(),
        sourceId: uuid(),
        startedAt: now,
        finishedAt: now,
        reconciledAt: null,
        status: 'quarantined',
        fullCoverage: true,
        discoveredCount: 4,
        vipCount: 0,
        standardCount: 4,
        newCount: 0,
        changedCount: 0,
        unchangedCount: 0,
        missingCount: 0,
        expiredCount: 0,
        reopenedCount: 0,
        quarantinedCount: 0,
        failedCount: 0,
      }).success,
    ).toBe(true);
  });

  it('ParserIncidentSchema', () => {
    expect(
      ParserIncidentSchema.safeParse({
        id: uuid(),
        sourceId: uuid(),
        crawlRunId: uuid(),
        detectedAt: now,
        kind: 'count_collapse',
        severity: 'critical',
        evidence: { previousCount: 300, currentCount: 4 },
        resolved: false,
        resolvedAt: null,
      }).success,
    ).toBe(true);
  });
});

describe('SourcePolicySchema', () => {
  const validPolicy = {
    id: uuid(),
    sourceId: uuid(),
    policyVersion: 'v1',
    allowedAcquisitionModes: ['http'] as const,
    allowedPathPatterns: [{ pattern: '/announcement/', match: 'prefix' as const }],
    disallowedPathPatterns: [],
    allowedHosts: ['example.ge'],
    disallowedHosts: [],
    authenticationScope: 'none' as const,
    rateLimit: { crawlDelaySeconds: 5, maxConcurrency: 1, notes: null },
    termsUrl: null,
    robotsUrl: 'https://example.ge/robots.txt',
    retention: { rawHtmlRetentionDays: null, notes: 'not yet set' },
    display: { mayRepublishFullContent: false, notes: 'not yet reviewed' },
    linkedResources: {
      allowedDestinationHosts: [],
      allowedRelationshipTypes: [],
      maxTraversalDepth: 0,
      maxResourcesPerOpportunity: 0,
      mayFetchExternalApplicationPages: false,
      retention: 'none' as const,
      notes: 'disabled',
    },
    reviewDate: now,
    evidence: ['robots.txt fetched'],
    notes: '',
    decisionOwner: 'project owner',
  };

  it('accepts a policy with at least one allowed path pattern', () => {
    expect(SourcePolicySchema.safeParse(validPolicy).success).toBe(true);
  });

  it('rejects an empty allowedPathPatterns — default-deny, not default-allow (§5.3)', () => {
    const result = SourcePolicySchema.safeParse({ ...validPolicy, allowedPathPatterns: [] });
    expect(result.success).toBe(false);
  });

  it('rejects an empty allowedHosts — default-deny, matching allowedPathPatterns', () => {
    const result = SourcePolicySchema.safeParse({ ...validPolicy, allowedHosts: [] });
    expect(result.success).toBe(false);
  });
});

describe('isHostAllowed', () => {
  const policy = { allowedHosts: ['www.hr.ge', 'api.p.hr.ge'], disallowedHosts: [] };

  it('allows a listed host on plain https at the default port', () => {
    expect(isHostAllowed(policy, new URL('https://www.hr.ge/search-posting'))).toBe(true);
    expect(isHostAllowed(policy, new URL('https://api.p.hr.ge/seo/sitemap'))).toBe(true);
  });

  it('rejects a host not in allowedHosts', () => {
    expect(isHostAllowed(policy, new URL('https://evil.example/'))).toBe(false);
  });

  it('disallow always wins, even over an allowed host', () => {
    const overlapping = { allowedHosts: ['www.hr.ge'], disallowedHosts: ['www.hr.ge'] };
    expect(isHostAllowed(overlapping, new URL('https://www.hr.ge/'))).toBe(false);
  });

  it('rejects a scheme bypass on an otherwise-allowed hostname', () => {
    // .hostname alone would not catch this — confirmed empirically the
    // same way isJobsGeUrlAllowed's original origin check was.
    expect(isHostAllowed(policy, new URL('file://www.hr.ge/etc/passwd'))).toBe(false);
    expect(isHostAllowed(policy, new URL('http://www.hr.ge/'))).toBe(false);
  });

  it('rejects a port bypass on an otherwise-allowed hostname', () => {
    expect(isHostAllowed(policy, new URL('https://www.hr.ge:4444/'))).toBe(false);
  });
});

describe('matchesPathRule / isPathAllowed', () => {
  it('exact match only matches the literal path, not descendants', () => {
    const rule = { pattern: '/', match: 'exact' as const };
    expect(matchesPathRule('/', rule)).toBe(true);
    expect(matchesPathRule('/jobseeker/sign-in', rule)).toBe(false);
  });

  it('prefix match covers the pattern and everything beneath it', () => {
    const rule = { pattern: '/announcement/', match: 'prefix' as const };
    expect(matchesPathRule('/announcement/491744/slug', rule)).toBe(true);
    expect(matchesPathRule('/announcement/favorites', rule)).toBe(true);
    expect(matchesPathRule('/customer/59550/avto-reg', rule)).toBe(false);
  });

  it('decodes percent-encoding before matching, including double-encoding', () => {
    const rule = { pattern: '/announcement/favorites', match: 'prefix' as const };
    // %66 -> 'f'; WHATWG URL.pathname preserves this encoding rather than
    // decoding it, so a naive string comparison would miss it (verified
    // empirically against Node's URL implementation before this fix).
    expect(matchesPathRule('/announcement/%66avorites', rule)).toBe(true);
    // %2F -> '/': a differently-shaped encoding of the same real path.
    expect(matchesPathRule('/announcement%2Ffavorites', rule)).toBe(true);
    // %2566 -> %66 -> 'f': double-encoded, one layer deeper than reported.
    expect(matchesPathRule('/announcement/%2566avorites', rule)).toBe(true);
  });

  it('fails closed (does not match, does not throw) on undecodable input', () => {
    const rule = { pattern: '/announcement/favorites', match: 'prefix' as const };
    // A lone '%' is not a valid percent-encoding and makes
    // decodeURIComponent throw; matchesPathRule must swallow that and
    // report no match, not propagate the exception or default to allow.
    expect(() => matchesPathRule('/announcement/%zzfavorites', rule)).not.toThrow();
    expect(matchesPathRule('/announcement/%zzfavorites', rule)).toBe(false);
  });

  it('fails closed on a dot-segment that only appears after decoding', () => {
    // %252e%252e decodes in two rounds to '..' — it never looks like a
    // dot-segment to WHATWG URL parsing (which only normalizes at most one
    // decode layer), so this must be checked after this module's own
    // repeated decoding, not assumed already handled upstream.
    const rule = { pattern: '/announcement/', match: 'prefix' as const };
    expect(matchesPathRule('/announcement/%252e%252e/jobseeker/sign-in', rule)).toBe(false);
    // A literal, single-encoded '..' must also be rejected, not just the
    // double-encoded form the review specifically reported.
    expect(matchesPathRule('/announcement/../jobseeker/sign-in', rule)).toBe(false);
  });

  it('does not false-positive on a legitimate segment that merely contains a dot', () => {
    // '..' as a whole segment is a traversal marker; 'file.pdf' is not —
    // containsDotSegment must distinguish "is exactly . or .." from
    // "contains a . character somewhere".
    const rule = { pattern: '/announcement/', match: 'prefix' as const };
    expect(matchesPathRule('/announcement/attachment/file.pdf', rule)).toBe(true);
  });

  it('isPathAllowed: disallow always wins over allow', () => {
    const policy = {
      allowedPathPatterns: [{ pattern: '/', match: 'exact' as const }],
      disallowedPathPatterns: [{ pattern: '/data/clients/', match: 'prefix' as const }],
    };
    // '/' itself matches the exact allow rule and no disallow rule.
    expect(isPathAllowed(policy, '/')).toBe(true);
    // A path could only reach the disallow branch if it also matched an
    // allow rule elsewhere; this confirms disallow still wins when it does.
    const overlapping = {
      allowedPathPatterns: [{ pattern: '/data/clients/', match: 'prefix' as const }],
      disallowedPathPatterns: [{ pattern: '/data/clients/', match: 'prefix' as const }],
    };
    expect(isPathAllowed(overlapping, '/data/clients/report.csv')).toBe(false);
  });

  it("isPathAllowed reflects hr.ge's real policy: detail pages allowed, auth pages not", () => {
    const policy = {
      allowedPathPatterns: [
        { pattern: '/', match: 'exact' as const },
        { pattern: '/search-posting', match: 'exact' as const },
        { pattern: '/announcement/', match: 'prefix' as const },
        { pattern: '/customer/', match: 'prefix' as const },
      ],
      disallowedPathPatterns: [],
    };
    expect(isPathAllowed(policy, '/announcement/491744/slug')).toBe(true);
    expect(isPathAllowed(policy, '/customer/59550/avto-reg')).toBe(true);
    expect(isPathAllowed(policy, '/search-posting')).toBe(true);
    expect(isPathAllowed(policy, '/jobseeker/sign-in')).toBe(false);
    expect(isPathAllowed(policy, '/subscriber/subscription')).toBe(false);
  });

  it("isPathAllowed reflects jobs.ge's real policy: root allowed, data/clients disallowed", () => {
    const policy = {
      allowedPathPatterns: [{ pattern: '/', match: 'exact' as const }],
      disallowedPathPatterns: [{ pattern: '/data/clients/', match: 'prefix' as const }],
    };
    expect(isPathAllowed(policy, '/')).toBe(true);
    expect(isPathAllowed(policy, '/data/clients/x.csv')).toBe(false);
  });
});
