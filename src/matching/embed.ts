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

let embedderPromise: Promise<FeatureExtractionPipeline> | null = null;

/** Lazily loads the pinned model once per process (Singleton pattern, matching Transformers.js's own recommended usage). */
function loadEmbedder(): Promise<FeatureExtractionPipeline> {
  embedderPromise ??= pipeline('feature-extraction', MULTILINGUAL_E5_SMALL_PIN.repo, {
    revision: MULTILINGUAL_E5_SMALL_PIN.revision,
    dtype: MULTILINGUAL_E5_SMALL_PIN.dtype,
  });
  return embedderPromise;
}

async function embed(texts: readonly string[], prefix: string): Promise<number[][]> {
  const extractor = await loadEmbedder();
  const prefixed = texts.map((text) => `${prefix}${text}`);
  const output = await extractor(prefixed, {
    pooling: MULTILINGUAL_E5_SMALL_PIN.pooling,
    normalize: MULTILINGUAL_E5_SMALL_PIN.normalize,
  });
  return output.tolist() as number[][];
}

/** A CV/profile side of a comparison — the E5 "query: " role, per src/matching/models/multilingual-e5-small.ts. */
export function embedQueries(texts: readonly string[]): Promise<number[][]> {
  return embed(texts, MULTILINGUAL_E5_SMALL_PIN.inputPrefix.query);
}

/** A vacancy/opportunity side of a comparison — the E5 "passage: " role. */
export function embedPassages(texts: readonly string[]): Promise<number[][]> {
  return embed(texts, MULTILINGUAL_E5_SMALL_PIN.inputPrefix.passage);
}
