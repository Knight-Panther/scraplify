import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from './client.js';
import { sourceTaxonomyMappings, taxonomyTerms } from './schema/index.js';
import { cleanupTestSource, createTestSource } from './test-support.js';

describe('cleanupTestSource — taxonomy cleanup', () => {
  /**
   * `taxonomyTermIds` is EXPLICIT ownership proof, not something
   * `cleanupTestSource` infers on its own — see that function's own doc
   * comment for why an earlier version that inferred ownership from "the
   * source's mapping was the last one pointing at it" was rejected (commit
   * gate, 2026-09-15): a term reading zero current references is not proof
   * a given caller created it, and treating the two as equivalent risked
   * deleting a term the caller never touched. A test still names the ids it
   * created (below) — cleanupTestSource then only deletes a NAMED id, and
   * only if nothing still depends on it.
   */
  it('deletes a source-seeded taxonomy term the caller names, when nothing else references it', async () => {
    const sourceId = await createTestSource();
    const termId = randomUUID();
    await db.insert(taxonomyTerms).values({
      id: termId,
      axis: 'profession',
      code: `profession-${randomUUID()}`,
      label: 'ტესტის ტერმინი',
      taxonomyVersion: 'v1',
      parentId: null,
    });
    await db.insert(sourceTaxonomyMappings).values({
      id: randomUUID(),
      sourceId,
      sourceCategoryRaw: randomUUID(),
      taxonomyTermId: termId,
      method: 'deterministic_rule',
      confidence: 1,
      taxonomyVersion: 'v1',
    });

    await cleanupTestSource(sourceId, { taxonomyTermIds: [termId] });

    const [term] = await db.select().from(taxonomyTerms).where(eq(taxonomyTerms.id, termId));
    expect(term).toBeUndefined();
  });

  /**
   * A term still referenced by ANOTHER source's mapping must survive, even
   * though it was named as a candidate — naming is permission to delete IF
   * safe, not an unconditional delete.
   */
  it('keeps a named taxonomy term that another source still maps to', async () => {
    const sourceIdA = await createTestSource();
    const sourceIdB = await createTestSource();
    const termId = randomUUID();
    await db.insert(taxonomyTerms).values({
      id: termId,
      axis: 'industry',
      code: `industry-${randomUUID()}`,
      label: 'გაზიარებული ტერმინი',
      taxonomyVersion: 'v1',
      parentId: null,
    });
    await db.insert(sourceTaxonomyMappings).values([
      {
        id: randomUUID(),
        sourceId: sourceIdA,
        sourceCategoryRaw: randomUUID(),
        taxonomyTermId: termId,
        method: 'deterministic_rule',
        confidence: 1,
        taxonomyVersion: 'v1',
      },
      {
        id: randomUUID(),
        sourceId: sourceIdB,
        sourceCategoryRaw: randomUUID(),
        taxonomyTermId: termId,
        method: 'deterministic_rule',
        confidence: 1,
        taxonomyVersion: 'v1',
      },
    ]);

    await cleanupTestSource(sourceIdA, { taxonomyTermIds: [termId] });

    const [term] = await db.select().from(taxonomyTerms).where(eq(taxonomyTerms.id, termId));
    expect(term).toBeDefined();

    // Clean up what this test itself created for source B, which
    // cleanupTestSource(sourceIdA, ...) correctly left alone.
    await cleanupTestSource(sourceIdB, { taxonomyTermIds: [termId] });
  });

  /**
   * The self-referencing `taxonomy_terms.parent_id` case a term-only
   * reference check missed: a parent with zero DIRECT mappings/
   * classifications left can still have a live CHILD (itself still
   * referenced by something else). Deleting the parent anyway would
   * violate `taxonomy_terms_parent_id_taxonomy_terms_id_fk` and abort the
   * whole cleanup transaction — turning a debris-avoidance feature into a
   * cleanup-breaking one (commit gate, 2026-09-15). The parent must survive
   * exactly like the still-mapped case above, not merely avoid crashing.
   */
  it('keeps a named parent term whose child is still referenced, rather than violating the self-referencing FK', async () => {
    const sourceIdA = await createTestSource();
    const sourceIdB = await createTestSource();
    const parentId = randomUUID();
    const childId = randomUUID();
    await db.insert(taxonomyTerms).values([
      {
        id: parentId,
        axis: 'profession',
        code: `profession-${randomUUID()}`,
        label: 'მშობელი',
        taxonomyVersion: 'v1',
        parentId: null,
      },
      {
        id: childId,
        axis: 'profession',
        code: `profession-${randomUUID()}`,
        label: 'შვილი',
        taxonomyVersion: 'v1',
        parentId,
      },
    ]);
    // Source A mapped only the PARENT (its own mapping about to be deleted
    // by A's cleanup); source B mapped the CHILD, and B is not being
    // cleaned up here, so the child stays live and the parent must too.
    await db.insert(sourceTaxonomyMappings).values([
      {
        id: randomUUID(),
        sourceId: sourceIdA,
        sourceCategoryRaw: randomUUID(),
        taxonomyTermId: parentId,
        method: 'deterministic_rule',
        confidence: 1,
        taxonomyVersion: 'v1',
      },
      {
        id: randomUUID(),
        sourceId: sourceIdB,
        sourceCategoryRaw: randomUUID(),
        taxonomyTermId: childId,
        method: 'deterministic_rule',
        confidence: 1,
        taxonomyVersion: 'v1',
      },
    ]);

    // Must not throw (the FK-violation-aborts-everything failure mode) and
    // must leave the parent in place.
    await expect(
      cleanupTestSource(sourceIdA, { taxonomyTermIds: [parentId] }),
    ).resolves.toBeUndefined();

    const [parent] = await db.select().from(taxonomyTerms).where(eq(taxonomyTerms.id, parentId));
    expect(parent).toBeDefined();

    // One call naming both — cleanupTestSource resolves the intra-batch
    // parent/child ordering itself (deletes the now-unblocked leaf first,
    // then re-checks and deletes the parent it was blocking).
    await cleanupTestSource(sourceIdB, { taxonomyTermIds: [childId, parentId] });
  });

  /**
   * The pattern `seedTaxonomyTerms` itself actually produces, and the one
   * that leaked real rows in practice (not just in a hand-built scenario
   * above): ONE source seeds a whole parent+child tree, then names every
   * node it created in ONE `cleanupTestSource` call — exactly what
   * `seed-terms.test.ts` does after every test. A single-pass version of
   * the reference check found the child's own row still present at query
   * time (nothing had deleted it yet within that same pass) and protected
   * the parent every time, leaking it forever — confirmed for real via
   * `docker exec psql` after a full run of this suite: seven leaked
   * top-level terms, each missing exactly the child that should have
   * unblocked it (commit gate, 2026-09-15). This must delete BOTH.
   */
  it('deletes an entire parent+child tree named together in one call, from one source', async () => {
    const sourceId = await createTestSource();
    const parentId = randomUUID();
    const childId = randomUUID();
    await db.insert(taxonomyTerms).values([
      {
        id: parentId,
        axis: 'profession',
        code: `profession-${randomUUID()}`,
        label: 'მშობელი ორივე',
        taxonomyVersion: 'v1',
        parentId: null,
      },
      {
        id: childId,
        axis: 'profession',
        code: `profession-${randomUUID()}`,
        label: 'შვილი ორივე',
        taxonomyVersion: 'v1',
        parentId,
      },
    ]);
    await db.insert(sourceTaxonomyMappings).values([
      {
        id: randomUUID(),
        sourceId,
        sourceCategoryRaw: randomUUID(),
        taxonomyTermId: parentId,
        method: 'deterministic_rule',
        confidence: 1,
        taxonomyVersion: 'v1',
      },
      {
        id: randomUUID(),
        sourceId,
        sourceCategoryRaw: randomUUID(),
        taxonomyTermId: childId,
        method: 'deterministic_rule',
        confidence: 1,
        taxonomyVersion: 'v1',
      },
    ]);

    await cleanupTestSource(sourceId, { taxonomyTermIds: [parentId, childId] });

    const rows = await db.select().from(taxonomyTerms).where(eq(taxonomyTerms.id, parentId));
    const childRows = await db.select().from(taxonomyTerms).where(eq(taxonomyTerms.id, childId));
    expect(rows).toHaveLength(0);
    expect(childRows).toHaveLength(0);
  });
});
