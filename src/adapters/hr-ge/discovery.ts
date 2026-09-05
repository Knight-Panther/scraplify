import * as cheerio from 'cheerio';
import { hrGeSource, isHrGeUrlAllowed } from '../../policies/hr-ge.js';
import { extractNgState, findNgStateEntry } from './ng-state.js';

/** One listing found on a `/search-posting?pg=N` discovery page. */
export interface DiscoveredListing {
  /** hr.ge's own numeric `announcementId` — SourceListing.sourceRecordId's value for this source. */
  readonly sourceRecordId: string;
  /** Absolute, policy-checked detail URL: `https://www.hr.ge/announcement/<id>/<slug>`. */
  readonly url: string;
  readonly title: string;
  /** Confirmed to exactly determine sitemap membership (RECON_NOTES.md); not a VIP/standard-style container split — every tier is interleaved in one list. */
  readonly isPriority: boolean;
  readonly listingSection: number;
  /** ISO timestamp with year, unlike jobs.ge — never yearless (RECON_NOTES.md). */
  readonly publishDate: string | null;
  readonly renewalDate: string | null;
  readonly deadlineDate: string | null;
}

export interface ParsedSearchPostingPage {
  readonly listings: readonly DiscoveredListing[];
  /**
   * The source's own claimed total corpus size, from the same response
   * (RECON_NOTES.md: "a free completeness oracle") — lets a caller compare
   * what it actually collected against what hr.ge itself says exists,
   * stronger evidence than a fixed floor or a purely historical ratio.
   */
  readonly totalCount: number;
}

export class SearchPostingParseError extends Error {
  constructor(reason: string) {
    super(`hr.ge search-posting page does not match the expected structure: ${reason}`);
    this.name = 'SearchPostingParseError';
  }
}

const ANNOUNCEMENT_SEARCH_URL_RE = /\/api\/v3\/announcement-search$/;
const DOM_ANNOUNCEMENT_HREF_RE = /^\/announcement\/([1-9][0-9]*)\/([^/?#]+)/;

/**
 * Maps announcementId -> slug from the page's own DOM anchors. The
 * ng-state item for each listing carries no slug (RECON_NOTES.md: it's
 * decorative, derived from the title, and would change if a title were
 * edited) but a fetchable, policy-compliant detail URL still needs one —
 * isHrGeUrlAllowed's shape requires `/announcement/<digits>/<slug>`. Reading
 * it from the real anchor rather than deriving one from the title avoids
 * guessing at hr.ge's own slugification rules.
 */
function extractSlugsById($: cheerio.CheerioAPI): Map<number, string> {
  const slugs = new Map<number, string>();
  $('a[href*="/announcement/"]').each((_index, el) => {
    const href = $(el).attr('href');
    if (href === undefined) return;
    let path: string;
    try {
      path = new URL(href, hrGeSource.baseUrl).pathname;
    } catch {
      return;
    }
    const match = DOM_ANNOUNCEMENT_HREF_RE.exec(path);
    const idGroup = match?.[1];
    const slugGroup = match?.[2];
    if (idGroup === undefined || slugGroup === undefined) return;
    const id = Number(idGroup);
    if (!slugs.has(id)) slugs.set(id, slugGroup);
  });
  return slugs;
}

/**
 * Parses one `/search-posting?pg=N` page. Recommended parse target per
 * RECON_NOTES.md: the ng-state `announcement-search` JSON entry is the
 * primary source (typed values, real ISO timestamps) — the DOM is only
 * consulted for the real anchor slug each listing needs for a fetchable
 * URL, a structural cross-check this function already relies on.
 *
 * Throws when the island is absent/unparseable, or when the
 * announcement-search entry or its `items`/`totalCount` shape is missing —
 * real structural drift a caller must quarantine (concept §6.2's "throw on
 * absent structure, not on an empty value" — jobs-ge's ninth adversarial
 * review round learned this the hard way for a scaffold that degrades
 * quietly rather than failing loudly, docs/STATUS.md). Does NOT throw when
 * a listing lacks a matching DOM anchor for its slug — that listing is
 * simply skipped (no policy-compliant URL can be built for it), which is a
 * per-listing gap the caller's own coverage/health checks see via a lower
 * `listings.length` than `totalCount`, not a whole-page parse failure.
 */
export function parseSearchPostingPage(html: string): ParsedSearchPostingPage {
  const $ = cheerio.load(html);
  const state = extractNgState($);
  const entry = findNgStateEntry(state, ANNOUNCEMENT_SEARCH_URL_RE);
  if (entry === null) {
    throw new SearchPostingParseError('no announcement-search entry found in the ng-state island');
  }

  const body = entry.b as { data?: { announcements?: { items?: unknown; totalCount?: unknown } } };
  const announcements = body?.data?.announcements;
  if (announcements === undefined || !Array.isArray(announcements.items)) {
    throw new SearchPostingParseError(
      'announcement-search entry has no data.announcements.items[]',
    );
  }
  if (typeof announcements.totalCount !== 'number') {
    throw new SearchPostingParseError(
      'announcement-search entry has no data.announcements.totalCount',
    );
  }

  const slugsById = extractSlugsById($);
  const listings: DiscoveredListing[] = [];
  const seenIds = new Set<string>();

  for (const item of announcements.items) {
    if (item === null || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (typeof record.announcementId !== 'number') continue;

    const slug = slugsById.get(record.announcementId);
    if (slug === undefined) continue; // no matching anchor -> no compliant URL can be built

    const sourceRecordId = String(record.announcementId);
    if (seenIds.has(sourceRecordId)) continue;

    let url: string;
    try {
      url = new URL(`/announcement/${sourceRecordId}/${slug}`, hrGeSource.baseUrl).toString();
    } catch {
      continue;
    }
    // Re-checks the same authorization boundary every real fetch will be
    // gated on (src/net/http-fetcher.ts) rather than trusting slug
    // extraction alone can't produce something unexpected — fail-closed if
    // the site's markup ever puts something unusual in an href attribute.
    if (!isHrGeUrlAllowed(url)) continue;

    seenIds.add(sourceRecordId);
    listings.push({
      sourceRecordId,
      url,
      title: typeof record.title === 'string' ? record.title : '',
      isPriority: record.isPriority === true,
      listingSection: typeof record.listingSection === 'number' ? record.listingSection : 0,
      publishDate: typeof record.publishDate === 'string' ? record.publishDate : null,
      renewalDate: typeof record.renewalDate === 'string' ? record.renewalDate : null,
      deadlineDate: typeof record.deadlineDate === 'string' ? record.deadlineDate : null,
    });
  }

  return { listings, totalCount: announcements.totalCount };
}
