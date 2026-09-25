/**
 * The three `next start` instances the route-level surface suite runs
 * against, shared by `playwright.surfaces.config.ts` (which starts them) and
 * `surfaces.spec.ts` (which calls them).
 *
 * The admin instance gets throwaway auth values of its own rather than
 * whatever `.env` holds: `instrumentation.ts` refuses to start `admin`
 * without all four, and the suite needs to know `AUTH_SECRET` to mint session
 * cookies (Auth.js's own `encode()`, the same technique Stage 6-8's live
 * verification used by hand). A fixed value, not a random one, because
 * Playwright evaluates this module in the runner AND in every worker, and a
 * per-process random secret would make the cookies the workers mint
 * undecryptable by the server the runner started. It authenticates nothing
 * but a loopback-only test server whose GitHub provider credentials are fake.
 */
export const TEST_AUTH_SECRET = 'e2e-surfaces-only-not-a-real-secret-0123456789';
export const ADMIN_GITHUB_ID = '424242';
export const NON_ADMIN_GITHUB_ID = '1';

export const SERVERS = {
  local: { port: 3100, env: { XTELO_SURFACE: 'local' } },
  // The public process must be told where bundles live (it refuses to guess).
  public: {
    port: 3101,
    env: { XTELO_SURFACE: 'public', XTELO_MATCHING_ARTIFACT_DIR: '.matching-artifacts' },
  },
  admin: {
    port: 3102,
    env: {
      XTELO_SURFACE: 'admin',
      AUTH_SECRET: TEST_AUTH_SECRET,
      AUTH_GITHUB_ID: 'e2e-fake-client-id',
      AUTH_GITHUB_SECRET: 'e2e-fake-client-secret',
      ADMIN_GITHUB_IDS: ADMIN_GITHUB_ID,
      // `next start` binds 127.0.0.1; Auth.js otherwise refuses the host.
      AUTH_TRUST_HOST: 'true',
      AUTH_URL: 'http://127.0.0.1:3102',
    },
  },
} as const;

export type SurfaceName = keyof typeof SERVERS;

export function origin(surface: SurfaceName): string {
  return `http://127.0.0.1:${SERVERS[surface].port}`;
}
