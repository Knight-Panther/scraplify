import { expect, test } from '@playwright/test';

/**
 * Codifies the viewport sweep from the `professional-frontend` skill's
 * browser-qa gate (`.claude/skills/professional-frontend/references/browser-qa.md`)
 * so it runs as a fast, repeatable check instead of a manual Playwright MCP
 * resize-and-inspect pass every time. Same four widths that gate documents.
 */

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'large', width: 1920, height: 1080 },
];

const PATHS = ['/', '/opportunities', '/listings', '/cv-ranked'];

for (const viewport of VIEWPORTS) {
  for (const path of PATHS) {
    test(`no horizontal overflow on ${path} at ${viewport.name} (${viewport.width}px)`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(path);
      const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(
        scrollWidth,
        `${path} at ${viewport.width}px: scrollWidth ${scrollWidth} > clientWidth ${clientWidth}`,
      ).toBeLessThanOrEqual(clientWidth);
    });
  }
}
