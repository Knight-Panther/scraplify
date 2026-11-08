import type { MetadataRoute } from 'next';

/**
 * Crawlers asked to stay off the whole site, because they bring no visitors.
 * There are two kinds:
 * - AI-training and data crawlers;
 * - SEO tools that map other sites' links for their own customers.
 *
 * From 2026-10-29 to 11-08, 95% of the public site's 188,400 requests came
 * from robots (Caddy's access log). The largest were GPTBot (30%),
 * Reflectionbot (26%), SemrushBot (14%) and AhrefsBot (5%). Over the same
 * time about five real browsers came a day.
 *
 * The rest stay welcome, because they are how people find and share the site:
 * - search engines (Googlebot, Bingbot, YandexBot, Applebot, DuckDuckBot);
 * - AI search that cites and links its sources (OAI-SearchBot, ChatGPT-User,
 *   PerplexityBot, Claude-SearchBot, Claude-User);
 * - link previews (facebookexternalhit, Twitterbot, TelegramBot and the rest).
 * `Google-Extended` and `Applebot-Extended` are only consent tokens: Googlebot
 * and Applebot do the fetching, so naming them would save no load.
 *
 * robots.txt is a request. The crawlers named here say they honour it; one
 * that does not would need a block by User-Agent in Caddy instead.
 */
export const TURNED_AWAY_CRAWLERS = [
  // AI training and data: the first five were seen in the log, the rest are the usual ones.
  'GPTBot',
  'Reflectionbot',
  'Amazonbot',
  'KeenableBot',
  'ElevenlabsCrawler',
  'CCBot',
  'ClaudeBot',
  'Bytespider',
  'meta-externalagent',
  // SEO tools: the first four were seen in the log.
  'SemrushBot',
  'AhrefsBot',
  'SERankingBacklinksBot',
  'DotBot',
  'MJ12bot',
  'BLEXBot',
  'DataForSeoBot',
  'Barkrowler',
  'serpstatbot',
] as const;

/**
 * What `app/robots.ts` serves on this surface.
 * - `public` welcomes crawlers to the catalogue except the ones above, keeps
 *   `/api/*` (data, not pages) out of search, and points at the sitemap.
 * - `admin` and `local` ask every crawler to stay out.
 */
export function robotsRules(indexable: boolean, origin: URL | undefined): MetadataRoute.Robots {
  if (!indexable) {
    return { rules: { userAgent: '*', disallow: '/' } };
  }
  return {
    rules: [
      { userAgent: '*', allow: '/', disallow: '/api/' },
      { userAgent: [...TURNED_AWAY_CRAWLERS], disallow: '/' },
    ],
    ...(origin === undefined ? {} : { sitemap: new URL('/sitemap.xml', origin).href }),
  };
}
