import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { db, pool } from './client.js';

/**
 * These exist because a lazy-pool refactor briefly wrapped the pool in a Proxy
 * over a plain object (adversarial review, 2026-09-07). Every one of the 477
 * tests still passed, because nothing asserted the pool's identity — but
 * drizzle's node-postgres driver branches on `instanceof Pool` to decide
 * whether a transaction reserves a single connection. Failing that check makes
 * BEGIN, the body and COMMIT separate pool queries that can land on different
 * connections, so transactions stop being atomic while looking fine.
 */
describe('database client', () => {
  it('exposes a real pg.Pool, which drizzle needs for transactions', () => {
    expect(pool).toBeInstanceOf(Pool);
    expect(db.$client).toBeInstanceOf(Pool);
  });

  it('runs a transaction on one reserved connection', async () => {
    // pg_backend_pid() is the connection's own identity, so two reads inside
    // one transaction returning the same pid is direct evidence that the
    // transaction held a single connection rather than borrowing from the pool
    // twice.
    const [first, second] = await db.transaction(async (tx) => {
      const a = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      const b = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      return [a.rows[0]?.pid, b.rows[0]?.pid];
    });
    expect(first).toBeDefined();
    expect(second).toBe(first);
  });

  it('rolls back, which requires that single reserved connection', async () => {
    const marker = `rollback-check-${Date.now()}`;
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(
          sql`create temporary table if not exists xtelo_rollback_probe (note text)`,
        );
        await tx.execute(sql`insert into xtelo_rollback_probe (note) values (${marker})`);
        throw new Error('deliberate');
      }),
    ).rejects.toThrow('deliberate');

    // The temp table itself is rolled back with the transaction, so the probe
    // is simply that nothing survived.
    const survived = await db.execute<{ count: string }>(
      sql`select count(*) as count from pg_tables where tablename = 'xtelo_rollback_probe'`,
    );
    expect(survived.rows[0]?.count).toBe('0');
  });
});
