import type { BundleOpportunity } from '../../../src/matching/bundle/schema.js';
import type { MatchProfile, Vocabulary } from '../../../src/matching/lexical/profile.js';
import type { RankingStats } from '../../../src/matching/lexical/rank.js';
import type { HybridReason, HybridSimilarity } from '../../../src/matching/semantic/hybrid.js';
import type { CvErrorCode, CvKind, CvScript } from './document-checks.js';

/**
 * Messages between the CV Ranked UI and its worker (Phase 8D). Everything
 * here stays inside this tab: the worker has no endpoint to send any of it
 * to, and the only network it performs is `GET`ting the public bundle.
 *
 * Errors cross as a bounded `CvErrorCode`, never a message or stack, since a
 * parser's own error text can quote the document (change.md §7).
 */

export type ToWorker =
  | { type: 'process'; file: File; now: number }
  /** `id` echoes back on `ranked`, so the UI can drop a reply a newer edit superseded. */
  | { type: 'rank'; id: number; profile: MatchProfile; now: number; limit: number };

export type Stage = 'reading' | 'bundle' | 'ranking';

export interface DocumentSummary {
  kind: CvKind;
  /** PDF only. */
  pages: number | null;
  characters: number;
  /** Most letters' alphabet; 'other' means neither Georgian nor Latin. */
  script: CvScript;
}

/** What the page shows about the data it ranked against — all from the manifest. */
export interface BundleSummary {
  bundleId: string;
  generatedAt: string;
  opportunities: number;
  sourceFreshness: { sourceSlug: string; lastSeenAt: string }[];
}

export interface RankedRow {
  row: BundleOpportunity;
  score: number;
  reasons: HybridReason[];
  locationUnstated: boolean;
}

export interface RankingPayload {
  version: string;
  /**
   * What title similarity compared titles with: the roles, through the
   * bundle's role vectors; the roles and the CV's short lines, through the
   * static model; or nothing, when a CV needed the static model and it could
   * not be loaded or verified. The page says which.
   */
  similarity: HybridSimilarity;
  results: RankedRow[];
  /** Every match, of which `results` is the first `limit`; more than its length means "show more". */
  total: number;
  stats: RankingStats;
}

/**
 * Bytes of the vacancy index (and the static model, when a CV needs it)
 * received so far, decoded. The index downloads from the start, so this
 * arrives during 'reading' too.
 */
export interface DownloadProgress {
  received: number;
  total: number;
}

export type FromWorker =
  | { type: 'progress'; stage: Stage }
  | ({ type: 'download' } & DownloadProgress)
  | {
      type: 'ready';
      document: DocumentSummary;
      bundle: BundleSummary;
      profile: MatchProfile;
      vocabulary: Vocabulary;
      ranking: RankingPayload;
    }
  | { type: 'ranked'; id: number; ranking: RankingPayload }
  | { type: 'error'; code: CvErrorCode; bundle?: BundleSummary };

export const INITIAL_RESULT_LIMIT = 50;
