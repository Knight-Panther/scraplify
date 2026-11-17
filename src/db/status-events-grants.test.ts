import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from './client.js';
import {
  closeMissingListingsInTransaction,
  expireOverdueListings,
} from './reconcile-source-listings.js';
import { crawlRuns, sourceListings, sources } from './schema/index.js';
import { backfillStatusEvents } from './status-events.js';

/**
 * The role scripts' Phase 17C grants, run for real: the worker part of
 * `scripts/sql/phase-8b-worker-admin-migration-roles.sql` and all of
 * `scripts/sql/phase-8b-public-role.sql`, against probe roles of their own,
 * inside one transaction that is rolled back (the same harness as
 * src/realestate/history-grants.test.ts). The worker must write the status
 * timeline under its grants alone, and never rewrite or delete it; the public
 * role must not read it at all.
 */

class RolledBack extends Error {}

/** drizzle wraps the database's error ("Failed query: …") and keeps it as the cause. */
const deniedByPostgres = (err: unknown) =>
  err instanceof Error &&
  err.cause instanceof Error &&
  /^permission denied for (table|view)/.test(err.cause.message);

describe('the role scripts, for the Phase 17C status timeline', () => {
  it('let the worker write status events but not change them, and keep them from the public role', async (context) => {
    const { rows } = await db.execute<{ may: boolean; database: string }>(sql`
      select rolsuper or rolcreaterole as may, current_database() as database
        from pg_roles where rolname = current_user`);
    if (!rows[0]?.may) context.skip('this database user cannot create a role');
    const database = rows[0]?.database as string;

    const suffix = randomBytes(4).toString('hex');
    const worker = `xtelo_probe_worker_${suffix}`;
    const publicRole = `xtelo_probe_public_${suffix}`;
    const password = randomBytes(16).toString('hex');
    const fill = (text: string) =>
      text
        .replaceAll('scraplify_worker', worker)
        .replaceAll('scraplify_public', publicRole)
        .replaceAll(/<STRONG_PASSWORD_HERE(_[A-Z]+)?>/g, password)
        .replaceAll('<TARGET_DATABASE>', `"${database}"`);
    const workerPart = readFileSync(
      'scripts/sql/phase-8b-worker-admin-migration-roles.sql',
      'utf8',
    ).split('-- 2. scraplify_admin')[0] as string;
    const publicScript = readFileSync('scripts/sql/phase-8b-public-role.sql', 'utf8');

    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql.raw(fill(workerPart)));
        await tx.execute(sql.raw(fill(publicScript)));

        // As the owner: a source, a completed full run, and three listings.
        const sourceId = randomUUID();
        await tx.insert(sources).values({
          id: sourceId,
          slug: `test-source-${sourceId}`,
          displayName: 'Test source',
          baseUrl: 'https://example.invalid/',
        });
        const runId = randomUUID();
        await tx.insert(crawlRuns).values({
          id: runId,
          sourceId,
          startedAt: '2026-01-05T00:00:00Z',
          finishedAt: '2026-01-05T01:00:00Z',
          reconciledAt: '2026-01-05T01:00:00Z',
          status: 'completed',
          fullCoverage: true,
        });
        const listing = (key: string, deadline: string | null) => ({
          sourceId,
          sourceRecordId: key,
          canonicalSourceUrl: `https://example.invalid/${key}`,
          firstSeenAt: '2026-01-01T00:00:00Z',
          lastSeenAt: '2026-01-01T00:00:00Z',
          status: 'active' as const,
          sourceDeadlineAt: deadline,
        });
        await tx
          .insert(sourceListings)
          .values([
            listing('overdue', '2026-01-02T00:00:00Z'),
            listing('absent', null),
            listing('closed-before', null),
          ]);
        await tx.execute(
          sql`update ${sourceListings} set status = 'closed' where source_id = ${sourceId} and source_record_id = 'closed-before'`,
        );

        // As the worker: an expiry, a reconciliation pass and the backfill.
        await tx.execute(sql.raw(`set local role ${worker}`));
        expect(
          await expireOverdueListings(tx, {
            sourceId,
            asOf: '2026-01-05T01:00:00Z',
            crawlRunId: runId,
          }),
        ).toEqual({ expiredCount: 1 });
        expect(
          await closeMissingListingsInTransaction(tx, {
            crawlRunId: runId,
            missingStreakThreshold: 3,
          }),
        ).toMatchObject({ missingSuspectedCount: 1, closedCount: 0 });
        expect(await backfillStatusEvents(tx, { sourceIds: [sourceId] })).toMatchObject({
          total: 3,
        });
        const [count] = (
          await tx.execute<{ n: number }>(sql`
            select count(*)::int as n from source_listing_status_events e
              join source_listings l on l.id = e.source_listing_id
             where l.source_id = ${sourceId}`)
        ).rows;
        expect(count?.n).toBe(5);
        for (const statement of [
          'update source_listing_status_events set reason = reason',
          'delete from source_listing_status_events',
        ]) {
          await expect(tx.transaction((sp) => sp.execute(sql.raw(statement)))).rejects.toSatisfy(
            deniedByPostgres,
          );
        }

        // As the public role: nothing.
        await tx.execute(sql.raw('reset role'));
        await tx.execute(sql.raw(`set local role ${publicRole}`));
        await expect(
          tx.transaction((sp) =>
            sp.execute(sql.raw('select count(*) from source_listing_status_events')),
          ),
        ).rejects.toSatisfy(deniedByPostgres);
        throw new RolledBack();
      }),
    ).rejects.toBeInstanceOf(RolledBack);
  });
});
