import {
  type OpportunityView,
  countOpportunities,
  getSourceHealth,
  searchOpportunities,
} from '../../src/browse/queries.js';
import { db } from '../../src/db/client.js';
import { HeroTicker } from '../components/hero-ticker.js';
import { HeroVideo } from '../components/hero-video.js';
import { count, relativeTime } from '../lib/format.js';
import { listingStatusLabel, sourceLabel } from '../lib/labels.js';
import { type OpportunityRow, toRow } from '../lib/opportunity-row.js';
import { lastCompletedSync } from '../lib/sync.js';

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
  const hero = await loadHeroData();

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
                  {hero.lastSync !== undefined && <> · synced {relativeTime(hero.lastSync)}</>}
                </span>
              </p>
            )}

            <h1 className="mt-[18px] font-[family-name:var(--font-display)] text-[clamp(46px,7.4vw,104px)] uppercase leading-[0.86]">
              <HeadlineLine text="DO NOT MISS" accent={false} delayClass="[animation-delay:80ms]" />
              <HeadlineLine
                text="YOUR CHANCE,"
                accent={false}
                delayClass="[animation-delay:200ms]"
              />
              <HeadlineLine
                text="KEEP YOURSELF"
                accent={true}
                delayClass="[animation-delay:320ms]"
              />
              <HeadlineLine text="POSTED!" accent={true} delayClass="[animation-delay:440ms]" />
            </h1>

            <div
              aria-hidden="true"
              className="mt-[26px] h-0.5 w-full animate-hero-sweep bg-[var(--color-browse-accent)]"
            />

            <p className="mt-[22px] max-w-[52ch] animate-hero-fade-up text-base text-[var(--color-browse-text-muted)] leading-[var(--leading-body)] [animation-delay:640ms] [animation-duration:700ms]">
              Job vacancies from jobs.ge and hr.ge, deduplicated into one record — browse, filter
              and shortlist without checking two sites separately.
            </p>

            <div className="mt-[30px] flex animate-hero-fade-up flex-wrap items-center gap-3 [animation-delay:760ms] [animation-duration:700ms]">
              <a
                href="/opportunities?status=active"
                className="inline-flex h-[50px] items-center rounded-[var(--radius)] bg-[var(--color-browse-accent)] px-[26px] text-[15px] font-bold text-[var(--color-browse-ink)] transition-colors duration-150 hover:bg-[var(--color-browse-accent-hover)]"
              >
                Browse openings
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
                Closing soon
              </a>
              <span className="numeric text-xs text-[var(--color-browse-text-muted)]">
                no account needed
              </span>
            </div>

            {hero.ok && (
              <div className="mt-11 flex animate-hero-fade-up flex-wrap gap-x-12 gap-y-6 border-t border-[var(--color-browse-border)] pt-6 [animation-delay:880ms] [animation-duration:700ms]">
                <Stat value={hero.openCount} label="open vacancies" />
                <Stat value={hero.boardsCount} label="boards merged" />
                <Stat value={hero.trackedCount} label="listings tracked" />
              </div>
            )}
          </div>

          {hero.ok && (
            <div className="animate-hero-fade-up [animation-delay:700ms] [animation-duration:800ms]">
              <NewestPanel rows={hero.panelRows} openCount={hero.openCount} />
            </div>
          )}
        </div>

        {hero.ok && <HeroTicker rows={hero.tickerRows} />}
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
      openCount: number;
      panelRows: PanelRow[];
      tickerRows: OpportunityRow[];
    }
  | { ok: false };

/** Panel (4) + ticker (10). */
const ROWS_SHOWN = 14;

async function loadHeroData(): Promise<HeroData> {
  try {
    const genuinelyOpenAsOf = new Date().toISOString();
    const [health, openCount, eligible] = await Promise.all([
      getSourceHealth(db),
      countOpportunities(db, { genuinelyOpenAsOf }),
      searchOpportunities(db, { genuinelyOpenAsOf, sort: 'recent', limit: ROWS_SHOWN }),
    ]);

    // getSourceHealth's row order is whatever Postgres happened to return
    // (no ORDER BY in the query) — sorted here so the kicker's board list
    // reads the same on every render rather than depending on incidental
    // result order (found during this screen's own Codex design review).
    const sortedHealth = [...health].sort((a, b) => a.sourceSlug.localeCompare(b.sourceSlug));

    const trackedCount = health.reduce(
      (sum, source) => sum + Object.values(source.listingsByStatus).reduce((a, b) => a + b, 0),
      0,
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
      boardsLabel: sortedHealth.map((source) => sourceLabel(source.sourceSlug)).join(' + '),
      boardsCount: health.length,
      trackedCount,
      lastSync: lastCompletedSync(health),
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
  text,
  accent,
  delayClass,
}: {
  text: string;
  accent: boolean;
  delayClass: string;
}) {
  return (
    <span className="block overflow-hidden">
      <span
        className={`block animate-hero-line-up whitespace-nowrap tracking-[0.004em] ${delayClass} ${
          accent ? 'text-[var(--color-browse-accent)]' : 'text-white'
        }`}
      >
        {text}
      </span>
    </span>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div>
      <p className="numeric text-[34px] text-white leading-none">{count(value)}</p>
      <p className="numeric mt-2 text-[11px] text-[var(--color-browse-text-muted)] uppercase">
        <span className="tracking-[0.16em]">{label}</span>
      </p>
    </div>
  );
}

function NewestPanel({ rows, openCount }: { rows: PanelRow[]; openCount: number }) {
  return (
    <div>
      <p className="numeric text-[11px] text-[var(--color-browse-text-muted)] uppercase">
        <span className="tracking-[0.16em]">Newest listings</span>
      </p>
      <div className="mt-3.5 overflow-hidden rounded-[14px] border border-[var(--color-browse-border)] bg-[var(--color-browse-panel)]">
        {rows.length === 0 ? (
          <p className="px-[18px] py-6 text-sm text-[var(--color-browse-text-muted)]">
            There are no opportunities yet. They appear once a crawl has run and listings have been
            grouped.
          </p>
        ) : (
          <>
            {rows.map((panelRow) => (
              <NewestRow key={panelRow.row.opportunityId} panelRow={panelRow} />
            ))}
            <a
              href="/opportunities?status=active"
              className="block px-[18px] py-3.5 text-[13px] text-[var(--color-browse-accent)] transition-colors duration-150 hover:text-[var(--color-browse-accent-hover)]"
            >
              See all {count(openCount)} openings →
            </a>
          </>
        )}
      </div>
    </div>
  );
}

function NewestRow({ panelRow }: { panelRow: PanelRow }) {
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
                  short: 'deadline passed',
                  explanation:
                    'This board still lists it as active, but its own stated deadline has already passed.',
                }
              : listingStatusLabel(source.status);
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
              className="numeric rounded-full border border-[var(--color-browse-border-control)] px-2.5 py-1 text-[11px] text-[var(--color-browse-text-pill)] transition-colors duration-150 hover:border-[var(--color-browse-accent)] hover:text-[var(--color-browse-accent)]"
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
