# scraplify

Job/opportunity aggregator (product name: Xtelo). Crawls jobs.ge and hr.ge on a schedule, normalizes and dedupes listings across sources, categorizes them, and later ranks them against an uploaded CV. See [`docs/scraplify-concept.md`](docs/scraplify-concept.md) for the confirmed-final product and architecture concept — read it before making any architectural or scope decision; it takes precedence over `docs/PROJECT_PLAN.md` and `docs/CRAWLING_ARCHITECTURE_2026.md`, which are earlier research kept for reference only. Check [`docs/STATUS.md`](docs/STATUS.md) for what's actually done versus outstanding, and update it in the same commit as any work that changes phase/exit-gate status.

## Session handoff

A `SessionStart` hook (`.claude/settings.json` → `scripts/session-context.sh`) injects live repo state into every new session: branch, uncommitted count, last three commits, the current-phase line from `docs/STATUS.md`, any active Codex cooldown, and any dev server already holding port 3000/3001. It exists so a fresh session stops spending tool calls re-deriving all of that.

When the user says **"save state"** (or similar, before `/clear`), write a few plain lines to `.git/session-handoff` — what is mid-flight and what the immediate next step is. That file is machine-local and gitignored by virtue of living in `.git/` (same home as `.git/codex-cooldown`), it is printed back at the next session's start, and it is **not** a status file: anything about phase or exit-gate progress belongs in `docs/STATUS.md`, which is versioned and visible to Codex. Overwrite it rather than appending, and delete it once its next step has been done.

A `PreCompact` hook (`scripts/compact-watch.sh`) counts compactions per session and warns as they accumulate — quietly for the first two, then from the third saying plainly that starting fresh beats another summary of a summary. **Treat that third warning as a real signal**, not noise: compaction compounds, so by then the specific detail a long task depends on is usually gone. Offer to write the handoff note and stop, rather than carrying on from a blurred context. The hook never blocks compaction (a blocked compaction on a full context kills the session mid-task, which is worse) and it cannot control *when* compaction fires — that is purely token-count driven by the built-in `autoCompactWindow`, deliberately left at its default here.

## Git workflow

- `main` stays always in a working, phase-complete state. Direct commits to `main` are for repo-governance/doc changes only (`docs/`, `.claude/`, `.agents/`, `.codex/`, `.githooks/`, `scripts/`, and a few root config/readme files) — implementation work happens on branches. This is enforced, not just documented: the pre-commit hook hard-blocks (exit 1) any commit on `main` that stages a file outside that allow-list, and prints the exact `git checkout -b <name>` command to fix it, auto-derived from `docs/STATUS.md`'s current-phase heading.
- One branch per phase/sub-phase from [`docs/STATUS.md`](docs/STATUS.md) (e.g. `phase-0-foundation`, `phase-1a-jobsge`). Commit normally on the branch — the pre-commit Codex gate still runs on every commit there, unchanged.
- Before merging a phase branch into `main`: push it, open a PR (`gh pr create`), and run `/codex:adversarial-review --base main` for a whole-branch review — this catches cross-commit issues the per-commit gate can't see, since it only ever looks at one commit's diff at a time.
- Merge only when that review is clean (no P0/P1) and the phase's exit-gate checklist in `docs/STATUS.md` is actually checked off, updated in the same PR. Delete the branch after merging.

## Local databases

Two Postgres databases exist locally: `scraplify` (the real crawled corpus) and `scraplify_qa` (a frozen, disposable snapshot — a few hundred listings, not kept in sync with crawls or anything else). `npm run dev` / `dev:web` always points at `scraplify` with writes permanently disabled — a hard rule, not a temporary or togglable state, because a session has accidentally mutated the real corpus twice before this existed. `npm run dev:web:qa` points at `scraplify_qa` with writes enabled, for testing anything that mutates data (Save/Dismiss, duplicate-review actions, etc.) without any risk to real data. See `web/lib/writes.ts` for the full rationale.

## Roles

- **Claude (Claude Code): implementer.** Writes and edits all code in this repo.
- **Codex (OpenAI Codex CLI / `codex`): code reviewer.** Reviews Claude's changes; does not implement. See `AGENTS.md` for Codex's own copy of this rule.

## Implementer / reviewer workflow

- Claude Code is the implementer: write and edit code directly.
- OpenAI Codex CLI (`codex`) is the reviewer, not the implementer. Don't ask Codex to write code here — use `/codex:review` or `/codex:adversarial-review` for review, or `/codex:rescue` to delegate an investigation/fix task if asked.
- After local setup with `scripts/setup-git-hooks.ps1`, every normal `git commit` is gated by the version-controlled `.githooks/pre-commit` Git hook. It runs `codex review --uncommitted` and blocks the commit if Codex reports P0/P1 findings, cannot be found, or fails. Non-blocking suggestions are surfaced but don't stop the commit.
- `codex review --uncommitted` reviews staged, unstaged, and untracked changes, not only the pending commit. Keep unrelated work out of the working tree while committing.
- If a commit is blocked, fix the reported issue, re-stage, and commit again — don't bypass the hook.

## Frontend

Never treat a successful build, a passing typecheck, or a green test run as completion of frontend work. UI work is complete only after it has been rendered in a real browser and inspected — Playwright MCP is connected, so this costs nothing.

Three skills cover this, with no overlap between them: **`frontend-design`** (global) for aesthetic direction, **`web-design-guidelines`** (global) for interface and accessibility review, and **`professional-frontend`** (this repo) for what those cannot know — Xtelo's product context, its Georgian-script typography constraints, its data-density patterns, and the browser QA gate. Invoke `professional-frontend` before writing UI components and again before calling the work done; it points to the reference files rather than restating them.

Two rules deserve stating here because they are correctness issues, not taste: **never render invented data** (listings, employers, logos, metrics, scores, statuses) — Xtelo's value is that its data is real and traceable; and **never uppercase text that may be Georgian**, which has no capital letters.
