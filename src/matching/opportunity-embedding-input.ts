import { sql } from 'drizzle-orm';
import type { db as Db } from '../db/client.js';

export interface OpportunityEmbeddingInput {
  opportunityId: string;
  canonicalTitle: string;
  /** Composed per change.md §8: title, organization, source description, location — no incident/review/candidate data. */
  text: string;
}

/**
 * A real, traceable sample of canonical opportunities for Phase 8A's
 * evaluation harness (change.md §12 needs "real traceable listings", not
 * synthetic vacancies — only the CV side of the corpus is synthetic).
 * Deliberately simple for a feasibility spike: any one live member per
 * opportunity, not necessarily change.md §8's eventual "most authoritative"
 * pick — that precision matters for the production bundle builder (Phase
 * 8C), not for measuring this candidate's size/latency/parity now.
 */
export async function sampleOpportunityEmbeddingInputs(
  db: typeof Db,
  limit: number,
): Promise<OpportunityEmbeddingInput[]> {
  const { rows } = await db.execute<{
    opportunity_id: string;
    canonical_title: string;
    organization: string | null;
    description: string | null;
    locations: unknown;
  }>(sql`
    select distinct on (o.id)
      o.id as opportunity_id,
      o.canonical_title,
      slr.organization_raw as organization,
      slr.description as description,
      slr.locations as locations
    from opportunities o
    join opportunity_source_memberships osm
      on osm.opportunity_id = o.id and osm.superseded_at is null
    join source_listings sl
      on sl.id = osm.source_listing_id and sl.status = 'active'
    join source_listing_revisions slr
      on slr.id = sl.current_revision_id
    order by o.id, sl.first_seen_at desc
    limit ${limit}
  `);

  return rows.map((row) => {
    const locations = Array.isArray(row.locations) ? (row.locations as string[]).join(', ') : '';
    const parts = [
      row.canonical_title,
      row.organization ?? '',
      locations,
      (row.description ?? '').slice(0, 500),
    ].filter((part) => part.length > 0);
    return {
      opportunityId: row.opportunity_id,
      canonicalTitle: row.canonical_title,
      text: parts.join(' — '),
    };
  });
}
