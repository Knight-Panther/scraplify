import path from 'node:path';
import type { NextConfig } from 'next';

/**
 * The app lives in `web/` inside a larger repo whose real root is one level up.
 * Without both root hints Next infers a workspace root from the nearest lockfile
 * and traces the wrong files.
 */
const repoRoot = path.join(import.meta.dirname, '..');

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
  // No eslint key: Next 16 removed it. Biome is this repo's linter and ESLint is
  // deliberately not installed, so there is nothing for Next to run anyway.
};

export default config;
