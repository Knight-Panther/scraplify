'use client';

import { useRouter } from 'next/navigation.js';
import { useEffect, useState } from 'react';
import {
  type CrawlStatusSnapshot,
  type CrawlStatusView,
  describeCrawlStatus,
} from '../../src/browse/crawl-status-view.js';
import {
  CRAWL_STATUS_COPY,
  countdown,
  updateClock,
  updateDateTime,
} from '../lib/crawl-status-copy.js';
import { sourceLabel } from '../lib/labels.js';
import type { Locale } from '../lib/locale.js';

/** The countdown's own tick; the text only changes by the minute. */
const TICK_MS = 30_000;
/** How often fresh snapshots are fetched while the tab is visible. */
const REFRESH_MS = 60_000;

const TONES = {
  hero: {
    list: 'text-[12px] text-[var(--color-browse-text-muted)]',
    source: 'font-semibold text-white',
    dot: 'bg-[var(--color-browse-accent)]',
  },
  admin: {
    list: 'text-sm text-muted',
    source: 'font-semibold text-foreground',
    dot: 'bg-[var(--color-status-open)]',
  },
} as const;

/**
 * Per source: when it was last fully updated and when the next scheduled
 * update is, counting down; "updating now" while a crawl runs, and "late"
 * when a scheduled run has not started 30 minutes after its time, so a
 * stopped scheduler shows instead of a countdown that quietly rolls over.
 *
 * Rendered on the server with the server's clock, then kept current in the
 * browser: the countdown every 30 s, the snapshots every minute from
 * `pollUrl` (public and local), or by re-rendering the page where there is
 * no such endpoint (admin). Nothing is polled while the tab is hidden.
 */
export function CrawlStatus({
  initial,
  initialNowMs,
  locale,
  pollUrl,
  tone,
}: {
  initial: CrawlStatusSnapshot[];
  initialNowMs: number;
  locale: Locale;
  pollUrl?: string;
  tone: keyof typeof TONES;
}) {
  const router = useRouter();
  const [snapshots, setSnapshots] = useState(initial);
  const [nowMs, setNowMs] = useState(initialNowMs);

  // A server re-render (the admin path) hands new props.
  useEffect(() => setSnapshots(initial), [initial]);

  useEffect(() => {
    const tick = window.setInterval(() => setNowMs(Date.now()), TICK_MS);
    setNowMs(Date.now());
    return () => window.clearInterval(tick);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const refresh = async (): Promise<void> => {
      if (document.visibilityState !== 'visible') return;
      if (pollUrl === undefined) {
        router.refresh();
        return;
      }
      try {
        const response = await fetch(pollUrl, { cache: 'no-store', credentials: 'omit' });
        if (!response.ok) return;
        const body = (await response.json()) as { sources?: CrawlStatusSnapshot[] };
        if (!cancelled && Array.isArray(body.sources)) setSnapshots(body.sources);
      } catch {
        // Keep the last snapshot; the next poll tries again.
      }
    };
    const timer = window.setInterval(refresh, REFRESH_MS);
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') {
        setNowMs(Date.now());
        void refresh();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [pollUrl, router]);

  const views = snapshots
    .map((snapshot) => describeCrawlStatus(snapshot, nowMs))
    .filter((view): view is CrawlStatusView => view !== null);
  if (views.length === 0) return null;

  const copy = CRAWL_STATUS_COPY[locale];
  const classes = TONES[tone];
  return (
    <section aria-label={copy.heading}>
      <ul className={`flex flex-col gap-1.5 leading-[var(--leading-body)] ${classes.list}`}>
        {views.map((view) => (
          // Two columns, so a line that wraps (Georgian, or a narrow
          // column) continues under the text rather than under the dot.
          // Spacing, not a "·", separates the two parts: a separator would
          // dangle at the end of a wrapped line.
          <li
            key={view.sourceSlug}
            className="grid grid-cols-[5.25rem_minmax(0,1fr)] items-baseline gap-x-2"
          >
            <span className="flex items-center gap-2">
              <StateDot view={view} dotClass={classes.dot} />
              <span className={classes.source} translate="no">
                {sourceLabel(view.sourceSlug)}
              </span>
            </span>
            <span className="flex flex-wrap gap-x-4">
              <span>
                {copy.lastUpdate}{' '}
                {view.lastUpdatedAt === null ? (
                  copy.noUpdateYet
                ) : (
                  <time dateTime={view.lastUpdatedAt} className="whitespace-nowrap tabular-nums">
                    {updateDateTime(view.lastUpdatedAt, locale)}
                  </time>
                )}
                {view.lastAttemptIncomplete && view.state.kind !== 'updating' && (
                  <> ({copy.lastAttemptIncomplete})</>
                )}
              </span>
              <StateText view={view} nowMs={nowMs} locale={locale} />
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function StateDot({ view, dotClass }: { view: CrawlStatusView; dotClass: string }) {
  const color = view.state.kind === 'late' ? 'bg-[var(--color-status-unconfirmed)]' : dotClass;
  const pulse = view.state.kind === 'updating' ? 'motion-safe:animate-hero-pulse' : '';
  return (
    <span aria-hidden="true" className={`h-1.5 w-1.5 flex-none rounded-full ${color} ${pulse}`} />
  );
}

function StateText({
  view,
  nowMs,
  locale,
}: {
  view: CrawlStatusView;
  nowMs: number;
  locale: Locale;
}) {
  const copy = CRAWL_STATUS_COPY[locale];
  if (view.state.kind === 'updating') return <span>{copy.updatingNow}</span>;
  if (view.state.kind === 'late') {
    return (
      <span className="text-[var(--color-status-unconfirmed)]">
        {copy.late(updateClock(view.state.expectedAt))}
      </span>
    );
  }
  return (
    <span>
      {copy.nextUpdate}{' '}
      <time
        dateTime={view.nextUpdateAt}
        title={updateDateTime(view.nextUpdateAt, locale)}
        className="whitespace-nowrap tabular-nums"
      >
        {countdown(Date.parse(view.nextUpdateAt), nowMs, locale)}
      </time>
    </span>
  );
}
