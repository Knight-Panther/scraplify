import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  sourceListingRevisions,
  sourceListings,
  sourceTaxonomyMappings,
  sources,
  taxonomyTerms,
} from '../db/schema/index.js';
import type { Database } from '../db/types.js';
import type { TaxonomyAxis } from '../domain/taxonomy.js';

/** Bumped whenever the seeding logic itself changes what it writes, not on every run. */
export const TAXONOMY_VERSION = 'v1';

interface RawTaxonomyNode {
  sourceTermId: string;
  name: string;
  children: RawTaxonomyNode[];
}

/**
 * Reads `structuredAttributes.specialty`/`.industry` defensively, the same
 * way `web/lib/opportunity-detail.ts`'s `asTaxonomyNames` does for display —
 * jsonb arrives as `unknown`, and a pre-`v3` hr.ge revision still holds a
 * flat array of plain strings rather than these nodes. Those revisions
 * contribute nothing here (no `sourceTermId` to seed a stable mapping
 * from); they are picked up once the re-crawl (Phase 3C-2 Stage 2) writes a
 * fresh `v3` revision for them.
 */
function asRawTaxonomyNodes(value: unknown): RawTaxonomyNode[] {
  if (!Array.isArray(value)) return [];
  const nodes: RawTaxonomyNode[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.sourceTermId !== 'string' || typeof record.name !== 'string') continue;
    nodes.push({
      sourceTermId: record.sourceTermId,
      name: record.name,
      children: asRawTaxonomyNodes(record.children),
    });
  }
  return nodes;
}

export interface SeedTaxonomyTermsResult {
  listingsScanned: number;
  termsCreated: number;
  mappingsCreated: number;
  /** A node already mapped under an older TAXONOMY_VERSION, re-derived under the current one. */
  termsUpdated: number;
}

/**
 * Walks every current hr.ge listing's specialty/industry tree and seeds
 * `taxonomyTerms` + `sourceTaxonomyMappings` for every node not already
 * mapped (§15.2 steps 1-4).
 *
 * Idempotent by construction: hr.ge's own node id (`sourceTermId`) is a
 * real, stable key — re-running after a later incremental crawl adds only
 * genuinely new nodes, never a duplicate term for one already seeded. This
 * is exactly what the earlier (falsified) flattened-string design needed a
 * fuzzy normalization pass to approximate; a real source id makes "is this
 * the same node" exact instead (`docs/STATUS.md`, Phase 3C-2).
 *
 * `code` is the domain contract's "stable slug, independent of label
 * wording changes" (`src/domain/taxonomy.ts`) — derived from hr.ge's own
 * node id rather than genuinely source-independent, since hr.ge is the only
 * source seeding this table today (see `taxonomyTerms`'s own schema
 * comment for why that is recorded as a known simplification, not hidden).
 *
 * `sourceSlug` defaults to the real `'hr-ge'` and exists so tests can point
 * this at a disposable `createTestSource()` slug instead — parameterizing
 * the slug is simpler here than the `vi.mock`-the-policy-module pattern
 * `crawl.test.ts` uses, since this function never imports the policy's
 * `hrGeSource` constant in the first place.
 */
export async function seedTaxonomyTerms(
  db: Database,
  options: { sourceSlug?: string } = {},
): Promise<SeedTaxonomyTermsResult> {
  const sourceSlug = options.sourceSlug ?? 'hr-ge';
  const [hrGeSource] = await db
    .select({ id: sources.id })
    .from(sources)
    .where(eq(sources.slug, sourceSlug));
  if (hrGeSource === undefined) {
    return { listingsScanned: 0, termsCreated: 0, mappingsCreated: 0, termsUpdated: 0 };
  }
  // Extracted so the seedNode closure below captures a plain string rather
  // than the outer, possibly-undefined-typed object — TS narrowing from the
  // guard above doesn't cross a nested function's closure boundary.
  const hrGeSourceId = hrGeSource.id;

  const existingMappings = await db
    .select({
      id: sourceTaxonomyMappings.id,
      sourceCategoryRaw: sourceTaxonomyMappings.sourceCategoryRaw,
      taxonomyTermId: sourceTaxonomyMappings.taxonomyTermId,
      taxonomyVersion: sourceTaxonomyMappings.taxonomyVersion,
    })
    .from(sourceTaxonomyMappings)
    .where(eq(sourceTaxonomyMappings.sourceId, hrGeSourceId));
  const existingByRawId = new Map(
    existingMappings.map((row) => [
      row.sourceCategoryRaw,
      { mappingId: row.id, termId: row.taxonomyTermId, version: row.taxonomyVersion },
    ]),
  );

  const listingRows = await db
    .select({ structuredAttributes: sourceListingRevisions.structuredAttributes })
    .from(sourceListings)
    .innerJoin(
      sourceListingRevisions,
      eq(sourceListingRevisions.id, sourceListings.currentRevisionId),
    )
    .where(eq(sourceListings.sourceId, hrGeSourceId));

  let termsCreated = 0;
  let mappingsCreated = 0;
  let termsUpdated = 0;

  async function seedNode(
    node: RawTaxonomyNode,
    axis: TaxonomyAxis,
    parentId: string | null,
  ): Promise<string> {
    const existing = existingByRawId.get(node.sourceTermId);

    if (existing !== undefined && existing.version === TAXONOMY_VERSION) {
      for (const child of node.children) await seedNode(child, axis, existing.termId);
      return existing.termId;
    }

    if (existing !== undefined) {
      // A node mapped under an OLDER TAXONOMY_VERSION: re-derive its term
      // and mapping in place rather than silently leaving stale data behind
      // a version bump — §15.2's "versioned deterministic mappings" means a
      // version change actually reprocesses, not just applies going forward
      // (commit gate finding, 2026-09-15). Same reasoning as the insert
      // path below for why this is one transaction: a crash between the two
      // updates must not leave the term and its mapping's version disagreeing.
      await db.transaction(async (tx) => {
        await tx
          .update(taxonomyTerms)
          .set({
            axis,
            code: `${axis}-${node.sourceTermId}`,
            label: node.name,
            taxonomyVersion: TAXONOMY_VERSION,
            parentId,
          })
          .where(eq(taxonomyTerms.id, existing.termId));
        await tx
          .update(sourceTaxonomyMappings)
          .set({ taxonomyVersion: TAXONOMY_VERSION })
          .where(eq(sourceTaxonomyMappings.id, existing.mappingId));
      });
      existingByRawId.set(node.sourceTermId, { ...existing, version: TAXONOMY_VERSION });
      termsUpdated++;
      for (const child of node.children) await seedNode(child, axis, existing.termId);
      return existing.termId;
    }

    const termId = randomUUID();
    // One transaction for both inserts: a crash between them would leave a
    // taxonomyTerms row with no mapping pointing at it, and — since `code`
    // is deterministic from `node.sourceTermId` — a retry would then hit
    // `taxonomy_terms_code_unique` trying to re-create the term, permanently
    // blocking that node from ever getting its missing mapping without
    // manual repair (commit gate finding, 2026-09-15).
    const mappingId = randomUUID();
    await db.transaction(async (tx) => {
      await tx.insert(taxonomyTerms).values({
        id: termId,
        axis,
        code: `${axis}-${node.sourceTermId}`,
        label: node.name,
        taxonomyVersion: TAXONOMY_VERSION,
        parentId,
      });
      await tx.insert(sourceTaxonomyMappings).values({
        id: mappingId,
        sourceId: hrGeSourceId,
        sourceCategoryRaw: node.sourceTermId,
        taxonomyTermId: termId,
        method: 'deterministic_rule',
        confidence: 1,
        taxonomyVersion: TAXONOMY_VERSION,
      });
    });
    existingByRawId.set(node.sourceTermId, { mappingId, termId, version: TAXONOMY_VERSION });
    termsCreated++;
    mappingsCreated++;

    for (const child of node.children) await seedNode(child, axis, termId);
    return termId;
  }

  for (const row of listingRows) {
    const attributes =
      typeof row.structuredAttributes === 'object' && row.structuredAttributes !== null
        ? (row.structuredAttributes as Record<string, unknown>)
        : {};
    const specialty = asRawTaxonomyNodes(attributes.specialty);
    const industry = asRawTaxonomyNodes(attributes.industry);
    for (const node of specialty) await seedNode(node, 'profession', null);
    for (const node of industry) await seedNode(node, 'industry', null);
  }

  return { listingsScanned: listingRows.length, termsCreated, mappingsCreated, termsUpdated };
}
