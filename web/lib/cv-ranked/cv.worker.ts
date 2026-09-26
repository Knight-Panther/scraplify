/// <reference lib="webworker" />
import {
  buildVocabulary,
  deriveProfile,
  type MatchProfile,
  type Vocabulary,
} from '../../../src/matching/lexical/profile.js';
import {
  type IndexedOpportunity,
  indexOpportunities,
  rankOpportunities,
} from '../../../src/matching/lexical/rank.js';
import {
  type CvSource,
  cvLines,
  type HybridIndex,
  indexHybrid,
  rankHybrid,
} from '../../../src/matching/semantic/hybrid.js';
import type { StaticModel } from '../../../src/matching/semantic/static-embed.js';
import titleDictionary from '../../../src/matching/semantic/title-dictionary.json' with {
  type: 'json',
};
import type { TitleDictionary } from '../../../src/matching/semantic/title-english.js';
import { BundleRefusal, type LoadedBundle, loadBundle, loadModel } from './bundle-client.js';
import { CvError } from './document-checks.js';
import { extractText } from './extract-text.js';
import {
  type FromWorker,
  INITIAL_RESULT_LIMIT,
  type RankingPayload,
  type ToWorker,
} from './protocol.js';

/**
 * The CV Ranked worker (Phase 8D). Created only when a visitor chooses a CV
 * and terminated on cancel, replacement, timeout, clear and leaving the page
 * (`session.tsx`), so every CV-derived value in here dies with it.
 *
 * It holds the file only long enough to extract text. From the text it
 * keeps the derived profile and the CV's short lines (`cvLines`), which
 * title similarity ranks against on every edit, and nothing else. It logs
 * nothing: no `console` call anywhere on this path, since a worker's
 * console is still the page's console.
 */

declare const self: DedicatedWorkerGlobalScope;

const DICTIONARY = titleDictionary as TitleDictionary;

type Ranker =
  | { kind: 'lexical'; index: IndexedOpportunity[] }
  | { kind: 'hybrid'; index: HybridIndex; model: StaticModel; cv: CvSource };

let ranker: Ranker | null = null;

function post(message: FromWorker): void {
  self.postMessage(message);
}

function rank(profile: MatchProfile, now: number, limit: number): RankingPayload {
  const result =
    ranker?.kind === 'hybrid'
      ? rankHybrid(profile, ranker.cv, ranker.index, ranker.model, DICTIONARY, { now })
      : rankOpportunities(profile, ranker?.index ?? [], { now });
  return {
    version: result.version,
    similarity: ranker?.kind === 'hybrid',
    results: result.results.slice(0, limit),
    total: result.results.length,
    stats: result.stats,
  };
}

async function process(file: File, now: number): Promise<void> {
  post({ type: 'progress', stage: 'reading' });
  // The public bundle and the model download while the CV is read; nothing
  // waits on anything else. The no-op catch only stops a bundle failure
  // from surfacing as an unhandled rejection while the text is still being
  // read — it is awaited, and its error handled, below. `loadModel` never
  // rejects: without a model, ranking falls back to words alone.
  const bundle: Promise<LoadedBundle> = loadBundle();
  bundle.catch(() => undefined);
  const model = loadModel();

  const extracted = await extractText(file);
  post({ type: 'progress', stage: 'bundle' });
  const loaded = await bundle;
  const rows = loaded.file.opportunities;
  const vocabulary: Vocabulary = buildVocabulary(rows);
  const loadedModel = await model;

  post({ type: 'progress', stage: 'ranking' });
  const profile = deriveProfile(extracted.text, vocabulary);
  ranker =
    loadedModel === null
      ? { kind: 'lexical', index: indexOpportunities(rows) }
      : {
          kind: 'hybrid',
          index: indexHybrid(rows, loadedModel, DICTIONARY),
          model: loadedModel,
          cv: { lines: cvLines(extracted.text), derived: profile.terms },
        };
  post({
    type: 'ready',
    document: extracted.summary,
    bundle: loaded.summary,
    profile,
    vocabulary,
    ranking: rank(profile, now, INITIAL_RESULT_LIMIT),
  });
}

self.addEventListener('message', (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  const run =
    message.type === 'process'
      ? process(message.file, message.now)
      : Promise.resolve().then(() =>
          post({
            type: 'ranked',
            id: message.id,
            ranking: rank(message.profile, message.now, message.limit),
          }),
        );
  run.catch((error: unknown) => {
    if (error instanceof BundleRefusal) {
      post({
        type: 'error',
        code: error.code,
        ...(error.summary ? { bundle: error.summary } : {}),
      });
    } else {
      post({ type: 'error', code: error instanceof CvError ? error.code : 'internal' });
    }
  });
});
