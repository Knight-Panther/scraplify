/**
 * Shown while the count and the rows are read.
 *
 * A sentence rather than a skeleton, for the reason the opportunities screen
 * gives: the number of rows is exactly what is being looked up, and two of the
 * named views legitimately match nothing — grey bars that resolve to "no
 * listing has been edited since it was first captured" have told the reader
 * something false on the way there.
 */
export default function Loading() {
  return (
    <main className="w-full px-4 py-8 sm:px-6 sm:py-10">
      <h1 className="text-xl font-semibold">Listings</h1>
      <p className="mt-6 text-sm text-faint" role="status">
        Searching…
      </p>
    </main>
  );
}
