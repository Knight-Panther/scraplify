/**
 * Fail-closed startup checks for the `public` surface (Phase 8E, change.md
 * §6: "Each production profile fails closed if required DB, auth or
 * artifact configuration is absent", and `public` runs with "public
 * read-only DB credential, no admin auth secret"). `instrumentation.ts`
 * runs them before the process accepts a request. The `admin` surface's own
 * checks already live there.
 */

/** Admin credentials a public process must never hold, not even unused. */
const ADMIN_ONLY_ENV_VARS = ['AUTH_SECRET', 'AUTH_GITHUB_SECRET', 'ADMIN_GITHUB_IDS'] as const;

export function publicConfigProblems(env: Readonly<Record<string, string | undefined>>): string[] {
  const problems: string[] = [];
  if (!env.DATABASE_URL) problems.push('DATABASE_URL is not set');
  if (!env.XTELO_MATCHING_ARTIFACT_DIR) {
    problems.push('XTELO_MATCHING_ARTIFACT_DIR is not set (the bundle directory is never guessed)');
  }
  const held = ADMIN_ONLY_ENV_VARS.filter((name) => env[name]);
  if (held.length > 0) {
    problems.push(`${held.join(', ')} must not be set on public: those are admin credentials`);
  }
  return problems;
}

/**
 * Every table or view in `public` that the connected role can change. For
 * the `scraplify_public` role this is empty (`scripts/sql/phase-8b-public-role.sql`);
 * for the owner credential local development uses, it is every table.
 */
export const WRITABLE_RELATIONS_SQL = `
  select c.relname as name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind in ('r', 'p', 'v', 'm')
     and has_table_privilege(current_user, c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE')
   order by c.relname`;

/**
 * The deliberate, named escape hatch for the e2e suites only, which run a
 * real `public` server on the owner credential because CI has no other
 * role. Never set it on a deployment.
 */
export const SKIP_ROLE_CHECK_ENV = 'XTELO_E2E_ALLOW_WRITABLE_PUBLIC_ROLE';

export function writableRoleProblem(writable: readonly string[]): string | null {
  if (writable.length === 0) return null;
  const sample = writable.slice(0, 5).join(', ');
  return (
    `the public database role can change ${writable.length} relation(s) (${sample}${writable.length > 5 ? ', …' : ''}). ` +
    'Connect as scraplify_public (scripts/sql/phase-8b-public-role.sql), never an owner or worker role'
  );
}
