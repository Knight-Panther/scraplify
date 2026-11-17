import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '../db/client.js';
import { realEstateListings, sources } from '../db/schema/index.js';
import { deleteLongGoneListings } from './expiry.js';
import { recordListingHistory } from './history.js';

/**
 * The role scripts' Phase 17A grants, run for real: the worker part of
 * `scripts/sql/phase-8b-worker-admin-migration-roles.sql` and all of
 * `scripts/sql/phase-8b-public-role.sql`, against probe roles of their own,
 * inside one transaction that is rolled back. The worker must be able to run
 * the nightly history step and the archive copy under its grants alone, and
 * the public role (the website's and Hermes's) must read the history but
 * never the archive's private part.
 */

class RolledBack extends Error {}

/** drizzle wraps the database's error ("Failed query: …") and keeps it as the cause. */
const deniedByPostgres = (err: unknown) =>
  err instanceof Error &&
  err.cause instanceof Error &&
  /^permission denied for (table|view)/.test(err.cause.message);

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-12-10T13:30:00.000Z');
const at = (days: number) => new Date(NOW + days * DAY_MS).toISOString();

describe('the role scripts, for the Phase 17A history', () => {
  it('let the worker write the history and the public role read all of it but the private part', async (context) => {
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

        // As the owner: a source and its listings.
        const sourceId = randomUUID();
        await tx.insert(sources).values({
          id: sourceId,
          slug: `test-source-${sourceId}`,
          displayName: 'Test source',
          baseUrl: 'https://example.invalid/',
        });
        const base = {
          sourceId,
          dealType: 'sale' as const,
          propertyType: 'flat' as const,
          sourceUpdatedAt: at(-3),
          firstSeenAt: at(-3),
          lastSeenAt: at(-0.1),
          contentHash: 'h',
        };
        await tx.insert(realEstateListings).values([
          {
            ...base,
            sourceListingKey: 'g1',
            canonicalUrl: 'https://example.invalid/g1',
            expectedEndAt: at(0.5),
            groupKey: `probe-${suffix}`,
          },
          {
            ...base,
            sourceListingKey: 'g2',
            canonicalUrl: 'https://example.invalid/g2',
            status: 'gone',
            goneAt: at(-1),
            latitude: '41.709000',
            longitude: '44.766000',
            description: 'private words',
            cadastralCode: '01.14.12.005.017',
          },
        ]);

        // As the worker: two nights of history, and the archive copy between.
        await tx.execute(sql.raw(`set local role ${worker}`));
        const first = await recordListingHistory(tx, { sourceId, now: at(0), crawlRunId: null });
        expect(first).toMatchObject({ ok: true, versionsOpened: 2, spellsOpened: 1, groupDays: 1 });
        expect(await deleteLongGoneListings(tx, { sourceId, asOf: at(16) })).toBe(1);
        const next = await recordListingHistory(tx, { sourceId, now: at(17), crawlRunId: null });
        expect(next).toMatchObject({ ok: true, spellsClosed: 1, groupDays: 1 });

        // As the public role: the history, and not the private part.
        await tx.execute(sql.raw('reset role'));
        await tx.execute(sql.raw(`set local role ${publicRole}`));
        for (const relation of [
          'listing_versions',
          'show_spells',
          'listing_group_days',
          'run_quality',
          'listings',
          'recently_gone',
        ]) {
          await tx.execute(sql.raw(`select count(*) from realestate_archive.${relation}`));
        }
        for (const relation of ['listing_private', 'history_steps']) {
          await expect(
            tx.transaction((sp) =>
              sp.execute(sql.raw(`select count(*) from realestate_archive.${relation}`)),
            ),
          ).rejects.toSatisfy(deniedByPostgres);
        }
        throw new RolledBack();
      }),
    ).rejects.toBeInstanceOf(RolledBack);
  });
});
