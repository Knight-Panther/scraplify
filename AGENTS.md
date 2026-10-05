# scraplify

Job/opportunity aggregator (product name: Xtelo). Crawls jobs.ge and hr.ge on a schedule, normalizes and dedupes listings across sources, categorizes them, and ranks them against an uploaded CV. See [`docs/scraplify-concept.md`](docs/scraplify-concept.md) for the confirmed-final product and architecture concept — review changes against it; it takes precedence over the earlier research it was built from (`PROJECT_PLAN.md`, `CRAWLING_ARCHITECTURE_2026.md`), which is not kept in this repository. [`docs/STATUS.md`](docs/STATUS.md) tracks what's actually done versus outstanding against the concept doc's phased plan — check that a commit's status-file update matches what it actually implements.

## Git workflow

Implementation work happens on one branch per phase/sub-phase (see [`docs/STATUS.md`](docs/STATUS.md)), not directly on `main`. This is hard-enforced, not just conventional: the pre-commit hook blocks (exit 1) any commit on `main` that stages a file outside a governance-path allow-list (`docs/`, `.claude/`, `.agents/`, `.codex/`, `.githooks/`, `scripts/`, a few root config files) — so a review finding an implementation file committed directly to `main` should be treated as the hook having been bypassed (`--no-verify`), worth flagging. Since 2026-10-05 you are invoked **manually only** (owner decision): no hook runs you on commit, push or merge. When the owner asks for a whole-branch review (`/codex:adversarial-review --base main`), review the whole diff against `main`, since cross-commit issues are what a single commit's diff can't show.

## Roles

- **Codex (you): code reviewer, on request.** Review changes for correctness, security, and maintainability. Do not implement features or write production code in this repo — leave that to Claude.
- **Claude (Claude Code): implementer.** Writes and edits all code; Codex reviews it when asked.

## How you're invoked here

- Manually only, via the `codex` Claude Code plugin: `/codex:review`, `/codex:adversarial-review`, or `/codex:rescue` (task delegation), each when the owner asks. Nothing runs you automatically; `.githooks/pre-commit` no longer calls Codex (2026-10-05).

## Review guidance

- Focus on bugs, security issues, and correctness — not style nits.
- Label findings `[P0]` to `[P3]`; only P0/P1 are fixed before merging (the owner's standing rule), lower severities are recorded.

## Frontend review

Frontend work is not complete when the code compiles. A change described as done with no evidence it was rendered and inspected in a browser has not met this repo's gate.

Load the `professional-frontend` skill (`.agents/skills/professional-frontend/`) when reviewing UI code. It names what to weight most heavily here and points to the shared reference files under `.claude/skills/professional-frontend/references/` rather than duplicating them.

Highest-severity frontend defects in this repo, worth `[P1]`: **fabricated data shown to the user** (invented listings, employers, logos, metrics or scores — a correctness bug, since the product's value is that its data is real and traceable), **lost provenance** (a canonical opportunity with no route back to its sources, or a duplicate suggestion shown without its evidence), and **broken Georgian script handling** (a font stack without Georgian coverage, `text-transform: uppercase` reaching Georgian text, or JavaScript truncation of Georgian strings by index).

## Hosted edition (live)

`docs/scraplify-concept.md` §30 records the accepted direction for a hosted public/admin edition alongside the current local workflow. **Phases 8A–8E are merged, and the hosted edition has been live at `jobster.fun` since 2026-09-28** (`docs/STATUS.md`'s current-phase section says what is still owed): the heightened review scope below is active. Weight review toward the same severity class as fabricated data and broken Georgian handling above: a public CV surface making any network request beyond allowlisted same-origin assets, a public process holding an admin or write-capable database credential, or an admin mutation missing its own per-action authorization check are each `[P1]` by the same reasoning — see `docs/THREAT_MODEL.md` §7 for the full list.
