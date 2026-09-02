# scraplify — implementation status

Last updated: 2026-09-03

Tracks progress against the phased plan in [`scraplify-concept.md`](./scraplify-concept.md) §25. Update this file in the same commit/PR as the work that changes its status — that keeps it honest (Codex reviews the status change alongside the code) instead of a self-reported log that can drift from reality.

Check an item only when it's actually true, not aspirationally.

## Current phase: Phase 0 — policy and domain foundation

In progress, on branch `phase-0-policy-and-domain-foundation`.

### Exit gate

- [ ] Confirm Node/npm in a fresh non-interactive PowerShell — confirmed via Bash (`node v24.20.0`, `npm 11.19.0`), not yet specifically re-verified in a fresh non-interactive PowerShell as this item's own wording requires
- [x] Initialize strict TypeScript, validation, formatting, tests — TypeScript/Biome/Vitest done and clean-install-verified
- [ ] Initialize CI (GitHub Actions) — not started
- [x] Source-policy records for jobs.ge and hr.ge — `src/policies/`, validated against a `SourcePolicy` Zod schema; genuinely unknown fields (terms URL, retention period) left explicitly null, not guessed
- [x] Domain contracts defined: `Opportunity`, `SourceListing`, revision, organization, resource, taxonomy, duplicate, run, incident — `src/domain/`, Zod schemas, runtime-tested
- [x] Threat model and approval boundaries documented — [`docs/THREAT_MODEL.md`](./THREAT_MODEL.md); grounded in the actual path-matching bypasses found and fixed while building the source-policy records, not written in the abstract
- [x] Database migrations and local PostgreSQL configuration — `docker-compose.yml` (Postgres + pgvector), `drizzle.config.ts`, `src/db/schema/` (9 tables covering sources/policies/listings/revisions/resources/runs/attempts/incidents — organizations/taxonomy/dedupe/opportunity tables deliberately deferred to Phase 1C/2), migration generated and applied against a live local instance, round-trip verified through the actual Drizzle client (not just the migration tool)
- [ ] Clean install, format, lint, typecheck, tests, build all pass (no live crawler required for this gate) — passes now for what exists; final check happens once the exit gate's other items land

## Upcoming phases

Not started, listed in order:

- Phase 1A — jobs.ge vertical slice
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

On the Phase 0 branch so far: TypeScript/Node tooling scaffold (package.json, tsconfig, Biome, Vitest), domain contracts as Zod schemas (`src/domain/`), source-policy records for jobs.ge and hr.ge (`src/policies/`), threat model and approval boundaries doc (`docs/THREAT_MODEL.md`), Postgres + Drizzle migrations (`docker-compose.yml`, `drizzle.config.ts`, `src/db/`).

Only remaining exit-gate items: re-verify Node/npm in a fresh non-interactive PowerShell (currently only checked via Bash), initialize CI, and the final full clean-install/format/lint/typecheck/test/build pass once those land.
