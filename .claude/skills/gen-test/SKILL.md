---
name: gen-test
description: Scaffold a new vitest test file following scraplify's existing conventions — colocated *.test.ts, vitest describe/it/expect, fixture factories with overrides, and the DB test-support helpers with mandatory cleanup tracking.
---

# Generate a scraplify test

This repo's tests are colocated per module (`foo.ts` → `foo.test.ts`, both in
the same directory) and run via `npm test` (vitest, loading `.env` if
present). There are two distinct shapes here — use whichever matches the code
under test.

## 1. Pure-function tests (no database)

Example: `web/lib/review-pair.test.ts`, `src/dedupe/membership-review.test.ts`'s
pure helpers.

- `import { describe, expect, it } from 'vitest';`
- Build fixtures with a small factory function that takes
  `overrides: Partial<T> = {}` and spreads them over sane defaults — don't
  inline full object literals per test case. See `listing()` and `pair()` in
  `web/lib/review-pair.test.ts` for the pattern.
- Use real-looking data in fixtures, including actual Georgian text where the
  field would hold it in production (titles, organization names) — this repo
  treats fabricated-looking test data as worth avoiding even in fixtures,
  since Georgian-script handling is a real correctness concern here (see
  `CLAUDE.md`'s frontend rules on Georgian typography).
- Comment *why* a fixture default was chosen when it's non-obvious (e.g. "both
  singletons by default — the ordinary case"), not what the code does.

## 2. Database-touching tests

Example: `src/dedupe/membership-review.test.ts`.

- Import helpers from `src/db/test-support.ts`: `createTestSource`,
  `createTestSourceListing`, `cleanupTestSource`, and similar. These generate
  disposable rows with a slug prefix (`test-source-`, `crawl-test-`, etc.
  — see `DISPOSABLE_SOURCE_SLUG_PREFIXES`) that the project's orphan-sweep
  guard recognizes as safe to delete.
- **Track every id you create** in arrays declared at the top of the
  `describe` block (`sourceIds`, `opportunityIds`, `listingIds`, ...) and
  delete them all in `afterEach`. This is not optional — this exact class of
  bug (a created row never registered for cleanup) leaked real orphan rows
  into the live corpus and took a five-round gate fight to fully close (see
  `docs/STATUS.md`'s Phase 3B/3C history). When a test result register a new
  id — e.g. `result.splitOpportunityId` — track it immediately, don't assume
  the id it started from is the only one it produced.
- Use `db` from `src/db/client.js` directly with drizzle-orm query builders
  (`eq`, `inArray`, etc.) for setup/teardown and assertions, matching the
  existing test's style — no separate test-database abstraction exists.
- If the test exercises a decision/actor field, use the existing `ACTOR`
  convention (`{ decidedBy: 'human', version: 'operator:test' }`) rather than
  inventing a new shape.

## After writing

Run `npm test -- <path-to-test-file>` (vitest) before considering the test
done, not just `npm run typecheck` — a database test can typecheck cleanly
while still leaking rows or asserting the wrong thing. If it's a DB test,
confirm the `afterEach` cleanup actually ran by checking no new rows remain
for the ids you tracked.
