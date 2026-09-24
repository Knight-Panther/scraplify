'use client';

/**
 * This route's own error state, following `(local)/review/error.tsx`'s
 * template exactly, including the `retry`-not-`reset` reasoning: `reset()`
 * re-renders the boundary's children without re-fetching, which against a
 * server-component database failure would appear to work and change
 * nothing.
 *
 * The message itself is not printed — it can carry a connection string —
 * while the digest is what makes the server log findable.
 */
export default function AdminDuplicatesError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <main className="w-full px-4 py-8 sm:px-6 sm:py-10">
      <h1 className="text-xl font-semibold">Duplicates</h1>
      <div className="mt-6 max-w-[var(--measure)] rounded-[var(--radius)] border border-status-held bg-surface px-4 py-4">
        <p className="text-sm">The review queue could not be loaded.</p>
        <p className="mt-2 text-sm text-muted">
          Nothing has been decided or lost — this is a failure to read the queue, not to keep it.
          The screen queries the database on every request, so the usual cause is that Postgres is
          not running.
        </p>
        {error.digest !== undefined && (
          <p className="mt-2 text-xs text-faint">
            Server log reference: <span className="numeric">{error.digest}</span>
          </p>
        )}
        <button
          type="button"
          onClick={() => retry()}
          className="mt-4 rounded-[var(--radius)] border border-border-strong bg-surface-raised px-4 py-1.5 text-sm hover:bg-surface-active"
        >
          Try again
        </button>
      </div>
    </main>
  );
}
