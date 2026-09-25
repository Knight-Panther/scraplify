import { defineConfig } from '@playwright/test';

/**
 * Rendering-QA checks that used to live as visible "content" on the design
 * system page (`web/app/page.tsx`) — font fallback, tabular numerals,
 * truncation, focus visibility. None of those are verifiable from a document:
 * they only exist at render time, in a real browser, against real DOM layout.
 * Moving them here means the design-system page can stay a real style
 * reference instead of a checklist wearing a content costume.
 *
 * `channel: 'chrome'` uses the system's installed Chrome rather than
 * Playwright's own downloaded Chromium build — this machine has no outbound
 * access to Playwright's CDN, and the system browser is the one real users
 * and this project's manual browser-QA gate already render against.
 */
export default defineConfig({
  testDir: './e2e',
  // Needs three production servers of its own: `playwright.surfaces.config.ts`.
  testIgnore: 'surfaces/**',
  fullyParallel: true,
  retries: 0,
  use: {
    baseURL: 'http://127.0.0.1:3000',
    channel: 'chrome',
  },
  webServer: {
    command: 'npm run dev:web',
    url: 'http://127.0.0.1:3000',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
