// Vendors a pinned matching model into XTELO_MATCHING_MODEL_DIR (default
// .matching-models/, gitignored): downloads exactly the pinned revision's
// files from Hugging Face, checks every file against the SHA-256 and size
// recorded in src/matching/models/, and only then moves it into place.
// Everything after that loads from this local copy with
// `env.allowRemoteModels = false`, so no run ever downloads a model.
//
//   npm run matching:vendor-model          the title-vector model (bge-small-en), which the bundle builder needs
//   npm run matching:vendor-model -- e5    the Phase 8A multilingual-e5-small candidate (evaluation only)
//
// Idempotent: a file already present with the right hash is left alone.
// Needs `npm run build` first (it reads the pins from dist/).
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { BGE_SMALL_EN_PIN } from '../dist/matching/models/bge-small-en.js';
import { MULTILINGUAL_E5_SMALL_PIN } from '../dist/matching/models/multilingual-e5-small.js';

const PINS = { bge: BGE_SMALL_EN_PIN, e5: MULTILINGUAL_E5_SMALL_PIN };
const which = process.argv[2] ?? 'bge';
const pin = PINS[which];
if (pin === undefined) {
  console.error(`unknown model "${which}"; expected one of: ${Object.keys(PINS).join(', ')}`);
  process.exit(1);
}

const root = resolve(process.env.XTELO_MATCHING_MODEL_DIR ?? '.matching-models');
const destDir = join(root, pin.repo);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

let failures = 0;
for (const [relPath, expected] of Object.entries(pin.files)) {
  const target = join(destDir, relPath);
  const existing = await readFile(target).catch(() => null);
  if (
    existing !== null &&
    existing.byteLength === expected.bytes &&
    sha256(existing) === expected.sha256
  ) {
    console.log(`OK   ${relPath} (already vendored)`);
    continue;
  }
  const url = `https://huggingface.co/${pin.repo}/resolve/${pin.revision}/${relPath}`;
  const response = await fetch(url);
  if (!response.ok) {
    console.error(`FAIL ${relPath}: HTTP ${response.status}`);
    failures += 1;
    continue;
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const actual = sha256(bytes);
  if (bytes.byteLength !== expected.bytes || actual !== expected.sha256) {
    console.error(
      `FAIL ${relPath}: got ${bytes.byteLength} bytes, ${actual}; the pin says ${expected.sha256}`,
    );
    failures += 1;
    continue;
  }
  await mkdir(dirname(target), { recursive: true });
  const staging = `${target}.tmp-${process.pid}`;
  await writeFile(staging, bytes);
  await rm(target, { force: true });
  await rename(staging, target);
  console.log(`OK   ${relPath} (downloaded, ${bytes.byteLength} bytes)`);
}

if (failures > 0) {
  console.error(
    `${failures} file(s) failed. Nothing wrong was kept; fix the cause and run it again.`,
  );
  process.exitCode = 1;
} else {
  console.log(`${pin.repo}@${pin.revision.slice(0, 12)} verified in ${destDir}`);
}
