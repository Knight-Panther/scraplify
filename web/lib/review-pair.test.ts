import { describe, expect, it } from 'vitest';
import type { ListingView, ReviewQueueEntry } from '../../src/browse/queries.js';
import { evidenceReasons, pickSurvivor, reviewerReasons } from './review-pair.js';

function listing(overrides: Partial<ListingView> = {}): ListingView {
  return {
    sourceListingId: 'a0000000-0000-4000-8000-000000000001',
    sourceSlug: 'jobs-ge',
    status: 'active',
    title: 'დიჯითალ ოპერატორი',
    organization: 'თიბისი',
    canonicalUrl: 'https://www.jobs.ge/ge/?view=jobs&id=750397',
    publishedAt: '2026-09-06T08:00:00Z',
    deadlineAt: '2026-09-20T19:59:00Z',
    firstSeenAt: '2026-09-06T08:04:23.263Z',
    lastSeenAt: '2026-09-06T08:04:23.263Z',
    applicationMethod: null,
    ...overrides,
  };
}

function pair(overrides: Partial<ReviewQueueEntry> = {}): ReviewQueueEntry {
  return {
    candidateId: 'c0000000-0000-4000-8000-000000000001',
    similarityScore: 1,
    decision: 'needs_review',
    evidence: {},
    a: listing(),
    b: listing({
      sourceListingId: 'b0000000-0000-4000-8000-000000000001',
      sourceSlug: 'hr-ge',
      canonicalUrl: 'https://www.hr.ge/announcement/492305/dijiTal-operatori',
      firstSeenAt: '2026-09-06T07:17:20.828Z',
    }),
    // Both singletons by default — the ordinary case, where cluster size
    // never comes into it and the tie-breaker is first-seen date alone.
    aClusterSize: 1,
    bClusterSize: 1,
    ...overrides,
  };
}

describe('evidenceReasons', () => {
  /**
   * A real payload, copied from the live review queue on 2026-09-14 rather
   * than composed — `scorePair`'s own sentences, not a paraphrase of them.
   */
  it('reads the reasons the scorer actually wrote', () => {
    const reasons = evidenceReasons({
      reasons: [
        'same organization and closely matching titles, but no vacancy-level application value',
        '§14.2 forbids auto-linking on employer and title agreement alone',
        'posting dates are within the proximity window',
      ],
      signals: { titleSimilarity: 1, sameOrganization: true },
    });
    expect(reasons).toEqual([
      'same organization and closely matching titles, but no vacancy-level application value',
      '§14.2 forbids auto-linking on employer and title agreement alone',
      'posting dates are within the proximity window',
    ]);
  });

  it('is empty for a row written before the evidence column existed', () => {
    expect(evidenceReasons(null)).toEqual([]);
  });

  /** jsonb is `unknown` at the type level and arbitrary at runtime. */
  it('survives a malformed payload rather than throwing', () => {
    for (const payload of [
      null,
      undefined,
      'text',
      42,
      [],
      { reasons: 'not an array' },
      { reasons: [1, null, ''] },
    ]) {
      expect(() => evidenceReasons(payload)).not.toThrow();
    }
    expect(evidenceReasons({ reasons: [1, null, '', '  ', 'real reason'] })).toEqual([
      'real reason',
    ]);
  });
});

describe('pickSurvivor', () => {
  it('picks the earlier-seen side as the survivor', () => {
    const { survivor, moving } = pickSurvivor(pair());
    // b was first seen 2026-09-06T07:17, a at 08:04 — b is earlier.
    expect(survivor.sourceListingId).toBe('b0000000-0000-4000-8000-000000000001');
    expect(moving.sourceListingId).toBe('a0000000-0000-4000-8000-000000000001');
  });

  it('picks the other side when the ordering is reversed', () => {
    const reversed = pair({
      a: listing({ sourceListingId: 'earlier', firstSeenAt: '2026-01-01T00:00:00Z' }),
      b: listing({ sourceListingId: 'later', firstSeenAt: '2026-06-01T00:00:00Z' }),
    });
    const { survivor, moving } = pickSurvivor(reversed);
    expect(survivor.sourceListingId).toBe('earlier');
    expect(moving.sourceListingId).toBe('later');
  });

  /**
   * A tie must still resolve to exactly one side, deterministically — an
   * ORDER BY that is not total is the defect class this project has already
   * hit twice (Stages 5 and 7), and this comparison has the same shape.
   */
  it('resolves a tie to side a, not to whichever the caller happened to pass first', () => {
    const tied = pair({
      a: listing({ sourceListingId: 'side-a', firstSeenAt: '2026-01-01T00:00:00Z' }),
      b: listing({ sourceListingId: 'side-b', firstSeenAt: '2026-01-01T00:00:00Z' }),
    });
    expect(pickSurvivor(tied).survivor.sourceListingId).toBe('side-a');
    expect(pickSurvivor(tied).moving.sourceListingId).toBe('side-b');
  });

  /**
   * The real defect this branch found: after one fan-out sibling is
   * accepted, that side's opportunity has more than one live member.
   * `acceptDuplicateCandidate` refuses to move a listing OUT of a cluster it
   * shares with another (the cluster-size guard), so a first-seen-only rule
   * that happened to pick the ALREADY-clustered side as `moving` would make
   * the next sibling permanently impossible to accept through this screen —
   * even though moving the still-singleton side INTO the established
   * cluster is exactly the safe, correct operation.
   *
   * `b` is first-seen EARLIER than `a` — the plain tie-breaker would pick it
   * as survivor — but `a` is the one already anchoring a two-member cluster.
   * Cluster size must win.
   */
  it('prefers the side already anchoring a larger cluster, even against an earlier first-seen date', () => {
    const afterOneSiblingAccepted = pair({
      a: listing({
        sourceListingId: 'already-clustered',
        firstSeenAt: '2026-06-01T00:00:00Z', // later than b
      }),
      b: listing({
        sourceListingId: 'still-singleton',
        firstSeenAt: '2026-01-01T00:00:00Z', // earlier than a
      }),
      aClusterSize: 2,
      bClusterSize: 1,
    });
    const { survivor, moving } = pickSurvivor(afterOneSiblingAccepted);
    expect(survivor.sourceListingId).toBe('already-clustered');
    expect(moving.sourceListingId).toBe('still-singleton');
  });

  it('falls back to first-seen date when both sides have the same cluster size', () => {
    const bothClustered = pair({
      a: listing({ sourceListingId: 'a-side', firstSeenAt: '2026-06-01T00:00:00Z' }),
      b: listing({ sourceListingId: 'b-side', firstSeenAt: '2026-01-01T00:00:00Z' }),
      aClusterSize: 2,
      bClusterSize: 2,
    });
    const { survivor } = pickSurvivor(bothClustered);
    // b is earlier, and the sizes are equal, so the tie-breaker still applies.
    expect(survivor.sourceListingId).toBe('b-side');
  });
});

describe('reviewerReasons', () => {
  /**
   * Real payloads, copied from the live review queue on 2026-09-14 — the
   * exact reason set that was being rendered verbatim, spec citation
   * included, before this fix.
   */
  it('translates every reason the live needs_review queue actually carries', () => {
    const translated = reviewerReasons({
      reasons: [
        'same organization and closely matching titles, but no vacancy-level application value',
        '§14.2 forbids auto-linking on employer and title agreement alone',
        'shared application value is employer-level (carried by 4 listings) — not a vacancy identifier',
        'posting dates are within the proximity window',
      ],
    });
    expect(translated).toEqual([
      'Same employer, and the titles closely match.',
      "Matching employer and title alone isn't enough to link automatically — a person decides this one.",
      'The shared contact or link is used by 4 listings from this employer — it identifies the employer, not this one vacancy.',
      'Both were posted around the same time.',
    ]);
    // None of §14.2, "vacancy-level", "normalized organization" or any other
    // scorer/spec vocabulary survives into what is actually rendered.
    for (const sentence of translated) {
      expect(sentence).not.toMatch(/§|vacancy-level|normalized organization/);
    }
  });

  it('never shows the raw sentence for a reason it does not recognise', () => {
    const translated = reviewerReasons({
      reasons: ['a brand new reason scorePair might add later'],
    });
    expect(translated).toEqual([
      'The scorer found another signal for this pair that is not summarised here.',
    ]);
  });

  it('preserves order and length exactly, one translated sentence per raw reason', () => {
    const raw = evidenceReasons({
      reasons: ['same normalized organization', 'titles agree (similarity 1.00)'],
    });
    const translated = reviewerReasons({
      reasons: ['same normalized organization', 'titles agree (similarity 1.00)'],
    });
    expect(translated).toHaveLength(raw.length);
    expect(translated).toEqual(['Same employer.', 'The titles closely match.']);
  });
});
