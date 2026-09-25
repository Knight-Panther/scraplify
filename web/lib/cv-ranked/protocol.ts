import type { BundleOpportunity } from '../../../src/matching/bundle/schema.js';
import type { MatchProfile, Vocabulary } from '../../../src/matching/lexical/profile.js';
import type { MatchReason, RankingStats } from '../../../src/matching/lexical/rank.js';
import type { CvErrorCode, CvKind } from './document-checks.js';

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
  reasons: MatchReason[];
  locationUnstated: boolean;
}

export interface RankingPayload {
  version: string;
  results: RankedRow[];
  /** Every match, of which `results` is the first `limit`; more than its length means "show more". */
  total: number;
  stats: RankingStats;
}

export type FromWorker =
  | { type: 'progress'; stage: Stage }
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
