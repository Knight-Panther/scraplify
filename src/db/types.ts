import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { NodePgDatabase, NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import type * as schema from './schema/index.js';

export type Database = NodePgDatabase<typeof schema>;

export type DatabaseTransaction = PgTransaction<
  NodePgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

/** Accepted by write-path functions meant to be composable inside a caller's own transaction. */
export type DatabaseOrTransaction = Database | DatabaseTransaction;
