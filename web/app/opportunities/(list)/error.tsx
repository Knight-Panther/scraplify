'use client';

/**
 * The screen's error state — reachable for real, since every render is a live
 * database query and the database is a local container that is not always up.
 *
 * It says which failure this is rather than showing a generic apology: "the
 * database is unreachable" and "the query was rejected" need different actions
 * from the person reading it, and the digest is what makes a server log
 * findable. The message itself is deliberately not printed — it can carry a
 * connection string.
 */
export default function OpportunitiesError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  // `retry`, not `reset`. In this Next version `reset()` only clears the error
  // boundary and re-renders its children without re-fetching, so against a
  // server-component database failure the button would appear to work and
  // change nothing. `retry()` re-fetches. (next/dist/docs .../error.md)
  retry: () => void;
}) {
  return (
    <main className="w-full px-4 py-8 sm:px-6 sm:py-10">
      <h1 className="text-xl font-semibold">Opportunities</h1>
      <div className="mt-6 max-w-[var(--measure)] rounded-[var(--radius)] border border-status-held bg-surface px-4 py-4">
        <p className="text-sm">This list could not be loaded.</p>
        <p className="mt-2 text-sm text-muted">
          The screen reads the database on every request, so the usual cause is that Postgres is not
          running. <span className="numeric">npm run dev</span> starts it and applies migrations.
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
