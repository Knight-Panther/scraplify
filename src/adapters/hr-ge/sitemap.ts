import * as cheerio from 'cheerio';
import { isHrGeUrlAllowed } from '../../policies/hr-ge.js';

/** One announcement URL found in the public sitemap. */
export interface SitemapAnnouncementCandidate {
  readonly sourceRecordId: string;
  readonly url: string;
}

export class SitemapParseError extends Error {
  constructor(reason: string) {
    super(`hr.ge sitemap does not match the expected structure: ${reason}`);
    this.name = 'SitemapParseError';
  }
}

const ANNOUNCEMENT_LOC_RE = /^https:\/\/www\.hr\.ge\/announcement\/([1-9][0-9]*)\/[^/?#]+\/?$/;

/**
 * Parses hr.ge's public sitemap (a single flat `<urlset>`, no child
 * sitemaps to follow — RECON_NOTES.md) into candidate announcement IDs.
 *
 * ADDITIVE CROSS-CHECK ONLY. Measured 2026-09-05 against a full index
 * walk: the sitemap contains exactly the ~33% of the corpus that is
 * paid/priority and zero free listings, with no `<lastmod>` anywhere in
 * the document. Using it as a reconciliation oracle would make every free
 * listing look absent on a perfectly healthy run and mass-close them —
 * concept §10.2's own "never infer mass closure from a single reduced
 * result set." The return type is named "candidate," not "current
 * membership," deliberately: a caller may only use this to ADD ids
 * discovery might have missed, never to decide anything is absent —
 * mirroring how Phase 1A's closeMissingListings was hardened to read
 * completeness from its own persisted crawl_runs row rather than trust a
 * caller's claim (docs/STATUS.md).
 *
 * Uses cheerio's XML mode rather than a dedicated XML parser dependency —
 * concept §20's "do not install later-phase dependencies during
 * foundation work," and cheerio is already a project dependency for HTML.
 *
 * Throws when no `<url>` entries are found at all — genuine structural
 * drift (a changed sitemap format, or, note the caveat below, content
 * this function received that wasn't actually the XML it expected). Does
 * NOT throw on a `<url>` entry whose `<loc>` isn't an announcement path
 * (customer/, jobs/, jobs-in/, search-posting, or the one third-host
 * `customer.hr.ge` entry RECON_NOTES.md found) — those are simply
 * filtered out, not a parse failure.
 *
 * The shared fetcher decodes compressed responses before this parser runs,
 * bounding both wire and expanded bytes. A live zstd response was verified
 * through that path on 2026-09-05; see docs/STATUS.md for the canary result.
 */
export function parseHrGeSitemap(xml: string): SitemapAnnouncementCandidate[] {
  const $ = cheerio.load(xml, { xmlMode: true });
  const urlElements = $('url');
  if (urlElements.length === 0) {
    throw new SitemapParseError('no <url> entries found');
  }

  const candidates: SitemapAnnouncementCandidate[] = [];
  const seen = new Set<string>();

  urlElements.each((_index, el) => {
    const loc = $(el).children('loc').first().text().trim();
    const match = ANNOUNCEMENT_LOC_RE.exec(loc);
    const id = match?.[1];
    if (id === undefined || seen.has(id)) return;
    if (!isHrGeUrlAllowed(loc)) return;
    seen.add(id);
    candidates.push({ sourceRecordId: id, url: loc });
  });

  return candidates;
}
