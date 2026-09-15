import { getSourceHealth } from '../../src/browse/queries.js';
import { db } from '../../src/db/client.js';
import { HeroVideo } from '../components/hero-video.js';
import { count } from '../lib/format.js';
import { databaseLabel, writesEnabled } from '../lib/writes.js';

/**
 * The design system, checked against real data.
 *
 * This used to carry the whole rendering-QA suite inline — real mixed-script
 * titles, the longest title in the corpus, tabular-numeral samples, a focus-
 * ring demo — dressed up as "information" when their actual job was catching
 * regressions (font fallback splitting a title into two typefaces, truncation
 * cutting a multibyte character, a CSS reset silently killing focus
 * visibility). None of that is useful to a person landing on this page, and
 * presenting a regression guard as content is what made it read as filler.
 * That verification now lives in `web/e2e/design-system.spec.ts`, run for
 * real against the live screens rather than a synthetic specimen.
 *
 * What stays below is what is actually true of a design-system page: a
 * living reference for the type scale and the token palette. Both are real,
 * neither depends on live corpus data to be worth looking at, and dropping
 * them would just mean re-deriving the same two facts from globals.css by
 * hand next time someone needs them.
 */

export default async function Page() {
  const health = await getSourceHealth(db);
  const totalListings = health.reduce(
    (sum, source) => sum + Object.values(source.listingsByStatus).reduce((a, b) => a + b, 0),
    0,
  );

  return (
    <main>
      <section className="relative flex min-h-[70vh] items-end overflow-hidden bg-surface">
        <HeroVideo />
        <div
          className="absolute inset-0"
          style={{
            background:
              'linear-gradient(180deg, rgba(0,0,0,0.35) 0%, rgba(0,0,0,0.55) 55%, rgba(0,0,0,0.9) 100%)',
          }}
        />
        <div className="relative px-6 py-12 sm:px-10">
          <p className="numeric text-xs tracking-[0.1em] text-[var(--color-accent)] uppercase">
            {health.map((source) => source.sourceSlug).join(' + ')}
          </p>
          <h1 className="mt-2 font-[family-name:var(--font-display)] text-7xl leading-[0.9] text-white uppercase sm:text-8xl">
            Xtelo
          </h1>
          <p className="mt-3 max-w-[var(--measure)] text-base text-white/80">
            jobs.ge + hr.ge, deduplicated into one row per vacancy.
          </p>
          <p className="numeric mt-4 text-sm text-white/60">
            <span className="text-[var(--color-accent)]">{count(totalListings)}</span> listings
            tracked across <span className="text-[var(--color-accent)]">{health.length}</span>{' '}
            boards
          </p>
        </div>
      </section>

      <div className="mx-auto max-w-5xl px-6 py-12">
        <dl className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
          <Fact label="Database" value={databaseLabel()} />
          <Fact label="Writes" value={writesEnabled() ? 'enabled' : 'disabled'} />
        </dl>

        <Section title="Type scale" note="Noto Sans Georgian, one family for both scripts.">
          <div className="space-y-3">
            <p className="text-2xl font-semibold">უფროსი Android დეველოპერი</p>
            <p className="text-lg">უფროსი Android დეველოპერი</p>
            <p className="text-base">უფროსი Android დეველოპერი</p>
            <p className="text-sm text-muted">უფროსი Android დეველოპერი</p>
            <p className="text-xs text-faint">უფროსი Android დეველოპერი</p>
          </div>
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
      </div>
    </main>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-faint">{label}</dt>
      <dd>{value}</dd>
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
      <div className={`h-12 w-24 rounded-[var(--radius)] border border-border ${className}`} />
      <div className="mt-1 text-faint">{name}</div>
    </div>
  );
}
