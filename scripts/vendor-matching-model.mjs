// Phase 8A: copies the Transformers.js download cache for the pinned
// matching model into .matching-models/ (gitignored — see .gitignore), then
// re-hashes every copied file and compares it against
// src/matching/models/multilingual-e5-small.ts's recorded SHA-256s. Run once
// per machine after `npm install` has triggered the first download (e.g. via
// running the eval corpus embedding CLI once with remote downloads allowed);
// everything after that loads from this local, self-hosted copy with
// `env.allowRemoteModels = false`, proving Phase 8A's own "no runtime
// download" requirement rather than assuming it.
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MULTILINGUAL_E5_SMALL_PIN } from '../dist/matching/models/multilingual-e5-small.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const sourceDir = join(
  repoRoot,
  'node_modules/@huggingface/transformers/.cache',
  MULTILINGUAL_E5_SMALL_PIN.repo,
);
const destDir = join(repoRoot, '.matching-models', MULTILINGUAL_E5_SMALL_PIN.repo);

async function sha256(path) {
  const buf = await readFile(path);
  return createHash('sha256').update(buf).digest('hex');
}

let mismatches = 0;
for (const [relPath, expected] of Object.entries(MULTILINGUAL_E5_SMALL_PIN.files)) {
  const from = join(sourceDir, relPath);
  const to = join(destDir, relPath);
  await mkdir(dirname(to), { recursive: true });
  await copyFile(from, to);
  const actualHash = await sha256(to);
  const ok = actualHash === expected.sha256;
  if (!ok) mismatches += 1;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${relPath} (${actualHash})`);
}

if (mismatches > 0) {
  console.error(`${mismatches} file(s) did not match the pinned hash. Re-download and retry.`);
  process.exitCode = 1;
} else {
  console.log(`All files verified against the pin. Self-hosted copy at: ${destDir}`);
}
