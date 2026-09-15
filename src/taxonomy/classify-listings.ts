import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import {
  listingClassifications,
  sourceListingRevisions,
  sourceListings,
  sourceTaxonomyMappings,
  sources,
} from '../db/schema/index.js';
import type { Database } from '../db/types.js';
import type { TaxonomyAxis } from '../domain/taxonomy.js';
import { TAXONOMY_VERSION } from './seed-terms.js';

interface RawTaxonomyNode {
  sourceTermId: string;
  name: string;
  children: RawTaxonomyNode[];
}

/** Same defensive reader as seed-terms.ts — kept local rather than shared, since each file's contract on the shape is narrow. */
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

function flatten(nodes: RawTaxonomyNode[]): RawTaxonomyNode[] {
  const flat: RawTaxonomyNode[] = [];
  for (const node of nodes) {
    flat.push(node);
    flat.push(...flatten(node.children));
  }
  return flat;
}

export interface ClassifyListingsResult {
  listingsScanned: number;
  classificationsCreated: number;
  unmappedNodes: number;
  /** A revision/term pair already classified under an older TAXONOMY_VERSION, re-derived under the current one. */
  classificationsUpdated: number;
}

/**
 * Backfills `listingClassifications` for every current hr.ge listing
 * revision, from the `sourceTaxonomyMappings` `seedTaxonomyTerms` already
 * wrote (§15.2 steps 5-8). Must run after `seedTaxonomyTerms` — a node with
 * no mapping yet is counted as `unmappedNodes` and skipped rather than
 * guessed at.
 *
 * One row per selected node, **parent and child both** — matching how the
 * pre-3C-2 flattened storage already treated a listing's selection (it
 * flattened parent and child into one undifferentiated list), and how the
 * raw data actually works: a listing selecting a subcategory is also
 * meaningfully classified under its parent category.
 *
 * `confidence: 1` throughout — this is hr.ge's own stated category via its
 * structured field, not an inferred guess, so §15.2's confidence field is
 * honest at its maximum rather than fabricated.
 */
export async function classifyListings(
  db: Database,
  options: { sourceSlug?: string } = {},
): Promise<ClassifyListingsResult> {
  const sourceSlug = options.sourceSlug ?? 'hr-ge';
  const [hrGeSource] = await db
    .select({ id: sources.id })
    .from(sources)
    .where(eq(sources.slug, sourceSlug));
  if (hrGeSource === undefined) {
    return {
      listingsScanned: 0,
      classificationsCreated: 0,
      unmappedNodes: 0,
      classificationsUpdated: 0,
    };
  }

  const mappingRows = await db
    .select({
      sourceCategoryRaw: sourceTaxonomyMappings.sourceCategoryRaw,
      taxonomyTermId: sourceTaxonomyMappings.taxonomyTermId,
    })
    .from(sourceTaxonomyMappings)
    .where(eq(sourceTaxonomyMappings.sourceId, hrGeSource.id));
  const termIdByRawId = new Map(
    mappingRows.map((row) => [row.sourceCategoryRaw, row.taxonomyTermId]),
  );

  const listingRows = await db
    .select({
      revisionId: sourceListingRevisions.id,
      structuredAttributes: sourceListingRevisions.structuredAttributes,
    })
    .from(sourceListings)
    .innerJoin(
      sourceListingRevisions,
      eq(sourceListingRevisions.id, sourceListings.currentRevisionId),
    )
    .where(eq(sourceListings.sourceId, hrGeSource.id));

  const revisionIds = listingRows.map((row) => row.revisionId);
  const alreadyClassified =
    revisionIds.length === 0
      ? []
      : await db
          .select({
            id: listingClassifications.id,
            sourceListingRevisionId: listingClassifications.sourceListingRevisionId,
            taxonomyTermId: listingClassifications.taxonomyTermId,
            taxonomyVersion: listingClassifications.taxonomyVersion,
            method: listingClassifications.method,
          })
          .from(listingClassifications)
          .where(inArray(listingClassifications.sourceListingRevisionId, revisionIds));
  const existingByPair = new Map(
    alreadyClassified.map((row) => [
      `${row.sourceListingRevisionId}:${row.taxonomyTermId}`,
      { id: row.id, version: row.taxonomyVersion, method: row.method },
    ]),
  );

  let classificationsCreated = 0;
  let classificationsUpdated = 0;
  let unmappedNodes = 0;
  const now = new Date().toISOString();

  for (const row of listingRows) {
    const attributes =
      typeof row.structuredAttributes === 'object' && row.structuredAttributes !== null
        ? (row.structuredAttributes as Record<string, unknown>)
        : {};
    const byAxis: Array<[TaxonomyAxis, RawTaxonomyNode[]]> = [
      ['profession', flatten(asRawTaxonomyNodes(attributes.specialty))],
      ['industry', flatten(asRawTaxonomyNodes(attributes.industry))],
    ];

    for (const [axis, nodes] of byAxis) {
      for (const node of nodes) {
        const termId = termIdByRawId.get(node.sourceTermId);
        if (termId === undefined) {
          unmappedNodes++;
          continue;
        }
        const pairKey = `${row.revisionId}:${termId}`;
        const existing = existingByPair.get(pairKey);
        const evidence = {
          reasons: [`hr.ge lists this vacancy under "${node.name}" via its own structured field`],
        };

        if (existing !== undefined && existing.version === TAXONOMY_VERSION) continue;

        // A pair already classified by a DIFFERENT method (human_review,
        // keyword, llm_classification — none of which this function has
        // ever produced, but the enum permits) is left untouched rather
        // than re-derived: this function's only authority is hr.ge's own
        // structured field, so overwriting a human's or a smarter method's
        // judgment with a mechanical backfill would silently downgrade it
        // while still claiming its original method — the exact audit-trail
        // corruption `run-dedupe.ts`'s own "never overwrite a human verdict"
        // rule exists to prevent elsewhere in this codebase (commit gate
        // finding, 2026-09-15).
        if (existing !== undefined && existing.method !== 'deterministic_rule') continue;

        if (existing !== undefined) {
          // §15.2's "versioned deterministic mappings" means a
          // TAXONOMY_VERSION bump reprocesses already-classified pairs, not
          // just new ones — a first version of this function treated an old
          // pair as permanently complete regardless of version (commit gate
          // finding, 2026-09-15).
          await db
            .update(listingClassifications)
            .set({
              axis,
              confidence: 1,
              evidence,
              taxonomyVersion: TAXONOMY_VERSION,
              createdAt: now,
            })
            .where(eq(listingClassifications.id, existing.id));
          existingByPair.set(pairKey, {
            id: existing.id,
            version: TAXONOMY_VERSION,
            method: 'deterministic_rule',
          });
          classificationsUpdated++;
          continue;
        }

        const newId = randomUUID();
        await db.insert(listingClassifications).values({
          id: newId,
          sourceListingRevisionId: row.revisionId,
          taxonomyTermId: termId,
          axis,
          method: 'deterministic_rule',
          confidence: 1,
          evidence,
          taxonomyVersion: TAXONOMY_VERSION,
          createdAt: now,
        });
        existingByPair.set(pairKey, {
          id: newId,
          version: TAXONOMY_VERSION,
          method: 'deterministic_rule',
        });
        classificationsCreated++;
      }
    }
  }

  return {
    listingsScanned: listingRows.length,
    classificationsCreated,
    unmappedNodes,
    classificationsUpdated,
  };
}
