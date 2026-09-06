import { getSourceHealth, searchListings } from '../../src/browse/queries.js';
import { db } from '../../src/db/client.js';
import { databaseLabel, writesEnabled } from '../lib/writes.js';

/**
 * Stage 2: the design system, proven against real data.
 *
 * This is not a finished screen — the real screens arrive from Stage 3. It
 * exists to make the token set and the typeface split visible and checkable,
 * and it deliberately renders REAL listings rather than placeholder text:
 * Latin filler hides exactly the Georgian rendering faults this page is meant
 * to catch (anti-patterns.md forbids fabricated content anywhere, scaffolding
 * included).
 */

const GEORGIAN = /[\u10A0-\u10FF\u1C90-\u1CBF]/u;
const LATIN = /[A-Za-z]/u;

export default async function Page() {
  const [health, listings] = await Promise.all([
    getSourceHealth(db),
    searchListings(db, { limit: 500 }),
  ]);

  const total = health.reduce(
    (sum, source) => sum + Object.values(source.listingsByStatus).reduce((a, b) => a + b, 0),
    0,
  );
  // The mixed-script titles are the hard case: a font without Georgian coverage
  // renders these in two different typefaces inside one string.
  const mixed = listings.filter((l) => GEORGIAN.test(l.title) && LATIN.test(l.title));
  const longest = listings.reduce(
    (a, b) => (b.title.length > a.title.length ? b : a),
    listings[0] ?? { title: '', sourceListingId: '' },
  );

  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <header className="border-b border-border pb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Xtelo</h1>
        <p className="mt-1 text-faint">Design system — no screens built yet.</p>
      </header>

      <section className="mt-8 flex flex-wrap gap-x-8 gap-y-2 text-sm">
        <Fact label="Database" value={databaseLabel()} />
        <Fact label="Writes" value={writesEnabled() ? 'enabled' : 'disabled'} />
        <Fact label="Sources" value={String(health.length)} numeric />
        <Fact label="Listings" value={String(total)} numeric />
        <Fact label="Mixed-script titles" value={String(mixed.length)} numeric />
      </section>

      <Section title="Type scale" note="Noto Sans Georgian, one family for both scripts.">
        <div className="space-y-3">
          <p className="text-2xl font-semibold tracking-tight">უფროსი Android დეველოპერი</p>
          <p className="text-lg">უფროსი Android დეველოპერი</p>
          <p className="text-base">უფროსი Android დეველოპერი</p>
          <p className="text-sm text-muted">უფროსი Android დეველოპერი</p>
          <p className="text-xs text-faint">უფროსი Android დეველოპერი</p>
        </div>
      </Section>

      <Section
        title="Mixed Georgian and Latin"
        note="Real titles. Each must render in ONE typeface — two means the font lacks Georgian."
      >
        <ul className="space-y-1.5">
          {mixed.slice(0, 8).map((listing) => (
            <li key={listing.sourceListingId} className="text-base">
              {listing.title}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Longest title" note={`${longest.title.length} characters, truncated by CSS.`}>
        <p className="max-w-sm truncate rounded-[--radius] border border-border bg-surface px-3 py-2">
          {longest.title}
        </p>
      </Section>

      <Section title="Surfaces and accent">
        <div className="flex flex-wrap gap-3">
          <Swatch name="background" className="bg-background" />
          <Swatch name="surface" className="bg-surface" />
          <Swatch name="surface-raised" className="bg-surface-raised" />
          <Swatch name="surface-active" className="bg-surface-active" />
          <Swatch name="accent" className="bg-accent" />
          <Swatch name="accent-strong" className="bg-accent-strong" />
        </div>
      </Section>

      <Section title="Numerals" note="Space Mono, tabular. Latin and digits only.">
        <div className="numeric space-y-1 text-sm">
          <div>2026-09-13 &nbsp; 0.8241 &nbsp; 310</div>
          <div>2026-10-03 &nbsp; 0.1109 &nbsp; 100</div>
        </div>
      </Section>

      <Section title="Focus ring" note="Tab to it. Taken verbatim from the reference.">
        <button
          type="button"
          className="rounded-[--radius] border border-border bg-surface px-4 py-2 text-sm hover:bg-surface-raised"
        >
          Focusable control
        </button>
      </Section>
    </main>
  );
}

function Fact({ label, value, numeric }: { label: string; value: string; numeric?: boolean }) {
  return (
    <div>
      <div className="text-xs text-faint">{label}</div>
      <div className={numeric === true ? 'numeric' : undefined}>{value}</div>
    </div>
  );
}

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-10 border-t border-border pt-6">
      <h2 className="text-sm font-medium">{title}</h2>
      {note !== undefined && <p className="mt-0.5 mb-4 text-xs text-faint">{note}</p>}
      {children}
    </section>
  );
}

function Swatch({ name, className }: { name: string; className: string }) {
  return (
    <div className="text-xs">
      <div className={`h-12 w-24 rounded-[--radius] border border-border ${className}`} />
      <div className="mt-1 text-faint">{name}</div>
    </div>
  );
}
