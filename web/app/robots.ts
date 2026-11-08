import type { MetadataRoute } from 'next';
import { robotsRules } from '../lib/robots.js';
import { isIndexable, siteOrigin } from '../lib/site-metadata.js';

// Next caches robots.ts at build time by default, and the build runs as
// `local`: a cached file would tell every surface the same thing. The answer
// depends on this process's runtime surface, so it is computed per request.
export const dynamic = 'force-dynamic';

/**
 * `public` welcomes crawlers to the catalogue, except those that bring no
 * visitors (`lib/robots.ts`), and points them at the sitemap. The JSON
 * endpoints behind the pages (`/api/*`) are not pages and stay out of search.
 * `admin` and `local` ask every crawler to stay out entirely; each page also
 * carries its own `noindex`, since robots.txt is only a request.
 */
export default function robots(): MetadataRoute.Robots {
  return robotsRules(isIndexable(), siteOrigin());
}
