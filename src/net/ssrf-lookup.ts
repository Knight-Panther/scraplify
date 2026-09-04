import dns from 'node:dns';
import { isPrivateOrReservedAddress } from '../domain/index.js';

/**
 * Thrown by createSsrfSafeLookup's returned function when every candidate
 * or any candidate resolved address is private/reserved. `.code` lets
 * callers classify this specific failure by NodeJS.ErrnoException's usual
 * convention (compare `err.code === 'ERR_SSRF_BLOCKED'`) without depending
 * on `instanceof` surviving whatever wrapping fetch()/undici does to it —
 * verify the actual wrapping depth empirically once this is wired into
 * src/net/http-fetcher.ts, don't assume a fixed nesting.
 */
export class SsrfBlockedError extends Error {
  readonly code = 'ERR_SSRF_BLOCKED';
  readonly hostname: string;
  readonly blockedAddresses: readonly string[];

  constructor(hostname: string, blockedAddresses: readonly string[]) {
    super(
      `SSRF policy blocked ${hostname}: resolved to non-public address(es) ${blockedAddresses.join(', ')}`,
    );
    this.name = 'SsrfBlockedError';
    this.hostname = hostname;
    this.blockedAddresses = blockedAddresses;
  }
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family: number,
) => void;

type LookupAllResolver = (
  hostname: string,
  options: dns.LookupAllOptions,
  callback: (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void,
) => void;

export interface CreateSsrfSafeLookupOptions {
  /**
   * Injectable for tests only — substitutes a fake dns.lookup-shaped
   * resolver so unit tests exercise this function with zero real DNS
   * I/O. Production callers should omit this; it defaults to node:dns's
   * real lookup.
   */
  resolver?: LookupAllResolver;
}

/**
 * A dns.lookup-shaped function for undici Agent's `connect.lookup` option
 * (see src/net/http-fetcher.ts). This is what makes the SSRF IP check
 * atomic with the real connection: undici's connector calls this function
 * to resolve the hostname it's about to connect to, so validation happens
 * on the exact resolution actually used, not a separate one done moments
 * earlier — closing the DNS-rebinding TOCTOU a "resolve once ourselves,
 * then let undici resolve again" approach would leave open.
 *
 * Always resolves with `all: true` internally regardless of what the
 * caller (undici) actually requested, and rejects if ANY returned address
 * is non-public — not just the first. Checking only the first address
 * would let an attacker-controlled resolver return one public decoy
 * followed by a private address and rely on the decoy being all that's
 * checked. Reshapes the result back to match the caller's originally
 * requested shape (array if `options.all`, scalar otherwise) so this is a
 * transparent drop-in for dns.lookup from undici's point of view.
 *
 * Deliberately does no caching. undici ships its own composable DNS cache
 * (`interceptors.dns`) for performance if that's ever needed — an
 * orthogonal concern. Caching a "was public N seconds ago" verdict inside
 * this function specifically would reopen the exact TOCTOU race this hook
 * exists to close.
 *
 * IMPORTANT — this is only one of two enforcement points, not the only
 * one: Node's socket layer skips `lookup` entirely when the connection
 * target is already a literal IP address (confirmed empirically against
 * this project's Node 24.20.0: `net.connect`'s own `net.isIP(host)` check
 * short-circuits it). A URL whose hostname is already `127.0.0.1` or
 * `::1` never reaches this function at all. src/net/http-fetcher.ts's
 * redirect loop has an independent literal-IP pre-check using the same
 * classifyIpAddress for exactly that reason — this function alone is not
 * sufficient SSRF coverage.
 */
export function createSsrfSafeLookup(options: CreateSsrfSafeLookupOptions = {}) {
  const resolveAll: LookupAllResolver =
    options.resolver ?? (dns.lookup as unknown as LookupAllResolver);

  return function ssrfSafeLookup(
    hostname: string,
    lookupOptions: dns.LookupOptions,
    callback: LookupCallback,
  ): void {
    const wantsAll = lookupOptions.all === true;
    const allOptions = { ...lookupOptions, all: true } as dns.LookupAllOptions;

    resolveAll(hostname, allOptions, (err, addresses) => {
      if (err) {
        callback(err, wantsAll ? [] : '', 0);
        return;
      }

      const blocked = addresses.filter((entry) => isPrivateOrReservedAddress(entry.address));
      if (blocked.length > 0) {
        const blockedError = new SsrfBlockedError(
          hostname,
          blocked.map((entry) => entry.address),
        );
        callback(blockedError as NodeJS.ErrnoException, wantsAll ? [] : '', 0);
        return;
      }

      if (wantsAll) {
        callback(null, addresses, 0);
        return;
      }
      const first = addresses[0];
      callback(null, first?.address ?? '', first?.family ?? 0);
    });
  };
}
