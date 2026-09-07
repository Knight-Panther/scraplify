import type { ReactNode } from 'react';
import { SiteNav } from '../components/site-nav.js';
import { notoGeorgian, spaceMono } from './fonts.js';
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
  return (
    <html lang="en" className={`${notoGeorgian.variable} ${spaceMono.variable}`}>
      <body>
        {/* The first stop for a keyboard user. The opportunities screen puts
            three filters and a sort control ahead of the table, so tabbing to
            the results is otherwise a dozen stops every visit. */}
        <a
          href="#content"
          className="sr-only focus:not-sr-only focus:absolute focus:z-10 focus:m-3 focus:rounded-[var(--radius)] focus:border focus:border-border-strong focus:bg-surface-raised focus:px-4 focus:py-2 focus:text-sm"
        >
          Skip to content
        </a>
        <SiteNav />
        <div id="content">{children}</div>
      </body>
    </html>
  );
}
