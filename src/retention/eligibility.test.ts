import { describe, expect, it } from 'vitest';
import { type ClusterClosureInput, closeOverClusters } from './eligibility.js';

/**
 * Pure unit tests for tier 3's cluster-closure decision (plan §3) — no
 * database. `run-retention.test.ts` covers `loadClusterGraph` and the real
 * deletes against a throwaway Postgres; these tests only exercise the
 * decision logic itself, given an already-loaded graph.
 */

function graph(overrides: Partial<ClusterClosureInput> = {}): ClusterClosureInput {
  return {
    candidateListingIds: new Set(),
    opportunityMembers: new Map(),
    listingOpportunities: new Map(),
    opportunitiesWithUserData: new Set(),
    ...overrides,
  };
}

describe('closeOverClusters', () => {
  it('deletes a single-member opportunity whose only listing is a candidate', () => {
    const result = closeOverClusters(
      graph({
        candidateListingIds: new Set(['l1']),
        opportunityMembers: new Map([['o1', ['l1']]]),
        listingOpportunities: new Map([['l1', ['o1']]]),
      }),
    );
    expect(result.deletableOpportunityIds).toEqual(new Set(['o1']));
    expect(result.deletableListingIds).toEqual(new Set(['l1']));
  });

  it('keeps an opportunity whose only listing is NOT a candidate', () => {
    // l1 is in the graph (it was a cluster-mate of some candidate) but is not
    // itself a candidate — still active, say.
    const result = closeOverClusters(
      graph({
        candidateListingIds: new Set(),
        opportunityMembers: new Map([['o1', ['l1']]]),
        listingOpportunities: new Map([['l1', ['o1']]]),
      }),
    );
    expect(result.deletableOpportunityIds.size).toBe(0);
    expect(result.deletableListingIds.size).toBe(0);
  });

  it('keeps a whole two-member cluster when only one member is a candidate (entangled)', () => {
    const result = closeOverClusters(
      graph({
        candidateListingIds: new Set(['dead-listing']),
        opportunityMembers: new Map([['o1', ['dead-listing', 'live-listing']]]),
        listingOpportunities: new Map([
          ['dead-listing', ['o1']],
          ['live-listing', ['o1']],
        ]),
      }),
    );
    expect(result.deletableOpportunityIds.size).toBe(0);
    expect(result.deletableListingIds.size).toBe(0);
  });

  it('deletes a two-member cluster only once BOTH members are candidates', () => {
    const result = closeOverClusters(
      graph({
        candidateListingIds: new Set(['l1', 'l2']),
        opportunityMembers: new Map([['o1', ['l1', 'l2']]]),
        listingOpportunities: new Map([
          ['l1', ['o1']],
          ['l2', ['o1']],
        ]),
      }),
    );
    expect(result.deletableOpportunityIds).toEqual(new Set(['o1']));
    expect(result.deletableListingIds).toEqual(new Set(['l1', 'l2']));
  });

  it('keeps an opportunity that carries user data even if every member is a candidate', () => {
    const result = closeOverClusters(
      graph({
        candidateListingIds: new Set(['l1']),
        opportunityMembers: new Map([['o1', ['l1']]]),
        listingOpportunities: new Map([['l1', ['o1']]]),
        opportunitiesWithUserData: new Set(['o1']),
      }),
    );
    expect(result.deletableOpportunityIds.size).toBe(0);
    expect(result.deletableListingIds.size).toBe(0);
  });

  it('propagates a poisoned listing through its ENTIRE reassignment history, not just the opportunity it poisoned first (the P1 this fixpoint fixes)', () => {
    // l1 currently lives in o2 (looks like a clean, fully-candidate cluster
    // in isolation) but was ALSO once a member of o1 (retired membership),
    // which still holds a non-candidate listing. §12.5's append-only history
    // means l1's own row can never be deleted while EITHER of its
    // ever-opportunities survives — so o1's poison must propagate through
    // l1 into o2, and through o2 into l2, even though l2 has no direct
    // relationship to the non-candidate listing at all.
    //
    // A two-step lookup (candidate-only, the bug) wrongly marks o2 and l2
    // deletable here: it never re-checks o2's members against l1's OWN
    // fate, only against the base "is l1 a candidate" fact, which is true.
    // Deleting o2 while l1's live membership row in it survives (l1 itself
    // is never deleted, since o1 keeps it) is exactly the corruption the
    // fixpoint exists to prevent.
    const result = closeOverClusters(
      graph({
        candidateListingIds: new Set(['l1', 'l2']),
        opportunityMembers: new Map([
          ['o1', ['l1', 'not-a-candidate']],
          ['o2', ['l1', 'l2']],
        ]),
        listingOpportunities: new Map([
          ['l1', ['o1', 'o2']],
          ['l2', ['o2']],
          ['not-a-candidate', ['o1']],
        ]),
      }),
    );
    // Nothing in this connected component is safe: o1 is blocked directly
    // (a non-candidate member), which blocks l1 (still owes o1 a live row),
    // which blocks o2 (l1's membership in it would survive), which blocks
    // l2 (its only ever-opportunity is no longer deletable).
    expect(result.deletableOpportunityIds.size).toBe(0);
    expect(result.deletableListingIds.size).toBe(0);
  });

  it('does NOT let one poisoned cluster block a second, disjoint one', () => {
    // Same poisoned o1/l1 shape as above, plus a completely separate
    // fully-candidate cluster (o3/l3) that shares no listing or opportunity
    // with it. The fixpoint must converge to keeping exactly the poisoned
    // component while still deleting the unrelated one.
    const result = closeOverClusters(
      graph({
        candidateListingIds: new Set(['l1', 'l3']),
        opportunityMembers: new Map([
          ['o1', ['l1', 'not-a-candidate']],
          ['o3', ['l3']],
        ]),
        listingOpportunities: new Map([
          ['l1', ['o1']],
          ['not-a-candidate', ['o1']],
          ['l3', ['o3']],
        ]),
      }),
    );
    expect(result.deletableOpportunityIds).toEqual(new Set(['o3']));
    expect(result.deletableListingIds).toEqual(new Set(['l3']));
  });

  it('deletes every listing and opportunity in a fully-candidate, multi-hop reassignment chain', () => {
    // l1: o1 -> o2 (reassigned), l2 joins o2 later. Both o1 and o2's every
    // ever-member is a candidate, and neither carries user data.
    const result = closeOverClusters(
      graph({
        candidateListingIds: new Set(['l1', 'l2']),
        opportunityMembers: new Map([
          ['o1', ['l1']],
          ['o2', ['l1', 'l2']],
        ]),
        listingOpportunities: new Map([
          ['l1', ['o1', 'o2']],
          ['l2', ['o2']],
        ]),
      }),
    );
    expect(result.deletableOpportunityIds).toEqual(new Set(['o1', 'o2']));
    expect(result.deletableListingIds).toEqual(new Set(['l1', 'l2']));
  });

  it('is a no-op on an empty graph', () => {
    const result = closeOverClusters(graph());
    expect(result.deletableOpportunityIds.size).toBe(0);
    expect(result.deletableListingIds.size).toBe(0);
  });

  it('never marks an opportunity with zero recorded members as deletable', () => {
    // Should not occur in practice (a membership row is how an opportunity
    // enters the map at all), but `every()` on an empty array is vacuously
    // true — guarded against explicitly rather than relying on that never
    // happening.
    const result = closeOverClusters(
      graph({
        candidateListingIds: new Set(),
        opportunityMembers: new Map([['o1', []]]),
      }),
    );
    expect(result.deletableOpportunityIds.size).toBe(0);
  });
});
