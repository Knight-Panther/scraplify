import { expect, request, test } from '@playwright/test';
import { origin, type SurfaceName } from './servers.js';

/**
 * What link-preview crawlers (Facebook, LinkedIn, X) and search engines get
 * from each surface, from the real production build. The page head is read
 * as raw HTML, the way those crawlers read it: they run no JavaScript.
 */

async function get(surface: SurfaceName, path: string) {
  const context = await request.newContext({ baseURL: origin(surface) });
  const response = await context.get(path, { maxRedirects: 0 });
  const result = {
    status: response.status(),
    headers: response.headers(),
    text: await response.text(),
    body: await response.body(),
  };
  await context.dispose();
  return result;
}

function meta(html: string, attr: 'property' | 'name', key: string): string | undefined {
  const tag = html.match(new RegExp(`<meta[^>]*${attr}="${key}"[^>]*>`))?.[0];
  return tag?.match(/content="([^"]*)"/)?.[1];
}

test.describe('public: link previews and search', () => {
  test('the landing page carries absolute Open Graph and X tags', async () => {
    const { text } = await get('public', '/');
    const image = meta(text, 'property', 'og:image');
    expect(image).toMatch(/^http:\/\/127\.0\.0\.1:3101\/opengraph-image\.jpg/);
    // Exactly one: a page's own openGraph once dropped the layout's image.
    expect(text.match(/property="og:image"/g)?.length).toBe(1);
    expect(meta(text, 'property', 'og:image:width')).toBe('1200');
    expect(meta(text, 'property', 'og:image:height')).toBe('630');
    expect(meta(text, 'property', 'og:image:alt')).toBeTruthy();
    expect(meta(text, 'property', 'og:title')).toContain('Xtelo');
    expect(meta(text, 'property', 'og:description')).toBeTruthy();
    expect(meta(text, 'property', 'og:site_name')).toBe('Xtelo');
    expect(meta(text, 'property', 'og:url')).toBe('http://127.0.0.1:3101');
    expect(meta(text, 'name', 'twitter:card')).toBe('summary_large_image');
    expect(text).toMatch(/<link rel="canonical" href="http:\/\/127\.0\.0\.1:3101"/);
    expect(meta(text, 'name', 'robots')).toBe('index, follow');
  });

  test('a crawler, which sends no cookie, gets the Georgian page and preview', async () => {
    const { text } = await get('public', '/');
    expect(meta(text, 'property', 'og:locale')).toBe('ka_GE');
    expect(meta(text, 'property', 'og:title')).toBe(
      'Xtelo: არ გამოტოვო ვაკანსია, მოძებნე მარტივად!',
    );
    expect(text).toMatch(/<main lang="ka"/);
    expect(text).toContain('<title>Xtelo: არ გამოტოვო ვაკანსია, მოძებნე მარტივად!</title>');
  });

  test('a visitor who chose English gets the English preview', async () => {
    const context = await request.newContext({
      baseURL: origin('public'),
      extraHTTPHeaders: { cookie: 'xtelo-locale=en' },
    });
    const text = await (await context.get('/')).text();
    await context.dispose();
    expect(meta(text, 'property', 'og:locale')).toBe('en_US');
    expect(text).toMatch(/<main lang="en"/);
  });

  test('the preview image is a 1200x630 JPEG a crawler can fetch', async () => {
    const { text } = await get('public', '/');
    const image = new URL(meta(text, 'property', 'og:image') ?? '');
    const reply = await get('public', image.pathname + image.search);
    expect(reply.status).toBe(200);
    expect(reply.headers['content-type']).toBe('image/jpeg');
    expect(reply.body.length).toBeLessThan(300_000);
  });

  test('robots.txt allows the catalogue and points at the sitemap', async () => {
    const { status, text } = await get('public', '/robots.txt');
    expect(status).toBe(200);
    expect(text).toContain('Allow: /');
    expect(text).toContain('Disallow: /api/');
    expect(text).toContain('Sitemap: http://127.0.0.1:3101/sitemap.xml');
  });

  test('the sitemap lists the public pages with absolute URLs', async () => {
    const { status, text, headers } = await get('public', '/sitemap.xml');
    expect(status).toBe(200);
    expect(headers['content-type']).toContain('xml');
    for (const path of ['/', '/opportunities', '/listings', '/cv-ranked']) {
      expect(text).toContain(`<loc>http://127.0.0.1:3101${path}</loc>`);
    }
    expect(text).not.toContain('/admin');
    // W3C datetime, not the view's Postgres text (`2026-09-06 15:58:57+00`).
    for (const stamp of text.matchAll(/<lastmod>([^<]*)<\/lastmod>/g)) {
      expect(stamp[1]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
  });

  test('a job page names its vacancy in title, preview and canonical link', async () => {
    const list = await get('public', '/opportunities');
    const id = list.text.match(/href="\/opportunities\/([0-9a-f-]{36})/)?.[1];
    test.skip(id === undefined, 'no public opportunity in this database');
    const { text } = await get('public', `/opportunities/${id}`);
    const title = text.match(/<title>([^<]*)<\/title>/)?.[1] ?? '';
    expect(title).not.toBe('Opportunity · Xtelo');
    expect(title.endsWith(' · Xtelo')).toBe(true);
    expect(meta(text, 'property', 'og:url')).toBe(`http://127.0.0.1:3101/opportunities/${id}`);
    expect(meta(text, 'name', 'description')?.length ?? 0).toBeGreaterThan(0);
    expect(meta(text, 'property', 'og:image')).toMatch(/\/opengraph-image\.jpg/);
    expect(text.match(/property="og:image"/g)?.length).toBe(1);
  });

  test('the hero paints from a server-rendered poster, not the late video', async () => {
    const { text } = await get('public', '/');
    expect(text).toMatch(/<img[^>]*src="\/hero-poster\.v2\.webp"[^>]*fetchPriority="high"/i);
  });

  test('versioned media are cached for a year', async () => {
    for (const path of ['/hero-bg.v2.mp4', '/hero-poster.v2.webp', '/logo.v2.webp']) {
      const { headers } = await get('public', path);
      expect(headers['cache-control']).toBe('public, max-age=31536000, immutable');
    }
  });
});

test.describe('admin and local stay out of search', () => {
  test('admin robots.txt disallows everything', async () => {
    const { status, text } = await get('admin', '/robots.txt');
    expect(status).toBe(200);
    expect(text).toContain('Disallow: /');
    expect(text).not.toContain('Sitemap:');
  });

  test('admin serves no sitemap', async () => {
    expect((await get('admin', '/sitemap.xml')).status).toBe(404);
  });

  test('local pages ask not to be indexed', async () => {
    const { text } = await get('local', '/');
    expect(meta(text, 'name', 'robots')).toBe('noindex, nofollow');
  });

  test('local robots.txt disallows everything', async () => {
    const { text } = await get('local', '/robots.txt');
    expect(text).toContain('Disallow: /');
  });
});
