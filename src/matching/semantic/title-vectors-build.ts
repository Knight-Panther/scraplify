import type { BundleOpportunity } from '../bundle/schema.js';
import { LEXICON } from '../lexical/lexicon.js';
import { buildVocabulary, derivableTitleRoles } from '../lexical/profile.js';
import { englishTitle, type TitleDictionary } from './title-english.js';
import { quantizeRows, TitleVectorsError, type TitleVectorsMeta } from './title-vectors.js';

/**
 * The builder's half of title vectors (`title-vectors.ts`): what is
 * embedded and in which order. The model itself is injected, so this stays
 * pure and testable; `bundle/title-embedder.ts` supplies the pinned one.
 */

export interface TitleEmbedder {
  /** The model pin's id, recorded in the files and the manifest. */
  model: string;
  dims: number;
  /** Unit vectors, one per text. Queries and passages take different prefixes. */
  embed(texts: readonly string[], as: 'query' | 'passage'): Promise<number[][]>;
}

/**
 * What a vacancy is embedded as: its English key, else the title as
 * written. Lowercased and space-collapsed, which changes no vector (the
 * pinned tokenizer lowercases anyway) but merges keys that differ only in
 * case, so each distinct title is embedded and shipped once.
 */
export function titleKey(title: string, dictionary: TitleDictionary): string {
  const key = englishTitle(title, dictionary).text || title.normalize('NFKC');
  return key.replace(/\s+/gu, ' ').trim().toLowerCase();
}

/** Every lexicon role, by the id a profile gives it, with its English label. */
export function lexiconRoles(): { id: string; text: string }[] {
  return LEXICON.filter((entry) => entry.kind === 'role').map((entry) => ({
    id: `${entry.kind}:${entry.key}`,
    text: entry.en,
  }));
}

/**
 * Every corpus title a CV can yield as a role (`derivableTitleRoles`), by
 * the id a profile gives it, with its English key. The browser derives the
 * same list from the same rows, so the ids agree. A title whose words the
 * dictionary does not know is left out: this English model would embed its
 * Georgian as noise, so such a role keeps the fallback path it has today.
 */
export function titleRoles(
  rows: readonly BundleOpportunity[],
  dictionary: TitleDictionary,
): { id: string; text: string }[] {
  return derivableTitleRoles(buildVocabulary(rows)).flatMap((role) => {
    const english = englishTitle(role.label, dictionary);
    if (english.text === '' || english.unknown.length > 0) return [];
    return [{ id: `role:title:${role.key}`, text: titleKey(role.label, dictionary) }];
  });
}

export async function buildTitleVectors(
  rows: readonly BundleOpportunity[],
  dictionary: TitleDictionary,
  embedder: TitleEmbedder,
  ids: { schemaVersion: number; bundleId: string },
): Promise<{ meta: TitleVectorsMeta; table: Int8Array }> {
  const roles = [...lexiconRoles(), ...titleRoles(rows, dictionary)];
  const titles: string[] = [];
  const indexOf = new Map<string, number>();
  const titleOf = rows.map((row) => {
    const key = titleKey(row.title, dictionary);
    let index = indexOf.get(key);
    if (index === undefined) {
      index = titles.length;
      titles.push(key);
      indexOf.set(key, index);
    }
    return index;
  });

  const vectors = [
    ...(await embedder.embed(
      roles.map((role) => role.text),
      'query',
    )),
    ...(await embedder.embed(titles, 'passage')),
  ];
  if (vectors.length !== roles.length + titles.length) {
    throw new TitleVectorsError('embedder returned the wrong number of rows');
  }
  if (vectors.some((vector) => vector.length !== embedder.dims)) {
    throw new TitleVectorsError('embedder returned the wrong dimension');
  }
  const { table, scales } = quantizeRows(vectors);
  return {
    meta: {
      schemaVersion: ids.schemaVersion,
      bundleId: ids.bundleId,
      model: embedder.model,
      dims: embedder.dims,
      roles,
      titles,
      titleOf,
      scales,
    },
    table,
  };
}
