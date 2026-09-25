/**
 * Shown while the review queue is read. A sentence, not a skeleton, matching
 * `(local)/review/loading.tsx` — an empty queue is a real, expected answer
 * grey bars would misrepresent as still loading.
 */
export default function Loading() {
  return (
    <main className="w-full px-4 py-8 sm:px-6 sm:py-10">
      <h1 className="text-xl font-semibold">Duplicates</h1>
      <p className="mt-6 text-sm text-faint" role="status">
        Loading the review queue…
      </p>
    </main>
  );
}
