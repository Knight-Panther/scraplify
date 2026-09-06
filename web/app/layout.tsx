import type { ReactNode } from 'react';
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

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${notoGeorgian.variable} ${spaceMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
