import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema/index.js';

const MISSING_DATABASE_URL =
  'DATABASE_URL is not set. See the "Database" section of README.md for the local setup steps and connection string.';

/**
 * A real `pg.Pool` that refuses to be used, for when DATABASE_URL is absent.
 *
 * It must be a genuine `Pool` instance, not a stand-in: drizzle's node-postgres
 * driver branches on `instanceof Pool` to decide whether a transaction can
 * reserve a single connection. A proxy or duck-typed object fails that check,
 * and drizzle then issues BEGIN, the body, and COMMIT as separate pool queries
 * that may land on different connections — losing atomicity silently, with
 * every test still green (adversarial review, 2026-09-07).
 *
 * So the pool is real and only its entry points are replaced, which keeps the
 * prototype chain intact while still failing with a message that says what to
 * do. `end()` is deliberately left alone so the CLIs' `db.$client.end()` works.
 */
function unconfiguredPool(): Pool {
  const pool = new Pool();
  const fail = (): never => {
    throw new Error(MISSING_DATABASE_URL);
  };
  pool.query = fail as unknown as Pool['query'];
  pool.connect = fail as unknown as Pool['connect'];
  return pool;
}

/**
 * Memoized on `globalThis` rather than held in a module-level `const`.
 *
 * Next's dev server re-evaluates modules on every edit, so a module-scope pool
 * leaks one pool per hot reload until Postgres refuses connections. A
 * `Symbol.for` key survives module re-evaluation; a `const` does not.
 *
 * Construction is also deliberately non-throwing: `next build` evaluates every
 * route module to collect page data, so requiring DATABASE_URL at import time
 * made the production build fail on a machine that was only compiling. `pg`
 * connects lazily, so building a Pool here costs nothing until a query runs.
 */
const POOL_KEY = Symbol.for('xtelo.db.pool');

interface PoolCarrier {
  [POOL_KEY]?: Pool;
}

function resolvePool(): Pool {
  const carrier = globalThis as unknown as PoolCarrier;
  const existing = carrier[POOL_KEY];
  if (existing !== undefined) return existing;
  const url = process.env.DATABASE_URL;
  const created =
    url === undefined || url === '' ? unconfiguredPool() : new Pool({ connectionString: url });
  carrier[POOL_KEY] = created;
  return created;
}

export const pool = resolvePool();

export const db = drizzle({ client: pool, schema });
