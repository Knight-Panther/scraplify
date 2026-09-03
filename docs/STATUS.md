# scraplify — implementation status

Last updated: 2026-09-03

Tracks progress against the phased plan in [`scraplify-concept.md`](./scraplify-concept.md) §25. Update this file in the same commit/PR as the work that changes its status — that keeps it honest (Codex reviews the status change alongside the code) instead of a self-reported log that can drift from reality.

Check an item only when it's actually true, not aspirationally.

## Current phase: Phase 0 — policy and domain foundation

All exit-gate items met on branch `phase-0-policy-and-domain-foundation`. `/codex:adversarial-review --base main` ran once and returned 3 P1 findings, all fixed (see commit history). A second run was intended to confirm the fixes, per the normal workflow in `CLAUDE.md`, but the Codex CLI became unresponsive mid-session (a review hung indefinitely; `/codex:cancel` found no job to cancel) — by explicit user decision, that re-review was skipped for this merge rather than blocked on a tool that wasn't responding. The last two commits landed via `--no-verify` (both the per-commit gate and the second whole-branch pass), verified instead by hand: fixes were tested against a real local Postgres instance (seeded legacy/invalid data, confirmed both the intended rejections and the intended successes), and the full local gate (format, lint, typecheck, test, build, clean install) passed throughout. CI (GitHub Actions) still runs independently once this is pushed and will be the first automated check this branch has actually been through.

### Exit gate

- [x] Confirm Node/npm in a fresh non-interactive PowerShell — verified on this machine via both shells, no profile: `pwsh -NoProfile -NonInteractive` and `powershell.exe -NoProfile -NonInteractive` (Windows PowerShell 5.1) both resolve `node v24.20.0` / `npm 11.19.0` successfully. That's the specific risk this item was probing: a Windows Task Scheduler job runs with no profile loaded, so a profile-only Node would have broken scheduled crawls in a later phase. **Caveat, found by review:** this machine's `CurrentUser` execution policy is `RemoteSigned`; under a stricter policy (`Restricted`, a plausible default on a freshly provisioned machine — confirmed to actually reproduce in Codex's own review sandbox), bare `powershell.exe` fails to run npm's `.ps1` shim. A future Task Scheduler action should invoke `npm.cmd` directly or pass `-ExecutionPolicy Bypass`, not assume the policy this machine happens to have
- [x] Initialize strict TypeScript, validation, formatting, tests — TypeScript/Biome/Vitest done and clean-install-verified
- [x] Initialize CI (GitHub Actions) — [`.github/workflows/ci.yml`](../.github/workflows/ci.yml): install, format:check, lint, typecheck, test, build on push/PR to `main`, Node version read from `.node-version`. Caveat: the workflow has never actually executed, because this branch isn't pushed yet — its first real run is the Phase 0 PR. Written and complete, not yet proven green in GitHub's runner
- [x] Source-policy records for jobs.ge and hr.ge — `src/policies/`, validated against a `SourcePolicy` Zod schema; genuinely unknown fields (terms URL, retention period) left explicitly null, not guessed
- [x] Domain contracts defined: `Opportunity`, `SourceListing`, revision, organization, resource, taxonomy, duplicate, run, incident — `src/domain/`, Zod schemas, runtime-tested
- [x] Threat model and approval boundaries documented — [`docs/THREAT_MODEL.md`](./THREAT_MODEL.md); grounded in the actual path-matching bypasses found and fixed while building the source-policy records, not written in the abstract
- [x] Database migrations and local PostgreSQL configuration — `docker-compose.yml` (Postgres + pgvector), `drizzle.config.ts`, `src/db/schema/` (9 tables covering sources/policies/listings/revisions/resources/runs/attempts/incidents — organizations/taxonomy/dedupe/opportunity tables deliberately deferred to Phase 1C/2), migrations 0000-0006 generated and applied against a live local instance, round-trip verified through the actual Drizzle client (not just the migration tool). `source_listings.currentRevisionId` is enforced by a composite ownership FK — `(id, currentRevisionId)` must match some revision's `(sourceListingId, id)` — added and empirically verified (seeded a nonexistent pointer and a real pointer belonging to a *different* listing; both rejected) after the whole-branch adversarial review found the column was an unconstrained UUID
- [x] Clean install, format, lint, typecheck, tests, build all pass (no live crawler required for this gate) — verified locally after `rm -rf node_modules dist && npm ci`: format:check, lint, typecheck, 49 tests, and build all pass. Generated drizzle migration metadata is excluded from Biome (`biome.json`), since reformatting drizzle-kit's own output just starts a tug-of-war with the generator on the next `db:generate`

## Upcoming phases

Not started, listed in order:

- Phase 1A — jobs.ge vertical slice. Carries one requirement forward from Phase 0's adversarial review: `source_listing_revisions` has no DB-level uniqueness on `(sourceListingId, meaningfulContentHash)` (removed deliberately — see `src/db/schema/source-listings.ts`, a lifetime-unique index would reject a listing whose content legitimately reverts to an earlier hash). Retry-safe idempotency therefore has to be enforced in the ingestion write path itself: `SELECT ... FOR UPDATE` the `source_listings` row, re-read its current revision's hash after acquiring the lock, insert a new revision only if the freshly fetched hash differs, then update `currentRevisionId` — all inside one transaction. Exit gate for this phase isn't met without a concurrency test proving two overlapping identical-content writes produce exactly one revision and one pointer update, not two.
- Phase 1B — hr.ge acquisition decision and adapter
- Phase 1C — cross-source reconciliation
- Phase 2 — normalization, taxonomy, deduplication
- Phase 3 — browse and shortlist
- Phase 4 — attachments and resource expansion
- Phase 5 — CV matching
- Phase 6 — outreach assistance
- Phase 7 — operations and supervised repair

## Completed

Nothing merged to `main` yet — the items below are on the unmerged `phase-0-policy-and-domain-foundation` branch. Current `main` state: concept and research docs (`docs/`), vendored Claude Code skills (`.claude/skills/`), git hook scaffolding, git workflow enforcement.

On the Phase 0 branch, all exit-gate work is done: TypeScript/Node tooling scaffold (package.json, tsconfig, Biome, Vitest), domain contracts as Zod schemas (`src/domain/`), source-policy records for jobs.ge and hr.ge (`src/policies/`), threat model and approval boundaries doc (`docs/THREAT_MODEL.md`), Postgres + Drizzle migrations (`docker-compose.yml`, `drizzle.config.ts`, `src/db/`), and CI (`.github/workflows/ci.yml`).

Next: push the branch, open a PR, and merge (whole-branch review's second pass was skipped this time — see the note under "Current phase" above). Phase 1A (jobs.ge vertical slice) starts from a fresh branch off the merged `main`.
