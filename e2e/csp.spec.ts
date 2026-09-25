import { expect, test } from '@playwright/test';

/**
 * Phase 8E: every page renders under the per-request nonce CSP from
 * `web/proxy.ts` without a single violation. A nonce Next failed to stamp on
 * one of its scripts would not break server-rendered HTML, only hydration,
 * so this watches the console rather than trusting that the page "looks
 * right". The public-surface production build is covered by the privacy
 * suite, which also runs the CV worker under the same policy.
 */

const PATHS = ['/', '/opportunities', '/listings', '/cv-ranked', '/ranked', '/health'];

for (const path of PATHS) {
  test(`${path} runs under the nonce CSP with no violation`, async ({ page }) => {
    const violations: string[] = [];
    page.on('console', (message) => {
      if (/Content.Security.Policy/i.test(message.text())) violations.push(message.text());
    });
    const response = await page.goto(path, { waitUntil: 'networkidle' });
    expect(response?.headers()['content-security-policy']).toMatch(
      /script-src 'self' 'nonce-[A-Za-z0-9+/]+=*' 'strict-dynamic'/,
    );
    // Hydrated: React attached its handlers, which needs every framework
    // script to have run.
    await expect
      .poll(() =>
        page.evaluate(() => Object.keys(document.body).some((key) => key.startsWith('__react'))),
      )
      .toBe(true);
    expect(violations).toEqual([]);
  });
}
