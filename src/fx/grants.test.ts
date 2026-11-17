import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '../db/client.js';
import { syncFxRates } from './sync.js';
import { nbgAnswer } from './test-answers.js';

/**
 * The role scripts' Phase 17D grants, run for real against probe roles of
 * their own, inside one transaction that is rolled back: the worker can run
 * the sync under its grants alone and cannot change a stored rate, and the
 * public role (the website's and Hermes's) can read the rates and write none.
 */

class RolledBack extends Error {}

/** drizzle wraps the database's error ("Failed query: …") and keeps it as the cause. */
const deniedByPostgres = (err: unknown) =>
  err instanceof Error &&
  err.cause instanceof Error &&
  /^permission denied for (table|view)/.test(err.cause.message);

describe('the role scripts, for the Phase 17D exchange rates', () => {
  it('let the worker store rates, never change them, and the public role only read them', async (context) => {
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
        await tx.execute(sql`delete from fx_rates`);

        // As the worker: one day stored, then no update or delete.
        await tx.execute(sql.raw(`set local role ${worker}`));
        const result = await syncFxRates(tx, {
          fetchJson: async () => nbgAnswer('2026-01-01', [{ code: 'USD', rate: 2.7 }]),
          now: '2026-01-01T08:00:00.000Z',
          from: '2026-01-01',
          maxRequests: 1,
        });
        expect(result).toMatchObject({ daysStored: 1, rowsInserted: 1 });
        for (const statement of ['update fx_rates set rate = 3', 'delete from fx_rates']) {
          await expect(tx.transaction((sp) => sp.execute(sql.raw(statement)))).rejects.toSatisfy(
            deniedByPostgres,
          );
        }

        // As the public role: read, and nothing else.
        await tx.execute(sql.raw('reset role'));
        await tx.execute(sql.raw(`set local role ${publicRole}`));
        const read = await tx.execute<{ n: number }>(sql`select count(*)::int as n from fx_rates`);
        expect(read.rows[0]?.n).toBe(1);
        await expect(
          tx.transaction((sp) =>
            sp.execute(
              sql`insert into fx_rates (currency, day, valid_from, quantity, rate, gel_per_unit)
                  values ('EUR', '2026-01-01', '2026-01-01', 1, 3, 3)`,
            ),
          ),
        ).rejects.toSatisfy(deniedByPostgres);
        throw new RolledBack();
      }),
    ).rejects.toBeInstanceOf(RolledBack);
  });
});
