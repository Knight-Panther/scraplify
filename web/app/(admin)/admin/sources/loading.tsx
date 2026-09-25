/**
 * Shown while source health is read. A sentence, not a skeleton, matching
 * every other queue/list screen in this app.
 */
export default function Loading() {
  return (
    <main className="w-full px-4 py-8 sm:px-6 sm:py-10">
      <h1 className="text-xl font-semibold">Sources</h1>
      <p className="mt-6 text-sm text-faint" role="status">
        Loading source health…
      </p>
    </main>
  );
}
