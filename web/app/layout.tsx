import type { ReactNode } from 'react';
import './globals.css';

// Every DB-reading segment is dynamic: `next build` must not prerender against a
// database, and caching a triage corpus someone re-checks daily is a correctness
// bug rather than a performance win.
export const dynamic = 'force-dynamic';

export const metadata = { title: 'Xtelo' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
