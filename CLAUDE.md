# scraplify

Job/opportunity aggregator (product name: Xtelo). Crawls jobs.ge and hr.ge on a schedule, normalizes and dedupes listings across sources, categorizes them, and later ranks them against an uploaded CV. See [`docs/scraplify-concept.md`](docs/scraplify-concept.md) for the confirmed-final product and architecture concept — read it before making any architectural or scope decision; it takes precedence over `docs/PROJECT_PLAN.md` and `docs/CRAWLING_ARCHITECTURE_2026.md`, which are earlier research kept for reference only. Check [`docs/STATUS.md`](docs/STATUS.md) for what's actually done versus outstanding, and update it in the same commit as any work that changes phase/exit-gate status.

## Git workflow

- `main` stays always in a working, phase-complete state. Direct commits to `main` are for repo-governance/doc changes only (`docs/`, `.claude/`, `.agents/`, `.codex/`, `.githooks/`, `scripts/`, and a few root config/readme files) — implementation work happens on branches. This is enforced, not just documented: the pre-commit hook hard-blocks (exit 1) any commit on `main` that stages a file outside that allow-list, and prints the exact `git checkout -b <name>` command to fix it, auto-derived from `docs/STATUS.md`'s current-phase heading.
- One branch per phase/sub-phase from [`docs/STATUS.md`](docs/STATUS.md) (e.g. `phase-0-foundation`, `phase-1a-jobsge`). Commit normally on the branch — the pre-commit Codex gate still runs on every commit there, unchanged.
- Before merging a phase branch into `main`: push it, open a PR (`gh pr create`), and run `/codex:adversarial-review --base main` for a whole-branch review — this catches cross-commit issues the per-commit gate can't see, since it only ever looks at one commit's diff at a time.
- Merge only when that review is clean (no P0/P1) and the phase's exit-gate checklist in `docs/STATUS.md` is actually checked off, updated in the same PR. Delete the branch after merging.

## Roles

- **Claude (Claude Code): implementer.** Writes and edits all code in this repo.
- **Codex (OpenAI Codex CLI / `codex`): code reviewer.** Reviews Claude's changes; does not implement. See `AGENTS.md` for Codex's own copy of this rule.

## Implementer / reviewer workflow

- Claude Code is the implementer: write and edit code directly.
- OpenAI Codex CLI (`codex`) is the reviewer, not the implementer. Don't ask Codex to write code here — use `/codex:review` or `/codex:adversarial-review` for review, or `/codex:rescue` to delegate an investigation/fix task if asked.
- After local setup with `scripts/setup-git-hooks.ps1`, every normal `git commit` is gated by the version-controlled `.githooks/pre-commit` Git hook. It runs `codex review --uncommitted` and blocks the commit if Codex reports P0/P1 findings, cannot be found, or fails. Non-blocking suggestions are surfaced but don't stop the commit.
- `codex review --uncommitted` reviews staged, unstaged, and untracked changes, not only the pending commit. Keep unrelated work out of the working tree while committing.
- If a commit is blocked, fix the reported issue, re-stage, and commit again — don't bypass the hook.
