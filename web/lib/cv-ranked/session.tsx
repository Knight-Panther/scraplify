'use client';

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { MatchProfile, Vocabulary } from '../../../src/matching/lexical/profile.js';
import { type CvErrorCode, LIMITS } from './document-checks.js';
import {
  type BundleSummary,
  type DocumentSummary,
  type DownloadProgress,
  type FromWorker,
  INITIAL_RESULT_LIMIT,
  type RankingPayload,
  type Stage,
  type ToWorker,
} from './protocol.js';
import { type Watchdog, watchdog } from './watchdog.js';

/**
 * The CV Ranked session (Phase 8D, change.md §6/§7): one worker and its
 * results, held in React state and nowhere else. Nothing here touches
 * storage, cookies, the URL or the server, so a refresh or a full page load
 * ends the session by construction — `/cv-ranked` then shows its chooser.
 *
 * Mounted in the root layout so the landing chooser can start processing
 * and client-navigate to `/cv-ranked` with the worker still running. The
 * worker is created only in `start`, so a visit that never chooses a CV
 * downloads none of it.
 */

export type CvSessionState =
  | { status: 'idle' }
  | { status: 'processing'; stage: Stage; download: DownloadProgress | null }
  | {
      status: 'ready';
      document: DocumentSummary;
      bundle: BundleSummary;
      profile: MatchProfile;
      vocabulary: Vocabulary;
      ranking: RankingPayload;
      /** How many results were asked for; "show more" raises it. */
      limit: number;
      /** A re-rank for the current profile is in flight. */
      reranking: boolean;
    }
  | { status: 'error'; code: CvErrorCode; bundle?: BundleSummary };

interface CvSession {
  state: CvSessionState;
  /** Terminates any current worker, then processes `file` in a new one. */
  start(file: File): void;
  /** Terminates the worker and forgets everything: cancel, change CV and clear all use this. */
  reset(): void;
  /** Re-ranks against an edited profile. */
  setProfile(profile: MatchProfile): void;
  showMore(): void;
}

const CvSessionContext = createContext<CvSession | null>(null);

export function useCvSession(): CvSession {
  const session = useContext(CvSessionContext);
  if (session === null) throw new Error('useCvSession outside CvSessionProvider');
  return session;
}

export function CvSessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<CvSessionState>({ status: 'idle' });
  const worker = useRef<Worker | null>(null);
  const guard = useRef<Watchdog | null>(null);
  const rankId = useRef(0);

  const stop = useCallback(() => {
    guard.current?.stop();
    guard.current = null;
    worker.current?.terminate();
    worker.current = null;
  }, []);

  const fail = useCallback(
    (code: CvErrorCode, bundle?: BundleSummary) => {
      stop();
      setState(bundle ? { status: 'error', code, bundle } : { status: 'error', code });
    },
    [stop],
  );

  const send = useCallback((message: ToWorker) => worker.current?.postMessage(message), []);

  const start = useCallback(
    (file: File) => {
      stop();
      const created = new Worker(new URL('./cv.worker.ts', import.meta.url), {
        type: 'module',
        name: 'cv-ranked',
      });
      worker.current = created;
      rankId.current = 0;
      let stage: Stage = 'reading';
      let download: DownloadProgress | null = null;
      setState({ status: 'processing', stage, download });

      // Each stage has its own limit; none of them times the whole job,
      // because a first visit's downloads take a phone on a slow connection
      // a minute or more, and that is not a slow file.
      // - Reading and ranking get LIMITS.timeoutMs each. A hostile file
      //   that hangs a parser is stopped by terminating the whole thread.
      // - Downloads start alongside reading; once 'bundle' begins they are
      //   all that is left. The worker abandons a download after downloadStallMs of
      //   silence; this backstop fires only if the worker goes quiet for
      //   twice that.
      const expire = (code: CvErrorCode) => () => {
        if (worker.current === created) fail(code);
      };
      const arm = () => {
        guard.current?.stop();
        guard.current =
          stage === 'bundle'
            ? watchdog(2 * LIMITS.downloadStallMs, expire('network'))
            : watchdog(LIMITS.timeoutMs, expire('timeout'));
      };
      arm();

      created.addEventListener('message', (event: MessageEvent<FromWorker>) => {
        if (worker.current !== created) return;
        const message = event.data;
        switch (message.type) {
          case 'progress':
            stage = message.stage;
            arm();
            setState({ status: 'processing', stage, download });
            return;
          case 'download':
            // Only the download backstop counts from the last byte; the
            // reading limit keeps running while bytes arrive.
            if (stage === 'bundle') guard.current?.reset();
            download = { received: message.received, total: message.total };
            setState((current) =>
              current.status === 'processing' ? { status: 'processing', stage, download } : current,
            );
            return;
          case 'ready':
            guard.current?.stop();
            guard.current = null;
            setState({
              status: 'ready',
              document: message.document,
              bundle: message.bundle,
              profile: message.profile,
              vocabulary: message.vocabulary,
              ranking: message.ranking,
              limit: INITIAL_RESULT_LIMIT,
              reranking: false,
            });
            return;
          case 'ranked':
            if (message.id !== rankId.current) return;
            setState((current) =>
              current.status === 'ready'
                ? { ...current, ranking: message.ranking, reranking: false }
                : current,
            );
            return;
          case 'error':
            fail(message.code, message.bundle);
            return;
        }
      });
      // A script that fails to load or throws at the top level. The event's
      // own message is not forwarded: only the bounded code crosses.
      created.addEventListener('error', (event) => {
        event.preventDefault();
        if (worker.current === created) fail('internal');
      });
      created.postMessage({ type: 'process', file, now: Date.now() } satisfies ToWorker);
    },
    [fail, stop],
  );

  const reset = useCallback(() => {
    stop();
    setState({ status: 'idle' });
  }, [stop]);

  const rerank = useCallback(
    (profile: MatchProfile, limit: number) => {
      rankId.current += 1;
      send({ type: 'rank', id: rankId.current, profile, now: Date.now(), limit });
    },
    [send],
  );

  const setProfile = useCallback(
    (profile: MatchProfile) => {
      setState((current) =>
        current.status === 'ready' ? { ...current, profile, reranking: true } : current,
      );
      if (state.status === 'ready') rerank(profile, state.limit);
    },
    [rerank, state],
  );

  const showMore = useCallback(() => {
    if (state.status !== 'ready') return;
    const limit = state.limit + INITIAL_RESULT_LIMIT;
    setState({ ...state, limit, reranking: true });
    rerank(state.profile, limit);
  }, [rerank, state]);

  // Leaving the app (tab close, full navigation, bfcache) ends the session;
  // unmounting does too.
  useEffect(() => {
    window.addEventListener('pagehide', reset);
    return () => {
      window.removeEventListener('pagehide', reset);
      stop();
    };
  }, [reset, stop]);

  const value = useMemo<CvSession>(
    () => ({ state, start, reset, setProfile, showMore }),
    [state, start, reset, setProfile, showMore],
  );
  return <CvSessionContext.Provider value={value}>{children}</CvSessionContext.Provider>;
}
