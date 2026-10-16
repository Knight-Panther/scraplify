import { afterAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import {
  publicConfigProblems,
  WRITABLE_RELATIONS_SQL,
  writableRoleProblem,
} from './startup-checks.js';

afterAll(async () => {
  await db.$client.end();
});

describe('publicConfigProblems', () => {
  const ok = { DATABASE_URL: 'postgres://x', XTELO_MATCHING_ARTIFACT_DIR: '/srv/bundles' };

  it('accepts a public process with a database and a bundle directory', () => {
    expect(publicConfigProblems(ok)).toEqual([]);
  });

  it('refuses a missing database or bundle directory', () => {
    expect(publicConfigProblems({})).toHaveLength(2);
  });

  it('refuses any admin credential, even an unused one', () => {
    const problems = publicConfigProblems({ ...ok, AUTH_SECRET: 's', ADMIN_GITHUB_IDS: '1' });
    expect(problems).toEqual([
      'AUTH_SECRET, ADMIN_GITHUB_IDS must not be set on public: those are admin credentials',
    ]);
  });
});

describe('writableRoleProblem', () => {
  it('is null for a read-only role and names tables otherwise', () => {
    expect(writableRoleProblem([])).toBeNull();
    expect(writableRoleProblem(['a', 'b'])).toContain('2 relation(s) (a, b)');
  });
});

describe('WRITABLE_RELATIONS_SQL against the real database', () => {
  it('finds the owner credential writable', async () => {
    const result = await db.$client.query<{ name: string }>(WRITABLE_RELATIONS_SQL);
    expect(result.rows.map((row) => row.name)).toContain('crawl_runs');
  });

  // The 11C review's P2: a role able to write the Real estate tables passed
  // a check that looked at `public` only.
  it('finds a writable table outside public, by its schema-qualified name', async (context) => {
    const client = await db.$client.connect();
    try {
      const may = await client.query<{ may: boolean }>(
        'select rolsuper or rolcreaterole as may from pg_roles where rolname = current_user',
      );
      if (!may.rows[0]?.may) context.skip('this database user cannot create a role');
      await client.query('begin');
      await client.query('create role xtelo_startup_check_probe nologin');
      await client.query('grant usage on schema realestate to xtelo_startup_check_probe');
      await client.query('grant update on realestate.listings to xtelo_startup_check_probe');
      await client.query('set local role xtelo_startup_check_probe');
      const result = await client.query<{ name: string }>(WRITABLE_RELATIONS_SQL);
      expect(result.rows.map((row) => row.name)).toEqual(['realestate.listings']);
    } finally {
      await client.query('rollback');
      client.release();
    }
  });

  it('finds scraplify_public able to write nothing', async (context) => {
    const client = await db.$client.connect();
    try {
      const role = await client.query(`select 1 from pg_roles where rolname = 'scraplify_public'`);
      if (role.rowCount === 0) context.skip('scraplify_public is not provisioned on this database');
      await client.query('begin');
      await client.query('set local role scraplify_public');
      const result = await client.query<{ name: string }>(WRITABLE_RELATIONS_SQL);
      expect(result.rows).toEqual([]);
    } finally {
      await client.query('rollback');
      client.release();
    }
  });
});
