import type { ReactNode } from 'react';
import { SiteFooter } from '../components/site-footer.js';
import { SiteHeader } from '../components/site-header.js';
import { CvSessionProvider } from '../lib/cv-ranked/session.js';
import { currentSurface } from '../lib/surface.js';
import { bebasNeue, notoGeorgian, spaceMono } from './fonts.js';
import './globals.css';

// Every DB-reading segment is dynamic: `next build` must not prerender against
// a database, and caching a triage corpus someone re-checks daily is a
// correctness bug rather than a performance win.
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Xtelo',
  description: 'Job listings from jobs.ge and hr.ge, deduplicated and ranked.',
};

// Matches --color-background, so the browser's own chrome does not flash a
// light band above a black page.
export const viewport = { themeColor: '#000000' };

export default function RootLayout({ children }: { children: ReactNode }) {
  // Always "en", NOT the `lib/locale.ts` cookie: that cookie is read by
  // `/` alone to switch its own copy, and the root layout has no reliable,
  // Next-App-Router-supported way to know the CURRENT route (only
  // middleware injecting a header would give that) — reading it here would
  // put `lang="ka"` on `/opportunities`, `/listings` and every other
  // still-English screen the cookie also applies to, which is actively
  // wrong (a Codex review, 2026-09-16, caught screen readers and browser
  // language services then processing mostly-English pages as Georgian).
  return (
    <html
      lang="en"
      className={`${notoGeorgian.variable} ${spaceMono.variable} ${bebasNeue.variable}`}
    >
      <body className="flex min-h-screen flex-col">
        {/* The first stop for a keyboard user. The opportunities screen puts
            three filters and a sort control ahead of the table, so tabbing to
            the results is otherwise a dozen stops every visit. */}
        <a
          href="#content"
          className="sr-only focus:not-sr-only focus:absolute focus:z-10 focus:m-3 focus:rounded-[var(--radius)] focus:border focus:border-border-strong focus:bg-surface-raised focus:px-4 focus:py-2 focus:text-sm"
        >
          Skip to content
        </a>
        <SiteHeader />
        <div id="content" className="flex-1">
          {/* The CV Ranked session (Phase 8D) lives above the routes so the
              landing chooser can hand a running worker to /cv-ranked. Not on
              `admin`, which has no CV Ranked route. */}
          {currentSurface() === 'admin' ? (
            children
          ) : (
            <CvSessionProvider>{children}</CvSessionProvider>
          )}
        </div>
        <SiteFooter />
      </body>
    </html>
  );
}
