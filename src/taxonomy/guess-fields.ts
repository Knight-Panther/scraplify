import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { listingClassifications } from '../db/schema/index.js';
import type { Database } from '../db/types.js';
import {
  FIELD_GUESS_VERSION,
  type FieldExample,
  guessField,
  trainFieldModel,
} from './field-guess.js';
import { TAXONOMY_VERSION } from './seed-terms.js';

/**
 * The share of the posterior a guess needs before it is written (Phase 16D).
 * Chosen on 2026-11-14 against the jobs.ge vacancies that have an hr.ge twin,
 * with each twin held out of training: at 0.8 about 95% of them get a guess
 * and about 89% of those match hr.ge's own field, against 86% when every
 * listing is guessed. Below it the listing stays "does not state it".
 */
export const FIELD_GUESS_FLOOR = 0.8;

/** Fewer labelled vacancies than this and no model is trained: a thin one guesses badly. */
export const MIN_TRAINING_EXAMPLES = 500;

/** Only so much of each description is read; the model reads its first 200 words. */
const DESCRIPTION_CHARS = 4000;

const BATCH = 500;

export interface GuessFieldsResult {
  trainedOn: number;
  /** Listings with no guess under the current model, looked at this run. */
  revisionsScanned: number;
  guessesCreated: number;
  /** Looked at, but no field reached `FIELD_GUESS_FLOOR`. */
  belowFloor: number;
  /** Guesses made under an older model, retired so they can be made again. */
  retired: number;
  /** A guessed field with no top-level taxonomy term (seeding has not caught up). */
  unmapped: number;
}

const EMPTY: GuessFieldsResult = {
  trainedOn: 0,
  revisionsScanned: 0,
  guessesCreated: 0,
  belowFloor: 0,
  retired: 0,
  unmapped: 0,
};

function rowsOf<T>(result: unknown): T[] {
  return Array.isArray(result) ? (result as T[]) : (result as { rows: T[] }).rows;
}

/**
 * Guesses a field for the current revision of every listing on a board that
 * states none (jobs.ge), from hr.ge's labelled vacancies, and records it as a
 * `keyword` classification on the `profession` axis, the axis hr.ge's own
 * fields are seeded on. Run after `seedTaxonomyTerms` and `classifyListings`,
 * under the same lock.
 *
 * A revision is guessed once per `FIELD_GUESS_VERSION`: a new revision (the
 * listing's text changed) or a new version gets a new guess. One below the
 * floor writes nothing and is looked at again next run, when more hr.ge
 * vacancies may tip it. A revision with a live field a person set
 * (`human_review`) is never guessed over.
 */
export async function guessFields(
  db: Database,
  options: { sourceSlug?: string; labelledSlug?: string; now?: string; minExamples?: number } = {},
): Promise<GuessFieldsResult> {
  const sourceSlug = options.sourceSlug ?? 'jobs-ge';
  const labelledSlug = options.labelledSlug ?? 'hr-ge';
  const now = options.now ?? new Date().toISOString();

  const training = rowsOf<{
    title: string;
    employer: string | null;
    description: string | null;
    fields: string[] | null;
  }>(
    await db.execute(sql`
      select r.title_raw as title, r.organization_raw as employer,
        left(r.description, ${DESCRIPTION_CHARS}) as description,
        (select array_agg(distinct e->>'name')
           from jsonb_array_elements(
             case when jsonb_typeof(r.structured_attributes->'specialty') = 'array'
               then r.structured_attributes->'specialty' else '[]'::jsonb end) e
           where e->>'name' is not null) as fields
      from source_listings l
      join sources s on s.id = l.source_id and s.slug = ${labelledSlug}
      join source_listing_revisions r on r.id = l.current_revision_id
      order by l.id`),
  );
  const examples: FieldExample[] = training
    .filter((row) => (row.fields?.length ?? 0) > 0)
    .map((row) => ({
      title: row.title,
      employer: row.employer,
      description: row.description,
      fields: row.fields ?? [],
    }));
  if (examples.length < (options.minExamples ?? MIN_TRAINING_EXAMPLES)) {
    return { ...EMPTY, trainedOn: examples.length };
  }
  const model = trainFieldModel(examples);

  // hr.ge's top-level fields, by the name its listings carry.
  const terms = rowsOf<{ id: string; label: string }>(
    await db.execute(sql`
      select id, label from taxonomy_terms
      where axis = 'profession' and parent_id is null`),
  );
  const termByLabel = new Map(terms.map((t) => [t.label, t.id]));

  // Guesses from an older model, still live: retired, then made again below.
  const retiredRows = rowsOf<{ id: string }>(
    await db.execute(sql`
      update listing_classifications lc set superseded_at = ${now}
      from source_listing_revisions r, source_listings l, sources s
      where lc.source_listing_revision_id = r.id and r.id = l.current_revision_id
        and s.id = l.source_id and s.slug = ${sourceSlug}
        and lc.method = 'keyword' and lc.axis = 'profession' and lc.superseded_at is null
        and coalesce(lc.evidence->>'model', '') <> ${FIELD_GUESS_VERSION}
      returning lc.id`),
  );

  const targets = rowsOf<{
    revision_id: string;
    title: string;
    employer: string | null;
    description: string | null;
  }>(
    await db.execute(sql`
      select r.id as revision_id, r.title_raw as title, r.organization_raw as employer,
        left(r.description, ${DESCRIPTION_CHARS}) as description
      from source_listings l
      join sources s on s.id = l.source_id and s.slug = ${sourceSlug}
      join source_listing_revisions r on r.id = l.current_revision_id
      where l.status <> 'quarantined'
        and not exists (
          select 1 from listing_classifications lc
          where lc.source_listing_revision_id = r.id and lc.axis = 'profession'
            and ((lc.method = 'keyword' and lc.evidence->>'model' = ${FIELD_GUESS_VERSION})
              or (lc.method = 'human_review' and lc.superseded_at is null)))
      order by r.id`),
  );

  let belowFloor = 0;
  let unmapped = 0;
  const rows: (typeof listingClassifications.$inferInsert)[] = [];
  for (const target of targets) {
    const guess = guessField(model, target);
    if (guess === null || guess.probability < FIELD_GUESS_FLOOR) {
      belowFloor++;
      continue;
    }
    const termId = termByLabel.get(guess.field);
    if (termId === undefined) {
      unmapped++;
      continue;
    }
    rows.push({
      id: randomUUID(),
      sourceListingRevisionId: target.revision_id,
      taxonomyTermId: termId,
      axis: 'profession',
      method: 'keyword',
      confidence: guess.probability,
      evidence: {
        model: FIELD_GUESS_VERSION,
        reasons: [
          `guessed from the listing's title, employer and text, learnt from ${labelledSlug}'s own fields`,
        ],
        trainedOn: examples.length,
        runnerUp: guess.runnerUp,
      },
      taxonomyVersion: TAXONOMY_VERSION,
      createdAt: now,
    });
  }
  let guessesCreated = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    // A pair can only be live once; a guess racing a person's correction loses quietly.
    const written = await db
      .insert(listingClassifications)
      .values(rows.slice(i, i + BATCH))
      .onConflictDoNothing()
      .returning({ id: listingClassifications.id });
    guessesCreated += written.length;
  }

  return {
    trainedOn: examples.length,
    revisionsScanned: targets.length,
    guessesCreated,
    belowFloor,
    retired: retiredRows.length,
    unmapped,
  };
}
