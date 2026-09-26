import { describe, expect, it } from 'vitest';
import { type KnownListing, needsDetailFetch, pickCanaries, rateGuardOk } from './refetch.js';

const NOW = '2026-09-27T12:00:00Z';

function known(overrides: Partial<KnownListing> = {}): KnownListing {
  return {
    status: 'active',
    currentRevisionId: 'rev-1',
    discoveryFingerprint: 'fp-a',
    revisionFetchedAt: '2026-09-26T12:00:00Z',
    ...overrides,
  };
}

describe('needsDetailFetch', () => {
  it('fetches a listing with no stored row (new id)', () => {
    expect(needsDetailFetch(undefined, 'fp-a', NOW)).toBe('fetch');
  });

  it('fetches a listing never fetched successfully (no current revision)', () => {
    expect(
      needsDetailFetch(known({ status: 'discovered', currentRevisionId: null }), 'fp-a', NOW),
    ).toBe('fetch');
  });

  it('fetches a sitemap-only candidate, which has no fingerprint', () => {
    expect(needsDetailFetch(known(), null, NOW)).toBe('fetch');
  });

  it.each(['quarantined', 'closed'])('fetches a %s listing that reappears', (status) => {
    expect(needsDetailFetch(known({ status }), 'fp-a', NOW)).toBe('fetch');
  });

  it('fetches when the fingerprint changed', () => {
    expect(needsDetailFetch(known(), 'fp-b', NOW)).toBe('fetch');
  });

  it.each(['active', 'missing_suspected', 'expired'])(
    'skips a %s listing whose fingerprint is unchanged',
    (status) => {
      expect(needsDetailFetch(known({ status }), 'fp-a', NOW)).toBe('skip');
    },
  );

  it('adopts the fingerprint of an active listing fetched within 7 days (bootstrap)', () => {
    expect(needsDetailFetch(known({ discoveryFingerprint: null }), 'fp-a', NOW)).toBe('adopt');
  });

  it('fetches, rather than adopts, when the revision is older than 7 days', () => {
    expect(
      needsDetailFetch(
        known({ discoveryFingerprint: null, revisionFetchedAt: '2026-09-19T11:59:59Z' }),
        'fp-a',
        NOW,
      ),
    ).toBe('fetch');
  });

  it('fetches, rather than adopts, a listing that is not active', () => {
    expect(
      needsDetailFetch(
        known({ discoveryFingerprint: null, status: 'missing_suspected' }),
        'fp-a',
        NOW,
      ),
    ).toBe('fetch');
  });
});

describe('pickCanaries', () => {
  it('picks the requested number of distinct ids from the pool', () => {
    const pool = Array.from({ length: 50 }, (_, i) => String(i));
    const picked = pickCanaries(pool, 20);
    expect(picked.size).toBe(20);
    for (const id of picked) expect(pool).toContain(id);
  });

  it('picks the whole pool when it is smaller than the sample', () => {
    expect(pickCanaries(['a', 'b'], 20)).toEqual(new Set(['a', 'b']));
  });

  it('picks nothing for a zero sample or an empty pool', () => {
    expect(pickCanaries(['a'], 0).size).toBe(0);
    expect(pickCanaries([], 20).size).toBe(0);
  });

  it('is deterministic under an injected random source', () => {
    const pool = ['a', 'b', 'c', 'd'];
    expect(pickCanaries(pool, 2, () => 0)).toEqual(new Set(['a', 'b']));
  });
});

describe('rateGuardOk', () => {
  it('passes a run that fetched nothing', () => {
    expect(rateGuardOk(0, 0, 0.1)).toBe(true);
  });

  it('divides by pages fetched', () => {
    expect(rateGuardOk(2, 20, 0.1)).toBe(true);
    expect(rateGuardOk(3, 20, 0.1)).toBe(false);
  });

  it('fails a small run where every fetch went bad', () => {
    expect(rateGuardOk(1, 1, 0.1)).toBe(false);
  });
});
