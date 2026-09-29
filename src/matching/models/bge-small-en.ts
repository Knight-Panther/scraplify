/**
 * The title-vector model pin (CV Ranked A′, decided 2026-09-29 in the
 * "CV Matching Model Options" study). It runs ONLY in the scheduled bundle
 * builder, in Node: it embeds each lexicon role's English label and each
 * vacancy's English title key, and the bundle ships the resulting vectors.
 * The browser never downloads or runs it; it only takes dot products.
 *
 * Checked live against Hugging Face on 2026-09-29, not assumed:
 * - `BAAI/bge-small-en-v1.5` is MIT (its model card's `license: mit`).
 * - `Xenova/bge-small-en-v1.5` is its Transformers.js ONNX conversion
 *   (`base_model: BAAI/bge-small-en-v1.5`), pinned by commit `sha`, not
 *   "main", so a later re-conversion cannot silently change the vectors.
 * - bge's own conventions: CLS pooling, L2 normalisation, and an
 *   instruction prefix on queries (here the role labels) but none on
 *   passages (here the vacancy titles).
 *
 * The files are vendored into `.matching-models/` (or
 * `XTELO_MATCHING_MODEL_DIR`) by `npm run matching:vendor-model`, which
 * downloads exactly these revisions and refuses any file whose SHA-256
 * differs. The builder then loads them with remote downloads disabled.
 */
export const BGE_SMALL_EN_PIN = {
  /** What the bundle manifest and the rank version name. */
  id: 'bge-small-en-v1.5-q8',
  repo: 'Xenova/bge-small-en-v1.5',
  revision: 'ea104dacec62c0de699686887e3f920caeb4f3e3',
  upstreamRepo: 'BAAI/bge-small-en-v1.5',
  upstreamRevision: '5c38ec7c405ec4b44b94cc5a9bb96e735b38267a',
  license: 'MIT',
  dims: 384,
  pooling: 'cls',
  normalize: true,
  dtype: 'q8',
  inputPrefix: {
    query: 'Represent this sentence for searching relevant passages: ',
    passage: '',
  },
  files: {
    'config.json': {
      sha256: 'fa73f90bf92c8cace1fbcb709626306f2bdbc9ea3e5b5f94b440df9b6aa56350',
      bytes: 683,
    },
    'tokenizer.json': {
      sha256: 'd241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66',
      bytes: 711_396,
    },
    'tokenizer_config.json': {
      sha256: '9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3',
      bytes: 366,
    },
    'onnx/model_quantized.onnx': {
      sha256: '6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4',
      bytes: 34_014_426,
    },
  },
} as const;
