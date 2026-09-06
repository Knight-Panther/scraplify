/**
 * The write gate.
 *
 * Every mutating path in the web app is off unless `XTELO_WRITES_ENABLED` is
 * exactly `'true'`. Default-closed, deliberately.
 *
 * This exists because "do not write to the live database while testing" has
 * failed twice in this project as a procedural rule — once when a mutation check
 * moved 310 real jobs.ge listings to `missing_suspected`, and once when the
 * dedupe tests created canonical rows for real crawled listings. A browser
 * session is not covered by the vitest real-data guard at all, and the review
 * screen's actions are genuinely destructive to an audit trail:
 * `resolveDuplicateCandidate` permanently marks a candidate as adjudicated by a
 * human, and there are only 11 real pending pairs to consume.
 *
 * So the rule becomes a mechanism. `npm run dev:web` points at the live corpus
 * and cannot write; `npm run dev:web:qa` points at a disposable copy
 * (`.env.qa`) and can. Clicking every button on the live instance is safe.
 *
 * See `.claude/skills/professional-frontend/references/browser-qa.md` §1.
 */

export class WritesDisabledError extends Error {
  readonly code = 'WRITES_DISABLED';

  constructor() {
    super(
      'Writes are disabled for this instance. Start the app with XTELO_WRITES_ENABLED=true ' +
        'against a disposable database (npm run dev:web:qa) to make changes.',
    );
    this.name = 'WritesDisabledError';
  }
}

/** Whether this instance may mutate the database. */
export function writesEnabled(): boolean {
  return process.env.XTELO_WRITES_ENABLED === 'true';
}

/**
 * Throws unless writes are enabled. Call FIRST in every mutating Route Handler,
 * before reading the body or touching the database.
 */
export function assertWritesEnabled(): void {
  if (!writesEnabled()) throw new WritesDisabledError();
}

/**
 * The database name, for the chrome's environment chip, parsed so that no
 * credential can reach the page — `DATABASE_URL` carries a password, and this
 * value is rendered in HTML.
 */
export function databaseLabel(): string {
  const url = process.env.DATABASE_URL;
  if (!url) return 'no database';
  try {
    const name = new URL(url).pathname.replace(/^\//, '');
    return name === '' ? 'unknown' : name;
  } catch {
    return 'unparseable';
  }
}
