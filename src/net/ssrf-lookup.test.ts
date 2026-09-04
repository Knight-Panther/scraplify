import type dns from 'node:dns';
import { describe, expect, it, vi } from 'vitest';
import { createSsrfSafeLookup, SsrfBlockedError } from './ssrf-lookup.js';

function fakeResolver(addresses: dns.LookupAddress[]) {
  return vi.fn(
    (
      _hostname: string,
      _options: dns.LookupAllOptions,
      callback: (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void,
    ) => {
      callback(null, addresses);
    },
  );
}

describe('createSsrfSafeLookup', () => {
  it('passes through when every resolved address is public, scalar shape (options.all falsy)', () => {
    const resolver = fakeResolver([{ address: '8.8.8.8', family: 4 }]);
    const lookup = createSsrfSafeLookup({ resolver });
    const callback = vi.fn();

    lookup('example.com', {}, callback);

    expect(resolver).toHaveBeenCalledWith(
      'example.com',
      expect.objectContaining({ all: true }),
      expect.any(Function),
    );
    expect(callback).toHaveBeenCalledWith(null, '8.8.8.8', 4);
  });

  it('passes through when every resolved address is public, array shape (options.all true)', () => {
    const resolver = fakeResolver([
      { address: '8.8.8.8', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ]);
    const lookup = createSsrfSafeLookup({ resolver });
    const callback = vi.fn();

    lookup('example.com', { all: true }, callback);

    expect(callback).toHaveBeenCalledWith(
      null,
      [
        { address: '8.8.8.8', family: 4 },
        { address: '2606:4700:4700::1111', family: 6 },
      ],
      0,
    );
  });

  it('blocks when the only resolved address is private', () => {
    const resolver = fakeResolver([{ address: '127.0.0.1', family: 4 }]);
    const lookup = createSsrfSafeLookup({ resolver });
    const callback = vi.fn();

    lookup('attacker.example', {}, callback);

    expect(callback).toHaveBeenCalledTimes(1);
    const [err] = callback.mock.calls[0] as [Error];
    expect(err).toBeInstanceOf(SsrfBlockedError);
    expect((err as SsrfBlockedError).code).toBe('ERR_SSRF_BLOCKED');
  });

  it('blocks if even one of several resolved addresses is private — not just the first', () => {
    const resolver = fakeResolver([
      { address: '8.8.8.8', family: 4 }, // decoy public address
      { address: '169.254.169.254', family: 4 }, // cloud metadata endpoint
    ]);
    const lookup = createSsrfSafeLookup({ resolver });
    const callback = vi.fn();

    lookup('rebind.example', { all: true }, callback);

    const [err] = callback.mock.calls[0] as [Error];
    expect(err).toBeInstanceOf(SsrfBlockedError);
    expect((err as SsrfBlockedError).blockedAddresses).toEqual(['169.254.169.254']);
  });

  it('blocks a resolved deprecated site-local IPv6 address (fec0::/10)', () => {
    // Regression case: this range was initially missing from ip-policy.ts's
    // table and fell through to 'public', which would have let a resolver
    // on a legacy network that still routes fec0::/10 point this lookup at
    // an internal host undetected.
    const resolver = fakeResolver([{ address: 'fec0::1', family: 6 }]);
    const lookup = createSsrfSafeLookup({ resolver });
    const callback = vi.fn();

    lookup('legacy-site-local.example', {}, callback);

    const [err] = callback.mock.calls[0] as [Error];
    expect(err).toBeInstanceOf(SsrfBlockedError);
  });

  it('passes resolver errors through unchanged, not reclassified as SSRF-blocked', () => {
    const notFound = Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
    const resolver = vi.fn(
      (
        _h: string,
        _o: dns.LookupAllOptions,
        callback: (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void,
      ) => {
        callback(notFound as NodeJS.ErrnoException, []);
      },
    );
    const lookup = createSsrfSafeLookup({ resolver });
    const callback = vi.fn();

    lookup('nonexistent.example', {}, callback);

    expect(callback).toHaveBeenCalledWith(notFound, '', 0);
  });

  it('always requests all:true from the resolver regardless of what the caller asked for', () => {
    const resolver = fakeResolver([{ address: '8.8.8.8', family: 4 }]);
    const lookup = createSsrfSafeLookup({ resolver });

    lookup('example.com', { all: false }, vi.fn());

    expect(resolver).toHaveBeenCalledWith(
      'example.com',
      expect.objectContaining({ all: true }),
      expect.any(Function),
    );
  });
});
