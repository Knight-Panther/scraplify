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
import { BundleRefusal, type LoadedBundle, loadBundle } from './bundle-client.js';
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
 * It holds the file only long enough to extract text, and the text only long
 * enough to derive the profile. It logs nothing: no `console` call anywhere
 * on this path, since a worker's console is still the page's console.
 */

declare const self: DedicatedWorkerGlobalScope;

let index: IndexedOpportunity[] | null = null;

function post(message: FromWorker): void {
  self.postMessage(message);
}

function rank(profile: MatchProfile, now: number, limit: number): RankingPayload {
  const result = rankOpportunities(profile, index ?? [], { now });
  return {
    version: result.version,
    results: result.results.slice(0, limit),
    total: result.results.length,
    stats: result.stats,
  };
}

async function process(file: File, now: number): Promise<void> {
  post({ type: 'progress', stage: 'reading' });
  // The public bundle downloads while the CV is read; neither waits on the
  // other. The no-op catch only stops a bundle failure from surfacing as an
  // unhandled rejection while the text is still being read — it is awaited,
  // and its error handled, below.
  const bundle: Promise<LoadedBundle> = loadBundle();
  bundle.catch(() => undefined);

  const extracted = await extractText(file);
  post({ type: 'progress', stage: 'bundle' });
  const loaded = await bundle;
  const vocabulary: Vocabulary = buildVocabulary(loaded.file.opportunities);
  index = indexOpportunities(loaded.file.opportunities);

  post({ type: 'progress', stage: 'ranking' });
  const profile = deriveProfile(extracted.text, vocabulary);
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
          post({ type: 'ranked', ranking: rank(message.profile, message.now, message.limit) }),
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
