import { currentSurface } from '../../../../lib/surface.js';

/**
 * Reached both by a URL with no such opportunity and by one whose id is not a
 * uuid at all — `getOpportunity` refuses the second case rather than letting
 * Postgres raise on it, so a mistyped link is a 404 and not a 500.
 *
 * On public the usual cause is different. `publicGetOpportunity` returns a
 * vacancy only while one of its listings is still live, so once it closes,
 * expires or is taken down, every link to it lands here: shared links, old
 * search results and bookmarks. Search crawlers alone hit this about 600
 * times in the first five days after 2026-09-30, and real visitors did too.
 * The page says so plainly and offers the open vacancies. It cannot name the
 * closed one, because the public role cannot read it.
 *
 * Elsewhere, an earlier version of this page offered a second cause — that
 * review had split the grouping apart — and that cause cannot produce this
 * page. Detach and split deliberately RETAIN the opportunity for audit, and
 * `getOpportunity` returns one with no live members rather than refusing it,
 * so a reviewed cluster keeps resolving. Nothing deletes an opportunity in
 * normal operation, which leaves a mistyped or truncated link as the honest
 * explanation there.
 */
export default function OpportunityNotFound() {
  if (currentSurface() === 'public') {
    return (
      <main className="w-full px-4 py-8 sm:px-6 sm:py-10">
        <h1 className="text-pretty text-xl font-semibold">
          This vacancy or tender is no longer listed
        </h1>
        <p className="mt-4 max-w-[var(--measure)] text-sm text-muted">
          It has closed, passed its deadline, or the board that posted it took it down. Xtelo only
          shows vacancies and tenders that are still open. If you typed or pasted the address, check
          that it is complete.
        </p>
        <p className="mt-4 text-sm">
          <a
            className="text-accent underline underline-offset-2 hover:text-foreground"
            href="/opportunities"
          >
            Browse open vacancies and tenders
          </a>
        </p>
      </main>
    );
  }
  return (
    <main className="w-full px-4 py-8 sm:px-6 sm:py-10">
      <h1 className="text-pretty text-xl font-semibold">No such opportunity</h1>
      <p className="mt-4 max-w-[var(--measure)] text-sm text-muted">
        Nothing is stored under this address, so the link is most likely mistyped or truncated.
        Reviewing a duplicate does not cause this: detaching a listing keeps the record it came
        from, precisely so the decision stays inspectable.
      </p>
      <p className="mt-4 text-sm">
        <a
          className="text-accent underline underline-offset-2 hover:text-foreground"
          href="/opportunities"
        >
          Back to opportunities
        </a>
      </p>
    </main>
  );
}
