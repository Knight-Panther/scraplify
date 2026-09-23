// Bundles worker.mjs (and its @huggingface/transformers import) into a
// single browser-ready worker.bundle.mjs. Needed because transformers.js's
// own dist/transformers.web.js has an internal bare-specifier import
// (onnxruntime-web/webgpu) that only resolves through a bundler or an import
// map -- serving it raw to an unbundled browser <script type="module">
// fails with "Failed to resolve module specifier" (found while building this
// harness). Uses esbuild's JS API, not its CLI, since shelling out to the
// .cmd wrapper breaks on this machine's spaced path. Re-run after any change
// to worker.mjs.
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const dir = new URL('.', import.meta.url);

await esbuild.build({
  entryPoints: [fileURLToPath(new URL('worker.mjs', dir))],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  outfile: fileURLToPath(new URL('worker.bundle.mjs', dir)),
});
console.log('worker.bundle.mjs written');
