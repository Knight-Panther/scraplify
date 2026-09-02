# scraplify — implementation status

Last updated: 2026-09-02

Tracks progress against the phased plan in [`scraplify-concept.md`](./scraplify-concept.md) §25. Update this file in the same commit/PR as the work that changes its status — that keeps it honest (Codex reviews the status change alongside the code) instead of a self-reported log that can drift from reality.

Check an item only when it's actually true, not aspirationally.

## Current phase: Phase 0 — policy and domain foundation

Not started.

### Exit gate

- [ ] Confirm Node/npm in a fresh non-interactive PowerShell
- [ ] Initialize strict TypeScript, validation, formatting, tests, CI
- [ ] Source-policy records for jobs.ge and hr.ge
- [ ] Domain contracts defined: `Opportunity`, `SourceListing`, revision, organization, resource, taxonomy, duplicate, run, incident
- [ ] Threat model and approval boundaries documented
- [ ] Database migrations and local PostgreSQL configuration
- [ ] Clean install, format, lint, typecheck, tests, build all pass (no live crawler required for this gate)

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

Nothing implemented yet. Current repo state: concept and research docs (`docs/`), vendored Claude Code skills (`.claude/skills/`), git hook scaffolding.
