import { env, pipeline } from '@huggingface/transformers';
import { MULTILINGUAL_E5_SMALL_PIN } from './models/multilingual-e5-small.js';

/**
 * Points Transformers.js at the self-hosted copy vendored by
 * scripts/vendor-matching-model.mjs (.matching-models/, gitignored) and
 * forbids any runtime download from the Hugging Face Hub — change.md §7's
 * "self-host all model/tokenizer/WASM assets, disable remote model
 * downloads" applied to the Node side of this phase, not just the browser.
 * Call once before the first `loadEmbedder()`.
 */
export function configureSelfHostedModels(localModelPath: string): void {
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = localModelPath.endsWith('/') ? localModelPath : `${localModelPath}/`;
}

type FeatureExtractionPipeline = Awaited<ReturnType<typeof pipeline<'feature-extraction'>>>;

/** What loading and running a pinned model needs; both model pins satisfy it. */
export interface EmbeddingPin {
  repo: string;
  revision: string;
  dtype: 'q8' | 'fp32';
  pooling: 'mean' | 'cls';
  normalize: boolean;
}

const embedders = new Map<string, Promise<FeatureExtractionPipeline>>();

/** Lazily loads a pinned model once per process (Singleton pattern, matching Transformers.js's own recommended usage). */
function loadEmbedder(pin: EmbeddingPin): Promise<FeatureExtractionPipeline> {
  let loading = embedders.get(pin.repo);
  if (loading === undefined) {
    loading = pipeline('feature-extraction', pin.repo, {
      revision: pin.revision,
      dtype: pin.dtype,
    });
    embedders.set(pin.repo, loading);
  }
  return loading;
}

/** Embeds `texts` with `prefix` prepended, `batchSize` at a time, one row per text. */
export async function embedWith(
  pin: EmbeddingPin,
  texts: readonly string[],
  prefix: string,
  batchSize = 64,
): Promise<number[][]> {
  const extractor = await loadEmbedder(pin);
  const rows: number[][] = [];
  for (let start = 0; start < texts.length; start += batchSize) {
    const batch = texts.slice(start, start + batchSize).map((text) => `${prefix}${text}`);
    const output = await extractor(batch, { pooling: pin.pooling, normalize: pin.normalize });
    rows.push(...(output.tolist() as number[][]));
  }
  return rows;
}

function embed(texts: readonly string[], prefix: string): Promise<number[][]> {
  return embedWith(MULTILINGUAL_E5_SMALL_PIN, texts, prefix, texts.length || 1);
}

/** A CV/profile side of a comparison — the E5 "query: " role, per src/matching/models/multilingual-e5-small.ts. */
export function embedQueries(texts: readonly string[]): Promise<number[][]> {
  return embed(texts, MULTILINGUAL_E5_SMALL_PIN.inputPrefix.query);
}

/** A vacancy/opportunity side of a comparison — the E5 "passage: " role. */
export function embedPassages(texts: readonly string[]): Promise<number[][]> {
  return embed(texts, MULTILINGUAL_E5_SMALL_PIN.inputPrefix.passage);
}
