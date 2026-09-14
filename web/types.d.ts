// noUncheckedSideEffectImports (inherited from the root config) rejects a bare
// `import "./globals.css"` without this.
declare module '*.css';

/**
 * Types for the bare `next/font/google` specifier.
 *
 * Two constraints collide. Next's font support is a COMPILE-TIME transform keyed
 * on the exact specifier `next/font/google`, so the import cannot be written any
 * other way — `next/font/google/index.js` typechecks but makes Turbopack fail
 * with "Export Noto_Sans_Georgian doesn't exist in target module". Meanwhile
 * `next` ships no exports map, and nodenext ESM resolution does no
 * directory-index lookup, so the bare specifier has no types.
 *
 * Re-exporting the real declarations under the bare name satisfies both: the
 * transform sees the specifier it needs, and the types are the package's own
 * rather than hand-written stubs that could drift.
 */
declare module 'next/font/google' {
  export * from 'next/font/google/index.js';
}
