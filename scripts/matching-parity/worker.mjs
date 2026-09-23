// Phase 8A Stage 5/6 parity + isolation harness worker. Mirrors
// src/matching/embed.ts and src/matching/models/multilingual-e5-small.ts's
// pin — duplicated here in plain JS (not imported) because this file is
// served directly to a browser Worker, unbundled, and is a throwaway local
// harness rather than shipped product code.
// Bundled by esbuild (scripts/vendor-matching-model.mjs's sibling build step)
// so that transformers.js's own bare-specifier internal imports (e.g.
// onnxruntime-web/webgpu) resolve at build time -- serving its dist file raw
// to an unbundled browser module fails on exactly that import.
import { env, pipeline } from '@huggingface/transformers';

const PIN = {
  repo: 'Xenova/multilingual-e5-small',
  revision: '761b726dd34fb83930e26aab4e9ac3899aa1fa78',
  dtype: 'q8',
  pooling: 'mean',
  normalize: true,
};

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = '/models/';
env.backends.onnx.wasm.wasmPaths = {
  mjs: '/vendor/ort/ort-wasm-simd-threaded.asyncify.mjs',
  wasm: '/vendor/ort/ort-wasm-simd-threaded.asyncify.wasm',
};
// No COOP/COEP headers on this throwaway static server, so no
// SharedArrayBuffer/cross-origin isolation - single-threaded WASM only.
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.proxy = false;

let embedderPromise = null;
function loadEmbedder() {
  embedderPromise ??= pipeline('feature-extraction', PIN.repo, {
    revision: PIN.revision,
    dtype: PIN.dtype,
  });
  return embedderPromise;
}

self.addEventListener('message', async (event) => {
  const { texts, prefix } = event.data;
  try {
    const loadStart = performance.now();
    const extractor = await loadEmbedder();
    const loadMs = performance.now() - loadStart;

    const embedStart = performance.now();
    const prefixed = texts.map((t) => `${prefix}${t}`);
    const output = await extractor(prefixed, { pooling: PIN.pooling, normalize: PIN.normalize });
    const embedMs = performance.now() - embedStart;

    self.postMessage({
      status: 'done',
      vectors: output.tolist(),
      timings: { loadMs, embedMs },
    });
  } catch (err) {
    self.postMessage({ status: 'error', message: String(err?.stack ?? err) });
  }
});
