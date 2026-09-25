import { defineConfig } from '@playwright/test';
import { PRIVACY_PORT, PRIVACY_SERVER_LOG } from './e2e/privacy/server.js';

/**
 * The Phase 8D exit-gate suite: a canary CV through CV Ranked against a real
 * `public` production server whose output is captured to a file. Run with
 * `npm run test:e2e:privacy` (which builds first). System Chrome, like the
 * other suites: this machine cannot download Playwright's own browsers.
 */
export default defineConfig({
  testDir: './e2e/privacy',
  retries: 0,
  use: { channel: 'chrome' },
  webServer: {
    command: `node e2e/privacy/start-public-server.mjs ${PRIVACY_SERVER_LOG} ${PRIVACY_PORT}`,
    url: `http://127.0.0.1:${PRIVACY_PORT}/icon.svg`,
    env: {
      XTELO_SURFACE: 'public',
      XTELO_MATCHING_ARTIFACT_DIR: '.matching-artifacts',
      // CI has only the owner credential; see web/lib/startup-checks.ts.
      XTELO_E2E_ALLOW_WRITABLE_PUBLIC_ROLE: '1',
    },
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
