#!/usr/bin/env sh
#
# Orientation block injected into a fresh Claude Code session (SessionStart hook).
#
# Exists because every new session otherwise re-derives the same half-dozen
# facts with its own tool calls — branch, recent commits, current phase,
# whether a dev server is already up. Each is
# one round trip there and nearly free here.
#
# Deliberately NOT a project-status file: docs/STATUS.md owns that (CLAUDE.md's
# own rule, and the reason this prints a pointer to it rather than a copy of
# it). This reports live git/machine state only, plus an optional short-lived
# handoff note a session wrote on its way out.
#
# Fails open: any missing tool or file just drops that line rather than
# breaking session startup.
set -u

root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
cd "$root" || exit 0

# --git-common-dir, not --git-dir: this repo is worked in multiple worktrees,
# and a per-worktree .git directory would hide the cooldown/handoff files the
# main checkout wrote (the same reasoning .githooks/pre-commit documents).
gitdir=$(git rev-parse --git-common-dir 2>/dev/null || echo .git)

context=$(
  branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
  dirty=$(git status --porcelain 2>/dev/null | grep -c . || true)
  echo "Branch: $branch — $dirty uncommitted file(s)"

  echo "Recent commits:"
  git log --oneline -3 2>/dev/null | sed 's/^/  /'

  phase=$(grep -m1 '^## Current phase:' docs/STATUS.md 2>/dev/null | sed 's/^## //' || true)
  [ -n "$phase" ] && echo "docs/STATUS.md says: $phase"

  ports=$(netstat -ano 2>/dev/null | grep -i listening | grep -oE ':(3000|3001)[[:space:]]' | tr -d ': \t' | sort -u | tr '\n' ' ')
  [ -n "$ports" ] && echo "Dev server already listening on port(s): $ports"

  handoff="$gitdir/session-handoff"
  if [ -f "$handoff" ]; then
    echo "Handoff note from the previous session:"
    sed 's/^/  /' "$handoff"
  fi
)

[ -z "$context" ] && exit 0

printf '%s' "$context" | jq -Rs '{
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: ("Repo state at session start (scripts/session-context.sh — live git/machine state, not a substitute for reading docs/STATUS.md when the task needs it):\n" + .)
  }
}'
