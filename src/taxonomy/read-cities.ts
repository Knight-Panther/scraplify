import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { listingClassifications } from '../db/schema/index.js';
import type { Database } from '../db/types.js';
import { romanizedName } from '../realestate/place-lookup.js';
import { CITY_READ_VERSION, cityReader, readCities } from './city-read.js';
import { TAXONOMY_VERSION } from './seed-terms.js';

/** Only so much of each description is read. */
const DESCRIPTION_CHARS = 8000;

const BATCH = 500;

export interface ReadCitiesResult {
  /** hr.ge's places the reader knows. */
  places: number;
  /** Listings with no reading under the current reader, looked at this run. */
  revisionsScanned: number;
  /** Listings that got at least one city. */
  revisionsRead: number;
  readingsCreated: number;
  /** Readings from an older reader, retired so they can be made again. */
  retired: number;
}

function rowsOf<T>(result: unknown): T[] {
  return Array.isArray(result) ? (result as T[]) : (result as { rows: T[] }).rows;
}

/**
 * Reads the places named in the title and text of every listing on a board
 * that states no city (jobs.ge), in hr.ge's own place names (Phase 16E), and
 * records each as a `keyword` classification on the `location` axis, in the
 * order the text names them (`evidence.order`). A location term is made for
 * each hr.ge place the first time it is needed. Run in the taxonomy step,
 * after `guessFields`, under the same lock.
 *
 * A revision is read once per `CITY_READ_VERSION`. One that names no place
 * writes nothing and is read again next run (cheap: the reader is a lookup).
 * A revision with a live place a person set (`human_review`) is never read over.
 */
export async function readCitiesFromText(
  db: Database,
  options: { sourceSlug?: string; placesSlug?: string; now?: string } = {},
): Promise<ReadCitiesResult> {
  const sourceSlug = options.sourceSlug ?? 'jobs-ge';
  const placesSlug = options.placesSlug ?? 'hr-ge';
  const now = options.now ?? new Date().toISOString();

  // Most used first, so a clash between two places' stems goes to the commoner one.
  const places = rowsOf<{ place: string }>(
    await db.execute(sql`
      select e #>> '{}' as place
      from source_listings l
      join sources s on s.id = l.source_id and s.slug = ${placesSlug}
      join source_listing_revisions r on r.id = l.current_revision_id
      cross join lateral jsonb_array_elements(
        case when jsonb_typeof(r.locations) = 'array' then r.locations else '[]'::jsonb end) e
      where jsonb_typeof(e) = 'string'
      group by 1
      order by count(*) desc, 1`),
  ).map((row) => row.place);
  const reader = cityReader(places, new Map(places.map((p) => [p, romanizedName(p)])));
  const readable = new Set(reader.byStem.values());

  const retiredRows = rowsOf<{ id: string }>(
    await db.execute(sql`
      update listing_classifications lc set superseded_at = ${now}
      from source_listings l, sources s
      where lc.source_listing_revision_id = l.current_revision_id
        and s.id = l.source_id and s.slug = ${sourceSlug}
        and lc.method = 'keyword' and lc.axis = 'location' and lc.superseded_at is null
        and coalesce(lc.evidence->>'reader', '') <> ${CITY_READ_VERSION}
      returning lc.id`),
  );

  const targets = rowsOf<{ revision_id: string; title: string; description: string | null }>(
    await db.execute(sql`
      select r.id as revision_id, r.title_raw as title,
        left(r.description, ${DESCRIPTION_CHARS}) as description
      from source_listings l
      join sources s on s.id = l.source_id and s.slug = ${sourceSlug}
      join source_listing_revisions r on r.id = l.current_revision_id
      where l.status <> 'quarantined'
        and not exists (
          select 1 from listing_classifications lc
          where lc.source_listing_revision_id = r.id and lc.axis = 'location'
            and ((lc.method = 'keyword' and lc.evidence->>'reader' = ${CITY_READ_VERSION})
              or (lc.method = 'human_review' and lc.superseded_at is null)))
      order by r.id`),
  );

  const readings = targets.map((target) => ({
    revisionId: target.revision_id,
    cities: readCities(reader, target),
  }));
  const needed = [...new Set(readings.flatMap((r) => r.cities))].filter((p) => readable.has(p));
  const termByPlace = new Map<string, string>();
  if (needed.length > 0) {
    // One location term per place, made once; the code keeps it unique.
    await db.execute(sql`
      insert into taxonomy_terms (id, axis, code, label, taxonomy_version, parent_id)
      select gen_random_uuid(), 'location', 'location-' || p, p, ${TAXONOMY_VERSION}, null
      from unnest(${sql.param(needed)}::text[]) p
      on conflict (code) do nothing`);
    const terms = rowsOf<{ id: string; label: string }>(
      await db.execute(sql`
        select id, label from taxonomy_terms
        where axis = 'location' and code = any(${sql.param(needed.map((p) => `location-${p}`))}::text[])`),
    );
    for (const term of terms) termByPlace.set(term.label, term.id);
  }

  const rows: (typeof listingClassifications.$inferInsert)[] = [];
  let revisionsRead = 0;
  for (const reading of readings) {
    const cities = reading.cities.filter((c) => termByPlace.has(c));
    if (cities.length > 0) revisionsRead++;
    cities.forEach((city, order) => {
      rows.push({
        id: randomUUID(),
        sourceListingRevisionId: reading.revisionId,
        taxonomyTermId: termByPlace.get(city) as string,
        axis: 'location',
        method: 'keyword',
        confidence: 1,
        evidence: {
          reader: CITY_READ_VERSION,
          order,
          reasons: [`the listing's title or text names this place; ${sourceSlug} states no city`],
        },
        taxonomyVersion: TAXONOMY_VERSION,
        createdAt: now,
      });
    });
  }
  let readingsCreated = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const written = await db
      .insert(listingClassifications)
      .values(rows.slice(i, i + BATCH))
      .onConflictDoNothing()
      .returning({ id: listingClassifications.id });
    readingsCreated += written.length;
  }

  return {
    places: readable.size,
    revisionsScanned: targets.length,
    revisionsRead,
    readingsCreated,
    retired: retiredRows.length,
  };
}
