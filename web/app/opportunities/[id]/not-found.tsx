/**
 * Reached both by a URL with no such opportunity and by one whose id is not a
 * uuid at all — `getOpportunity` refuses the second case rather than letting
 * Postgres raise on it, so a mistyped link is a 404 and not a 500.
 *
 * An earlier version of this page offered a second cause — that review had
 * split the grouping apart — and that cause cannot produce this page. Detach
 * and split deliberately RETAIN the opportunity for audit, and
 * `getOpportunity` returns one with no live members rather than refusing it,
 * so a reviewed cluster keeps resolving. Nothing deletes an opportunity in
 * normal operation, which leaves a mistyped or truncated link as the honest
 * explanation.
 */
export default function OpportunityNotFound() {
  return (
    <main className="w-full px-4 py-8 sm:px-6 sm:py-10">
      <h1 className="text-xl font-semibold">No such opportunity</h1>
      <p className="mt-4 max-w-[var(--measure)] text-sm text-muted">
        Nothing is stored under this address, so the link is most likely mistyped or truncated.
        Reviewing a duplicate does not cause this: detaching a listing keeps the record it came
        from, precisely so the decision stays inspectable.
      </p>
      <p className="mt-4 text-sm">
        <a className="text-accent underline underline-offset-2" href="/opportunities">
          Back to opportunities
        </a>
      </p>
    </main>
  );
}
