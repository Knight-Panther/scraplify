import {
  LISTING_SPLIT_FACETS,
  type ListingSplitFacet,
} from '../../policies/summerschoolsineurope-eu.js';
import type { CourseCard, FacetChoice, ParsedListingPage } from './listing.js';

/**
 * The covering walk (RECON_NOTES, "Membership"). The listing is shuffled on
 * every page, so paging never shows every course; but a filtered result of
 * one page or less is complete on its page 1, and a facet takes several
 * values as OR. The walk reads the upcoming set's page 1, and where the set
 * is larger than a page splits it by the facet that does so most cheaply,
 * packing that facet's small values into OR-groups of up to a page and
 * splitting its large values again. A set that no facet splits further is
 * asked again (each request is shuffled anew) until its distinct courses
 * reach its own count. Every set is checked against the site's own
 * `total_rows`, so the walk knows whether it saw every course.
 */

/** Facet filters, in the order they were applied: `[facet, values]`, values OR-ed. */
export type Filters = ReadonlyArray<readonly [ListingSplitFacet, readonly string[]]>;

/** Reads page 1 of a filtered listing; null when the request failed after its tries. */
export type ReadListing = (filters: Filters) => Promise<ParsedListingPage | null>;

export interface CoverOptions {
  /** Courses on one page. */
  capacity?: number;
  /** Listing requests one walk may make, root included. */
  maxRequests?: number;
  /** Extra page-1 requests for a set no facet splits. */
  maxResamples?: number;
  /**
   * Whether a facet value may be asked for. A refused value is left out of
   * every split and reported in `rejectedValues`; its courses count as
   * unseen unless another facet reaches them.
   */
  acceptValue?: (facet: ListingSplitFacet, value: string) => boolean;
}

export interface RejectedValue {
  facet: ListingSplitFacet;
  value: string;
  count: number;
}

export interface CoverResult {
  /** Every course seen, by post id; a later sighting replaces an earlier one. */
  cards: Map<string, CourseCard>;
  /** Every course the upcoming set counts was seen, and no request failed or was cut by the budget. */
  complete: boolean;
  /** No request failed. */
  requestsOk: boolean;
  requests: number;
  /** Result sets read (each node of the walk). */
  resultSets: number;
  resamples: number;
  rootTotal: number | null;
  /** Courses the upcoming set counts that the walk never saw. */
  uncovered: number;
  /** The root's facet choices (the crawl reads discipline names and slugs from them). */
  rootFacets: Record<string, FacetChoice[]>;
  /** Facet values `acceptValue` refused, each once, with the count where it was first refused. */
  rejectedValues: RejectedValue[];
}

const DEFAULT_CAPACITY = 12;
const DEFAULT_MAX_REQUESTS = 400;
const DEFAULT_MAX_RESAMPLES = 4;
/** Re-asking pays off only for a set a few pages long. */
const RESAMPLE_MAX_PAGES = 3;

const sumCounts = (choices: readonly FacetChoice[]): number =>
  choices.reduce((sum, choice) => sum + choice.count, 0);

/**
 * Small values packed into OR-groups of at most `capacity` courses (first fit,
 * largest first); values with more courses than a page are returned as `big`
 * to be split again. Values with no course are dropped.
 */
export function packGroups(
  choices: readonly FacetChoice[],
  capacity: number,
): { groups: FacetChoice[][]; big: FacetChoice[] } {
  const big: FacetChoice[] = [];
  const groups: { total: number; members: FacetChoice[] }[] = [];
  const small = choices
    .filter((choice) => choice.count > 0)
    .filter((choice) => {
      if (choice.count > capacity) big.push(choice);
      return choice.count <= capacity;
    })
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  for (const choice of small) {
    const group = groups.find((candidate) => candidate.total + choice.count <= capacity);
    if (group === undefined) groups.push({ total: choice.count, members: [choice] });
    else {
      group.total += choice.count;
      group.members.push(choice);
    }
  }
  return { groups: groups.map((group) => group.members), big };
}

/** Requests a split by these choices costs, roughly: one per group, and a few per large value. */
function splitCost(choices: readonly FacetChoice[], capacity: number): number {
  const { groups, big } = packGroups(choices, capacity);
  return (
    groups.length + big.reduce((cost, choice) => cost + 1 + Math.ceil(choice.count / capacity), 0)
  );
}

/**
 * The facet to split a set of `total` courses by: one not used yet, whose
 * every value holds fewer than the whole set (or it would split nothing).
 * A facet whose counts sum exactly to the set comes first (one value per
 * course, as country, city and start month have); then one whose counts sum
 * past it (several values per course, as disciplines: some courses may still
 * have none); then one that leaves courses out. Within each, the cheapest,
 * then the fixed order. Null when no facet can split the set.
 */
export function chooseSplitFacet(
  facets: Readonly<Record<string, readonly FacetChoice[]>>,
  used: ReadonlySet<string>,
  total: number,
  capacity: number,
): ListingSplitFacet | null {
  let best: { facet: ListingSplitFacet; rank: number; cost: number } | null = null;
  for (const facet of LISTING_SPLIT_FACETS) {
    if (used.has(facet)) continue;
    const choices = (facets[facet] ?? []).filter((choice) => choice.count > 0);
    if (choices.length === 0) continue;
    if (choices.some((choice) => choice.count >= total)) continue;
    const sum = sumCounts(choices);
    const rank = sum === total ? 0 : sum > total ? 1 : 2;
    const cost = splitCost(choices, capacity);
    if (best === null || rank < best.rank || (rank === best.rank && cost < best.cost)) {
      best = { facet, rank, cost };
    }
  }
  return best?.facet ?? null;
}

export async function coverListing(
  read: ReadListing,
  options: CoverOptions = {},
): Promise<CoverResult> {
  const capacity = options.capacity ?? DEFAULT_CAPACITY;
  const maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS;
  const maxResamples = options.maxResamples ?? DEFAULT_MAX_RESAMPLES;
  const acceptValue = options.acceptValue ?? (() => true);
  const rejected = new Map<string, RejectedValue>();
  const result: CoverResult = {
    cards: new Map(),
    complete: true,
    requestsOk: true,
    requests: 0,
    resultSets: 0,
    resamples: 0,
    rootTotal: null,
    uncovered: 0,
    rootFacets: {},
    rejectedValues: [],
  };

  const ask = async (filters: Filters): Promise<ParsedListingPage | null> => {
    if (result.requests >= maxRequests) {
      result.complete = false;
      return null;
    }
    result.requests++;
    const page = await read(filters);
    if (page === null) {
      result.requestsOk = false;
      result.complete = false;
      return null;
    }
    for (const card of page.cards) result.cards.set(card.postId, card);
    return page;
  };

  /** Covers one set whose page 1 is already read; returns the ids seen in it. */
  const cover = async (filters: Filters, page: ParsedListingPage): Promise<Set<string>> => {
    result.resultSets++;
    const ids = new Set(page.cards.map((card) => card.postId));
    const total = page.pager.totalRows;

    if (total > capacity) {
      // Split by the best facet; if that leaves the set short (a multi-valued
      // facet some courses lack, or a refused value), by the next one.
      const used = new Set<string>(filters.map(([facet]) => facet));
      for (
        let facet = chooseSplitFacet(page.facets, used, total, capacity);
        facet !== null && ids.size < total;
        facet = chooseSplitFacet(page.facets, used, total, capacity)
      ) {
        used.add(facet);
        const accepted: FacetChoice[] = [];
        for (const choice of page.facets[facet] ?? []) {
          if (acceptValue(facet, choice.value)) accepted.push(choice);
          else if (choice.count > 0 && !rejected.has(`${facet}=${choice.value}`)) {
            rejected.set(`${facet}=${choice.value}`, {
              facet,
              value: choice.value,
              count: choice.count,
            });
          }
        }
        const { groups, big } = packGroups(accepted, capacity);
        const children = [
          ...groups.map((group) => group.map((choice) => choice.value)),
          ...big.map((choice) => [choice.value]),
        ];
        for (const values of children) {
          const childFilters: Filters = [...filters, [facet, values]];
          const child = await ask(childFilters);
          if (child === null) continue;
          for (const id of await cover(childFilters, child)) ids.add(id);
        }
      }
    }

    // A set short of its own count is asked again while that can still pay off.
    for (
      let attempt = 0;
      ids.size < total && attempt < maxResamples && total <= capacity * RESAMPLE_MAX_PAGES;
      attempt++
    ) {
      const again = await ask(filters);
      if (again === null) break;
      result.resamples++;
      for (const card of again.cards) ids.add(card.postId);
    }
    return ids;
  };

  const root = await ask([]);
  if (root === null) return result;
  result.rootTotal = root.pager.totalRows;
  result.rootFacets = root.facets;
  // Complete means every course the upcoming set counts was seen: a set that
  // fell short is fine when another split reached its courses.
  const seen = await cover([], root);
  result.uncovered = Math.max(0, root.pager.totalRows - seen.size);
  if (result.uncovered > 0) result.complete = false;
  result.rejectedValues = [...rejected.values()];
  return result;
}
