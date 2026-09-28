import type { MetadataRoute } from 'next';
import { publicSitemapOpportunities } from '../../src/browse/public-queries.js';
import { db } from '../../src/db/client.js';
import { isIndexable, siteOrigin } from '../lib/site-metadata.js';

// Per request, never cached at build: the list comes from the database and
// the answer depends on the runtime surface (see robots.ts).
export const dynamic = 'force-dynamic';

/**
 * The public pages a search engine should know about: the landing page, the
 * two lists, CV Ranked, and every open vacancy's own page, straight from the
 * public views (`publicSitemapOpportunities`, the Browse eligibility rule).
 * Empty on `admin` and `local`, which are not meant to be indexed, and
 * without an origin, since a sitemap URL must be absolute.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = siteOrigin();
  if (!isIndexable() || origin === undefined) return [];
  const at = (path: string) => new URL(path, origin).href;

  const opportunities = await publicSitemapOpportunities(db);
  return [
    { url: at('/'), changeFrequency: 'daily', priority: 1 },
    { url: at('/opportunities'), changeFrequency: 'daily', priority: 0.9 },
    { url: at('/listings'), changeFrequency: 'daily', priority: 0.6 },
    { url: at('/cv-ranked'), changeFrequency: 'weekly', priority: 0.5 },
    ...opportunities.map((row) => ({
      url: at(`/opportunities/${row.opportunityId}`),
      // The view returns Postgres text (`2026-09-06 15:58:57.973+00`); sitemaps
      // require W3C datetime.
      lastModified: new Date(row.updatedAt).toISOString(),
      changeFrequency: 'daily' as const,
      priority: 0.7,
    })),
  ];
}
