/**
 * Shown while the counts and the decided opportunities are read.
 *
 * The shortlist had no scoped loading or error state at all, unlike every
 * other database-backed screen here — so an unreachable Postgres fell through
 * to a generic framework failure with no retry path. `browser-qa.md` requires
 * all three states for every fetching screen, and this was the one that got
 * them last (whole-branch review, 2026-09-08).
 *
 * A sentence rather than a skeleton, for the reason the other screens give:
 * empty is a real answer here — nothing saved yet is the ordinary state on a
 * fresh instance — and grey bars that resolve to "Nothing is saved yet" have
 * asserted a list that was never coming.
 */
export default function Loading() {
  return (
    <main className="w-full px-4 py-8 sm:px-6 sm:py-10">
      <h1 className="text-xl font-semibold">Shortlist</h1>
      <p className="mt-6 text-sm text-faint" role="status">
        Loading your decisions…
      </p>
    </main>
  );
}
