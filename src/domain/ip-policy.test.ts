import { describe, expect, it } from 'vitest';
import { classifyIpAddress, isPrivateOrReservedAddress } from './ip-policy.js';

describe('classifyIpAddress: IPv4 CIDR boundaries', () => {
  it('10.0.0.0/8 (private)', () => {
    expect(classifyIpAddress('9.255.255.255')).toBe('public');
    expect(classifyIpAddress('10.0.0.0')).toBe('private');
    expect(classifyIpAddress('10.255.255.255')).toBe('private');
    expect(classifyIpAddress('11.0.0.0')).toBe('public');
  });

  it('172.16.0.0/12 (private)', () => {
    expect(classifyIpAddress('172.15.255.255')).toBe('public');
    expect(classifyIpAddress('172.16.0.0')).toBe('private');
    expect(classifyIpAddress('172.31.255.255')).toBe('private');
    expect(classifyIpAddress('172.32.0.0')).toBe('public');
  });

  it('192.168.0.0/16 (private)', () => {
    expect(classifyIpAddress('192.167.255.255')).toBe('public');
    expect(classifyIpAddress('192.168.0.0')).toBe('private');
    expect(classifyIpAddress('192.168.255.255')).toBe('private');
    expect(classifyIpAddress('192.169.0.0')).toBe('public');
  });

  it('100.64.0.0/10 (cgnat)', () => {
    expect(classifyIpAddress('100.63.255.255')).toBe('public');
    expect(classifyIpAddress('100.64.0.0')).toBe('cgnat');
    expect(classifyIpAddress('100.127.255.255')).toBe('cgnat');
    expect(classifyIpAddress('100.128.0.0')).toBe('public');
  });

  it('127.0.0.0/8 (loopback)', () => {
    expect(classifyIpAddress('127.0.0.1')).toBe('loopback');
    expect(classifyIpAddress('127.255.255.254')).toBe('loopback');
  });

  it('169.254.0.0/16 (link_local), including the cloud metadata endpoint', () => {
    expect(classifyIpAddress('169.253.255.255')).toBe('public');
    expect(classifyIpAddress('169.254.0.0')).toBe('link_local');
    expect(classifyIpAddress('169.254.169.254')).toBe('link_local');
    expect(classifyIpAddress('169.255.0.0')).toBe('public');
  });

  it('the three TEST-NET ranges (reserved)', () => {
    expect(classifyIpAddress('192.0.2.1')).toBe('reserved');
    expect(classifyIpAddress('198.51.100.1')).toBe('reserved');
    expect(classifyIpAddress('203.0.113.1')).toBe('reserved');
  });

  it('multicast and reserved-future-use ranges', () => {
    expect(classifyIpAddress('224.0.0.1')).toBe('reserved');
    expect(classifyIpAddress('255.255.255.255')).toBe('reserved');
    expect(classifyIpAddress('0.0.0.0')).toBe('reserved');
  });

  it('public sanity: well-known public addresses classify as public', () => {
    expect(classifyIpAddress('8.8.8.8')).toBe('public');
    expect(classifyIpAddress('1.1.1.1')).toBe('public');
  });

  it('deliberately NOT blocked: real public anycast ranges (AS112, AMT relay)', () => {
    expect(classifyIpAddress('192.31.196.1')).toBe('public');
    expect(classifyIpAddress('192.175.48.1')).toBe('public');
    expect(classifyIpAddress('192.52.193.1')).toBe('public');
  });
});

describe('classifyIpAddress: IPv6', () => {
  it('loopback and unspecified', () => {
    expect(classifyIpAddress('::1')).toBe('loopback');
    expect(classifyIpAddress('::')).toBe('unspecified');
  });

  it('fe80::/10 (link_local)', () => {
    expect(classifyIpAddress('fe80::1')).toBe('link_local');
  });

  it('fc00::/7 (unique local / private), including outside the all-zero prefix', () => {
    expect(classifyIpAddress('fc00::1')).toBe('private');
    expect(classifyIpAddress('fd12:3456:789a::1')).toBe('private');
  });

  it('fec0::/10 (deprecated site-local) is still blocked, not treated as reclaimed-public', () => {
    // RFC 3879 deprecated this range in favor of fc00::/7 above, but never
    // reassigned it as globally routable — some legacy networks still route
    // it internally, so it must classify the same as any other private
    // range, not fall through to 'public' for lacking a dedicated entry.
    expect(classifyIpAddress('fec0::1')).toBe('private');
    expect(classifyIpAddress('feff:ffff:ffff:ffff::1')).toBe('private'); // near the top of the /10, not just its base address
  });

  it('ff02::1 (multicast, reserved)', () => {
    expect(classifyIpAddress('ff02::1')).toBe('reserved');
  });

  it('2001:db8::/32 (documentation, reserved)', () => {
    expect(classifyIpAddress('2001:db8::1')).toBe('reserved');
  });

  it('the whole 2001::/23 IETF Protocol Assignments block is blocked, not just its named sub-ranges', () => {
    // 2002:7f00:1:: encodes 127.0.0.1 in 6to4's simple hex-as-dotted-quad
    // scheme, but this is asserted blocked via the flat 2002::/16 rule, not
    // via unwrapping — 6to4 is an accepted limitation, not decoded.
    expect(classifyIpAddress('2002:7f00:1::')).toBe('reserved');
    expect(classifyIpAddress('2001:0:1234::')).toBe('reserved'); // Teredo (2001::/32)
    // Regression case: benchmarking (RFC 5180) is a narrower sub-block that
    // an earlier version of this file, blocking only 2001::/32, missed
    // entirely — caught now by blocking the containing /23 as a whole.
    expect(classifyIpAddress('2001:2::1')).toBe('reserved');
  });

  it('3fff::/20 (newer IPv6 documentation range, RFC 9637)', () => {
    expect(classifyIpAddress('3fff::1')).toBe('reserved');
    // Top of the /20: only the first 4 bits of the second hextet are fixed
    // (0), so 3fff:fff:... (not 3fff:ffff:...) is the last address still
    // inside this range — verified against a from-scratch CIDR check, not
    // assumed.
    expect(classifyIpAddress('3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff')).toBe('reserved');
    expect(classifyIpAddress('3fff:1000::1')).toBe('public'); // just outside the /20
  });

  it('anything outside 2000::/3 (the only allocated Global Unicast range) is denied by default, not just named ranges', () => {
    // fe00::/9's non-link-local remainder: not fe80::/10 (link-local,
    // tested above) or fec0::/10 (site-local, tested above), and not named
    // in IPV6_RANGES at all — this is exactly the gap an enumerate-every-
    // known-range denylist kept missing, closed by the 2000::/3 boundary
    // rather than by adding yet another named entry.
    expect(classifyIpAddress('fe00::1')).toBe('reserved');
    // 1::1 has no special-purpose meaning and isn't inside 2000::/3 either
    // — still correctly denied by the same default, unrelated to any named
    // range above.
    expect(classifyIpAddress('1::1')).toBe('reserved');
  });

  it('public sanity: real addresses textually near blocked prefixes still classify public', () => {
    expect(classifyIpAddress('2606:4700:4700::1111')).toBe('public');
    // Close to blocked 2001:0000::/32 and 2001:db8::/32, but distinct, and
    // its second hextet (4860) is well outside 2001::/23's blocked range
    // (which only covers second-hextet 0000-01ff).
    expect(classifyIpAddress('2001:4860:4860::8888')).toBe('public');
  });
});

describe('classifyIpAddress: IPv4-mapped and NAT64 unwrap', () => {
  it('::ffff:0:0/96 unwraps the embedded IPv4 and reclassifies via the IPv4 table', () => {
    expect(classifyIpAddress('::ffff:127.0.0.1')).toBe('loopback');
    // Same address, hex form (as WHATWG URL canonicalizes it) — both
    // textual spellings of the identical address must be caught.
    expect(classifyIpAddress('::ffff:7f00:1')).toBe('loopback');
    expect(classifyIpAddress('::ffff:10.0.0.1')).toBe('private');
    // A true-positive-allow case: proves this is a real unwrap-and-recheck,
    // not a blanket block of the whole ::ffff:0:0/96 range (which would
    // also make every dual-stack-represented public IPv4 address unusable).
    expect(classifyIpAddress('::ffff:8.8.8.8')).toBe('public');
  });

  it('64:ff9b::/96 (NAT64) gets the same unwrap treatment', () => {
    expect(classifyIpAddress('64:ff9b::7f00:1')).toBe('loopback');
    expect(classifyIpAddress('64:ff9b::808:808')).toBe('public');
  });

  it('64:ff9b:1::/48 (RFC 8215 local-use NAT64) is flat-blocked at every RFC 6052 embedding length, not just /96', () => {
    // Unlike the well-known /96 prefix above, RFC 6052 lets an operator
    // embed the translated IPv4 address at /32, /40, /48, /56, /64, or /96
    // within this /48 — each with a different bit layout. Rather than
    // decode all six, the whole /48 is blocked outright (see the comment
    // above IPV6_RANGES). Regression case for the /48-length embedding
    // specifically: 64:ff9b:1:a00:0:100::/48 is RFC 6052's own worked
    // example encoding 10.0.0.1 — the earlier version of this file, which
    // only recognized the /96 form, let this fall through to 'public'.
    expect(classifyIpAddress('64:ff9b:1:a00:0:100::')).toBe('reserved');
    // The /96 form (matching the well-known prefix's own layout) must be
    // caught by the flat-block too, not just the other five lengths.
    expect(classifyIpAddress('64:ff9b:1::7f00:1')).toBe('reserved');
    // A "public"-looking embedded address doesn't earn an exemption either
    // — this is a flat block of the whole allocation, not a decode-and-recheck.
    expect(classifyIpAddress('64:ff9b:1::808:808')).toBe('reserved');
  });
});

describe('classifyIpAddress: malformed input fails closed', () => {
  it.each(['', 'not-an-ip', '999.999.999.999', '1.2.3', '1.2.3.4.5', 'gggg::1'])(
    '%s is not a valid literal (null, not silently treated as public)',
    (input) => {
      expect(classifyIpAddress(input)).toBeNull();
    },
  );
});

describe('isPrivateOrReservedAddress', () => {
  it('true for every non-public classification', () => {
    expect(isPrivateOrReservedAddress('10.0.0.1')).toBe(true);
    expect(isPrivateOrReservedAddress('127.0.0.1')).toBe(true);
    expect(isPrivateOrReservedAddress('::1')).toBe(true);
  });

  it('false only for public', () => {
    expect(isPrivateOrReservedAddress('8.8.8.8')).toBe(false);
    expect(isPrivateOrReservedAddress('2606:4700:4700::1111')).toBe(false);
  });

  it('fails closed (true) on unparseable input', () => {
    expect(isPrivateOrReservedAddress('not-an-ip')).toBe(true);
  });
});
