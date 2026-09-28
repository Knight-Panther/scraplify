import type { PublicOpportunityDetailView } from '../../src/browse/public-queries.js';
import { heroCopy } from './hero-copy.js';
import { sourceLabel } from './labels.js';
import type { Locale } from './locale.js';
import { locationText } from './opportunity-detail.js';
import { type Surface, currentSurface } from './surface.js';

/**
 * What link previews (Facebook, LinkedIn, X, messengers) and search engines
 * read from the page head, kept out of the layouts so it can be tested.
 */

export const SITE_NAME = 'Xtelo';

/**
 * The hero headline as one sentence, from the hero's own copy (the English
 * runs are set in capitals for the display face; a title reads as a sentence).
 * Previews reuse the site's own words in both languages: no second copy of
 * the Georgian to drift from the page.
 */
function headlineSentence(locale: Locale): string {
  const text = heroCopy(locale)
    .headline.map((line) => line.map((run) => run.text).join(''))
    .join(' ')
    .replace(/s+/g, ' ')
    .trim();
  return locale === 'en' ? text.charAt(0) + text.slice(1).toLowerCase() : text;
}

/** The page title: brand, then the hero headline. */
export function siteTitle(locale: Locale): string {
  return `${SITE_NAME}: ${headlineSentence(locale)}`;
}

/** The hero subhead, which already says what the site is in one sentence. */
export function siteDescription(locale: Locale): string {
  return heroCopy(locale).subhead;
}

/**
 * The banner is Georgian (owner decision, 2026-09-28: Georgian first), and
 * this is the text it shows. Must match `app/opengraph-image.alt.txt` (a test
 * checks).
 */
export const OG_IMAGE_ALT =
  'Xtelo: არ გამოტოვო ვაკანსია, მოძებნე მარტივად! ვაკანსიები jobs.ge-დან და hr.ge-დან, გაერთიანებული ერთ ჩანაწერად';

const OG_LOCALE: Record<Locale, string> = { ka: 'ka_GE', en: 'en_US' };

/**
 * An `openGraph` object for the layout or a page, always with the image.
 *
 * Next merges metadata shallowly: a page that sets its own `openGraph` (to
 * add its `url`, say) replaces the layout's whole object. That also drops the
 * image Next derives from `app/opengraph-image.jpg`, which belongs to the
 * layout's object: the landing page and every job page were shared with no
 * picture (e2e/surfaces/seo.spec.ts, 2026-09-28). So every `openGraph` names
 * the image itself. The file still serves it at `/opengraph-image.jpg`.
 */
export function siteOpenGraph(
  page: { locale?: Locale; title?: string; description?: string; url?: string } = {},
) {
  const locale = page.locale ?? 'ka';
  return {
    type: 'website' as const,
    siteName: SITE_NAME,
    title: page.title ?? siteTitle(locale),
    description: page.description ?? siteDescription(locale),
    locale: OG_LOCALE[locale],
    alternateLocale: [OG_LOCALE[locale === 'ka' ? 'en' : 'ka']],
    images: [
      {
        url: '/opengraph-image.jpg',
        width: 1200,
        height: 630,
        type: 'image/jpeg',
        alt: OG_IMAGE_ALT,
      },
    ],
    ...(page.url === undefined ? {} : { url: page.url }),
  };
}

/** Previews and search results cut descriptions around here. */
const DESCRIPTION_LIMIT = 160;

/**
 * The absolute origin this process is served at, which `og:image`, `og:url`
 * and canonical links are resolved against: a crawler cannot follow a
 * relative image URL. `XTELO_SITE_URL` on `public` (e.g. `https://jobster.fun`);
 * `admin` already has its own origin as `AUTH_URL`. Anything that is not an
 * absolute http(s) URL is ignored rather than trusted, so a typo loses the
 * previews instead of pointing them at another site. `local` normally has
 * neither, and Next then falls back to the request's own host.
 */
export function siteOrigin(
  env: Readonly<Record<string, string | undefined>> = process.env,
  surface: Surface = currentSurface(),
): URL | undefined {
  const raw = surface === 'admin' ? env.AUTH_URL : env.XTELO_SITE_URL;
  if (raw === undefined || raw.trim() === '') return undefined;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    return new URL(url.origin);
  } catch {
    return undefined;
  }
}

/**
 * Only the public catalogue is meant to be found. `admin` is a private
 * dashboard behind sign-in, and `local` is the operator's own machine, so
 * both ask search engines to stay out, on every page and in robots.txt.
 */
export function isIndexable(surface: Surface = currentSurface()): boolean {
  return surface === 'public';
}

function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= limit) return flat;
  const cut = flat.slice(0, limit - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * A job page's description, from what its boards actually state: employer,
 * places and which boards carry it, then the start of the description text.
 * Nothing is invented. A field no board states is left out rather than
 * filled with a placeholder, and the text is the same policy-filtered
 * description the page itself shows, so it can be empty.
 */
export function opportunityDescription(view: PublicOpportunityDetailView): string {
  const members = view.members;
  const employer = members.map((m) => m.organization?.trim() ?? '').find((name) => name !== '');
  const place = members
    .map((m) => locationText(m.locations))
    .find((cell) => cell !== null && cell.kind === 'text');
  const boards = [...new Set(members.map((m) => sourceLabel(m.sourceSlug)))];

  const facts = [
    employer,
    place?.kind === 'text' ? place.value : undefined,
    boards.length > 0 ? `on ${boards.join(' and ')}` : undefined,
  ].filter((part): part is string => part !== undefined && part !== '');

  const lead = facts.join(' · ');
  const body = members.map((m) => m.description.trim()).find((text) => text !== '') ?? '';
  const combined = body === '' ? lead : lead === '' ? body : `${lead}. ${body}`;
  return clip(combined === '' ? siteDescription('en') : combined, DESCRIPTION_LIMIT);
}
