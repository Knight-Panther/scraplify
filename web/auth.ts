import NextAuth, { type NextAuthResult } from 'next-auth';
import authConfig from './auth.config.js';

/**
 * The full Auth.js config — this file (unlike `auth.config.ts`) is never
 * imported from `proxy.ts`, so it is free to depend on Node-only code. It
 * doesn't yet (no adapter, no database), but the split exists so that stays
 * true going forward without anyone having to notice the Edge boundary again.
 */
const result: NextAuthResult = NextAuth({
  session: { strategy: 'jwt' },
  // This app is always self-hosted behind its own reverse proxy, never
  // Vercel or another platform Auth.js auto-trusts — without this, every
  // request 500s with `UntrustedHost` (confirmed live), since Auth.js
  // refuses to trust the incoming `Host` header by default anywhere it
  // isn't itself certain the header is safe.
  trustHost: true,
  ...authConfig,
});

// Each export is annotated from `NextAuthResult` explicitly — destructuring
// `result` directly re-triggers TS7's "inferred type is not portable"
// diagnostic on `auth` specifically, since its overloaded signature
// references next-auth's own unexported internal types.
export const handlers: NextAuthResult['handlers'] = result.handlers;
export const auth: NextAuthResult['auth'] = result.auth;
export const signIn: NextAuthResult['signIn'] = result.signIn;
export const signOut: NextAuthResult['signOut'] = result.signOut;
