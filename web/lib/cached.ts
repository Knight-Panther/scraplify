/**
 * An answer that is the same for every visitor and changes slowly, asked
 * once per `ttlMs` in this process instead of once per page view. Callers in
 * the same window share the one answer, including while it is still on its
 * way; a failed answer is not kept, so the next caller asks again.
 *
 * Per process, so each surface (`local`, `public`, `admin`) keeps its own, read
 * through its own database role. Use it only for data that is the same for
 * everyone who may see the page, and whose staleness for `ttlMs` is harmless.
 */
export function cachedFor<T>(
  ttlMs: number,
  load: () => Promise<T>,
  clock: () => number = Date.now,
): () => Promise<T> {
  let entry: { at: number; value: Promise<T> } | null = null;
  return () => {
    const now = clock();
    if (entry === null || now - entry.at >= ttlMs) {
      const value = load();
      const loaded = { at: now, value };
      entry = loaded;
      value.catch(() => {
        if (entry === loaded) entry = null;
      });
    }
    return entry.value;
  };
}
