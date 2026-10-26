import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, pool } from '../../src/db/client.js';
import {
  opportunities,
  opportunityRevisions,
  opportunitySourceMemberships,
  sourceListingRevisions,
  sourceListings,
} from '../../src/db/schema/index.js';
import {
  createTestResource,
  createTestSource,
  createTestSourceListing,
} from '../../src/db/test-support.js';
import {
  artifactDirFromEnv,
  FilesystemArtifactStore,
} from '../../src/matching/bundle/artifact-store.js';
import { buildMatchingBundle } from '../../src/matching/bundle/build.js';
import { PUBLIC_MATCHING_CHANNEL } from '../../src/matching/bundle/contract.js';

/**
 * Global setup for the privacy suite, and only when XTELO_E2E_SEED_BUNDLE=1:
 * CI's database starts empty, and the suite needs an active public bundle
 * for the canary CV to be ranked against. It adds one disposable source with
 * one accountant vacancy and builds a schema 1 bundle (no title vectors, so
 * no model download). Run locally without the flag, it does nothing: the
 * suite then uses whatever bundle the database already has.
 */
export default async function seedBundle(): Promise<void> {
  if (process.env.XTELO_E2E_SEED_BUNDLE !== '1') return;
  try {
    const sourceId = await createTestSource();
    const title = 'ბუღალტერი / Accountant';
    const row = await createTestSourceListing(sourceId, { status: 'active' });
    const resourceId = await createTestResource(sourceId);
    const revisionId = randomUUID();
    await db.insert(sourceListingRevisions).values({
      id: revisionId,
      sourceListingId: row.id,
      parserVersion: 'v3',
      extractionMethod: 'http',
      rawResourceHash: 'a'.repeat(64),
      meaningfulContentHash: 'd'.repeat(64),
      titleRaw: title,
      titleNormalized: title,
      organizationRaw: 'Seeded employer',
      description: 'Financial reporting, payroll, bank reconciliation.',
      locations: ['თბილისი'],
      publishedDate: { raw: '', parsed: '2026-09-01T00:00:00Z' },
      deadlineDate: { raw: '', parsed: null },
      applicationMethod: null,
      sourceCategories: [],
      structuredAttributes: {},
      createdAt: '2026-09-01T00:00:00Z',
      provenanceResourceId: resourceId,
      provenanceFetchedAt: '2026-09-01T00:00:00Z',
      provenanceNotes: null,
    });
    await db
      .update(sourceListings)
      .set({ currentRevisionId: revisionId })
      .where(eq(sourceListings.id, row.id));

    const opportunityId = randomUUID();
    const canonicalRevisionId = randomUUID();
    await db.insert(opportunities).values({
      id: opportunityId,
      type: 'job',
      canonicalTitle: title,
      organizationId: null,
      canonicalStatus: 'active',
      currentCanonicalRevisionId: null,
      createdAt: '2026-09-06T12:00:00Z',
      updatedAt: '2026-09-06T12:00:00Z',
    });
    await db.insert(opportunityRevisions).values({
      id: canonicalRevisionId,
      opportunityId,
      canonicalTitle: title,
      canonicalStatus: 'active',
      organizationId: null,
      resolvedFields: {},
      sourceMembershipVersions: [],
      resolutionRulesetVersion: 'v1',
      meaningfulContentHash: 'e'.repeat(64),
      createdAt: '2026-09-06T12:00:00Z',
    });
    await db
      .update(opportunities)
      .set({ currentCanonicalRevisionId: canonicalRevisionId })
      .where(eq(opportunities.id, opportunityId));
    await db.insert(opportunitySourceMemberships).values({
      id: randomUUID(),
      opportunityId,
      sourceListingId: row.id,
      decision: 'confirmed_same',
      confidence: 0.97,
      evidence: { reasons: ['e2e privacy seed'] },
      decidedBy: 'ruleset',
      decidedAt: '2026-09-06T12:00:00Z',
      dedupeModelOrRulesetVersion: 'v1',
      supersededAt: null,
    });

    const result = await buildMatchingBundle(
      db,
      pool,
      new FilesystemArtifactStore(artifactDirFromEnv()),
      {
        channel: PUBLIC_MATCHING_CHANNEL,
        activatedBy: 'e2e-privacy-seed',
        sourceSlugs: [`test-source-${sourceId}`],
        upstreamAlerts: async () => [],
        holdDedupeLock: false,
      },
    );
    if (result.outcome !== 'activated') {
      throw new Error(`privacy seed: bundle build ${result.outcome} (${JSON.stringify(result)})`);
    }
  } finally {
    await pool.end();
  }
}
