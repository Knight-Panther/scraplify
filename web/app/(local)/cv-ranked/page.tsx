import { cvRankedEnabled } from '../../../lib/cv-ranked/availability.js';
import { CvRankedView } from './cv-ranked-view.js';

export const metadata = { title: 'CV Ranked · Xtelo' };

/**
 * CV Ranked (Phase 8D, change.md §6). Everything on this screen is computed
 * in the visitor's browser from their CV and the public matching bundle; the
 * server renders only the empty shell, so it never sees any of it.
 *
 * While the Phase 8E switch has it off (`XTELO_CV_RANKED=off`), the page says
 * so plainly instead of 404ing a link someone may have bookmarked, and ships
 * none of the worker.
 */
export default function Page() {
  if (!cvRankedEnabled()) {
    return (
      <main className="w-full px-4 py-8 sm:px-6 sm:py-10">
        <h1 className="text-xl font-semibold">CV Ranked</h1>
        <p className="mt-2 max-w-[var(--measure)] text-sm text-muted">
          CV Ranked is paused for now. Browsing current vacancies works as usual.
        </p>
        <p className="mt-6">
          <a
            href="/opportunities"
            className="text-sm text-foreground underline decoration-border-strong underline-offset-2 hover:decoration-accent"
          >
            Browse vacancies
          </a>
        </p>
      </main>
    );
  }
  return <CvRankedView />;
}
