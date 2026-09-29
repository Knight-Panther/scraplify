/// <reference lib="webworker" />
import {
  buildVocabulary,
  deriveProfile,
  type MatchProfile,
  type Vocabulary,
} from '../../../src/matching/lexical/profile.js';
import {
  type CvSource,
  cvLines,
  type HybridIndex,
  indexHybrid,
  needsStaticModel,
  rankHybrid,
  withStaticModel,
} from '../../../src/matching/semantic/hybrid.js';
import titleDictionary from '../../../src/matching/semantic/title-dictionary.json' with {
  type: 'json',
};
import type { TitleDictionary } from '../../../src/matching/semantic/title-english.js';
import type { TitleVectors } from '../../../src/matching/semantic/title-vectors.js';
import {
  BundleRefusal,
  type LoadedBundle,
  loadBundle,
  loadModel,
  type Meter,
  meters,
} from './bundle-client.js';
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

interface Ranker {
  index: HybridIndex;
  vectors: TitleVectors | null;
  cv: CvSource;
}

let ranker: Ranker | null = null;
/**
 * The static model, fetched at most once and only when a profile needs it
 * (`needsStaticModel`). Null inside the promise when it could not be loaded
 * or verified: ranking then goes on without it and says so.
 */
let staticModel: Promise<HybridIndex['static']> | null = null;

function post(message: FromWorker): void {
  self.postMessage(message);
}

/** Loads the static model into the ranker's index if this profile needs it and it is not there yet. */
async function prepare(profile: MatchProfile, meter?: Meter): Promise<void> {
  const current = ranker;
  if (current === null || current.index.static !== null) return;
  if (!needsStaticModel(profile, current.cv, current.vectors)) return;
  staticModel ??= loadModel(meter).then((model) =>
    model === null ? null : withStaticModel(current.index, model, DICTIONARY).static,
  );
  const loaded = await staticModel;
  if (loaded !== null && ranker === current) {
    ranker = { ...current, index: { ...current.index, static: loaded } };
  }
}

function rank(profile: MatchProfile, now: number, limit: number): RankingPayload {
  const result = ranker
    ? rankHybrid(
        profile,
        ranker.cv,
        ranker.index,
        { dictionary: DICTIONARY, vectors: ranker.vectors },
        { now },
      )
    : null;
  return {
    version: result?.version ?? '',
    similarity: result?.similarity ?? 'none',
    results: result?.results.slice(0, limit) ?? [],
    total: result?.results.length ?? 0,
    stats: result?.stats ?? { considered: 0, excludedDeadline: 0, excludedLocation: 0, matched: 0 },
  };
}

async function process(file: File, now: number): Promise<void> {
  post({ type: 'progress', stage: 'reading' });
  // The public bundle downloads while the CV is read. The no-op catch only
  // stops a bundle failure from surfacing as an unhandled rejection while
  // the text is still being read — it is awaited, and its error handled,
  // below.
  const meter = meters((received, total) => post({ type: 'download', received, total }));
  const bundle: Promise<LoadedBundle> = loadBundle(meter.bundle);
  bundle.catch(() => undefined);

  const extracted = await extractText(file);
  post({ type: 'progress', stage: 'bundle' });
  const loaded = await bundle;
  const rows = loaded.file.opportunities;
  const vocabulary: Vocabulary = buildVocabulary(rows);
  const profile = deriveProfile(extracted.text, vocabulary);
  ranker = {
    index: indexHybrid(rows),
    vectors: loaded.vectors,
    cv: { lines: cvLines(extracted.text), derived: profile.terms },
  };
  // Most CVs name a role the bundle has vectors for and never fetch the
  // static model; the rest fetch it now, still under the download stage.
  await prepare(profile, meter.model);

  post({ type: 'progress', stage: 'ranking' });
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
      : // An edit can add a role only the static model can compare, so it
        // may fetch that model first; the page shows the re-rank as pending.
        prepare(message.profile).then(() =>
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
