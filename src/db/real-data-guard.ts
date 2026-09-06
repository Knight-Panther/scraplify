import { Pool } from 'pg';

/**
 * Fails the whole test run if the suite changed any REAL source's stored
 * data — the rows a live crawl produced, as opposed to the disposable
 * sources every test is supposed to confine itself to.
 *
 * Why this exists, concretely: on 2026-09-06, verifying that the new
 * cross-source isolation tests were load-bearing meant temporarily deleting
 * the per-source `WHERE` clause from `closeMissingListings`. That mutation
 * removes exactly the protection that keeps a test's reconciliation off other
 * sources' rows — so a test crawl run reconciled every source in the shared
 * dev database and moved all 310 freshly-crawled jobs.ge listings from
 * `active` to `missing_suspected`. The damage was found only because a
 * checksum happened to have been taken by hand; nothing in the suite noticed.
 *
 * The guard deliberately does NOT refuse to run against a database holding
 * real data — that is the normal state of any dev machine that has ever
 * crawled, and refusing would just get turned off. It asserts the weaker,
 * always-true property instead: **whatever real data is here, the test suite
 * must leave it byte-identical.** On CI's fresh-per-run database there are no
 * real source rows at all, so this is a silent no-op there — which is also
 * the point, since CI could never have caught the original accident either.
 *
 * Runs as a vitest `globalSetup`, so the before/after pair genuinely spans
 * the entire run rather than one parallel test file.
 */

/**
 * Slugs whose rows are real crawl output, hardcoded rather than imported from
 * the policy modules on purpose: several test files mock those modules, and a
 * guard that read its own definition of "real" through a mockable import
 * could be silently neutered by the very thing it is watching for.
 */
const REAL_SOURCE_SLUGS = ['jobs-ge', 'hr-ge'];

/**
 * One checksum over every row of every table a crawl, reconciliation or
 * dedupe pass writes, restricted to rows belonging to the real sources.
 *
 * **Whole rows, via `md5(t::text)`, never a hand-picked column list.** Naming
 * columns is how this guard kept being wrong. Its first version fingerprinted
 * `source_listing_revisions` with `count(*)`, so an in-place rewrite of a real
 * revision moved nothing. Replacing that count with a few named columns —
 * id, parser version, and the two hash columns — was no better in the way
 * that matters: `meaningful_content_hash` is maintained by application code,
 * so a write that changed `title_raw` or a parsed date without recomputing it
 * still slipped through, and the same objection applied to every other
 * subquery here (adversarial review, 2026-09-06). Casting the row to text
 * covers every column including ones added later, which is the only version
 * of this that actually asserts the stated property: **byte-identical.**
 *
 * `order by` inside each `string_agg` keeps the value stable across runs;
 * `coalesce` keeps a table with no rows from collapsing the whole fingerprint
 * to NULL.
 */
const FINGERPRINT_SQL = `
  select md5(concat_ws('|',
    (select coalesce(string_agg(md5(sl::text), ',' order by sl.id), '')
      from source_listings sl
      join sources s on s.id = sl.source_id
      where s.slug = any($1)),
    (select coalesce(string_agg(md5(cr::text), ',' order by cr.id), '')
      from crawl_runs cr
      join sources s on s.id = cr.source_id
      where s.slug = any($1)),
    (select coalesce(string_agg(md5(cc::text), ',' order by cc.source_id), '')
      from crawl_cursors cc
      join sources s on s.id = cc.source_id
      where s.slug = any($1)),
    (select coalesce(string_agg(md5(r::text), ',' order by r.id), '')
      from source_listing_revisions r
      join source_listings sl on sl.id = r.source_listing_id
      join sources s on s.id = sl.source_id
      where s.slug = any($1)),
    -- Canonical/dedupe rows attached to real listings. Added after the dedupe
    -- tests silently created opportunities and memberships for real crawled
    -- listings on 2026-09-06: the pass scanned the whole database rather than
    -- the test's own sources, and this guard could not see it because it only
    -- covered acquisition tables. A guard that watches some of the writable
    -- surface gives false assurance about the rest.
    (select coalesce(string_agg(md5(m::text), ',' order by m.id), '')
      from opportunity_source_memberships m
      join source_listings sl on sl.id = m.source_listing_id
      join sources s on s.id = sl.source_id
      where s.slug = any($1)),
    (select coalesce(string_agg(md5(dc::text), ',' order by dc.id), '')
      from duplicate_candidates dc
      -- EITHER endpoint, not just side A. Pairs are stored with the smaller
      -- UUID first, so an accidental test-versus-real candidate has the real
      -- listing on side B about half the time; joining through side A alone
      -- let exactly the review-queue pollution this guard exists to catch slip
      -- past unnoticed (adversarial review, 2026-09-06).
      join source_listings sl
        on sl.id = dc.source_listing_id_a or sl.id = dc.source_listing_id_b
      join sources s on s.id = sl.source_id
      where s.slug = any($1)),
    -- The opportunity rows and their revisions, for every cluster a real
    -- listing belongs to. Memberships above say WHICH listings are grouped
    -- together; these are what browsing and ranking actually read, and a test
    -- could rewrite a real opportunity's canonical title, status or revision
    -- pointer — or the revision behind it — without touching a membership row.
    (select coalesce(string_agg(md5(o::text), ',' order by o.id), '')
      from opportunities o
      where exists (
        select 1
        from opportunity_source_memberships m
        join source_listings sl on sl.id = m.source_listing_id
        join sources s on s.id = sl.source_id
        where m.opportunity_id = o.id and s.slug = any($1))),
    (select coalesce(string_agg(md5(orev::text), ',' order by orev.id), '')
      from opportunity_revisions orev
      where exists (
        select 1
        from opportunity_source_memberships m
        join source_listings sl on sl.id = m.source_listing_id
        join sources s on s.id = sl.source_id
        where m.opportunity_id = orev.opportunity_id and s.slug = any($1)))
  )) as fingerprint
`;

/** Postgres: relation does not exist — a database with no schema applied yet. */
const UNDEFINED_TABLE = '42P01';

/**
 * Deliberately narrow error handling. An earlier version caught every error
 * and returned a constant, which meant a malformed query produced the SAME
 * value before and after and the guard passed silently — it was broken for
 * its first hour of life and only found by deliberately probing it. A guard
 * whose failure mode is "silently succeed" is worse than no guard, so the
 * only tolerated error is the one benign case (no schema yet); anything else
 * throws and fails the run loudly.
 */
async function fingerprintRealData(): Promise<string> {
  const url = process.env.DATABASE_URL;
  // No database configured is not this guard's problem to report — the tests
  // themselves fail on that with a far better message.
  if (!url) return 'no-database';

  const pool = new Pool({ connectionString: url });
  try {
    const { rows } = await pool.query<{ fingerprint: string }>(FINGERPRINT_SQL, [
      REAL_SOURCE_SLUGS,
    ]);
    const fingerprint = rows[0]?.fingerprint;
    if (typeof fingerprint !== 'string') {
      throw new Error('real-data guard: fingerprint query returned no value');
    }
    return fingerprint;
  } catch (err) {
    if (
      typeof err === 'object' &&
      err !== null &&
      (err as { code?: string }).code === UNDEFINED_TABLE
    ) {
      return 'no-schema';
    }
    throw err;
  } finally {
    await pool.end();
  }
}

export async function setup(): Promise<() => Promise<void>> {
  const before = await fingerprintRealData();

  return async () => {
    const after = await fingerprintRealData();
    if (before !== after) {
      // Vitest reports a globalSetup teardown rejection as "error during
      // close" but still exits 0, so throwing alone would print a loud
      // message that CI happily ignores — the same silently-passing failure
      // mode this guard was rewritten to avoid. Set the exit code
      // explicitly, then throw for the human-readable message.
      process.exitCode = 1;
      throw new Error(
        [
          'TEST SUITE MODIFIED REAL SOURCE DATA.',
          '',
          `Sources guarded: ${REAL_SOURCE_SLUGS.join(', ')}`,
          `  fingerprint before: ${before}`,
          `  fingerprint after:  ${after}`,
          '',
          'Tests must confine every write to a disposable source (createTestSource, or a',
          'vi.mock overriding both the source id AND slug — see src/adapters/*/crawl.test.ts).',
          '',
          'If this fired during a deliberate mutation check (temporarily deleting a',
          'per-source WHERE clause to prove a test is load-bearing), that is exactly the',
          'accident this guard exists to catch: the mutation removes the protection that',
          'keeps tests off real rows. Restore the clause and repair the affected rows.',
        ].join('\n'),
      );
    }
  };
}
