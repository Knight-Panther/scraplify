# scraplify

## Roles

- **Claude (Claude Code): implementer.** Writes and edits all code in this repo.
- **Codex (OpenAI Codex CLI / `codex`): code reviewer.** Reviews Claude's changes; does not implement. See `AGENTS.md` for Codex's own copy of this rule.

## Implementer / reviewer workflow

- Claude Code is the implementer: write and edit code directly.
- OpenAI Codex CLI (`codex`) is the reviewer, not the implementer. Don't ask Codex to write code here — use `/codex:review` or `/codex:adversarial-review` for review, or `/codex:rescue` to delegate an investigation/fix task if asked.
- After local setup with `scripts/setup-git-hooks.ps1`, every normal `git commit` is gated by the version-controlled `.githooks/pre-commit` Git hook. It runs `codex review --uncommitted` and blocks the commit if Codex reports P0/P1 findings, cannot be found, or fails. Non-blocking suggestions are surfaced but don't stop the commit.
- `codex review --uncommitted` reviews staged, unstaged, and untracked changes, not only the pending commit. Keep unrelated work out of the working tree while committing.
- If a commit is blocked, fix the reported issue, re-stage, and commit again — don't bypass the hook.
