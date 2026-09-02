# scraplify

Job/opportunity aggregator (product name: Xtelo). Crawls jobs.ge and hr.ge on a schedule, normalizes and dedupes listings across sources, categorizes them, and later ranks them against an uploaded CV. See [`docs/scraplify-concept.md`](docs/scraplify-concept.md) for the confirmed-final product and architecture concept — review changes against it; it takes precedence over `docs/PROJECT_PLAN.md` and `docs/CRAWLING_ARCHITECTURE_2026.md`, which are earlier research kept for reference only. [`docs/STATUS.md`](docs/STATUS.md) tracks what's actually done versus outstanding against the concept doc's phased plan — check that a commit's status-file update matches what it actually implements.

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
