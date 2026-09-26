/**
 * The browser CV-matching model pin (spike/semantic "E1", decided
 * 2026-09-26 in docs/STATUS.md): a static, Model2Vec-style embedding table.
 * Judged on the 32-CV synthetic suite plus the owner's CV, lexical + E1
 * raised nDCG@10 from .709 to .788.
 *
 * Provenance, so the files can be rebuilt rather than trusted:
 * 1. `intfloat/multilingual-e5-small` (MIT) distilled with Model2Vec (MIT)
 *    to a 256-dimension static table (PCA 256, SIF 1e-4, float16).
 * 2. Rows restricted to the 34,763 e5 tokenizer pieces that Georgian and
 *    English vacancy titles and CVs use, kept in e5's own id order, so row
 *    `i` of the table is piece `i` of `model.json`.
 * 3. Quantised to int8 with one dequantisation scale per dimension.
 *
 * `model.json` holds the pieces (with the Unigram scores from e5's own
 * `tokenizer.json`), the unknown-piece id and the scales; `table.int8` is
 * the row-major table. Both are committed under `matching-models/` and
 * served by `/api/matching/models/<id>/<file>`, which re-checks these
 * checksums before sending a byte; the browser checks them again.
 */
export const STATIC_E1_PIN = {
  id: 'static-e1-v1',
  upstreamRepo: 'intfloat/multilingual-e5-small',
  license: 'MIT',
  dims: 256,
  rows: 34_763,
  files: {
    'model.json': {
      sha256: 'ad1875d457e84fd084197c759f75a176a1a02211d5a5aa079fa519be200c00ca',
      bytes: 1_127_237,
    },
    'table.int8': {
      sha256: 'ea01767c9b22775aef28a78caaa769db0077249fcd03fa342ac8d26007c7cc8f',
      bytes: 8_899_328,
    },
  },
} as const;

export type StaticModelFile = keyof typeof STATIC_E1_PIN.files;
