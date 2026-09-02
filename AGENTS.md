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
