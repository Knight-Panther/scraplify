/**
 * Shown while the ambiguous-classification queue is read, matching
 * `(local)/taxonomy-review/loading.tsx` — a sentence, not a skeleton, since
 * an empty queue is a real, expected answer.
 */
export default function Loading() {
  return (
    <main className="w-full px-4 py-8 sm:px-6 sm:py-10">
      <h1 className="text-xl font-semibold">Taxonomy</h1>
      <p className="mt-6 text-sm text-faint" role="status">
        Loading the review queue…
      </p>
    </main>
  );
}
