/**
 * Phase 8A candidate embedding model pin (docs/STATUS.md, "Phase 8A — private
 * matching feasibility"). Checked live against Hugging Face on 2026-09-23, not
 * assumed: MIT license (`intfloat/multilingual-e5-small`'s own model card),
 * Georgian (`ka`) explicitly listed among trained languages, `hidden_size: 384`,
 * `max_position_embeddings: 512` (both from that model's `config.json`).
 *
 * The ONNX port used here (`Xenova/multilingual-e5-small`) is a separate HF
 * repo — the standard Transformers.js community-conversion pattern — pinned by
 * its own commit `sha`, not "main", so a later re-conversion upstream cannot
 * silently change what this app embeds against.
 *
 * Three `dtype` variants were downloaded and measured (2026-09-23, this
 * machine): fp32 470,268,533 bytes, int8 (`q8`) 118,308,185 bytes, q4
 * 398,649,233 bytes — q4 is LARGER than int8 for this model, not smaller, most
 * likely because its ~250k-token multilingual vocabulary's embedding table
 * dominates total size and does not shrink the same way under 4-bit blockwise
 * packing as it does under plain int8; recorded as measured, not theorized
 * further. int8 is the smallest variant found and is what SHA256_ONNX_Q8
 * below pins. All three are still far over change.md §14's 25MB-compressed
 * reassessment threshold — this is the central open question this phase's
 * later stages (browser load-time/memory measurement) still need to answer
 * with real numbers before Phase 8A can conclude either way.
 */

export const MULTILINGUAL_E5_SMALL_PIN = {
  /** The ONNX port actually loaded by @huggingface/transformers. */
  repo: 'Xenova/multilingual-e5-small',
  /** Pinned commit of that repo (HF API `sha` field), not "main". */
  revision: '761b726dd34fb83930e26aab4e9ac3899aa1fa78',
  /** The original weights this port converts; license/language facts below are its. */
  upstreamRepo: 'intfloat/multilingual-e5-small',
  license: 'MIT',
  hiddenSize: 384,
  maxPositionEmbeddings: 512,
  /**
   * E5 family convention (mean pooling over non-padding tokens, L2-normalized,
   * "query: " / "passage: " input prefixes) — standard across every e5 /
   * multilingual-e5 release, not yet independently re-derived from this
   * repo's own tokenizer/config. Confirm before treating as settled.
   */
  inputPrefix: { query: 'query: ', passage: 'passage: ' } as const,
  pooling: 'mean',
  normalize: true,
  dtype: 'q8' as const,
  files: {
    'config.json': {
      sha256: 'cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1',
      bytes: 658,
    },
    'tokenizer_config.json': {
      sha256: 'a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b',
      bytes: 443,
    },
    'tokenizer.json': {
      sha256: '0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39',
      bytes: 17_082_730,
    },
    'onnx/model_quantized.onnx': {
      sha256: 'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193',
      bytes: 118_308_185,
    },
  },
} as const;
