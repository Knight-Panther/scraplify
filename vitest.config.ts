import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Both the core (src/) and the web app (web/) are covered by one run, so
    // the real-data guard below spans everything rather than leaving a whole
    // directory of tests outside its before/after pair.
    include: ['src/**/*.{test,spec}.ts', 'web/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['**/node_modules/**', 'web/.next/**'],
    // Node, not jsdom, for web/ too: component behaviour is verified through
    // the browser QA gate (browser-qa.md), which is a stronger check than a
    // simulated DOM and does not cost a dependency.
    // Fails the run if the suite changed any real source's crawled data.
    // A globalSetup (not a per-file hook) because the before/after pair has
    // to span the entire run — test files execute in parallel, so nothing
    // inside one of them can observe what another one wrote.
    globalSetup: ['./src/db/real-data-guard.ts'],
  },
});
