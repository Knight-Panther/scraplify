import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CrawlRunSchema,
  DuplicateCandidateSchema,
  OpportunityRevisionSchema,
  OpportunitySchema,
  OpportunitySourceMembershipSchema,
  OrganizationSchema,
  ParserIncidentSchema,
  ResourceSchema,
  SourceListingRevisionSchema,
  SourceListingSchema,
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
        status: 'completed',
        discoveredCount: 120,
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
        status: 'quarantined',
        discoveredCount: 4,
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
