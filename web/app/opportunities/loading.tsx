/**
 * Shown while the two queries run.
 *
 * Deliberately not a skeleton table. A skeleton implies a known number of rows
 * arriving in a known shape, and here the count is exactly what is being looked
 * up — a filter can legitimately match nothing, and grey bars that then resolve
 * to "no results" have told the user something false. A sentence that says what
 * is happening is more honest and costs nothing to read.
 */
export default function Loading() {
  return (
    <main className="w-full px-4 py-8 sm:px-6 sm:py-10">
      <h1 className="text-xl font-semibold">Opportunities</h1>
      <p className="mt-6 text-sm text-faint" role="status">
        Searching…
      </p>
    </main>
  );
}
