import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { origin } from './servers.js';

/**
 * Phase 8E accessibility evidence (change.md §13: "load/accessibility/
 * security evidence"): axe's WCAG 2.1 A and AA rules on every page the
 * public surface serves, on the real `public` production server. The
 * operator-only `local` controls are out of its scope. This is the automated half. Keyboard operation,
 * focus order and screen-reader wording were checked by hand at each
 * phase's browser QA, and axe cannot replace that.
 */

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

test.use({ channel: 'chrome', baseURL: origin('public') });

async function violations(page: Page): Promise<string[]> {
  // Contrast is measured on the settled page: the landing fades in, and a
  // half-faded element would fail as noise. Infinite ones (the ticker) never settle.
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (animation) =>
          animation.playState !== 'running' ||
          animation.effect?.getTiming().iterations === Number.POSITIVE_INFINITY,
      ),
  );
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return result.violations.map(
    (violation) =>
      `${violation.id} (${violation.impact}): ${violation.help} — ${violation.nodes
        .slice(0, 3)
        .map((node) => node.target.join(' '))
        .join(' | ')}`,
  );
}

for (const path of ['/', '/opportunities', '/listings', '/cv-ranked']) {
  test(`${path} has no WCAG 2.1 AA violation axe can detect`, async ({ page }) => {
    await page.goto(path, { waitUntil: 'networkidle' });
    expect(await violations(page)).toEqual([]);
  });
}

test('an opportunity detail page has no WCAG 2.1 AA violation axe can detect', async ({ page }) => {
  await page.goto('/opportunities', { waitUntil: 'networkidle' });
  const link = page.locator('a[href^="/opportunities/"]').first();
  test.skip((await link.count()) === 0, 'no opportunity on the current corpus to open');
  await page.goto((await link.getAttribute('href')) ?? '/', { waitUntil: 'networkidle' });
  expect(await violations(page)).toEqual([]);
});
