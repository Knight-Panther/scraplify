import { readFile } from 'node:fs/promises';
import { z } from 'zod';

/**
 * English names and aliases for ss.ge's own places, and the owner's
 * neighbourhoods ss.ge does not have (Phase 14B, `curated.json`, reviewed by
 * the owner). Lookups by Latin spelling need none of this: folding
 * (src/realestate/place-lookup.ts) already joins "Temka" and თემქა. It is for
 * names people use that no spelling of the Georgian gives ("Old Tbilisi",
 * "Turtle Lake"), and for groups ("Dighomi", four of ss.ge's areas).
 */

const curatedSchema = z.object({
  places: z.array(
    z.object({
      level: z.enum(['city', 'district', 'subdistrict']),
      /** ss.ge's id. */
      ref: z.number().int().positive(),
      /** ss.ge's name, as a check that the id still means this place. */
      nameKa: z.string().min(1),
      nameEn: z.string().min(1),
      aliases: z.array(z.string().min(1)).optional(),
    }),
  ),
  neighbourhoods: z.array(
    z.object({
      /** Ours. */
      ref: z.number().int().positive(),
      code: z.string().min(1),
      nameKa: z.string().min(1),
      nameEn: z.string().min(1),
      /** The ss.ge place its listings are under. */
      parentLevel: z.enum(['city', 'district', 'subdistrict']),
      parentRef: z.number().int().positive(),
      note: z.string().min(1),
    }),
  ),
});

export type CuratedPlaces = z.infer<typeof curatedSchema>;

/** Read from the source tree, like `loadOfficialMap`. */
export async function loadCuratedPlaces(): Promise<CuratedPlaces> {
  const url = new URL('../../../src/realestate/places/curated.json', import.meta.url);
  return curatedSchema.parse(JSON.parse(await readFile(url, 'utf8')));
}
