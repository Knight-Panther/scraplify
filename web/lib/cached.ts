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

/**
 * `cachedFor` for a family of answers told apart by a key: each key's answer
 * is asked once per `ttlMs`, and callers in the window share it, including
 * while it is on its way. An answer `keep` refuses is shared only while on
 * its way, then asked again by the next caller; so is a failed one. At most
 * `maxKeys` answers are held: past that the oldest goes, so a visitor trying
 * every key cannot grow the process.
 *
 * Keys are the caller's: build them from validated input only, never from a
 * raw request, and only for answers the same for everyone who may see them.
 */
export function cachedByKey<T>(
  ttlMs: number,
  maxKeys: number,
  keep: (value: T) => boolean = () => true,
  clock: () => number = Date.now,
): (key: string, load: () => Promise<T>) => Promise<T> {
  const entries = new Map<string, { at: number; value: Promise<T> }>();
  return (key, load) => {
    const now = clock();
    const held = entries.get(key);
    if (held !== undefined && now - held.at < ttlMs) return held.value;
    if (held !== undefined) entries.delete(key);
    const value = load();
    const loaded = { at: now, value };
    entries.set(key, loaded);
    while (entries.size > maxKeys) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
    const forget = () => {
      if (entries.get(key) === loaded) entries.delete(key);
    };
    value.then((answer) => {
      if (!keep(answer)) forget();
    }, forget);
    return value;
  };
}

/**
 * `cachedFor` that never makes a caller wait for a refresh: past `ttlMs` the
 * held answer is still returned while a new one loads in the background,
 * and it replaces the old one once it arrives. Only the very first caller
 * waits. A failed refresh keeps the old answer and is tried again by the
 * next caller; a failed first load is not kept.
 *
 * For an answer that is expensive to build and harmless when a little old,
 * such as Browse's in-memory index (Phase 16C): a crawl's rows reach the
 * page within about `ttlMs`, and no page view pays the rebuild.
 */
export function refreshingFor<T>(
  ttlMs: number,
  load: () => Promise<T>,
  clock: () => number = Date.now,
): () => Promise<T> {
  let held: { at: number; value: T } | null = null;
  let loading: Promise<T> | null = null;
  const start = () => {
    if (loading !== null) return loading;
    const started = clock();
    const next = load().then(
      (value) => {
        held = { at: started, value };
        loading = null;
        return value;
      },
      (error: unknown) => {
        loading = null;
        throw error;
      },
    );
    loading = next;
    return next;
  };
  return () => {
    if (held === null) return start();
    if (clock() - held.at >= ttlMs) start().catch(() => {});
    return Promise.resolve(held.value);
  };
}
