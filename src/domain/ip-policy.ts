/**
 * Classifies a literal IP address (never a hostname) as public or one of
 * several non-public categories, per the IANA IPv4/IPv6 special-purpose
 * address registries (RFC 1918, 2928, 3927, 4193, 4291, 5735, 5737, 6598,
 * 6890, 6052, 8215, 9637, among others). This is the SSRF policy boundary shared by every place
 * this codebase decides whether a resolved network destination is safe to
 * connect to (src/net/ssrf-lookup.ts's DNS hook, and src/net/http-fetcher.ts's
 * literal-IP-hostname pre-check) — it has no I/O and knows nothing about
 * DNS, sockets, or fetch.
 *
 * Hand-rolled rather than using a library (e.g. `private-ip`, evaluated and
 * rejected: last published 2024-01-25, four transitive dependencies) for
 * the same reason src/domain/source.ts hand-rolls its own path-matching
 * instead of a glob/URL-matching library — this is a small, RFC-stable
 * rule set, and owning it directly keeps it auditable and gives callers a
 * project-specific classification (used directly in fetch error codes)
 * instead of a third-party boolean.
 */

export type IpAddressClassification =
  | 'public'
  | 'private'
  | 'loopback'
  | 'link_local'
  | 'cgnat'
  | 'reserved'
  | 'unspecified';

interface Ipv4Range {
  network: string;
  prefixLength: number;
  classification: IpAddressClassification;
}

interface Ipv6Range {
  network: string;
  prefixLength: number;
  classification: IpAddressClassification;
}

// Block-unless-explicitly-public. Deliberately does NOT include
// 192.31.196.0/24 (AS112), 192.175.48.0/24 (AS112 direct delegation), or
// 192.52.193.0/24 (AMT relay) — these are real publicly-routed anycast
// infrastructure per IANA's special-purpose registry, not private ranges;
// including them would be a false-positive over-block.
const IPV4_RANGES: Ipv4Range[] = [
  { network: '0.0.0.0', prefixLength: 8, classification: 'reserved' },
  { network: '10.0.0.0', prefixLength: 8, classification: 'private' },
  { network: '100.64.0.0', prefixLength: 10, classification: 'cgnat' },
  { network: '127.0.0.0', prefixLength: 8, classification: 'loopback' },
  // Includes 169.254.169.254, the cloud metadata-service endpoint on
  // AWS/GCP/Azure — the single highest-value real-world SSRF target this
  // range table exists to block.
  { network: '169.254.0.0', prefixLength: 16, classification: 'link_local' },
  { network: '172.16.0.0', prefixLength: 12, classification: 'private' },
  { network: '192.0.0.0', prefixLength: 24, classification: 'reserved' },
  { network: '192.0.2.0', prefixLength: 24, classification: 'reserved' }, // TEST-NET-1
  { network: '192.88.99.0', prefixLength: 24, classification: 'reserved' },
  { network: '192.168.0.0', prefixLength: 16, classification: 'private' },
  { network: '198.18.0.0', prefixLength: 15, classification: 'reserved' },
  { network: '198.51.100.0', prefixLength: 24, classification: 'reserved' }, // TEST-NET-2
  { network: '203.0.113.0', prefixLength: 24, classification: 'reserved' }, // TEST-NET-3
  { network: '224.0.0.0', prefixLength: 4, classification: 'reserved' }, // multicast
  { network: '240.0.0.0', prefixLength: 4, classification: 'reserved' }, // incl. 255.255.255.255 broadcast
];

// Flat-blocked (not decoded) despite arithmetically embedding an IPv4
// address, unlike the well-known NAT64 /96 range handled in classifyIpv6
// below: Teredo's embedding is XOR-obfuscated (RFC 4380) and 6to4's, while
// simple, has near-zero practical relevance here — a job-board crawler
// has no legitimate reason to be redirected into either, and both need
// OS-level tunnel configuration to even be routable. Accepted limitation,
// recorded in docs/THREAT_MODEL.md.
//
// RFC 8215's local-use NAT64 allocation (64:ff9b:1::/48) is flat-blocked
// for a different reason: unlike the well-known /96 prefix, RFC 6052
// permits an operator to embed the translated IPv4 address at any of
// several prefix lengths within this /48 (32/40/48/56/64/96), each with
// its own bit layout (a reserved "u" byte splits the embedded address for
// lengths shorter than /96). Decoding every layout correctly is real
// complexity this crawler has no legitimate use for — conservatively
// blocking the entire /48 is simpler and strictly safer than only
// recognizing the /96 case and letting the other five slip through
// unrecognized (confirmed the wrong way once already: an earlier version
// of this file only handled /96 here, and a /48-style embedding like
// 64:ff9b:1:a00:0:100::/48 — RFC 6052's own encoding of 10.0.0.1 — was
// falling through the range table entirely and classifying as public).
const IPV6_RANGES: Ipv6Range[] = [
  { network: '::', prefixLength: 128, classification: 'unspecified' },
  { network: '::1', prefixLength: 128, classification: 'loopback' },
  { network: '64:ff9b:1::', prefixLength: 48, classification: 'reserved' }, // RFC 8215 local-use NAT64
  { network: '100::', prefixLength: 64, classification: 'reserved' }, // discard-only
  { network: '2001:db8::', prefixLength: 32, classification: 'reserved' }, // documentation
  // The whole IETF Protocol Assignments block (RFC 2928), blocked as one
  // /23 rather than by its many individual sub-allocations (Teredo
  // 2001::/32, benchmarking 2001:2::/48, ORCHID/ORCHIDv2, AS112-v6,
  // PCP/TURN anycast /128s, and whatever else gets carved out of it
  // later) — enumerating each sub-block by name is exactly the mistake
  // already made once for NAT64 above; almost none of it is meant to be
  // reachable the way ordinary global unicast is, and this crawler has no
  // legitimate reason to be redirected into any corner of it. Two known
  // real public-anycast exceptions live inside this block (AMT relay
  // 2001:3::/32, AS112-v6 2001:4:112::/48) and are over-blocked by this —
  // an accepted, documented trade-off (see docs/THREAT_MODEL.md), the
  // same call already made for IPv4 AS112/AMT but the other direction:
  // there, false-positive over-block was worth avoiding by naming two
  // /24s; here, avoiding it would mean naming every other sub-block
  // instead, which is the failure mode this entry exists to end.
  { network: '2001::', prefixLength: 23, classification: 'reserved' },
  { network: '2002::', prefixLength: 16, classification: 'reserved' }, // 6to4
  { network: '3fff::', prefixLength: 20, classification: 'reserved' }, // documentation (RFC 9637)
  { network: 'fc00::', prefixLength: 7, classification: 'private' }, // unique local (ULA)
  // Deprecated by RFC 3879 in favor of ULA (fc00::/7) above, but never
  // reclaimed as public — some legacy networks still route it internally,
  // so a resolved or literal address here is still a real internal-network
  // target, not a hypothetical one.
  { network: 'fec0::', prefixLength: 10, classification: 'private' }, // deprecated site-local
  { network: 'fe80::', prefixLength: 10, classification: 'link_local' },
  { network: 'ff00::', prefixLength: 8, classification: 'reserved' }, // multicast
];

// Only 2000::/3 has ever been allocated as Global Unicast Address space
// (the current form of RFC 4291 §2.4 / RFC 3513, as tracked by IANA's
// IPv6 Special-Purpose Address Registry) — everything outside it is
// non-global by construction, named above or not. classifyIpv6 checks
// this as a last-resort default-deny AFTER the specific ranges above,
// closing the whole class of gap IPV6_RANGES kept missing one narrow
// block at a time (fec0::/10, RFC 8215's NAT64 local-use /48, and — the
// case that motivated adding this boundary — anything else outside
// 2000::/3, like fe00::/9's non-link-local remainder): rather than race
// to enumerate every current and future non-global carve-out by name,
// default-deny everything that isn't inside the one range IANA has
// actually allocated for global reachability, the same
// block-unless-explicitly-public stance IPV4_RANGES already takes.
const GLOBAL_UNICAST_NETWORK = { network: '2000::', prefixLength: 3 };

// The two ranges that genuinely embed a live-routable IPv4 address in a
// single, simple /96 layout and are unwrapped-and-rechecked rather than
// flat-blocked: IPv4-mapped IPv6 (how every dual-stack socket API
// represents an IPv4 connection — always live) and the NAT64 well-known
// prefix (live on any IPv6-only/NAT64 network with no special config, and
// only ever used at /96 length, unlike RFC 8215's local-use allocation
// above). An address here can translate to an arbitrary IPv4 destination,
// RFC1918 included — flat-blocking the wrapper prefix without decoding it
// would wrongly classify that embedded private destination as public.
const IPV4_MAPPED_NETWORK = { network: '::ffff:0:0', prefixLength: 96 };
const NAT64_NETWORK = { network: '64:ff9b::', prefixLength: 96 };

function parseIpv4(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    result = ((result << 8) | n) >>> 0;
  }
  return result;
}

function ipv4Mask(prefixLength: number): number {
  return prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
}

function ipv4InCidr(ip: number, network: string, prefixLength: number): boolean {
  const networkAddr = parseIpv4(network);
  if (networkAddr === null) return false;
  const mask = ipv4Mask(prefixLength);
  return (ip & mask) >>> 0 === (networkAddr & mask) >>> 0;
}

function classifyIpv4(ip: number): IpAddressClassification {
  for (const range of IPV4_RANGES) {
    if (ipv4InCidr(ip, range.network, range.prefixLength)) return range.classification;
  }
  return 'public';
}

/**
 * Parses any standard IPv6 textual form (full, `::`-compressed, or with an
 * embedded IPv4 tail like `::ffff:127.0.0.1`) into a 128-bit value.
 * Normalizes fully to one canonical binary representation before any range
 * check runs — the same discipline decodePathSafely (src/domain/source.ts)
 * uses — rather than pattern-matching the surface string, since a single
 * address has multiple valid textual spellings (`::ffff:127.0.0.1` and
 * `::ffff:7f00:1` are the same address; a redirect Location header or a
 * raw dns.lookup result could hand back either).
 */
function parseIpv6(address: string): bigint | null {
  const zoneIndex = address.indexOf('%');
  let addr = zoneIndex === -1 ? address : address.slice(0, zoneIndex);
  if (addr.length === 0) return null;

  // Embedded IPv4 tail: rewrite to two hex groups so the rest of parsing
  // only ever deals with colon-separated hex groups.
  if (addr.includes('.')) {
    const lastColon = addr.lastIndexOf(':');
    if (lastColon === -1) return null;
    const ipv4Value = parseIpv4(addr.slice(lastColon + 1));
    if (ipv4Value === null) return null;
    const high = ((ipv4Value >>> 16) & 0xffff).toString(16);
    const low = (ipv4Value & 0xffff).toString(16);
    addr = `${addr.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const doubleColonCount = (addr.match(/::/g) ?? []).length;
  if (doubleColonCount > 1) return null;

  let groups: string[];
  if (addr.includes('::')) {
    const [left, right] = addr.split('::');
    const leftGroups = !left ? [] : left.split(':');
    const rightGroups = !right ? [] : right.split(':');
    const missing = 8 - leftGroups.length - rightGroups.length;
    if (missing < 0) return null;
    groups = [...leftGroups, ...Array(missing).fill('0'), ...rightGroups];
  } else {
    groups = addr.split(':');
  }

  if (groups.length !== 8) return null;

  let result = 0n;
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    result = (result << 16n) | BigInt(Number.parseInt(group, 16));
  }
  return result;
}

const IPV6_MAX = (1n << 128n) - 1n;

function ipv6Mask(prefixLength: number): bigint {
  return prefixLength === 0 ? 0n : (IPV6_MAX << BigInt(128 - prefixLength)) & IPV6_MAX;
}

function ipv6InCidr(ip: bigint, network: string, prefixLength: number): boolean {
  const networkAddr = parseIpv6(network);
  if (networkAddr === null) return false;
  const mask = ipv6Mask(prefixLength);
  return (ip & mask) === (networkAddr & mask);
}

function classifyIpv6(ip: bigint): IpAddressClassification {
  if (
    ipv6InCidr(ip, IPV4_MAPPED_NETWORK.network, IPV4_MAPPED_NETWORK.prefixLength) ||
    ipv6InCidr(ip, NAT64_NETWORK.network, NAT64_NETWORK.prefixLength)
  ) {
    const embeddedIpv4 = Number(ip & 0xffffffffn) >>> 0;
    return classifyIpv4(embeddedIpv4);
  }

  for (const range of IPV6_RANGES) {
    if (ipv6InCidr(ip, range.network, range.prefixLength)) return range.classification;
  }

  if (!ipv6InCidr(ip, GLOBAL_UNICAST_NETWORK.network, GLOBAL_UNICAST_NETWORK.prefixLength)) {
    return 'reserved';
  }
  return 'public';
}

/**
 * Classifies a literal IP address string. Returns `null` for anything that
 * isn't a syntactically valid IPv4 or IPv6 literal (not a hostname —
 * resolving hostnames is the caller's job, this function never does DNS).
 */
export function classifyIpAddress(address: string): IpAddressClassification | null {
  const ipv4 = parseIpv4(address);
  if (ipv4 !== null) return classifyIpv4(ipv4);

  const ipv6 = parseIpv6(address);
  if (ipv6 !== null) return classifyIpv6(ipv6);

  return null;
}

/**
 * Fail-closed SSRF policy check: true unless the address both parses and
 * classifies as 'public'. An unparseable address is treated as unsafe
 * rather than passed through — the same fail-closed stance
 * isPathAllowed/decodePathSafely take on their own malformed-input cases.
 */
export function isPrivateOrReservedAddress(address: string): boolean {
  return classifyIpAddress(address) !== 'public';
}
