/**
 * Covers `/drafts`, `/drafts/new` and `/drafts/[id]`: a segment's own
 * `loading.tsx` applies to every route nested under it that doesn't define
 * its own (the App Router's normal boundary inheritance), and the three
 * screens here fetch different things but share the same honest answer while
 * they do — "still reading" — so one file covers all three instead of three
 * near-identical copies.
 *
 * A sentence, not a skeleton, for the same reason `/saved`'s loading state
 * gives: these are real database reads on every request, typically fast, and
 * a skeleton that resolves to "No drafts yet" has asserted a list that was
 * never coming.
 */
export default function Loading() {
  return (
    <main className="w-full px-4 py-8 sm:px-6 sm:py-10">
      <p className="text-sm text-faint" role="status">
        Loading…
      </p>
    </main>
  );
}
