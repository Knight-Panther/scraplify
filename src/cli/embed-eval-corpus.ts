import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../db/client.js';
import { logger } from '../logger.js';
import { configureSelfHostedModels, embedPassages, embedQueries } from '../matching/embed.js';
import { MULTILINGUAL_E5_SMALL_PIN } from '../matching/models/multilingual-e5-small.js';
import { sampleOpportunityEmbeddingInputs } from '../matching/opportunity-embedding-input.js';
import { SYNTHETIC_PROFILES } from '../matching/eval/fixtures/synthetic-profiles.js';

/**
 * Phase 8A Stage 4: embeds the synthetic profiles (as E5 queries) and a real,
 * traceable sample of canonical opportunities (as E5 passages) with the
 * pinned model, self-hosted from .matching-models/ (no runtime download —
 * scripts/vendor-matching-model.mjs must have run first). Writes a fixed
 * "golden" JSON output that Stage 5's browser-Worker parity test embeds the
 * exact same inputs against and compares, numerically, to this file.
 *
 * Never logs profile or opportunity TEXT beyond what this CLI's own stdout
 * summary needs — the golden file itself is vectors and ids, not prose, and
 * ids here are already-public canonical opportunity ids, not candidate data.
 */

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const OUTPUT_PATH = join(repoRoot, 'src/matching/eval/fixtures/golden-vectors.node.json');
const OPPORTUNITY_SAMPLE_SIZE = 40;

async function main(): Promise<void> {
  configureSelfHostedModels(join(repoRoot, '.matching-models'));

  logger.info(
    { profiles: SYNTHETIC_PROFILES.length, model: MULTILINGUAL_E5_SMALL_PIN.repo },
    'embed-eval-corpus: embedding synthetic profiles',
  );
  const profileVectors = await embedQueries(SYNTHETIC_PROFILES.map((p) => p.text));

  const opportunities = await sampleOpportunityEmbeddingInputs(db, OPPORTUNITY_SAMPLE_SIZE);
  logger.info(
    { requested: OPPORTUNITY_SAMPLE_SIZE, found: opportunities.length },
    'embed-eval-corpus: embedding a real opportunity sample',
  );
  const opportunityVectors = await embedPassages(opportunities.map((o) => o.text));

  const golden = {
    model: {
      repo: MULTILINGUAL_E5_SMALL_PIN.repo,
      revision: MULTILINGUAL_E5_SMALL_PIN.revision,
      dtype: MULTILINGUAL_E5_SMALL_PIN.dtype,
    },
    generatedAt: new Date().toISOString(),
    profiles: SYNTHETIC_PROFILES.map((p, i) => ({
      id: p.id,
      language: p.language,
      text: p.text,
      vector: profileVectors[i],
    })),
    opportunities: opportunities.map((o, i) => ({
      opportunityId: o.opportunityId,
      text: o.text,
      vector: opportunityVectors[i],
    })),
  };

  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(golden, null, 2));
  logger.info({ path: OUTPUT_PATH }, 'embed-eval-corpus: wrote golden vectors');

  await db.$client.end();
}

main().catch((err) => {
  logger.error({ err }, 'embed-eval-corpus: failed');
  process.exitCode = 1;
});
