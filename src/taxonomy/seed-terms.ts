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

/** One raw node's authoritative observation, chosen across every listing that mentions it. */
interface CollectedNode {
  name: string;
  parentRawId: string | null;
  axis: TaxonomyAxis;
  /** `provenanceFetchedAt` of the revision this observation came from — the tie-breaker below. */
  observedAt: string;
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
 *
 * Runs in two phases, not one pass over listings: **collect** every raw
 * node observed across the whole corpus into one map keyed by its stable
 * id, keeping only the observation with the latest `provenanceFetchedAt`
 * per id; then **apply** each unique node exactly once, parents before
 * children. A single-pass version processed each listing's tree inline as
 * it was encountered — correct when every listing agrees on a node's
 * label/parent (the ordinary case), but if hr.ge renamed a category and
 * some listings' revisions still carry the pre-rename observation while
 * others already have the post-rename one, that version would toggle the
 * term between the two values depending on row order, incrementing
 * `termsUpdated` repeatedly and leaving a final value that depends on the
 * database's unordered scan order rather than which observation is
 * actually newer (commit gate finding, 2026-09-15). Collecting first makes
 * the choice explicit and deterministic instead of an accident of
 * iteration order.
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
  const hrGeSourceId = hrGeSource.id;

  const existingMappings = await db
    .select({
      id: sourceTaxonomyMappings.id,
      sourceCategoryRaw: sourceTaxonomyMappings.sourceCategoryRaw,
      taxonomyTermId: sourceTaxonomyMappings.taxonomyTermId,
      taxonomyVersion: sourceTaxonomyMappings.taxonomyVersion,
      termLabel: taxonomyTerms.label,
      termParentId: taxonomyTerms.parentId,
    })
    .from(sourceTaxonomyMappings)
    .innerJoin(taxonomyTerms, eq(taxonomyTerms.id, sourceTaxonomyMappings.taxonomyTermId))
    .where(eq(sourceTaxonomyMappings.sourceId, hrGeSourceId));
  const existingByRawId = new Map(
    existingMappings.map((row) => [
      row.sourceCategoryRaw,
      {
        mappingId: row.id,
        termId: row.taxonomyTermId,
        version: row.taxonomyVersion,
        label: row.termLabel,
        parentId: row.termParentId,
      },
    ]),
  );

  const listingRows = await db
    .select({
      structuredAttributes: sourceListingRevisions.structuredAttributes,
      observedAt: sourceListingRevisions.provenanceFetchedAt,
    })
    .from(sourceListings)
    .innerJoin(
      sourceListingRevisions,
      eq(sourceListingRevisions.id, sourceListings.currentRevisionId),
    )
    .where(eq(sourceListings.sourceId, hrGeSourceId));

  // Phase 1: collect one authoritative observation per raw node, across the
  // whole corpus, before writing anything.
  const collected = new Map<string, CollectedNode>();
  function collect(
    nodes: RawTaxonomyNode[],
    axis: TaxonomyAxis,
    parentRawId: string | null,
    observedAt: string,
  ): void {
    for (const node of nodes) {
      const current = collected.get(node.sourceTermId);
      if (current === undefined || observedAt > current.observedAt) {
        collected.set(node.sourceTermId, { name: node.name, parentRawId, axis, observedAt });
      }
      collect(node.children, axis, node.sourceTermId, observedAt);
    }
  }
  for (const row of listingRows) {
    const attributes =
      typeof row.structuredAttributes === 'object' && row.structuredAttributes !== null
        ? (row.structuredAttributes as Record<string, unknown>)
        : {};
    collect(asRawTaxonomyNodes(attributes.specialty), 'profession', null, row.observedAt);
    collect(asRawTaxonomyNodes(attributes.industry), 'industry', null, row.observedAt);
  }

  let termsCreated = 0;
  let mappingsCreated = 0;
  let termsUpdated = 0;

  async function applyNode(
    rawId: string,
    data: CollectedNode,
    parentId: string | null,
  ): Promise<string> {
    const { name, axis } = data;
    const existing = existingByRawId.get(rawId);

    // Re-derive on EITHER signal, not version alone: a `TAXONOMY_VERSION`
    // bump forces a full reprocess, but hr.ge can also rename a category or
    // move it under a different parent while keeping the same node id, and
    // an ordinary same-version rerun must pick that up too — otherwise the
    // label/hierarchy this table exists to mirror exactly (§15.2 step 1)
    // goes stale the moment the source edits it, version bump or not
    // (commit gate finding, 2026-09-15). Comparing the actual stored values
    // is what makes this self-healing on every run instead of only on a
    // version change.
    if (
      existing !== undefined &&
      existing.version === TAXONOMY_VERSION &&
      existing.label === name &&
      existing.parentId === parentId
    ) {
      return existing.termId;
    }

    if (existing !== undefined) {
      // Same reasoning as the insert path below for why this is one
      // transaction: a crash between the two updates must not leave the
      // term and its mapping's version disagreeing.
      await db.transaction(async (tx) => {
        await tx
          .update(taxonomyTerms)
          .set({
            axis,
            code: `${axis}-${rawId}`,
            label: name,
            taxonomyVersion: TAXONOMY_VERSION,
            parentId,
          })
          .where(eq(taxonomyTerms.id, existing.termId));
        await tx
          .update(sourceTaxonomyMappings)
          .set({ taxonomyVersion: TAXONOMY_VERSION })
          .where(eq(sourceTaxonomyMappings.id, existing.mappingId));
      });
      existingByRawId.set(rawId, { ...existing, version: TAXONOMY_VERSION, label: name, parentId });
      termsUpdated++;
      return existing.termId;
    }

    const termId = randomUUID();
    // One transaction for both inserts: a crash between them would leave a
    // taxonomyTerms row with no mapping pointing at it, and — since `code`
    // is deterministic from the raw id — a retry would then hit
    // `taxonomy_terms_code_unique` trying to re-create the term, permanently
    // blocking that node from ever getting its missing mapping without
    // manual repair (commit gate finding, 2026-09-15).
    const mappingId = randomUUID();
    await db.transaction(async (tx) => {
      await tx.insert(taxonomyTerms).values({
        id: termId,
        axis,
        code: `${axis}-${rawId}`,
        label: name,
        taxonomyVersion: TAXONOMY_VERSION,
        parentId,
      });
      await tx.insert(sourceTaxonomyMappings).values({
        id: mappingId,
        sourceId: hrGeSourceId,
        sourceCategoryRaw: rawId,
        taxonomyTermId: termId,
        method: 'deterministic_rule',
        confidence: 1,
        taxonomyVersion: TAXONOMY_VERSION,
      });
    });
    existingByRawId.set(rawId, {
      mappingId,
      termId,
      version: TAXONOMY_VERSION,
      label: name,
      parentId,
    });
    termsCreated++;
    mappingsCreated++;
    return termId;
  }

  // Phase 2: apply in dependency order — a node whose parent hasn't been
  // resolved yet (still pending in this same batch) waits for a later pass,
  // the same iterative approach `cleanupTestSource` uses for the reverse
  // problem (deleting children before the parents they block).
  const resolvedTermIdByRawId = new Map<string, string>();
  let pending = new Map(collected);
  while (pending.size > 0) {
    const stillPending = new Map<string, CollectedNode>();
    for (const [rawId, data] of pending) {
      const parentId =
        data.parentRawId === null
          ? null
          : (resolvedTermIdByRawId.get(data.parentRawId) ?? undefined);
      if (parentId === undefined && data.parentRawId !== null) {
        stillPending.set(rawId, data);
        continue;
      }
      const termId = await applyNode(rawId, data, parentId ?? null);
      resolvedTermIdByRawId.set(rawId, termId);
    }
    if (stillPending.size === pending.size) break; // no progress possible; avoid an infinite loop
    pending = stillPending;
  }

  return { listingsScanned: listingRows.length, termsCreated, mappingsCreated, termsUpdated };
}
