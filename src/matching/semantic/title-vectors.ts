import { z } from 'zod';

/**
 * Title vectors (CV Ranked A′, bundle schema 2): role-to-title similarity
 * computed where it is cheap, at the daily bundle build, so the browser only
 * takes dot products. Browser-safe: pure, no Node import.
 *
 * The builder embeds, with one pinned model (`models/bge-small-en.ts`):
 * - each lexicon role's English label, as a query;
 * - each distinct English title key (`englishTitle`, else the title as
 *   written), as a passage.
 * The bundle ships both as int8 rows with one scale per row. A CV's active
 * lexicon roles are rows here, so ranking a vacancy is a best-of-roles dot
 * product against its title's row: no model download, nothing embedded on
 * the visitor's side, and no CV-derived value anywhere near a network.
 *
 * Measured through this code on the judged 34-CV suite (Claude-graded
 * labels), lexical matching fused with this list at weight 2 scored nDCG@10
 * .833 on the 32 English and Georgian CVs, against .763 for the
 * static-model hybrid it replaces on the main path. A role with no row here
 * (one the user typed that the lexicon does not know) still has the static
 * model to fall back on.
 */

export const TITLE_VECTORS_META_FILE = 'title-vectors.json';
export const TITLE_VECTORS_TABLE_FILE = 'title-vectors.int8';

/** How far down the role-similarity list counts, as in the judged runs. */
export const ROLE_LIST_LENGTH = 100;
/**
 * A row stays in the role-similarity list only while its cosine is at least
 * this share of the list's best, so a weakly similar title is not offered
 * as "similar to your role". Measured on the 34-CV suite: with no floor,
 * nDCG@10 .834 for the English and Georgian CVs, and the top 20s held 25
 * judged-irrelevant rows reached by similarity alone; 0.8 gives .833 and
 * 18; 0.85 and above start losing real matches (.822 at 0.85, .806 at 0.9).
 */
export const ROLE_RELATIVE_FLOOR = 0.8;
/**
 * And never below this cosine, so that when nothing in the index is close
 * to a role, nothing is called similar to it. Specific to the pinned model's
 * cosine scale (re-judge it with any new model): there, a role scores about
 * 0.9 against its own title and 0.40–0.53 against unrelated ones
 * ("software developer" against "cook" .40, "driver" .52). On the suite 0.6
 * changes no ranking; 0.65 already costs real matches (.833 → .824, mixed
 * CVs .918 → .827), since adjacent roles sit there ("software developer"
 * against "graphic designer" .63).
 */
export const ROLE_ABSOLUTE_FLOOR = 0.6;

export const titleVectorsMetaSchema = z.strictObject({
  schemaVersion: z.number().int(),
  bundleId: z.uuid(),
  /** The model pin's id; vectors are comparable only within one. */
  model: z.string().min(1),
  dims: z.number().int().positive(),
  /** Rows `0 … roles.length-1`: each lexicon role's id and the text embedded for it. */
  roles: z.array(z.strictObject({ id: z.string().min(1), text: z.string().min(1) })),
  /** The rows after the roles: each distinct title key, as embedded. */
  titles: z.array(z.string().min(1)),
  /** Per opportunity, in `opportunities.json` order: the index of its title in `titles`. */
  titleOf: z.array(z.number().int().nonnegative()),
  /** One dequantisation scale per row, roles then titles. */
  scales: z.array(z.number().positive()),
});
export type TitleVectorsMeta = z.infer<typeof titleVectorsMetaSchema>;

export interface TitleVectors {
  model: string;
  dims: number;
  /** Role id to its row. */
  roleRow: ReadonlyMap<string, number>;
  /** Row-major int8, roles then titles. */
  table: Int8Array;
  scales: Float32Array;
  /** Per opportunity position: the row of its title. */
  titleRow: Uint32Array;
}

export class TitleVectorsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TitleVectorsError';
  }
}

/**
 * Checks the two files against each other and against the opportunity
 * count, and builds the lookup the ranker uses. Every length, index and
 * scale is checked here, since change.md §8 asks for vector byte length,
 * dimension and finite values to be validated at every boundary.
 */
export function parseTitleVectors(
  meta: TitleVectorsMeta,
  table: Int8Array,
  opportunities: number,
): TitleVectors {
  const rows = meta.roles.length + meta.titles.length;
  if (table.length !== rows * meta.dims) throw new TitleVectorsError('table size');
  if (meta.scales.length !== rows) throw new TitleVectorsError('scale count');
  if (!meta.scales.every(Number.isFinite)) throw new TitleVectorsError('scale value');
  if (meta.titleOf.length !== opportunities) throw new TitleVectorsError('opportunity count');
  const titleRow = new Uint32Array(opportunities);
  for (let position = 0; position < opportunities; position++) {
    const title = meta.titleOf[position] ?? -1;
    if (title < 0 || title >= meta.titles.length) throw new TitleVectorsError('title index');
    titleRow[position] = meta.roles.length + title;
  }
  const roleRow = new Map<string, number>();
  meta.roles.forEach((role, row) => {
    if (roleRow.has(role.id)) throw new TitleVectorsError('duplicate role');
    roleRow.set(role.id, row);
  });
  return {
    model: meta.model,
    dims: meta.dims,
    roleRow,
    table,
    scales: Float32Array.from(meta.scales),
    titleRow,
  };
}

/**
 * Symmetric int8 per row: each row's largest magnitude maps to 127. With
 * unit vectors, the rounding error moves a cosine by well under 0.01.
 */
export function quantizeRows(rows: readonly (readonly number[])[]): {
  table: Int8Array;
  scales: number[];
} {
  const dims = rows[0]?.length ?? 0;
  const table = new Int8Array(rows.length * dims);
  const scales: number[] = [];
  rows.forEach((row, index) => {
    if (row.length !== dims) throw new TitleVectorsError('ragged rows');
    const largest = row.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
    if (!Number.isFinite(largest) || largest === 0) throw new TitleVectorsError('row value');
    const scale = largest / 127;
    scales.push(scale);
    for (let d = 0; d < dims; d++) {
      table[index * dims + d] = Math.max(-127, Math.min(127, Math.round((row[d] ?? 0) / scale)));
    }
  });
  return { table, scales };
}

function dot(vectors: TitleVectors, a: number, b: number): number {
  const { dims, table } = vectors;
  let sum = 0;
  for (let d = 0; d < dims; d++) sum += (table[a * dims + d] ?? 0) * (table[b * dims + d] ?? 0);
  return sum * (vectors.scales[a] ?? 0) * (vectors.scales[b] ?? 0);
}

export interface RoleHit {
  position: number;
  /** Cosine to the closest role. */
  score: number;
  roleId: string;
}

/**
 * Eligible rows by their title's best cosine to any of `roleIds` that has
 * a row, best first: those within `relativeFloor` of the best and above
 * `absoluteFloor`, at most `ROLE_LIST_LENGTH`.
 */
export function roleSimilarList(
  roleIds: readonly string[],
  vectors: TitleVectors,
  eligible: Uint8Array,
  relativeFloor = ROLE_RELATIVE_FLOOR,
  absoluteFloor = ROLE_ABSOLUTE_FLOOR,
): RoleHit[] {
  const roles = roleIds.flatMap((id) => {
    const row = vectors.roleRow.get(id);
    return row === undefined ? [] : [{ id, row }];
  });
  if (roles.length === 0) return [];
  // Many vacancies share a title key, so each title row is scored once.
  const best = new Map<number, { score: number; roleId: string }>();
  const hits: RoleHit[] = [];
  for (let position = 0; position < eligible.length; position++) {
    if (eligible[position] === 0) continue;
    const titleRow = vectors.titleRow[position];
    if (titleRow === undefined) continue;
    let found = best.get(titleRow);
    if (found === undefined) {
      found = { score: Number.NEGATIVE_INFINITY, roleId: '' };
      for (const role of roles) {
        const score = dot(vectors, role.row, titleRow);
        if (score > found.score) found = { score, roleId: role.id };
      }
      best.set(titleRow, found);
    }
    hits.push({ position, score: found.score, roleId: found.roleId });
  }
  hits.sort((a, b) => b.score - a.score || a.position - b.position);
  const floor = Math.max((hits[0]?.score ?? 0) * relativeFloor, absoluteFloor);
  return hits.filter((hit) => hit.score >= floor).slice(0, ROLE_LIST_LENGTH);
}
