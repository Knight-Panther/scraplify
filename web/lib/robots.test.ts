import { describe, expect, it } from 'vitest';
import { robotsRules, TURNED_AWAY_CRAWLERS } from './robots.js';

const ORIGIN = new URL('https://jobster.fun');

// The crawlers that bring people: search engines, AI search that links its
// sources, and the previews of a shared link.
const WELCOME = [
  'Googlebot',
  'Googlebot-Image',
  'Bingbot',
  'YandexBot',
  'Applebot',
  'DuckDuckBot',
  'OAI-SearchBot',
  'ChatGPT-User',
  'PerplexityBot',
  'Perplexity-User',
  'Claude-SearchBot',
  'Claude-User',
  'facebookexternalhit',
  'Twitterbot',
  'LinkedInBot',
  'TelegramBot',
  'WhatsApp',
  'Slackbot',
  'Discordbot',
];

describe('robotsRules', () => {
  it('on public, welcomes crawlers to the catalogue, keeps /api/ out and points at the sitemap', () => {
    const robots = robotsRules(true, ORIGIN);
    const rules = Array.isArray(robots.rules) ? robots.rules : [robots.rules];
    expect(rules[0]).toEqual({ userAgent: '*', allow: '/', disallow: '/api/' });
    expect(robots.sitemap).toBe('https://jobster.fun/sitemap.xml');
  });

  it('turns the listed crawlers away from the whole site, in one group', () => {
    const robots = robotsRules(true, ORIGIN);
    const rules = Array.isArray(robots.rules) ? robots.rules : [robots.rules];
    expect(rules).toHaveLength(2);
    expect(rules[1]).toEqual({ userAgent: [...TURNED_AWAY_CRAWLERS], disallow: '/' });
    // The heaviest in the log, 2026-10-29 to 11-08.
    for (const name of [
      'GPTBot',
      'Reflectionbot',
      'SemrushBot',
      'AhrefsBot',
      'Amazonbot',
      'SERankingBacklinksBot',
    ]) {
      expect(TURNED_AWAY_CRAWLERS).toContain(name);
    }
  });

  it('never turns away a search engine, an AI search that links back, or a link preview', () => {
    // A crawler picks the group whose name matches its own, and some fall back
    // on a shorter prefix (Googlebot-Image reads Googlebot's group). So no
    // listed name may equal or prefix a welcome one, or the other way round.
    for (const welcome of WELCOME) {
      for (const away of TURNED_AWAY_CRAWLERS) {
        const [a, b] = [welcome.toLowerCase(), away.toLowerCase()];
        expect(a.startsWith(b) || b.startsWith(a), `${away} would also match ${welcome}`).toBe(
          false,
        );
      }
    }
  });

  it('lists each crawler once', () => {
    const lower = TURNED_AWAY_CRAWLERS.map((name) => name.toLowerCase());
    expect(new Set(lower).size).toBe(lower.length);
  });

  it('leaves the sitemap out when the origin is unknown', () => {
    expect(robotsRules(true, undefined).sitemap).toBeUndefined();
  });

  it('on admin and local, asks every crawler to stay out', () => {
    expect(robotsRules(false, ORIGIN)).toEqual({ rules: { userAgent: '*', disallow: '/' } });
  });
});
