import {
  publicCountOpportunities,
  publicLastSeen,
  publicSearchOpportunities,
  publicSourceOverview,
} from '../../../src/browse/public-queries.js';
import {
  type OpportunityView,
  countOpportunities,
  getSourceHealth,
  searchOpportunities,
} from '../../../src/browse/queries.js';
import { db } from '../../../src/db/client.js';
import { CvChooser } from '../../components/cv-chooser.js';
import { HeroTicker } from '../../components/hero-ticker.js';
import { HeroVideo } from '../../components/hero-video.js';
import { count, relativeTime } from '../../lib/format.js';
import { type HeadlineRun, type HeroCopy, heroCopy } from '../../lib/hero-copy.js';
import { sourceLabel } from '../../lib/labels.js';
import { type Locale, currentLocale } from '../../lib/locale.js';
import { type OpportunityRow, toRow } from '../../lib/opportunity-row.js';
import { currentSurface } from '../../lib/surface.js';
import { lastCompletedSync } from '../../lib/sync.js';

export const dynamic = 'force-dynamic';

/**
 * The public landing page. One hero section, motion-led, everything in it
 * real and live — Phase 3E, see docs/STATUS.md's "Phase 3E — landing hero"
 * section for the full design-review history (a Plan pass, then a Codex
 * design review that first caught a nine-day-stale dedupe backlog behind
 * this screen's own proof numbers, fixed before any of this was written).
 *
 * `never render invented data` applies here as much as anywhere else in this
 * product: every number, title and employer below comes from
 * `src/browse/queries.ts` against the corpus, not from the design reference
 * this screen was built from (which used placeholder Georgian content and
 * placeholder numbers — high-fidelity on type/color/motion, not on data).
 *
 * "Open" means `searchOpportunities`/`countOpportunities`'s
 * `genuinelyOpenAsOf` filter (`src/browse/queries.ts`) — at least one live
 * member is `active` *and* that same member's own stated deadline, if any,
 * has not passed — not the stored `canonicalStatus` column alone, which
 * can and does lag real per-member state (a Codex review, 2026-09-15,
 * caught the stat and the panel/ticker using two different, disagreeing
 * definitions of "open" before this; both now share the one query-layer
 * filter, so the number shown here and `countOpportunities` report the
 * same thing by construction, not by two call sites happening to agree).
 * `missing_suspected` ("may be gone" — an unconfirmed absence, not a fact)
 * stays excluded even though the ranking engine treats it as still
 * available; a landing-page headline number should read as more certain
 * than that. The CTA links still point at `/opportunities?status=active`,
 * the closest real destination — that screen has not been retrofitted with
 * this same per-member filter, so its own count can differ slightly from
 * the number shown here; recorded as a known, narrower gap rather than
 * silently glossed over.
 */
export default async function Page() {
  const [hero, locale] = await Promise.all([loadHeroData(), currentLocale()]);
  const copy = heroCopy(locale);

  return (
    <main>
      <section className="relative flex min-h-[calc(100svh-58px)] flex-col justify-end overflow-hidden border-b border-[var(--color-browse-border)] bg-[var(--color-browse-ink)] lg:min-h-[calc(100svh-78px)]">
        <HeroVideo />
        {/* Legibility overlay, not the source reference's grid+glow layers —
            those exist as an alternative background for a page with no
            video; layering an animated grid AND a warm glow gradient under
            a moving video competes for the same visual depth and the glow
            (~4% luminance) is invisible over real video brightness anyway.
            Retuned to this screen's own ink token so the reduced-motion
            render (HeroVideo mounts nothing at all, see hero-video.tsx)
            rests on the same ground as the panel/ticker below it, not a
            different dark. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'linear-gradient(180deg, rgba(11,13,16,0.55) 0%, rgba(11,13,16,0.72) 55%, rgba(11,13,16,0.94) 100%)',
          }}
        />

        <div className="relative mx-auto grid w-full max-w-[1440px] grid-cols-1 items-end gap-11 px-8 pt-14 min-[1060px]:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] min-[1060px]:gap-14 min-[1060px]:pt-16">
          <div>
            {hero.ok && (
              <p className="numeric flex animate-hero-fade-up items-center gap-[9px] text-[11px] text-[var(--color-browse-accent)] uppercase [animation-duration:600ms]">
                <span
                  aria-hidden="true"
                  className="h-1.5 w-1.5 flex-none animate-hero-pulse rounded-full bg-[var(--color-browse-accent)]"
                />
                <span className="tracking-[0.22em]">
                  {hero.boardsLabel}
                  {hero.lastSync !== undefined && (
                    <>
                      {' '}
                      · {hero.lastSyncLabel} {relativeTime(hero.lastSync)}
                    </>
                  )}
                </span>
              </p>
            )}

            {/* English sets `--font-display` (Bebas Neue) with a real CSS
                `uppercase` transform for its ALL-CAPS look. Georgian gets
                neither: `--font-display-ka` (BPG Nino Mtavruli, falling
                back through Noto Sans Georgian) already renders Mkhedruli
                input in Mtavruli capitals-style forms by design, and
                `uppercase` is a documented no-op-or-worse on Georgian
                (georgian-typography.md rule 4) that this project avoids
                applying near Georgian text categorically. */}
            <h1
              className={`mt-[18px] ${
                locale === 'ka'
                  ? // ~42% of the English clamp(46px,7.4vw,104px) — two
                    // rounds of project-owner-requested reduction (60%, then
                    // another 70% on top) after review found a straight size
                    // match too heavy: Mtavruli-style Georgian caps read
                    // visually wider than Latin caps at the same size.
                    //
                    // Leading held at 1.4, NOT reduced further on request:
                    // georgian-typography.md rule 5 sets 1.4 as a hard floor
                    // for Georgian headings specifically because Mkhedruli's
                    // real descenders (ვ, ყ, წ, ჯ...) collide with the next
                    // line's ascenders below it — the exact corruption a
                    // browser screenshot caught earlier in this change at
                    // the English hero's 0.86. Smaller type does shrink the
                    // descenders in absolute px, but the rule is written as
                    // a ratio, not a pixel budget, so it still applies.
                    'font-[family-name:var(--font-display-ka)] text-[clamp(20px,3.1vw,43px)] leading-[1.4]'
                  : 'font-[family-name:var(--font-display)] text-[clamp(46px,7.4vw,104px)] leading-[0.86] uppercase'
              }`}
            >
              {copy.headline.map((runs, index) => (
                <HeadlineLine
                  key={runs.map((run) => run.text).join('')}
                  runs={runs}
                  delayClass={HEADLINE_DELAY_CLASSES[index] ?? ''}
                  locale={locale}
                />
              ))}
            </h1>

            <div
              aria-hidden="true"
              className="mt-[26px] h-0.5 w-full animate-hero-sweep bg-[var(--color-browse-accent)]"
            />

            <p className="mt-[22px] max-w-[52ch] animate-hero-fade-up text-base text-[var(--color-browse-text-muted)] leading-[var(--leading-body)] [animation-delay:640ms] [animation-duration:700ms]">
              {copy.subhead}
            </p>

            <div className="mt-[30px] flex animate-hero-fade-up flex-wrap items-center gap-3 [animation-delay:760ms] [animation-duration:700ms]">
              <a
                href="/opportunities?status=active"
                className="inline-flex h-[50px] items-center rounded-[var(--radius)] bg-[var(--color-browse-accent)] px-[26px] text-[15px] font-bold text-[var(--color-browse-ink)] transition-colors duration-150 hover:bg-[var(--color-browse-accent-hover)]"
              >
                {copy.browseOpenings}
              </a>
              {/* "Get daily alerts" in the design reference has no backend
                  anywhere in this app (no route, no schema) — a disabled or
                  dead-linked button would violate this product's own
                  never-invented rule as much as fake data would. Real second
                  destination instead: both params are genuine and round-trip
                  through parseOpportunityQuery. */}
              <a
                href="/opportunities?status=active&closing=7"
                className="inline-flex h-[50px] items-center rounded-[var(--radius)] border border-[var(--color-browse-border-control)] px-[22px] text-[15px] text-[var(--color-browse-text-pill)] transition-colors duration-150 hover:border-[var(--color-browse-border-control-hover)] hover:text-white"
              >
                {copy.closingSoon}
              </a>
              {/* `.numeric` is Space Mono, which has no Georgian coverage
                  (fonts.ts) — kept only for the English copy, which used it
                  for SynapseX's monospace chrome look; Georgian falls back
                  to the default `--font-sans` (Noto Sans Georgian), which
                  actually covers it. */}
              <span
                className={`${locale === 'en' ? 'numeric' : ''} text-xs text-[var(--color-browse-text-muted)]`}
              >
                {copy.noAccountNeeded}
              </span>
            </div>

            {/* Phase 8D: the CV is read in this tab's worker and the page
                client-navigates to /cv-ranked. Rendered even when the live
                hero data failed — it needs only the public bundle. */}
            <div className="mt-5 animate-hero-fade-up [animation-delay:820ms] [animation-duration:700ms]">
              <CvChooser
                navigate
                label={copy.rankByCv}
                note={copy.rankByCvNote}
                className="inline-flex h-[46px] w-fit items-center rounded-[var(--radius)] border border-[var(--color-browse-accent)] px-[22px] text-[15px] font-semibold text-[var(--color-browse-accent)] transition-colors duration-150 hover:bg-[var(--color-browse-accent)] hover:text-[var(--color-browse-ink)]"
              />
            </div>

            {hero.ok && (
              <div className="mt-11 flex animate-hero-fade-up flex-wrap gap-x-12 gap-y-6 border-t border-[var(--color-browse-border)] pt-6 [animation-delay:880ms] [animation-duration:700ms]">
                <Stat value={hero.openCount} label={copy.statOpenVacancies} locale={locale} />
                <Stat value={hero.boardsCount} label={copy.statBoardsMerged} locale={locale} />
                <Stat value={hero.trackedCount} label={copy.statListingsTracked} locale={locale} />
              </div>
            )}
          </div>

          {hero.ok && (
            <div className="animate-hero-fade-up [animation-delay:700ms] [animation-duration:800ms]">
              <NewestPanel
                rows={hero.panelRows}
                openCount={hero.openCount}
                copy={copy}
                locale={locale}
              />
            </div>
          )}
        </div>

        {hero.ok && (
          <HeroTicker rows={hero.tickerRows} pauseLabel={copy.pause} playLabel={copy.play} />
        )}
      </section>
    </main>
  );
}

interface PanelRow {
  row: OpportunityRow;
  /** Source slugs among `row.sources` that are themselves genuinely open. */
  openSourceSlugs: ReadonlySet<string>;
}

type HeroData =
  | {
      ok: true;
      boardsLabel: string;
      boardsCount: number;
      trackedCount: number;
      lastSync: string | undefined;
      /**
       * `lastSync`'s own honest label. `lastCompletedSync` (local) is a real
       * full-coverage crawl completion, worth calling "synced"; `publicLastSeen`
       * (public) is only the newest per-listing confirmation the public role can
       * see — a single incrementally-confirmed listing can advance it with most
       * of the catalogue still stale, so calling that "synced" too would assert
       * a full-coverage guarantee this role has no way to back (Codex, 2026-09-24).
       */
      lastSyncLabel: string;
      openCount: number;
      panelRows: PanelRow[];
      tickerRows: OpportunityRow[];
    }
  | { ok: false };

/** Panel (4) + ticker (10). */
const ROWS_SHOWN = 14;

/** Staggered entrance timing for each headline line — longest of either
 * locale's `copy.headline` is 4 lines, so this covers both. */
const HEADLINE_DELAY_CLASSES = [
  '[animation-delay:80ms]',
  '[animation-delay:200ms]',
  '[animation-delay:320ms]',
  '[animation-delay:440ms]',
];

/**
 * The board list and tracked count, surface-aware.
 *
 * `getSourceHealth` carries crawl-run diagnostics (§30.2, Stage 4) the public
 * database role has no grant to read at all — `publicSourceOverview` is the
 * public equivalent, grouped from `public_opportunity_members` instead.
 * One real, unavoidable difference: `getSourceHealth` lists every REGISTERED
 * source from the `sources` table, even one with zero current listings;
 * `publicSourceOverview` can only ever list a source that has at least one
 * live, non-quarantined listing right now, since the public role has no
 * grant on `sources` itself. Not a gap in practice today (both real sources
 * have live listings), but a real, stated boundary of what this role can see.
 */
async function loadBoardOverview(surface: ReturnType<typeof currentSurface>): Promise<{
  sortedSlugs: string[];
  trackedCount: number;
  lastSync: string | undefined;
  lastSyncLabel: string;
}> {
  if (surface === 'public') {
    const overview = await publicSourceOverview(db);
    return {
      sortedSlugs: overview.map((source) => source.sourceSlug).sort(),
      trackedCount: overview.reduce((sum, source) => sum + source.trackedCount, 0),
      lastSync: publicLastSeen(overview),
      // Deliberately not "synced" — see `HeroData.lastSyncLabel`'s own comment.
      lastSyncLabel: 'last confirmed',
    };
  }
  const health = await getSourceHealth(db);
  // getSourceHealth's row order is whatever Postgres happened to return (no
  // ORDER BY in the query) — sorted here so the kicker's board list reads the
  // same on every render rather than depending on incidental result order (a
  // Codex design review found this during this screen's own build).
  const sortedSlugs = health.map((source) => source.sourceSlug).sort();
  const trackedCount = health.reduce(
    (sum, source) => sum + Object.values(source.listingsByStatus).reduce((a, b) => a + b, 0),
    0,
  );
  return {
    sortedSlugs,
    trackedCount,
    lastSync: lastCompletedSync(health),
    lastSyncLabel: 'synced',
  };
}

async function loadHeroData(): Promise<HeroData> {
  try {
    const surface = currentSurface();
    const genuinelyOpenAsOf = new Date().toISOString();
    const [{ sortedSlugs, trackedCount, lastSync, lastSyncLabel }, openCount, eligible] =
      await Promise.all([
        loadBoardOverview(surface),
        surface === 'public'
          ? publicCountOpportunities(db, { genuinelyOpenAsOf })
          : countOpportunities(db, { genuinelyOpenAsOf }),
        surface === 'public'
          ? publicSearchOpportunities(db, { genuinelyOpenAsOf, sort: 'recent', limit: ROWS_SHOWN })
          : searchOpportunities(db, { genuinelyOpenAsOf, sort: 'recent', limit: ROWS_SHOWN }),
      ]);

    const nowMs = Date.parse(genuinelyOpenAsOf);
    // Per-source "is THIS member genuinely open," not just the opportunity
    // overall — a cross-posted pair can have one board open and the other
    // already closed/expired, and `hasGenuinelyOpenMember`-shaped logic
    // upstream only guarantees at least ONE side qualifies. Computed here,
    // from the real per-member fields, and passed to the panel below so its
    // per-board pills can say which specific link is trustworthy (a Codex
    // review, 2026-09-15, found the first version showed every pill
    // identically regardless).
    const openSourceSlugs = (opportunity: OpportunityView): ReadonlySet<string> =>
      new Set(
        opportunity.members
          .filter(
            (member) =>
              member.status === 'active' &&
              (member.deadlineAt === null || Date.parse(member.deadlineAt) >= nowMs),
          )
          .map((member) => member.sourceSlug),
      );

    const panelRows: PanelRow[] = eligible.slice(0, 4).map((opportunity) => ({
      row: toRow(opportunity),
      openSourceSlugs: openSourceSlugs(opportunity),
    }));
    const tickerRows = eligible.slice(4, ROWS_SHOWN).map((opportunity) => toRow(opportunity));

    return {
      ok: true,
      boardsLabel: sortedSlugs.map((slug) => sourceLabel(slug)).join(' + '),
      boardsCount: sortedSlugs.length,
      trackedCount,
      lastSync,
      lastSyncLabel,
      openCount,
      panelRows,
      tickerRows,
    };
  } catch (err) {
    // A landing page that 500s because a health/count query timed out is
    // worse than one that shows less. Degrades to headline + CTAs only —
    // see the `hero.ok` checks above.
    console.error('landing hero: failed to load live data', err);
    return { ok: false };
  }
}

function HeadlineLine({
  runs,
  delayClass,
  locale,
}: {
  runs: ReadonlyArray<HeadlineRun>;
  delayClass: string;
  locale: Locale;
}) {
  return (
    <span className="block overflow-hidden">
      {/* tracking-[0.004em] is near-zero but still real letter-spacing, and
          georgian-typography.md rule 6 bans letter-spacing near Georgian
          categorically, not just above some magnitude threshold (Codex,
          2026-09-16) — English only. */}
      <span
        className={`block animate-hero-line-up whitespace-nowrap ${
          locale === 'en' ? 'tracking-[0.004em]' : ''
        } ${delayClass}`}
      >
        {runs.map((run) => (
          <span
            key={run.text}
            className={run.accent ? 'text-[var(--color-browse-accent)]' : 'text-white'}
          >
            {run.text}
          </span>
        ))}
      </span>
    </span>
  );
}

function Stat({ value, label, locale }: { value: number; label: string; locale: Locale }) {
  return (
    <div>
      <p className="numeric text-[34px] text-white leading-none">{count(value)}</p>
      {/* `.numeric` (Space Mono) covers only the count above — it has no
          Georgian glyphs, so the label below only takes it in English. */}
      <p
        className={`mt-2 text-[11px] text-[var(--color-browse-text-muted)] ${
          locale === 'en' ? 'numeric uppercase' : ''
        }`}
      >
        <span className={locale === 'en' ? 'tracking-[0.16em]' : ''}>{label}</span>
      </p>
    </div>
  );
}

function NewestPanel({
  rows,
  openCount,
  copy,
  locale,
}: {
  rows: PanelRow[];
  openCount: number;
  copy: HeroCopy;
  locale: Locale;
}) {
  return (
    <div>
      {/* `.numeric` is Space Mono, no Georgian coverage — English only. */}
      <p
        className={`text-[11px] text-[var(--color-browse-accent)] ${
          locale === 'en' ? 'numeric uppercase' : ''
        }`}
      >
        <span className={locale === 'en' ? 'tracking-[0.16em]' : ''}>{copy.newestListings}</span>
      </p>
      <div className="mt-3.5 overflow-hidden rounded-[14px] border border-[var(--color-browse-border)] bg-[var(--color-browse-panel)]">
        {rows.length === 0 ? (
          <p className="px-[18px] py-6 text-sm text-[var(--color-browse-text-muted)]">
            {copy.emptyState}
          </p>
        ) : (
          <>
            {rows.map((panelRow) => (
              <NewestRow
                key={panelRow.row.opportunityId}
                panelRow={panelRow}
                copy={copy}
                locale={locale}
              />
            ))}
            <a
              href="/opportunities?status=active"
              className="block px-[18px] py-3.5 text-[13px] text-[var(--color-browse-accent)] transition-colors duration-150 hover:text-[var(--color-browse-accent-hover)]"
            >
              {copy.seeAllOpenings(count(openCount))}
            </a>
          </>
        )}
      </div>
    </div>
  );
}

function NewestRow({
  panelRow,
  copy,
  locale,
}: {
  panelRow: PanelRow;
  copy: HeroCopy;
  locale: Locale;
}) {
  const { row, openSourceSlugs } = panelRow;
  const employers = row.employers.join(' · ');
  return (
    <div className="flex items-start gap-3.5 border-b border-[var(--color-browse-border)] px-[18px] py-4 last:border-b-0">
      <span
        aria-hidden="true"
        className="mt-1.5 h-1.5 w-1.5 flex-none rounded-full bg-[var(--color-browse-accent)]"
      />
      <div className="min-w-0 flex-1">
        <a
          href={`/opportunities/${row.opportunityId}`}
          className="block truncate text-[15px] font-semibold text-white leading-[var(--leading-body)] hover:text-[var(--color-browse-accent)]"
          title={row.title}
        >
          {row.title}
        </a>
        {row.employers.length > 0 && (
          <p
            className="truncate text-[13px] text-[var(--color-browse-text-muted)] leading-[var(--leading-body)]"
            title={employers}
          >
            {employers}
          </p>
        )}
      </div>
      <span className="flex flex-none flex-wrap justify-end gap-1">
        {row.sources.map((source) => {
          // At least one member of this opportunity is genuinely open (the
          // query-layer `genuinelyOpenAsOf` filter guarantees that), but
          // not necessarily *this* one — a cross-posted pair can have one
          // board active-with-a-live-deadline and the other already
          // closed/expired/missing, or active but individually past its
          // OWN deadline (a status-only check misses that second case —
          // found by a Codex review testing the real corpus, which
          // contains genuine examples of it). `openSourceSlugs` is the
          // same per-member status-and-deadline check the eligibility
          // filter itself uses, computed per source rather than per
          // opportunity. Rendering every pill identically regardless would
          // still link a visitor straight to an inactive listing with no
          // warning — exactly what `anti-patterns.md` and
          // `/opportunities`'s own `SourceLinks` (the pattern mirrored
          // here) both exist to prevent.
          const inactive = !openSourceSlugs.has(source.sourceSlug);
          // `source.status` alone would mislabel the "active status, but
          // this member's own deadline already passed" case (the whole
          // reason `openSourceSlugs` exists) as "open" — the enum value
          // really is `active`, reconciliation just hasn't caught up to
          // the deadline yet. `openSourceSlugs` already ruled that in or
          // out, so if status reads `active` but the pill is still
          // `inactive`, the deadline is categorically why.
          const label =
            inactive && source.status === 'active'
              ? {
                  short: copy.deadlinePassed,
                  explanation: copy.deadlinePassedExplanation,
                }
              : copy.sourceStatusLabel(source.status);
          return (
            <a
              key={source.sourceSlug}
              href={source.url}
              target="_blank"
              rel="noreferrer"
              translate="no"
              aria-label={`${row.title} on ${sourceLabel(source.sourceSlug)}${
                inactive ? `, ${label.short} on this board` : ''
              } (opens in a new tab)`}
              title={inactive ? label.explanation : undefined}
              // `.numeric` (Space Mono, no Georgian) only in English: this
              // pill can mix an always-Latin source name with a localized
              // `label.short` ("deadline passed" / "ვადა გავიდა"), and in
              // `ka` that second run has no Georgian glyph to fall back to
              // under Space Mono. English-only keeps the split-typeface risk
              // out; `ka` renders the whole pill in the default Noto Sans
              // Georgian sans stack instead, which covers both scripts.
              className={`${locale === 'en' ? 'numeric' : ''} rounded-full border border-[var(--color-browse-border-control)] px-2.5 py-1 text-[11px] text-[var(--color-browse-text-pill)] transition-colors duration-150 hover:border-[var(--color-browse-accent)] hover:text-[var(--color-browse-accent)]`}
            >
              {sourceLabel(source.sourceSlug)}
              {inactive && ` · ${label.short}`}
            </a>
          );
        })}
      </span>
    </div>
  );
}

// The marquee strip itself is `HeroTicker`, a client component
// (`web/components/hero-ticker.tsx`) — the one deliberate exception to
// this page's server-only rendering, for a real keyboard/touch-operable
// pause control (see that file's own comment for why plain CSS
// hover/focus-within wasn't sufficient, found by this screen's own Codex
// design review).
