/**
 * Shown while the queue is read. A sentence, not a skeleton — the shortlist
 * screen's own note about `browser-qa.md` requiring all three states for
 * every fetching screen applies here too, and an empty queue is a real,
 * expected answer that grey bars would misrepresent as still loading.
 */
export default function Loading() {
  return (
    <main className="w-full px-4 py-8 sm:px-6 sm:py-10">
      <h1 className="text-xl font-semibold">Duplicate review</h1>
      <p className="mt-6 text-sm text-faint" role="status">
        Loading the review queue…
      </p>
    </main>
  );
}
