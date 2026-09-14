import { Pool, type PoolClient } from 'pg';

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

/**
 * Deletes `test-source-*` rows left behind by an EARLIER run, before this one
 * starts.
 *
 * Every test file that calls `createTestSource` also calls `cleanupTestSource`,
 * and a run that finishes normally leaves nothing — verified by counting
 * sources after a full green run. But `afterEach` does not run when a run is
 * interrupted, when setup throws before the hook is registered, or when the
 * process is killed, and that debris then outlives the run that made it.
 *
 * It is not cosmetic, which is the reason this is code and not a note. The
 * residue was recorded twice in `docs/STATUS.md` as "harmless" and was not:
 * `sourceLabel` falls back to the raw slug, so every leftover source appeared
 * in the product's board filter as a raw UUID, and dedupe generated candidate
 * pairs from the leftover listings that surfaced in the human review queue as
 * fake duplicates. It was cleaned by hand on 2026-09-06 and had come back by
 * 2026-09-14. A sweep at setup rather than at teardown is what makes it stop
 * recurring: teardown is exactly what an interrupted run skips.
 *
 * Scoped to the slug prefix `createTestSource` generates and nothing else. It
 * runs BEFORE the fingerprint is taken, so the deletions are not themselves
 * mistaken for the suite modifying data — and it can never touch a real source,
 * since `jobs-ge` and `hr-ge` do not match the prefix.
 */
/**
 * Advisory-lock key identifying "a scraplify test run is active on this
 * database". Arbitrary but fixed; advisory locks share one namespace per
 * database, so it only has to avoid colliding with another application's key.
 */
const TEST_RUN_LOCK_KEY = 0x5c2a_f1f7;

/**
 * Holds the run lock for the lifetime of the suite. Null when this run did not
 * get the lock (another run has it), in which case the sweep is skipped.
 */
let runLock: { pool: Pool; client: PoolClient; holdsExclusive: boolean } | null = null;

/**
 * Registers this run as active and reports whether it may sweep.
 *
 * The lock is what makes the sweep safe at all. Test sources are named
 * `test-source-<uuid>` with no timestamp, so a prefix query cannot tell debris
 * left by a dead run from fixtures a CONCURRENTLY RUNNING suite is using right
 * now — and deleting the latter breaks that run in a way that looks random
 * (commit gate, 2026-09-14).
 *
 * **Shared for the run, exclusive for the sweep**, which is the part a first
 * version got wrong. It only took an exclusive lock around the sweep and let a
 * losing run proceed holding nothing — so a run that started second was
 * unprotected, and a third run starting after the first exited could take the
 * lock and sweep the second run's live fixtures. Every run now holds a SHARED
 * lock for its whole duration, and sweeping additionally requires the EXCLUSIVE
 * one, which Postgres grants only when no OTHER session holds either. A session
 * does not conflict with itself, so holding shared does not block this run's own
 * exclusive attempt — verified against this Postgres, not assumed.
 *
 * Both are session-scoped, so they are released by the teardown below and also,
 * for free, if this process dies — a crashed run cannot wedge the lock.
 */
async function acquireRunLock(): Promise<{ active: boolean; maySweep: boolean }> {
  const url = process.env.DATABASE_URL;
  if (!url) return { active: false, maySweep: false };

  const pool = new Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  try {
    // Blocking, not `try`: a run must never proceed unregistered, or it
    // becomes invisible to some later run's sweep. It waits only while a
    // sweep holds the exclusive lock, which is milliseconds.
    await client.query('select pg_advisory_lock_shared($1)', [TEST_RUN_LOCK_KEY]);
    runLock = { pool, client, holdsExclusive: false };

    const { rows } = await client.query<{ got: boolean }>(
      'select pg_try_advisory_lock($1) as got',
      [TEST_RUN_LOCK_KEY],
    );
    const maySweep = rows[0]?.got === true;
    if (maySweep) runLock.holdsExclusive = true;
    return { active: true, maySweep };
  } catch (err) {
    client.release();
    await pool.end();
    runLock = null;
    throw err;
  }
}

/**
 * Drops the exclusive lock as soon as the sweep is done, so a run waiting to
 * register is held up for the sweep only rather than for the whole suite.
 */
async function releaseSweepLock(): Promise<void> {
  if (runLock === null || !runLock.holdsExclusive) return;
  await runLock.client.query('select pg_advisory_unlock($1)', [TEST_RUN_LOCK_KEY]);
  runLock.holdsExclusive = false;
}

async function releaseRunLock(): Promise<void> {
  if (runLock === null) return;
  const { pool, client } = runLock;
  runLock = null;
  try {
    // Releases every advisory lock this session holds — the shared one always,
    // and the exclusive one too if the sweep somehow left it. Simpler than
    // unwinding them individually, and it cannot leave one behind.
    await client.query('select pg_advisory_unlock_all()');
  } finally {
    client.release();
    await pool.end();
  }
}

async function sweepOrphanTestSources(): Promise<number> {
  const url = process.env.DATABASE_URL;
  if (!url) return 0;

  const pool = new Pool({ connectionString: url });
  try {
    // Reuses the project's own cleanup path rather than open-coding the
    // delete order, so the FK sequence stays defined in one place — and so a
    // table added to one is never forgotten in the other. The prefix list
    // comes from the same module for the same reason: this query matched only
    // `test-source-%` at first and silently left behind the `crawl-test-*`,
    // `isolation-test-*` and `reliability-*` sources the adapter tests create,
    // which is most of the debris an interrupted run can leave.
    const { cleanupTestSource, DISPOSABLE_SOURCE_SLUG_PREFIXES } = await import(
      './test-support.js'
    );

    const { rows } = await pool.query<{ id: string }>(
      'select id from sources where slug like any($1)',
      [DISPOSABLE_SOURCE_SLUG_PREFIXES.map((prefix) => `${prefix}%`)],
    );
    if (rows.length === 0) return 0;
    for (const row of rows) {
      await cleanupTestSource(row.id);
    }
    console.warn(
      `real-data guard: swept ${rows.length} orphan test source(s) left by an earlier interrupted run.`,
    );
    return rows.length;
  } catch (err) {
    if (
      typeof err === 'object' &&
      err !== null &&
      (err as { code?: string }).code === UNDEFINED_TABLE
    ) {
      return 0;
    }
    throw err;
  } finally {
    await pool.end();
  }
}

export async function setup(): Promise<() => Promise<void>> {
  const { active, maySweep } = await acquireRunLock();
  if (maySweep) {
    try {
      await sweepOrphanTestSources();
    } finally {
      await releaseSweepLock();
    }
  } else if (active) {
    console.warn(
      'real-data guard: another test run is active; skipping the orphan sweep so its fixtures are left alone.',
    );
  }

  const before = await fingerprintRealData();

  return async () => {
    // Before the comparison below, which can throw: the run lock must not
    // outlive the run just because the run failed. It is session-scoped, so a
    // killed process releases it anyway — this covers the ordinary exit.
    await releaseRunLock();

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
