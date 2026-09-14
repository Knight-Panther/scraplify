/**
 * Shown while the profile, the count, the rankings and their members are read.
 *
 * A sentence rather than a skeleton, for the reason the other screens give:
 * how many results there are is exactly what is being looked up, and a ranking
 * can legitimately be empty — the stored rows go stale the moment a dedupe
 * pass rewrites the revisions they were scored against.
 */
export default function Loading() {
  return (
    <main className="w-full px-4 py-8 sm:px-6 sm:py-10">
      <h1 className="text-xl font-semibold">Ranked</h1>
      <p className="mt-6 text-sm text-faint" role="status">
        Scoring…
      </p>
    </main>
  );
}
