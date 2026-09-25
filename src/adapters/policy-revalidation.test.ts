import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { db } from '../db/client.js';
import { sources } from '../db/schema/index.js';
import { syncSourcePolicy } from '../db/source-policies.js';
import { cleanupTestSource, createTestSource } from '../db/test-support.js';
import type { SourcePolicy } from '../domain/source.js';
import type { HttpFetchResult } from '../net/http-fetcher.js';
import {
  assertPolicyRevisionActive,
  PolicyRevisionSupersededError,
  withPolicyRevalidation,
} from './policy-revalidation.js';

/** A minimal, schema-legal `SourcePolicy` -- mirrors src/db/schema/public-views.test.ts's own `buildPolicy`. */
function buildPolicy(sourceId: string, reviewDate: string): SourcePolicy {
  return {
    id: randomUUID(),
    sourceId: sourceId as SourcePolicy['sourceId'],
    policyVersion: `test-${randomUUID().slice(0, 8)}`,
    allowedAcquisitionModes: ['http'],
    allowedPathPatterns: [{ pattern: '/', match: 'exact' }],
    disallowedPathPatterns: [],
    disallowedHosts: [],
    allowedHosts: ['example.invalid'],
    authenticationScope: 'none',
    rateLimit: { crawlDelaySeconds: 0, maxConcurrency: 1, notes: 'test' },
    termsUrl: null,
    robotsUrl: 'https://example.invalid/robots.txt',
    retention: { rawHtmlRetentionDays: null, notes: 'test' },
    display: { mayRepublishFullContent: false, notes: 'test' },
    linkedResources: {
      allowedDestinationHosts: [],
      allowedRelationshipTypes: [],
      maxTraversalDepth: 0,
      maxResourcesPerOpportunity: 0,
      mayFetchExternalApplicationPages: false,
      retention: 'none',
      notes: 'test',
    },
    reviewDate,
    evidence: ['test'],
    notes: 'test',
    decisionOwner: 'test',
  };
}

function okResult(url: string): HttpFetchResult {
  return { status: 200, headers: {}, body: '', finalUrl: url, redirectCount: 0 };
}

describe('policy revalidation (Codex-caught P1, round 10, 2026-09-25)', () => {
  const sourceIds: string[] = [];
  afterEach(async () => {
    for (const id of sourceIds.splice(0)) {
      await cleanupTestSource(id);
    }
  });

  async function seedSource(): Promise<{ sourceId: string; revisionId: string | null }> {
    const sourceId = await createTestSource();
    sourceIds.push(sourceId);
    await syncSourcePolicy(db, buildPolicy(sourceId, '2026-01-01T00:00:00Z'));
    const [source] = await db
      .select({ currentPolicyRevisionId: sources.currentPolicyRevisionId })
      .from(sources)
      .where(eq(sources.id, sourceId));
    return { sourceId, revisionId: source?.currentPolicyRevisionId ?? null };
  }

  describe('assertPolicyRevisionActive', () => {
    it('resolves when the current revision still matches and no conflict is flagged', async () => {
      const { sourceId, revisionId } = await seedSource();
      await expect(assertPolicyRevisionActive(db, sourceId, revisionId)).resolves.toBeUndefined();
    });

    it('throws once the current revision has moved on since the baseline was captured', async () => {
      const { sourceId, revisionId } = await seedSource();
      // A genuinely later, different revision takes over -- simulates an
      // operator's `npm run sync-policies` or a fresher worker landing
      // after this crawl already captured its own baseline.
      await syncSourcePolicy(db, buildPolicy(sourceId, '2026-02-01T00:00:00Z'));
      await expect(assertPolicyRevisionActive(db, sourceId, revisionId)).rejects.toThrow(
        PolicyRevisionSupersededError,
      );
    });

    it('throws once a same-date conflict is flagged, even though the revision id itself is unchanged', async () => {
      const { sourceId, revisionId } = await seedSource();
      // Simulates a concurrent sync elsewhere detecting a same-date tie
      // (src/db/source-policies.ts's policyConflictAt) without the current
      // pointer itself having moved.
      await db
        .update(sources)
        .set({ policyConflictAt: new Date().toISOString() })
        .where(eq(sources.id, sourceId));
      await expect(assertPolicyRevisionActive(db, sourceId, revisionId)).rejects.toThrow(
        PolicyRevisionSupersededError,
      );
    });
  });

  describe('withPolicyRevalidation', () => {
    it('delegates to the real fetcher while the captured baseline still matches', async () => {
      const { sourceId, revisionId } = await seedSource();
      const wrapped = withPolicyRevalidation(
        { fetch: async (url) => okResult(url), close: async () => {} },
        db,
        sourceId,
        revisionId,
      );
      const result = await wrapped.fetch('https://example.invalid/1');
      expect(result.status).toBe(200);
    });

    it('aborts BEFORE reaching the real fetcher once the policy changes mid-crawl, without ever making the request', async () => {
      const { sourceId, revisionId } = await seedSource();
      let innerCalls = 0;
      const wrapped = withPolicyRevalidation(
        {
          fetch: async (url) => {
            innerCalls++;
            return okResult(url);
          },
          close: async () => {},
        },
        db,
        sourceId,
        revisionId,
      );

      // The first request happens while the baseline is still current.
      await wrapped.fetch('https://example.invalid/1');
      expect(innerCalls).toBe(1);

      // A fresher worker's sync lands mid-crawl -- exactly the scenario a
      // full jobs.ge walk's ~7.9 hours leaves exposed if nothing re-checks.
      await syncSourcePolicy(db, buildPolicy(sourceId, '2026-02-01T00:00:00Z'));

      await expect(wrapped.fetch('https://example.invalid/2')).rejects.toThrow(
        PolicyRevisionSupersededError,
      );
      // The real fetcher must never be reached once revalidation fails --
      // the whole point is that no further requests happen under a
      // superseded policy.
      expect(innerCalls).toBe(1);
    });
  });
});
