# scraplify

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
