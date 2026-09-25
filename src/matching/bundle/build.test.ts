import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, pool } from '../../db/client.js';
import {
  listingClassifications,
  matchingBundleBuilds,
  matchingBundlePublications,
  opportunities,
  opportunityRevisions,
  opportunitySourceMemberships,
  sourceListingRevisions,
  sourceListings,
  taxonomyTerms,
} from '../../db/schema/index.js';
import {
  cleanupTestSource,
  createTestResource,
  createTestSource,
  createTestSourceListing,
} from '../../db/test-support.js';
import { FilesystemArtifactStore } from './artifact-store.js';
import { type BuildOptions, buildMatchingBundle } from './build.js';
import {
  ARTIFACT_FILE_NAMES,
  MANIFEST_FILE,
  OPPORTUNITIES_FILE,
  type OpportunitiesFile,
  validateArtifactSet,
} from './contract.js';
import { rollbackMatchingBundle } from './rollback.js';
import { assessMatchingHealth, getMatchingBundleStatus } from './status.js';

/**
 * Phase 8C exit criteria, against the real database: an interrupted,
 * invalid or incompatible build never replaces the active bundle, and every
 * published row maps to a current public canonical revision and a real
 * source. Each test publishes to its own channel and its own temporary
 * store, and restricts the corpus to its own disposable source, so the real
 * `public` channel and corpus are never touched.
 */
describe('matching bundle build', () => {
  let sourceId: string;
  let sourceSlug: string;
  let channel: string;
  let store: FilesystemArtifactStore;
  let storeRoot: string;
  const termIds: string[] = [];

  beforeEach(async () => {
    sourceId = await createTestSource();
    sourceSlug = `test-source-${sourceId}`;
    channel = `test-${randomUUID()}`;
    storeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xtelo-bundle-'));
    store = new FilesystemArtifactStore(storeRoot);
  });

  afterEach(async () => {
    await db
      .delete(matchingBundlePublications)
      .where(eq(matchingBundlePublications.channel, channel));
    await db.delete(matchingBundleBuilds).where(eq(matchingBundleBuilds.channel, channel));
    await cleanupTestSource(sourceId, { taxonomyTermIds: termIds.splice(0) });
    await fs.rm(storeRoot, { recursive: true, force: true });
  });

  function options(overrides: Partial<BuildOptions> = {}): BuildOptions {
    return {
      channel,
      activatedBy: 'test',
      sourceSlugs: [sourceSlug],
      upstreamAlerts: async () => [],
      holdDedupeLock: false,
      ...overrides,
    };
  }

  /** A clustered, public, eligible opportunity with one live member and a canonical revision. */
  async function makeOpportunity(
    title: string,
    listing: { status?: 'active' | 'expired' | 'quarantined'; deadlineAt?: string | null } = {},
  ): Promise<{ opportunityId: string; listingId: string; revisionId: string }> {
    const row = await createTestSourceListing(sourceId, {
      status: listing.status ?? 'active',
      sourceDeadlineAt: listing.deadlineAt ?? null,
    });
    const resourceId = await createTestResource(sourceId);
    const revisionId = randomUUID();
    await db.insert(sourceListingRevisions).values({
      id: revisionId,
      sourceListingId: row.id,
      parserVersion: 'v3',
      extractionMethod: 'http',
      rawResourceHash: 'a'.repeat(64),
      meaningfulContentHash: randomUUID().replace(/-/g, '').padEnd(64, '0'),
      titleRaw: title,
      titleNormalized: title,
      organizationRaw: 'Test employer',
      description: 'secret full description',
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
      canonicalStatus: listing.status ?? 'active',
      currentCanonicalRevisionId: null,
      createdAt: '2026-09-06T12:00:00Z',
      updatedAt: '2026-09-06T12:00:00Z',
    });
    await db.insert(opportunityRevisions).values({
      id: canonicalRevisionId,
      opportunityId,
      canonicalTitle: title,
      canonicalStatus: listing.status ?? 'active',
      organizationId: null,
      resolvedFields: {},
      sourceMembershipVersions: [],
      resolutionRulesetVersion: 'v1',
      meaningfulContentHash: 'b'.repeat(64),
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
      evidence: { reasons: ['test fixture'] },
      decidedBy: 'ruleset',
      decidedAt: '2026-09-06T12:00:00Z',
      dedupeModelOrRulesetVersion: 'v1',
      supersededAt: null,
    });
    return { opportunityId, listingId: row.id, revisionId: canonicalRevisionId };
  }

  async function readBundle(buildId: string): Promise<OpportunitiesFile> {
    const files = new Map<string, Uint8Array>();
    for (const name of ARTIFACT_FILE_NAMES) {
      const bytes = await store.readFile(buildId, name);
      if (bytes !== null) files.set(name, bytes);
    }
    return validateArtifactSet(buildId, files).opportunities;
  }

  async function activeBuildId(): Promise<string | null> {
    return (await getMatchingBundleStatus(db, channel)).active?.buildId ?? null;
  }

  it('publishes only public, eligible opportunities, each mapped to its current revision and real source', async () => {
    const open = await makeOpportunity('Backend engineer');
    const expired = await makeOpportunity('Closed role', { status: 'expired' });
    const quarantined = await makeOpportunity('Hidden role', { status: 'quarantined' });
    const pastDeadline = await makeOpportunity('Past deadline', {
      deadlineAt: '2020-01-01T00:00:00Z',
    });
    const termId = randomUUID();
    termIds.push(termId);
    await db.insert(taxonomyTerms).values({
      id: termId,
      axis: 'profession',
      code: `test-${termId}`,
      label: 'პროგრამისტი',
      taxonomyVersion: 'test',
    });
    const [listing] = await db
      .select({ revisionId: sourceListings.currentRevisionId })
      .from(sourceListings)
      .where(eq(sourceListings.id, open.listingId));
    await db.insert(listingClassifications).values({
      sourceListingRevisionId: listing?.revisionId as string,
      taxonomyTermId: termId,
      axis: 'profession',
      method: 'keyword',
      confidence: 0.9,
      evidence: {},
      taxonomyVersion: 'test',
      createdAt: '2026-09-06T12:00:00Z',
    });

    const result = await buildMatchingBundle(db, pool, store, options());
    expect(result.outcome).toBe('activated');
    if (result.outcome !== 'activated') return;

    const bundle = await readBundle(result.buildId);
    expect(bundle.opportunities.map((row) => row.opportunityId)).toEqual([open.opportunityId]);
    const [row] = bundle.opportunities;
    expect(row).toMatchObject({
      canonicalRevisionId: open.revisionId,
      title: 'Backend engineer',
      organization: 'Test employer',
      locations: ['თბილისი'],
      taxonomy: [{ axis: 'profession', code: `test-${termId}`, label: 'პროგრამისტი' }],
      sources: [{ sourceSlug, sourceListingId: open.listingId }],
    });
    // Redacted in the public view, so it cannot reach a bundle either.
    const raw = new TextDecoder().decode(
      (await store.readFile(result.buildId, OPPORTUNITIES_FILE)) as Uint8Array,
    );
    expect(raw).not.toContain('secret full description');
    for (const excluded of [expired, quarantined, pastDeadline]) {
      expect(raw).not.toContain(excluded.opportunityId);
    }
    expect(await activeBuildId()).toBe(result.buildId);
  });

  it('is idempotent: an unchanged corpus produces byte-identical rows', async () => {
    await makeOpportunity('Analyst');
    await makeOpportunity('Designer');
    const first = await buildMatchingBundle(db, pool, store, options());
    const second = await buildMatchingBundle(db, pool, store, options());
    if (first.outcome !== 'activated' || second.outcome !== 'activated') {
      throw new Error('both builds should activate');
    }
    const a = await readBundle(first.buildId);
    const b = await readBundle(second.buildId);
    expect(b.opportunities).toEqual(a.opportunities);
    expect(await activeBuildId()).toBe(second.buildId);
  });

  it('keeps the previous bundle active when a build is interrupted after writing files', async () => {
    await makeOpportunity('Analyst');
    const good = await buildMatchingBundle(db, pool, store, options());
    if (good.outcome !== 'activated') throw new Error('first build should activate');

    await expect(
      buildMatchingBundle(
        db,
        pool,
        store,
        options({
          afterArtifactsWritten: async () => {
            throw new Error('simulated crash');
          },
        }),
      ),
    ).rejects.toThrow('simulated crash');

    expect(await activeBuildId()).toBe(good.buildId);
    const [failed] = await db
      .select()
      .from(matchingBundleBuilds)
      .where(eq(matchingBundleBuilds.channel, channel))
      .orderBy(matchingBundleBuilds.startedAt)
      .offset(1);
    expect(failed).toMatchObject({ state: 'failed', errorCode: 'internal_error' });
    expect(await store.hasVersion(failed?.id as string)).toBe(false);
  });

  it('marks a build left in `building` by a crashed process as interrupted on the next run', async () => {
    await makeOpportunity('Analyst');
    const orphanId = randomUUID();
    await db.insert(matchingBundleBuilds).values({
      id: orphanId,
      channel,
      schemaVersion: 1,
      featureContract: 'lexical-v1',
      state: 'building',
      startedAt: '2026-09-01T00:00:00Z',
    });
    const result = await buildMatchingBundle(db, pool, store, options());
    expect(result.outcome).toBe('activated');
    const [orphan] = await db
      .select()
      .from(matchingBundleBuilds)
      .where(eq(matchingBundleBuilds.id, orphanId));
    expect(orphan).toMatchObject({ state: 'failed', errorCode: 'interrupted' });
  });

  it('refuses an incompatible schema, a failing health gate, an empty corpus and a collapsed count', async () => {
    const first = await makeOpportunity('One');
    await makeOpportunity('Two');
    await makeOpportunity('Three');
    const good = await buildMatchingBundle(db, pool, store, options());
    if (good.outcome !== 'activated') throw new Error('baseline build should activate');

    expect(
      await buildMatchingBundle(db, pool, store, options({ schemaVersion: 99 })),
    ).toMatchObject({
      outcome: 'failed',
      errorCode: 'incompatible_schema',
    });
    expect(
      await buildMatchingBundle(
        db,
        pool,
        store,
        options({
          upstreamAlerts: async () => [
            { level: 'critical', code: 'last_run_failed', sourceSlug, message: 'x' },
          ],
        }),
      ),
    ).toMatchObject({ outcome: 'failed', errorCode: 'upstream_unhealthy' });

    // Two of three drop out: below half the active bundle's count.
    await db
      .update(sourceListings)
      .set({ status: 'expired' })
      .where(eq(sourceListings.sourceId, sourceId));
    await db
      .update(sourceListings)
      .set({ status: 'active' })
      .where(eq(sourceListings.id, first.listingId));
    expect(await buildMatchingBundle(db, pool, store, options())).toMatchObject({
      outcome: 'failed',
      errorCode: 'count_anomaly',
    });

    await db
      .update(sourceListings)
      .set({ status: 'expired' })
      .where(eq(sourceListings.sourceId, sourceId));
    expect(await buildMatchingBundle(db, pool, store, options())).toMatchObject({
      outcome: 'failed',
      errorCode: 'empty_bundle',
    });

    expect(await activeBuildId()).toBe(good.buildId);
    expect(await readBundle(good.buildId)).toBeDefined();
  });

  it('builds past the health gate only when told to, and records that it did', async () => {
    await makeOpportunity('Analyst');
    const result = await buildMatchingBundle(
      db,
      pool,
      store,
      options({
        overrideHealthGate: true,
        upstreamAlerts: async () => [
          { level: 'critical', code: 'last_run_failed', sourceSlug, message: 'x' },
        ],
      }),
    );
    expect(result.outcome).toBe('activated');
    const [build] = await db
      .select()
      .from(matchingBundleBuilds)
      .where(eq(matchingBundleBuilds.id, result.buildId));
    expect(build?.healthGateOverridden).toBe(true);
  });

  it('rolls back to the previous verified build and keeps rollback targets through garbage collection', async () => {
    await makeOpportunity('Analyst');
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const result = await buildMatchingBundle(db, pool, store, options());
      if (result.outcome !== 'activated') throw new Error('build should activate');
      ids.push(result.buildId);
    }
    // Active + two predecessors keep their files; older ones are collected.
    expect(await Promise.all(ids.map((id) => store.hasVersion(id)))).toEqual([
      false,
      false,
      true,
      true,
      true,
    ]);

    const rolled = await rollbackMatchingBundle(db, pool, store, { channel, activatedBy: 'test' });
    expect(rolled).toMatchObject({
      outcome: 'rolled_back',
      fromBuildId: ids[4],
      toBuildId: ids[3],
    });
    expect(await activeBuildId()).toBe(ids[3]);

    const again = await rollbackMatchingBundle(db, pool, store, { channel, activatedBy: 'test' });
    expect(again).toMatchObject({ outcome: 'rolled_back', toBuildId: ids[2] });
    // ids[1]'s files are gone: no further rollback, and nothing is activated blind.
    expect(await rollbackMatchingBundle(db, pool, store, { channel, activatedBy: 'test' })).toEqual(
      {
        outcome: 'refused',
        reason: 'no_rollback_target',
      },
    );
    expect(await activeBuildId()).toBe(ids[2]);

    const pubs = await db
      .select()
      .from(matchingBundlePublications)
      .where(eq(matchingBundlePublications.channel, channel));
    expect(pubs.filter((pub) => pub.retiredAt === null)).toHaveLength(1);
    expect(pubs.filter((pub) => pub.reason === 'rollback')).toHaveLength(2);
  });

  it('refuses to roll back onto a target whose files were tampered with', async () => {
    await makeOpportunity('Analyst');
    const first = await buildMatchingBundle(db, pool, store, options());
    await buildMatchingBundle(db, pool, store, options());
    if (first.outcome !== 'activated') throw new Error('build should activate');
    await fs.appendFile(path.join(storeRoot, first.buildId, OPPORTUNITIES_FILE), ' ');

    expect(await rollbackMatchingBundle(db, pool, store, { channel, activatedBy: 'test' })).toEqual(
      {
        outcome: 'refused',
        reason: 'target_invalid',
      },
    );
  });

  it('allows only one active publication per channel, enforced by the database', async () => {
    await makeOpportunity('Analyst');
    const result = await buildMatchingBundle(db, pool, store, options());
    if (result.outcome !== 'activated') throw new Error('build should activate');
    await expect(
      db.insert(matchingBundlePublications).values({
        id: randomUUID(),
        channel,
        buildId: result.buildId,
        reason: 'build',
        activatedBy: 'test',
        activatedAt: new Date().toISOString(),
      }),
    ).rejects.toThrow();
  });

  it('reports health from the build records', async () => {
    await makeOpportunity('Analyst');
    expect(
      assessMatchingHealth(await getMatchingBundleStatus(db, channel), new Date().toISOString()),
    ).toEqual([expect.objectContaining({ code: 'no_active_bundle' })]);
    const result = await buildMatchingBundle(db, pool, store, options());
    if (result.outcome !== 'activated') throw new Error('build should activate');
    const status = await getMatchingBundleStatus(db, channel);
    expect(assessMatchingHealth(status, new Date().toISOString())).toEqual([]);
    const later = new Date(Date.now() + 80 * 3600 * 1000).toISOString();
    expect(assessMatchingHealth(status, later)).toEqual([
      expect.objectContaining({ level: 'critical', code: 'bundle_stale' }),
    ]);
  });
});

describe('artifact validation', () => {
  it('rejects a manifest whose file checksum does not match', () => {
    const bundleId = randomUUID();
    const body = new TextEncoder().encode(
      JSON.stringify({ schemaVersion: 1, bundleId, opportunities: [] }),
    );
    const manifest = new TextEncoder().encode(
      JSON.stringify({
        schemaVersion: 1,
        bundleId,
        featureContract: 'lexical-v1',
        model: null,
        generatedAt: '2026-09-25T00:00:00Z',
        corpusWatermark: null,
        sourceFreshness: [],
        counts: { opportunities: 0, sources: 0 },
        files: { [OPPORTUNITIES_FILE]: { sha256: '0'.repeat(64), bytes: body.byteLength } },
      }),
    );
    expect(() =>
      validateArtifactSet(
        bundleId,
        new Map([
          [MANIFEST_FILE, manifest],
          [OPPORTUNITIES_FILE, body],
        ]),
      ),
    ).toThrow('checksum mismatch');
  });

  it('refuses path traversal through the store', async () => {
    const store = new FilesystemArtifactStore(os.tmpdir());
    await expect(store.readFile('../etc', MANIFEST_FILE)).rejects.toThrow('invalid bundle id');
    await expect(store.readFile(randomUUID(), '../../secret')).rejects.toThrow(
      'unknown artifact file',
    );
  });
});
