import type { Metadata } from 'next';
import { type CrawlStatusSnapshot, getCrawlStatus } from '../../../src/browse/crawl-status.js';
import {
  publicCountOpportunities,
  publicSearchOpportunities,
  publicSourceOverview,
} from '../../../src/browse/public-queries.js';
import {
  countOpportunities,
  getSourceHealth,
  type OpportunityView,
  searchOpportunities,
} from '../../../src/browse/queries.js';
import { db } from '../../../src/db/client.js';
import { PROGRAMME_KINDS } from '../../../src/dedupe/programme-kind.js';
import { countRealEstate } from '../../../src/realestate/queries.js';
import { CrawlStatus } from '../../components/crawl-status.js';
import { CvChooser } from '../../components/cv-chooser.js';
import { HeroTicker } from '../../components/hero-ticker.js';
import { HeroPoster, HeroVideo } from '../../components/hero-video.js';
import { KindTag } from '../../components/kind-tag.js';
import { LandingCrawler } from '../../components/landing-crawler.js';
import { cvRankedEnabled } from '../../lib/cv-ranked/availability.js';
import { count } from '../../lib/format.js';
import { type HeadlineRun, type HeroCopy, heroCopy } from '../../lib/hero-copy.js';
import { kindLabel } from '../../lib/kind-labels.js';
import { sourceLabel } from '../../lib/labels.js';
import { currentLocale, type Locale } from '../../lib/locale.js';
import { type OpportunityRow, toRow } from '../../lib/opportunity-row.js';
import { siteOpenGraph } from '../../lib/site-metadata.js';
import { currentSurface } from '../../lib/surface.js';

export const dynamic = 'force-dynamic';

/**
 * The page shared most, so it states its own address for previews and
 * search, in the visitor's language (Georgian for a crawler: lib/locale.ts).
 */
export async function generateMetadata(): Promise<Metadata> {
  const locale = await currentLocale();
  return {
    alternates: { canonical: '/' },
    openGraph: siteOpenGraph({ locale, url: '/' }),
  };
}

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
 * than that. Programme kinds (courses, scholarships and the rest, Phase
 * 15B) are left out of both with `excludeTypes`, so the stat's words, open
 * vacancies and tenders, stay true, and the links below carry the same two
 * kinds (`VACANCIES_AND_TENDERS`). The CTA links point at `/opportunities?status=active`,
 * the closest real destination — that screen has not been retrofitted with
 * this same per-member filter, so its own count can differ slightly from
 * the number shown here; recorded as a known, narrower gap rather than
 * silently glossed over.
 */
/** The kinds this page counts and shows, as Browse's query (`web/lib/search-params.ts`). */
const VACANCIES_AND_TENDERS = 'type=job&type=tender';

export default async function Page() {
  const [hero, crawlStatus, locale] = await Promise.all([
    loadHeroData(),
    loadCrawlStatus(),
    currentLocale(),
  ]);
  const copy = heroCopy(locale);

  return (
    // Only this page follows the locale, so it states its own language:
    // the root <html lang> stays "en" for the other, English-only screens.
    <main lang={locale}>
      {/* On a two-column desktop the hero fills exactly the screen between
          the 64px header and the 59px footer, so the whole page, ticker and
          footer included, is visible without scrolling (owner request,
          2026-09-27). Headline size and vertical spacing scale with the
          viewport height there for the same reason. Still min-h, not h: a
          window too short for even the smallest sizes scrolls instead of
          clipping. Narrower screens stack and scroll as before. */}
      <section className="relative flex min-h-[calc(100svh-56px)] flex-col justify-end overflow-hidden border-b border-border bg-background min-[900px]:min-h-[calc(100svh-64px)] lg:min-h-[calc(100svh-123px)]">
        {/* The film and its poster. On light, `--hero-film-filter` turns the
            same files into a light map (globals.css): nothing new to load. */}
        <div aria-hidden="true" className="absolute inset-0 [filter:var(--hero-film-filter)]">
          <HeroPoster />
          <HeroVideo />
        </div>
        {/* Legibility veil, not the source reference's grid+glow layers:
            those exist as an alternative background for a page with no
            video, and over real video the glow is invisible anyway. Its
            gradient is the theme's (`--hero-veil`): the page's own dark
            ground on dark, so the reduced-motion render (the poster alone,
            see hero-video.tsx) rests on the same ground as the panel and
            ticker below; the light ground from the left on light. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 [background:var(--hero-veil)]"
        />

        <div className="relative mx-auto grid w-full max-w-[1440px] grid-cols-1 items-end gap-11 px-8 pt-14 min-[1060px]:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] min-[1060px]:gap-14 min-[1060px]:pt-[3svh]">
          <div>
            {hero.ok && (
              <p className="numeric flex animate-hero-fade-up items-start gap-[9px] text-[11px] text-accent uppercase [animation-duration:600ms]">
                {/* On the first line's middle (its line is 17.6 px), so it
                    stays there if the names wrap. */}
                <span
                  aria-hidden="true"
                  className="mt-[5.8px] h-1.5 w-1.5 flex-none animate-hero-pulse rounded-full bg-accent-line"
                />
                {/* Tighter on a phone: with ss.ge the four names at 0.22em
                    took two lines at 390 px; without spacing they fit on one from
                    360 px with 17 px to spare (measured). */}
                <span className="tracking-normal sm:tracking-[0.22em]">{hero.boardsLabel}</span>
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
                    'font-[family-name:var(--font-display-ka)] text-[clamp(20px,3.1vw,43px)] leading-[1.4] min-[1060px]:text-[clamp(20px,min(3.1vw,calc(4.6svh-8px)),43px)]'
                  : 'font-[family-name:var(--font-display)] text-[clamp(46px,7.4vw,104px)] leading-[0.86] uppercase min-[1060px]:text-[clamp(40px,min(7.4vw,calc(10.5svh-28px)),104px)]'
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
              className="mt-[26px] h-0.5 w-full animate-hero-sweep min-[1060px]:mt-[2svh] bg-accent-line"
            />

            <p className="mt-[22px] max-w-[64ch] animate-hero-fade-up min-[1060px]:mt-[2svh] text-base text-faint leading-[var(--leading-body)] [animation-delay:640ms] [animation-duration:700ms]">
              <Subhead copy={copy} />
            </p>

            {/* One row: the two links with "no account needed" under them,
                and the CV chooser with its privacy note under it. */}
            <div className="mt-[30px] flex animate-hero-fade-up flex-wrap items-start gap-3 [animation-delay:760ms] [animation-duration:700ms] min-[1060px]:mt-[3svh]">
              <div className="flex flex-col gap-1.5">
                <div className="flex flex-wrap gap-3">
                  <a
                    href={`/opportunities?status=active&${VACANCIES_AND_TENDERS}`}
                    className="inline-flex h-[50px] items-center rounded-[var(--radius)] bg-brand px-5 text-[15px] font-bold text-ink transition-colors duration-150 hover:bg-brand-hover"
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
                    href={`/opportunities?status=active&closing=7&${VACANCIES_AND_TENDERS}`}
                    className="inline-flex h-[50px] items-center rounded-[var(--radius)] border border-border-control px-[18px] text-[15px] text-muted transition-colors duration-150 hover:border-border-hover hover:text-foreground"
                  >
                    {copy.closingSoon}
                  </a>
                </div>
                {/* `.numeric` is Space Mono, which has no Georgian coverage
                  (fonts.ts) — kept only for the English copy, which used it
                  for SynapseX's monospace chrome look; Georgian falls back
                  to the default `--font-sans` (Noto Sans Georgian), which
                  actually covers it. */}
                <span className={`${locale === 'en' ? 'numeric' : ''} text-xs text-faint`}>
                  {copy.noAccountNeeded}
                </span>
              </div>

              {/* Phase 8D: the CV is read in this tab's worker and the page
                  client-navigates to /cv-ranked. Rendered even when the live
                  hero data failed — it needs only the public bundle. Absent
                  while the Phase 8E switch has CV Ranked off. */}
              {cvRankedEnabled() && (
                <CvChooser
                  navigate
                  noteFitsButton
                  label={copy.rankByCv}
                  note={copy.rankByCvNote}
                  className="inline-flex h-[50px] w-fit items-center rounded-[var(--radius)] border border-accent-line px-[18px] text-[15px] font-semibold text-accent transition-colors duration-150 hover:bg-brand hover:text-ink"
                />
              )}
            </div>

            {hero.ok && (
              <div className="mt-11 flex animate-hero-fade-up flex-wrap gap-x-12 gap-y-6 border-t border-border pt-6 [animation-delay:880ms] [animation-duration:700ms] min-[1060px]:mt-[3svh] min-[1060px]:pt-[2svh]">
                <Stat value={hero.openCount} label={copy.statOpenVacancies} locale={locale} />
                <Stat value={hero.boardsCount} label={copy.statBoardsMerged} locale={locale} />
                <Stat value={hero.trackedCount} label={copy.statListingsTracked} locale={locale} />
              </div>
            )}
          </div>

          {(hero.ok || crawlStatus !== null) && (
            <div className="animate-hero-fade-up [animation-delay:700ms] [animation-duration:800ms]">
              {/* Each board's last full update and a countdown to its next
                  scheduled one, above the newest listings it vouches for.
                  Its own query, so it shows even when the hero data failed. */}
              {/* The crawler walks these rows (Phase 10B pilot); it steps
                  aside when a reader points, touches or tabs in. */}
              <LandingCrawler>
                {crawlStatus !== null && (
                  <div className="mb-6">
                    <CrawlStatus
                      initial={crawlStatus.sources}
                      initialNowMs={crawlStatus.nowMs}
                      locale={locale}
                      pollUrl="/api/crawl-status"
                      tone="hero"
                    />
                  </div>
                )}
                {hero.ok && (
                  <NewestPanel
                    rows={hero.panelRows}
                    openCount={hero.openCount}
                    copy={copy}
                    locale={locale}
                  />
                )}
              </LandingCrawler>
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
}> {
  if (surface === 'public') {
    const overview = await publicSourceOverview(db);
    return {
      sortedSlugs: overview.map((source) => source.sourceSlug).sort(),
      trackedCount: overview.reduce((sum, source) => sum + source.trackedCount, 0),
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
  return { sortedSlugs, trackedCount };
}

async function loadHeroData(): Promise<HeroData> {
  try {
    const surface = currentSurface();
    const genuinelyOpenAsOf = new Date().toISOString();
    const newest = { sort: 'recent', limit: ROWS_SHOWN, excludeTypes: PROGRAMME_KINDS } as const;
    const [{ sortedSlugs, trackedCount }, openCount, eligible, realEstateShown] = await Promise.all(
      [
        loadBoardOverview(surface),
        surface === 'public'
          ? publicCountOpportunities(db, { genuinelyOpenAsOf, excludeTypes: PROGRAMME_KINDS })
          : countOpportunities(db, { genuinelyOpenAsOf, excludeTypes: PROGRAMME_KINDS }),
        surface === 'public'
          ? publicSearchOpportunities(db, { ...newest, genuinelyOpenAsOf })
          : searchOpportunities(db, { ...newest, genuinelyOpenAsOf }),
        // Whether the Real estate tab has anything on show: counted no
        // further than one row. Its own catch, so a database without the
        // real-estate view still shows the job boards.
        countRealEstate(db, {}, genuinelyOpenAsOf, 0).then(
          (shown) => shown > 0,
          () => false,
        ),
      ],
    );

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
      // ss.ge joins the list of sources, not the count of boards merged: its
      // listings are a tab of their own, never folded into these records.
      boardsLabel: [
        ...sortedSlugs.map((slug) => sourceLabel(slug)),
        ...(realEstateShown ? [sourceLabel('ss-ge')] : []),
      ].join(' + '),
      boardsCount: sortedSlugs.length,
      trackedCount,
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

/**
 * Each board's crawl snapshot for `CrawlStatus`, with the clock it was read
 * at so the first render matches on server and client. Null when the query
 * fails: the line is left out rather than guessed.
 */
async function loadCrawlStatus(): Promise<{
  sources: CrawlStatusSnapshot[];
  nowMs: number;
} | null> {
  try {
    return { sources: await getCrawlStatus(db), nowMs: Date.now() };
  } catch (err) {
    console.error('landing: failed to load crawl status', err);
    return null;
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
        {/* The brand-coloured words are lime on dark and ink over a lime
            highlighter on light (`.hero-mark`, globals.css). */}
        {runs.map((run) => (
          <span key={run.text} className={run.accent ? 'hero-mark' : 'text-foreground'}>
            {run.text}
          </span>
        ))}
      </span>
    </span>
  );
}

/**
 * The subhead, its Real estate words a link to that tab. Underlined, not
 * only coloured: the accent is under 3:1 against the muted text around it.
 */
function Subhead({ copy }: { copy: HeroCopy }) {
  const at = copy.subhead.indexOf(copy.subheadRealEstateLink);
  if (at < 0) return copy.subhead;
  return (
    <>
      {copy.subhead.slice(0, at)}
      <a
        href="/real-estate"
        className="text-accent underline underline-offset-[3px] transition-colors duration-150 hover:text-accent-hover"
      >
        {copy.subheadRealEstateLink}
      </a>
      {copy.subhead.slice(at + copy.subheadRealEstateLink.length)}
    </>
  );
}

function Stat({ value, label, locale }: { value: number; label: string; locale: Locale }) {
  return (
    <div>
      <p className="numeric text-[34px] text-foreground leading-none">{count(value)}</p>
      {/* `.numeric` (Space Mono) covers only the count above — it has no
          Georgian glyphs, so the label below only takes it in English. */}
      <p className={`mt-2 text-[11px] text-faint ${locale === 'en' ? 'numeric uppercase' : ''}`}>
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
      <p className={`text-[11px] text-accent ${locale === 'en' ? 'numeric uppercase' : ''}`}>
        <span className={locale === 'en' ? 'tracking-[0.16em]' : ''}>{copy.newestListings}</span>
      </p>
      <div className="mt-3.5 overflow-hidden rounded-[14px] border border-border bg-surface">
        {rows.length === 0 ? (
          <p className="px-[18px] py-6 text-sm text-faint">{copy.emptyState}</p>
        ) : (
          <>
            {rows.map((panelRow, index) => (
              <NewestRow
                key={panelRow.row.opportunityId}
                panelRow={panelRow}
                copy={copy}
                locale={locale}
                // Fewer rows on a short desktop screen, so the page still
                // fits one screen (the column is otherwise the taller one in
                // Georgian, whose update lines wrap, and ss.ge's line made it
                // taller again): HIDE_WHEN_SHORT. "See all" follows.
                hideWhenShort={index >= 3 ? 'short' : index >= 2 ? 'shorter' : undefined}
              />
            ))}
            <a
              href={`/opportunities?status=active&${VACANCIES_AND_TENDERS}`}
              data-crawl-stop=""
              className="block px-[18px] py-3.5 text-[13px] text-accent transition-colors duration-150 hover:text-accent-hover"
            >
              <span data-crawl="">{copy.seeAllOpenings(count(openCount))}</span>
            </a>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Whole class names, so Tailwind finds them. Georgian's update lines wrap, so
 * its column runs out of height sooner (measured 2026-10-16 from 1280x720 to
 * 1920x950 against the live page: no size scrolls more than it did before
 * ss.ge's line was added).
 */
const HIDE_WHEN_SHORT = {
  short: { en: 'lg:[@media(max-height:760px)]:hidden', ka: 'lg:[@media(max-height:860px)]:hidden' },
  shorter: { en: '', ka: 'lg:[@media(max-height:680px)]:hidden' },
} as const;

function NewestRow({
  panelRow,
  copy,
  locale,
  hideWhenShort,
}: {
  panelRow: PanelRow;
  copy: HeroCopy;
  locale: Locale;
  hideWhenShort?: 'short' | 'shorter' | undefined;
}) {
  const { row, openSourceSlugs } = panelRow;
  const employers = row.employers.join(' · ');
  return (
    <div
      data-crawl-stop=""
      className={`flex items-start gap-3.5 border-b border-border px-[18px] py-4 last:border-b-0 ${
        hideWhenShort === undefined ? '' : HIDE_WHEN_SHORT[hideWhenShort][locale]
      }`}
    >
      <span
        aria-hidden="true"
        className="mt-1.5 h-1.5 w-1.5 flex-none rounded-full bg-accent-line"
      />
      <div className="min-w-0 flex-1">
        {row.type !== 'job' && (
          <span className="mb-1 block">
            <KindTag type={row.type} label={kindLabel(row.type, locale)} />
          </span>
        )}
        <a
          href={`/opportunities/${row.opportunityId}`}
          data-crawl=""
          className="block truncate text-[15px] font-semibold text-foreground leading-[var(--leading-body)] hover:text-accent"
          title={row.title}
        >
          {row.title}
        </a>
        {row.employers.length > 0 && (
          <p
            data-crawl=""
            className="truncate text-[13px] text-faint leading-[var(--leading-body)]"
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
              data-crawl=""
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
              className={`${locale === 'en' ? 'numeric' : ''} rounded-full border border-border-control px-2.5 py-1 text-[11px] text-muted transition-colors duration-150 hover:border-accent-line hover:text-accent`}
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
