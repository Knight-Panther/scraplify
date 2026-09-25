import { defineConfig } from '@playwright/test';
import { SERVERS } from './e2e/surfaces/servers.js';

/**
 * Phase 8B exit gate: route-level surface enforcement, end to end.
 *
 * `surface-routing.test.ts` proves `proxy.ts`'s predicates in isolation; this
 * proves the assembled app. It runs one real `next start` per surface, from the
 * one production build (`npm run test:e2e:surfaces` builds first), and asserts
 * each surface's status codes by direct URL.
 *
 * `next start`, not `next dev`: three dev servers cannot share `web/`'s one
 * build directory, and a production server is also what actually gets
 * deployed. `reuseExistingServer: false`, so a stray server on one of these
 * ports with a different `XTELO_SURFACE` fails the run instead of silently
 * answering for the wrong surface.
 *
 * Every server reads the repo `.env`'s database the way `npm run start:web`
 * does, with writes disabled. The suite only sends GETs.
 */
export default defineConfig({
  testDir: './e2e/surfaces',
  fullyParallel: true,
  retries: 0,
  webServer: Object.values(SERVERS).map(({ port, env }) => ({
    command: `node scripts/next.mjs start web -H 127.0.0.1 -p ${port}`,
    url: `http://127.0.0.1:${port}/icon.svg`,
    env,
    reuseExistingServer: false,
    timeout: 60_000,
  })),
});
