/**
 * Shown while the ambiguous-classification queue is read.
 *
 * A sentence rather than a skeleton, matching every other queue in this app
 * (`/review`, `/saved`): empty is a real, expected answer here — hr.ge's
 * structured-field classifications are all confidence 1 — and grey bars that
 * resolve to "nothing needs review" have asserted a list that was never
 * coming.
 */
export default function Loading() {
  return (
    <main className="w-full px-4 py-8 sm:px-6 sm:py-10">
      <h1 className="text-xl font-semibold">Taxonomy review</h1>
      <p className="mt-6 text-sm text-faint" role="status">
        Loading the review queue…
      </p>
    </main>
  );
}
