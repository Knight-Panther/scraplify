import { getSourceHealth } from '../../src/browse/queries.js';
import { db } from '../../src/db/client.js';
import { databaseLabel, writesEnabled } from '../lib/writes.js';

/**
 * Stage 1 placeholder. It exists to prove the integration end to end at
 * runtime — a server component importing the real query layer, reading the real
 * database, with the write gate resolved — and is replaced by the source-health
 * screen in Stage 3.
 *
 * It renders real counts only. No placeholder listings, no invented metrics:
 * `anti-patterns.md` treats fabricated data as a correctness bug, and that
 * applies to scaffolding as much as to a finished screen.
 */
export default async function Page() {
  const health = await getSourceHealth(db);
  const listings = health.reduce(
    (total, source) =>
      total + Object.values(source.listingsByStatus).reduce((sum, count) => sum + count, 0),
    0,
  );

  return (
    <main style={{ fontFamily: 'system-ui', padding: '2rem', lineHeight: 1.6 }}>
      <h1>Xtelo</h1>
      <p>Scaffolded. No screens are built yet.</p>
      <dl>
        <dt>Database</dt>
        <dd>{databaseLabel()}</dd>
        <dt>Writes</dt>
        <dd>{writesEnabled() ? 'enabled' : 'disabled'}</dd>
        <dt>Sources</dt>
        <dd>{health.length}</dd>
        <dt>Listings</dt>
        <dd>{listings}</dd>
      </dl>
    </main>
  );
}
