import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
    // Fails the run if the suite changed any real source's crawled data.
    // A globalSetup (not a per-file hook) because the before/after pair has
    // to span the entire run — test files execute in parallel, so nothing
    // inside one of them can observe what another one wrote.
    globalSetup: ['./src/db/real-data-guard.ts'],
  },
});
