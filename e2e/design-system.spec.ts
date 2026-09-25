import { expect, test } from '@playwright/test';

/**
 * These checks used to be visible "content" on the design-system page
 * (`web/app/page.tsx`): a list of real mixed-script titles, the corpus's
 * longest title inside a truncated box, tabular-numeral samples, a focus-ring
 * demo button. Each one was actually a regression guard wearing a content
 * costume — none of it is information a visitor benefits from, and a
 * document/README cannot replace it, because every one of these is only
 * observable at render time in a real browser (font fallback, computed CSS,
 * keyboard focus). They run here instead, against the real screens the
 * product actually ships, not a synthetic specimen.
 */

test('Noto Sans Georgian and Space Mono both load, neither falls back', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => document.fonts.ready);
  const families = await page.evaluate(() =>
    [...document.fonts].map((f) => ({ family: f.family, status: f.status })),
  );
  expect(
    families.some((f) => f.family.includes('Noto Sans Georgian') && f.status === 'loaded'),
    `expected a loaded Noto Sans Georgian face, got: ${JSON.stringify(families)}`,
  ).toBe(true);
  expect(
    families.some((f) => f.family.includes('Space Mono') && f.status === 'loaded'),
    `expected a loaded Space Mono face, got: ${JSON.stringify(families)}`,
  ).toBe(true);
});

test('a mixed Georgian/Latin title renders as one visual family', async ({ page }) => {
  // Real listing titles routinely mix scripts inline (a Latin brand name
  // inside a Georgian sentence). If the active font lacked Georgian
  // coverage, the browser would substitute a different font for just the
  // Georgian portion of the string, splitting one title into two typefaces.
  await page.goto('/listings');
  const title = page.locator('a.truncate').first();
  test.skip((await title.count()) === 0, 'no listing on the current corpus to check');
  await expect(title).toBeVisible();
  const fontFamily = await title.evaluate((el) => getComputedStyle(el).fontFamily);
  expect(fontFamily).toContain('Noto Sans Georgian');
});

test('numeric columns use tabular figures', async ({ page }) => {
  await page.goto('/listings');
  const numeric = page.locator('.numeric').first();
  test.skip((await numeric.count()) === 0, 'no listing on the current corpus to check');
  await expect(numeric).toBeVisible();
  const style = await numeric.evaluate((el) => {
    const computed = getComputedStyle(el);
    return { fontVariantNumeric: computed.fontVariantNumeric, fontFamily: computed.fontFamily };
  });
  expect(style.fontVariantNumeric).toContain('tabular-nums');
  expect(style.fontFamily).toContain('Space Mono');
});

test('a long employer name truncates instead of wrapping or overflowing', async ({ page }) => {
  await page.goto('/listings');
  const truncated = page.locator('span.truncate[title]');
  const count = await truncated.count();
  test.skip(count === 0, 'no truncatable employer name on the current page of results');
  // Find one that is actually clipped, rather than asserting on whichever
  // happens to be first — a short employer name legitimately does not
  // overflow, and that is not a defect.
  for (let i = 0; i < count; i++) {
    const el = truncated.nth(i);
    const { scrollWidth, clientWidth, textOverflow } = await el.evaluate((node) => ({
      scrollWidth: node.scrollWidth,
      clientWidth: node.clientWidth,
      textOverflow: getComputedStyle(node).textOverflow,
    }));
    if (scrollWidth > clientWidth) {
      expect(textOverflow).toBe('ellipsis');
      return;
    }
  }
  test.skip(true, 'no employer name on the current page is long enough to overflow');
});

test('keyboard focus stays visible on a real interactive control', async ({ page }) => {
  // A global CSS reset (`outline: none` applied too broadly) is the usual way
  // this silently breaks. Tabbing for real, rather than calling .focus()
  // programmatically, is what actually engages :focus-visible in Chromium.
  await page.goto('/opportunities');
  let outline = 'none';
  for (let i = 0; i < 15; i++) {
    await page.keyboard.press('Tab');
    outline = await page.evaluate(
      () => getComputedStyle(document.activeElement as Element).outlineStyle,
    );
    if (outline !== 'none') break;
  }
  expect(outline).not.toBe('none');
});

test('the homepage hero video is absent when reduced motion is requested', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.locator('video')).toHaveCount(0);
});

test('the homepage hero video plays when motion is not reduced', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/');
  await expect(page.locator('video')).toHaveCount(1);
});

test('real Georgian titles in the homepage "newest listings" panel render as one family, never uppercased', async ({
  page,
}) => {
  await page.goto('/');
  const title = page.locator('a[href^="/opportunities/"]').first();
  test.skip((await title.count()) === 0, 'no live opportunity to check on this corpus');
  await expect(title).toBeVisible();
  const style = await title.evaluate((el) => {
    const computed = getComputedStyle(el);
    return { fontFamily: computed.fontFamily, textTransform: computed.textTransform };
  });
  expect(style.fontFamily).toContain('Noto Sans Georgian');
  expect(style.textTransform).toBe('none');
});

test('the homepage kicker actually renders with letter-spacing applied', async ({ page }) => {
  // Guards the specific cascade bug this screen's own Codex design review
  // found: an unlayered `p { letter-spacing: normal }` in globals.css beats
  // Tailwind's layered tracking-* utilities regardless of specificity, so
  // `tracking-*` silently does nothing on a bare <p>/<h1>-<h4>. Every
  // tracked element on this page carries it on an inner <span> instead —
  // this proves that pattern actually works, not just that it looks right.
  await page.goto('/');
  const kicker = page.locator('p.numeric span.tracking-\\[0\\.22em\\]').first();
  test.skip(
    ((await kicker.textContent()) ?? '').trim() === '',
    'the kicker is empty on an empty corpus',
  );
  await expect(kicker).toBeVisible();
  const letterSpacing = await kicker.evaluate((el) => getComputedStyle(el).letterSpacing);
  expect(letterSpacing).not.toBe('normal');
});

test('reduced motion leaves the homepage hero fully visible, with no video, strobing dot, or moving ticker', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');

  await expect(page.locator('video')).toHaveCount(0);

  const headline = page.locator('h1').first();
  await expect(headline).toBeVisible();
  const headlineOpacity = await headline
    .locator('span > span')
    .first()
    .evaluate((el) => getComputedStyle(el).opacity);
  expect(headlineOpacity).toBe('1');

  const dot = page.locator('.animate-hero-pulse').first();
  test.skip((await dot.count()) === 0, 'no live data, kicker (and its pulse dot) not rendered');
  const dotOpacity = await dot.evaluate((el) => getComputedStyle(el).opacity);
  expect(Number(dotOpacity)).toBeGreaterThan(0.9);

  const ticker = page.locator('.animate-hero-ticker').first();
  if (await ticker.count()) {
    const before = await ticker.evaluate((el) => getComputedStyle(el).transform);
    await page.waitForTimeout(200);
    const after = await ticker.evaluate((el) => getComputedStyle(el).transform);
    expect(after).toBe(before);

    // A first fix here treated the ticker's own `paused` React state as the
    // only source of "is this stationary" — but globals.css's reduced-
    // motion rule freezes the strip independently of that state, so every
    // real link stayed tabIndex={-1} forever and a "Pause" button sat over
    // content that was already stationary (Codex, 2026-09-15). Both must
    // be genuinely fixed, not just visually stationary.
    const pauseButton = page.getByRole('button', { name: /pause/i });
    await expect(pauseButton).toHaveCount(0);
    const tabbableLinks = ticker.locator('a[data-ticker-id][tabindex="0"]');
    await expect(tabbableLinks.first()).toBeAttached();
  }
});
