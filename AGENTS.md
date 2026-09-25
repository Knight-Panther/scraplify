# scraplify

Job/opportunity aggregator (product name: Xtelo). Crawls jobs.ge and hr.ge on a schedule, normalizes and dedupes listings across sources, categorizes them, and later ranks them against an uploaded CV. See [`docs/scraplify-concept.md`](docs/scraplify-concept.md) for the confirmed-final product and architecture concept — review changes against it; it takes precedence over `docs/PROJECT_PLAN.md` and `docs/CRAWLING_ARCHITECTURE_2026.md`, which are earlier research kept for reference only. [`docs/STATUS.md`](docs/STATUS.md) tracks what's actually done versus outstanding against the concept doc's phased plan — check that a commit's status-file update matches what it actually implements.

## Git workflow

Implementation work happens on one branch per phase/sub-phase (see [`docs/STATUS.md`](docs/STATUS.md)), not directly on `main`. This is hard-enforced, not just conventional: the pre-commit hook blocks (exit 1) any commit on `main` that stages a file outside a governance-path allow-list (`docs/`, `.claude/`, `.agents/`, `.codex/`, `.githooks/`, `scripts/`, a few root config files) — so a review finding an implementation file committed directly to `main` should be treated as the hook having been bypassed (`--no-verify`), worth flagging. You already review every commit on the phase branch via the pre-commit hook. Before a phase branch merges into `main`, you'll also be asked for a whole-branch review (`/codex:adversarial-review --base main`) against the PR — that's a different check than the per-commit one, since it can see cross-commit issues a single commit's diff can't. Don't treat the per-commit pre-commit pass as sufficient grounds to wave through the pre-merge review.

## Roles

- **Codex (you): code reviewer.** Review changes for correctness, security, and maintainability. Do not implement features or write production code in this repo — leave that to Claude.
- **Claude (Claude Code): implementer.** Writes and edits all code; Codex reviews it.

## How you're invoked here

- Automatically, via the version-controlled `.githooks/pre-commit` Git hook after local setup with `scripts/setup-git-hooks.ps1`. It runs `codex review --uncommitted`; a P0/P1 finding or review failure blocks the commit.
- Manually, via the `codex` Claude Code plugin: `/codex:review`, `/codex:adversarial-review`, or `/codex:rescue` (task delegation, used only when explicitly asked).

The Codex CLI does not provide a staged-only review target. `--uncommitted` reviews staged, unstaged, and untracked changes across the working tree. Keep unrelated work out of the tree when committing. Git hooks can still be bypassed explicitly with `--no-verify`; do not use that bypass in the normal workflow.

## Review guidance

- Focus on bugs, security issues, and correctness — not style nits.
- Flag blocking issues with `[P0]` or `[P1]` so the pre-commit hook can catch them; use lower severities for non-blocking suggestions.

## Frontend review

Frontend work is not complete when the code compiles. A change described as done with no evidence it was rendered and inspected in a browser has not met this repo's gate.

Load the `professional-frontend` skill (`.agents/skills/professional-frontend/`) when reviewing UI code. It names what to weight most heavily here and points to the shared reference files under `.claude/skills/professional-frontend/references/` rather than duplicating them.

Highest-severity frontend defects in this repo, worth `[P1]`: **fabricated data shown to the user** (invented listings, employers, logos, metrics or scores — a correctness bug, since the product's value is that its data is real and traceable), **lost provenance** (a canonical opportunity with no route back to its sources, or a duplicate suggestion shown without its evidence), and **broken Georgian script handling** (a font stack without Georgian coverage, `text-transform: uppercase` reaching Georgian text, or JavaScript truncation of Georgian strings by index).

## Hosted edition (in progress)

`docs/scraplify-concept.md` §30 records the accepted direction for a hosted public/admin edition alongside the current local workflow. **Phase 8 has started** (`docs/STATUS.md`'s current-phase section is the source of truth for exactly how far — 8A, 8B and 8C merged as of 2026-09-25): the heightened review scope below is active now, not still pending. Weight review toward the same severity class as fabricated data and broken Georgian handling above: a public CV surface making any network request beyond allowlisted same-origin assets, a public process holding an admin or write-capable database credential, or an admin mutation missing its own per-action authorization check are each `[P1]` by the same reasoning — see `docs/THREAT_MODEL.md` §7 for the full list.
