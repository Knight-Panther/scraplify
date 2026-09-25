'use client';

/**
 * The taxonomy review screen's own error state, following the same
 * scoped-boundary pattern every database-backed screen here uses —
 * `browser-qa.md` requires all three states (loading/content/error) for a
 * fetching screen, not a generic framework failure with no retry path.
 *
 * The message itself is not printed — it can carry a connection string —
 * while the digest is what makes the server log findable.
 */
export default function TaxonomyReviewError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  // `retry`, not `reset`: in this Next version `reset()` re-renders the
  // boundary's children without re-fetching, so against a server-component
  // database failure the button would appear to work and change nothing.
  retry: () => void;
}) {
  return (
    <main className="w-full px-4 py-8 sm:px-6 sm:py-10">
      <h1 className="text-xl font-semibold">Taxonomy review</h1>
      <div className="mt-6 max-w-[var(--measure)] rounded-[var(--radius)] border border-status-held bg-surface px-4 py-4">
        <p className="text-sm">The review queue could not be loaded.</p>
        <p className="mt-2 text-sm text-muted">
          This screen queries the database on every request, so the usual cause is that Postgres is
          not running. <span className="numeric">npm run dev</span> starts it and applies
          migrations.
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
