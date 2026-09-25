import { describe, expect, it } from 'vitest';
import { clientKey, RATE_LIMITS, RateLimiter, rateClass } from './rate-limit.js';

describe('rateClass', () => {
  it('never limits the local surface', () => {
    expect(rateClass('local', '/api/matching/bundles/x/opportunities.json')).toBeNull();
    expect(rateClass('local', '/')).toBeNull();
  });

  it('puts bundle files, the manifest, sign-in and pages in their own buckets', () => {
    expect(rateClass('public', '/api/matching/bundles/b/opportunities.json')).toBe('bundle');
    expect(rateClass('public', '/api/matching/manifest')).toBe('manifest');
    expect(rateClass('admin', '/api/auth/signin')).toBe('auth');
    expect(rateClass('public', '/opportunities')).toBe('page');
    expect(rateClass('admin', '/admin')).toBe('page');
  });
});

describe('clientKey', () => {
  it('trusts only the last X-Forwarded-For entry, the one the proxy added', () => {
    expect(clientKey('6.6.6.6, 203.0.113.9')).toBe('203.0.113.9');
    expect(clientKey('203.0.113.9')).toBe('203.0.113.9');
  });

  it('falls back to one shared key with no header', () => {
    expect(clientKey(null)).toBe('direct');
    expect(clientKey('')).toBe('direct');
  });
});

describe('RateLimiter', () => {
  it('allows a full bucket, then refuses with the wait until the next token', () => {
    const limiter = new RateLimiter();
    const { capacity, refillPerSecond } = RATE_LIMITS.bundle;
    for (let i = 0; i < capacity; i++) expect(limiter.take('bundle', 'a', 0)).toBe(0);
    expect(limiter.take('bundle', 'a', 0)).toBe(Math.ceil(1 / refillPerSecond));
  });

  it('refills over time', () => {
    const limiter = new RateLimiter();
    for (let i = 0; i < RATE_LIMITS.bundle.capacity; i++) limiter.take('bundle', 'a', 0);
    expect(limiter.take('bundle', 'a', 29_000)).toBeGreaterThan(0);
    expect(limiter.take('bundle', 'a', 60_000)).toBe(0);
  });

  it('keeps clients and classes apart', () => {
    const limiter = new RateLimiter();
    for (let i = 0; i < RATE_LIMITS.bundle.capacity; i++) limiter.take('bundle', 'a', 0);
    expect(limiter.take('bundle', 'b', 0)).toBe(0);
    expect(limiter.take('page', 'a', 0)).toBe(0);
  });

  it('stays bounded under a flood of distinct clients', () => {
    const limiter = new RateLimiter(RATE_LIMITS, 100);
    for (let i = 0; i < 1_000; i++) limiter.take('page', `client-${i}`, 0);
    expect(limiter.size).toBeLessThanOrEqual(100);
  });

  it('evicts refilled buckets first', () => {
    const limiter = new RateLimiter(RATE_LIMITS, 10);
    for (let i = 0; i < 10; i++) limiter.take('page', `old-${i}`, 0);
    // A minute later every old bucket has refilled; the new client evicts them.
    limiter.take('page', 'new', 60_000);
    expect(limiter.size).toBe(1);
  });
});
