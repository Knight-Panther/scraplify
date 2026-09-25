/**
 * `tsc` (this repo's TypeScript 7 native port, under `moduleResolution:
 * nodenext`) cannot resolve the bare specifier `next/server` from any of
 * this repo's own source files — `next`'s `package.json` has no `exports`
 * map at all, and nodenext's ESM resolution refuses a subpath import into a
 * package with none, even though both Node and Next's own Turbopack bundler
 * resolve it fine regardless (the encapsulation an `exports` map enables
 * only applies to a package that declares one).
 *
 * This re-exports the SAME file by a relative path, which resolves under
 * nodenext exactly like this repo's own `./lib/foo.js` imports already do —
 * so `tsc` sees the real, current types with no manual duplication or risk
 * of drift, and every `import ... from 'next/server'` elsewhere in this
 * repo keeps the ordinary bare specifier real code and Turbopack both use,
 * completely unaware this file exists. An earlier attempt fixed this via a
 * `tsconfig.json` `paths` mapping instead — but Turbopack reads `paths` too,
 * and aliasing `next/server` project-wide to this package's own `.d.ts`
 * silently broke every real request handler at runtime (`NextResponse`
 * resolved to `undefined`), caught only because a production build
 * actually exercises this repo's own auto-generated `/icon.svg` route,
 * which is Next's own code, not this repo's.
 */
declare module 'next/server' {
  export { NextFetchEvent, NextRequest, NextResponse } from '../../node_modules/next/server.js';
}
