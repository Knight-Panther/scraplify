import type { DefaultSession, NextAuthConfig } from 'next-auth';
import GitHub from 'next-auth/providers/github';

/**
 * Edge-compatible half of the Auth.js config (Auth.js's own migration guide:
 * split out anything with a Node-only dependency into `auth.ts` so `proxy.ts`
 * — which runs in the Edge runtime — can import this half alone). No
 * adapter here: this app has no user-account database at all, only a GitHub
 * numeric-id allowlist checked below, so a JWT session (Auth.js's own
 * default without an adapter) is the only piece this needs.
 *
 * `providers: [GitHub]` (the bare provider, not `GitHub({...})`) auto-infers
 * `AUTH_GITHUB_ID`/`AUTH_GITHUB_SECRET` from the environment — confirmed
 * against Auth.js's current GitHub provider docs (Context7).
 */

/**
 * Parses `ADMIN_GITHUB_IDS` into its comma-separated entries, trimmed and
 * with empties dropped. Exported so `instrumentation.ts` can validate the
 * SAME parsed shape at startup (every entry numeric, at least one present)
 * rather than duplicating this logic and risking the two drifting apart.
 */
export function parseAdminGithubIds(raw: string): string[] {
  return raw
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

function adminGithubIds(): ReadonlySet<string> {
  return new Set(parseAdminGithubIds(process.env.ADMIN_GITHUB_IDS ?? ''));
}

/**
 * This allowlist alone grants `isAdmin: true` — it does not check whether the
 * matching GitHub account has two-factor authentication enabled. GitHub's
 * `GET /user` no longer returns a `two_factor_authentication` field under any
 * scope (confirmed live via `gh api user`, 2026-09-24 — a field that did exist
 * historically and still appears in some outdated documentation/examples).
 * The only remaining API-verifiable signal is `GET /orgs/{org}/members?filter=
 * 2fa_disabled`, which requires this admin's GitHub account to belong to an
 * Organization with 2FA enforcement on, plus a `read:org`-scoped token here.
 *
 * Deliberately NOT built yet, by explicit project-owner decision (2026-09-24,
 * `docs/STATUS.md`'s Phase 8B Stage 6/7 build record, "round 2" entry): with
 * exactly one admin and this surface still pre-launch/localhost-only, an
 * Organization plus this check is more machinery than the current risk
 * warrants. Revisit when a second admin is added, or before this surface is
 * exposed beyond localhost — the project owner turning on 2FA on their own
 * GitHub account directly (unrelated to this allowlist) is a separate,
 * already-actionable step this does not block on.
 */

export default {
  providers: [GitHub],
  callbacks: {
    jwt({ token, profile }) {
      // GitHub's numeric `id` is immutable, unlike a login name which can be
      // renamed — the allowlist is keyed on this, stored once at sign-in.
      if (profile) {
        token.githubId = String(profile.id);
      }
      return token;
    },
    session({ session, token }) {
      // Deliberately re-checked against the CURRENT allowlist on every call,
      // not cached as a boolean on the token at sign-in: caching it would
      // mean removing someone from `ADMIN_GITHUB_IDS` had no effect until
      // their existing JWT session expired. The token only carries the
      // stable identity (`githubId`); admin status is derived fresh here.
      const githubId = typeof token.githubId === 'string' ? token.githubId : undefined;
      session.user.isAdmin = githubId !== undefined && adminGithubIds().has(githubId);
      // Exposed on `session.user` (not just the internal `token`) so Stage
      // 11's admin audit trail can name a real actor — the same immutable
      // numeric id `ADMIN_GITHUB_IDS` itself is keyed on, not a display name
      // that could be absent, renamed, or ambiguous between two accounts.
      session.user.githubId = githubId ?? null;
      return session;
    },
  },
} satisfies NextAuthConfig;

declare module 'next-auth' {
  interface Session {
    user: {
      isAdmin: boolean;
      /** GitHub's numeric user id, or `null` if somehow absent from the token — never a login name. */
      githubId: string | null;
    } & DefaultSession['user'];
  }
}

// No `declare module 'next-auth/jwt'` augmentation: `next-auth/jwt` only
// re-exports `@auth/core/jwt`'s `JWT`, which already `extends Record<string,
// unknown>` — TS refuses to augment a module that has no local declaration
// of its own to merge with, but the ambient index signature already covers
// `token.githubId` on both read (as `unknown`, narrowed below) and write.
