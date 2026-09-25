import path from 'node:path';
import type { NextConfig } from 'next';

/**
 * The app lives in `web/` inside a larger repo whose real root is one level up.
 * Without both root hints Next infers a workspace root from the nearest lockfile
 * and traces the wrong files.
 */
const repoRoot = path.join(import.meta.dirname, '..');

/**
 * Phase 8E security headers that need no per-request value, set on every
 * response. The CSP needs a per-request nonce, so `proxy.ts` sets it (see
 * `lib/security-headers.ts`). These live here because Next compiles this
 * config on its own and it cannot import app modules.
 *
 * HSTS is not here: it belongs to the TLS-terminating reverse proxy
 * (`deploy/Caddyfile`), since a plain-HTTP loopback process cannot know
 * whether it is being served over HTTPS.
 */
const STATIC_SECURITY_HEADERS: { key: string; value: string }[] = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value:
      'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), display-capture=(), browsing-topics=()',
  },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
];

const config: NextConfig = {
  outputFileTracingRoot: repoRoot,
  turbopack: { root: repoRoot },
  // pg opens raw sockets, and drizzle and pino resolve modules dynamically.
  // Bundling any of them into the server chunk breaks them.
  serverExternalPackages: ['pg', 'drizzle-orm', 'pino'],
  // Next's own default is 1MB, well under a real CV — raised to match
  // read-document.ts's own 8MB ceiling so the two limits agree; a file
  // between them would otherwise be rejected here with a generic 413
  // rather than by read-document.ts's own typed, user-facing error.
  experimental: { serverActions: { bodySizeLimit: '8mb' } },
  // This repo is on the TypeScript 7 native port, which is unproven as Next's
  // programmatic type checker. `npm run typecheck` covers web/ as its own step,
  // and CI runs it separately so a failure says which check failed.
  typescript: { ignoreBuildErrors: true },
  // Phase 8E: headers with no per-request value, on every response. The CSP
  // needs a per-request nonce, so `proxy.ts` sets it instead.
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: STATIC_SECURITY_HEADERS }];
  },
  // No eslint key: Next 16 removed it. Biome is this repo's linter and ESLint is
  // deliberately not installed, so there is nothing for Next to run anyway.
};

export default config;
