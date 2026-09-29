import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { configureSelfHostedModels, embedWith } from '../embed.js';
import { BGE_SMALL_EN_PIN } from '../models/bge-small-en.js';
import type { TitleDictionary } from '../semantic/title-english.js';
import type { TitleEmbedder } from '../semantic/title-vectors-build.js';

/**
 * The pinned title-vector model, loaded from the vendored copy only
 * (`npm run matching:vendor-model`). Every file is re-hashed against the
 * pin before the model loads, so a truncated or swapped file is refused
 * rather than silently embedding with something else.
 */

export class TitleModelUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TitleModelUnavailable';
  }
}

/**
 * The reviewed title dictionary, read from the source tree: `tsc` does not
 * copy JSON into `dist/`, and this path resolves to the same file from
 * `src/matching/bundle/` and `dist/matching/bundle/` alike.
 */
export async function loadTitleDictionary(): Promise<TitleDictionary> {
  const url = new URL('../../../src/matching/semantic/title-dictionary.json', import.meta.url);
  return JSON.parse(await readFile(url, 'utf8')) as TitleDictionary;
}

/** `XTELO_MATCHING_MODEL_DIR`, else `.matching-models/` under the working directory. */
export function modelDirFromEnv(): string {
  return path.resolve(process.env.XTELO_MATCHING_MODEL_DIR ?? '.matching-models');
}

export async function verifyTitleModel(modelDir: string): Promise<void> {
  for (const [file, expected] of Object.entries(BGE_SMALL_EN_PIN.files)) {
    let bytes: Buffer;
    try {
      bytes = await readFile(path.join(modelDir, BGE_SMALL_EN_PIN.repo, file));
    } catch {
      throw new TitleModelUnavailable(`${file} is missing`);
    }
    if (bytes.byteLength !== expected.bytes) throw new TitleModelUnavailable(`${file} size`);
    if (createHash('sha256').update(bytes).digest('hex') !== expected.sha256) {
      throw new TitleModelUnavailable(`${file} checksum`);
    }
  }
}

export async function pinnedTitleEmbedder(modelDir: string): Promise<TitleEmbedder> {
  await verifyTitleModel(modelDir);
  configureSelfHostedModels(modelDir);
  return {
    model: BGE_SMALL_EN_PIN.id,
    dims: BGE_SMALL_EN_PIN.dims,
    embed: (texts, as) => embedWith(BGE_SMALL_EN_PIN, texts, BGE_SMALL_EN_PIN.inputPrefix[as]),
  };
}
