import * as cheerio from 'cheerio';
import { isJobsGeUrlAllowed, jobsGeSource } from '../../policies/jobs-ge.js';
import { discoveryFingerprint } from '../discovery-fingerprint.js';

export type AdsPagePartition = 'vip' | 'standard';

/** One listing found on a `/ge/ads/?page=N` discovery page (concept §9's DiscoveredResource, jobs.ge-specific). */
export interface DiscoveredListing {
  /** The numeric ID jobs.ge itself uses as `?id=` — SourceListing.sourceRecordId's value for this source. */
  readonly sourceRecordId: string;
  /** Absolute, policy-checked detail URL — always `https://www.jobs.ge/ge/?view=jobs&id=<sourceRecordId>`. */
  readonly url: string;
  readonly title: string;
  readonly partition: AdsPagePartition;
  /**
   * Title, employer, published and deadline text as the row shows them
   * (Phase 7C). Not the partition: VIP placement is paid promotion, not a
   * change to the vacancy.
   */
  readonly fingerprint: string;
}

export interface ParsedAdsPage {
  readonly vip: readonly DiscoveredListing[];
  readonly standard: readonly DiscoveredListing[];
}

const DETAIL_LINK_SELECTOR = 'a[href*="view=jobs"]';

/**
 * Extracts listings from one section's rows (a `.vipEntries` div or the
 * `#job_list_table` table). Each row carries the detail link twice — once
 * as the title anchor, once as a same-href "open in new window" icon
 * anchor — so this takes the first match per row and dedupes by ID rather
 * than assuming one anchor per row.
 *
 * Deliberately does NOT use the title anchor's own CSS class to decide
 * anything: confirmed against the real fixtures that jobs.ge reuses
 * `class="vip"` on the title link in BOTH the VIP and standard sections
 * (it's a shared text-style class, not a partition marker) — the caller
 * passes `partition` in based on which container this section actually
 * is, which is the only reliable signal.
 */
function extractSectionListings(
  $: cheerio.CheerioAPI,
  sectionSelector: string,
  partition: AdsPagePartition,
): DiscoveredListing[] {
  const listings: DiscoveredListing[] = [];
  const seenIds = new Set<string>();

  $(sectionSelector)
    .find('tr')
    .each((_index, row) => {
      const anchor = $(row).find(DETAIL_LINK_SELECTOR).first();
      const href = anchor.attr('href');
      if (href === undefined) return;

      let resolved: URL;
      try {
        resolved = new URL(href, jobsGeSource.baseUrl);
      } catch {
        return;
      }

      const url = resolved.toString();
      // Re-checks the same authorization boundary every real fetch will be
      // gated on (src/net/http-fetcher.ts), rather than trusting that ID
      // extraction + URL construction here can't produce anything else —
      // fail-closed if the site's markup ever puts something unexpected in
      // this position.
      if (!isJobsGeUrlAllowed(url)) return;

      const id = resolved.searchParams.get('id');
      if (id === null || seenIds.has(id)) return;
      seenIds.add(id);

      const title = anchor.text().trim();
      // Cells: 1 title, 3 employer, 4 published, 5 deadline (the fixtures;
      // RECON_NOTES.md). If the layout shifts, every fingerprint changes
      // once and that run re-fetches everything, which is the safe side.
      const cell = (index: number) => $(row).find('td').eq(index).text();
      listings.push({
        sourceRecordId: id,
        url,
        title,
        partition,
        fingerprint: discoveryFingerprint([title, cell(3), cell(4), cell(5)]),
      });
    });

  return listings;
}

/**
 * Parses one `/ge/ads/?page=N` discovery page into its VIP and standard
 * partitions (RECON_NOTES.md: a `.vipEntries` div and a `#job_list_table`
 * table, structurally disjoint, confirmed zero ID overlap on real pages).
 */
export function parseAdsPage(html: string): ParsedAdsPage {
  const $ = cheerio.load(html);
  return {
    vip: extractSectionListings($, '.vipEntries', 'vip'),
    standard: extractSectionListings($, '#job_list_table', 'standard'),
  };
}
