#!/usr/bin/env sh
#
# Asks before a shell command that can write to a real database runs
# (PreToolUse hook on Bash|PowerShell).
#
# The real corpus has been mutated by accident twice (CLAUDE.md, "Local
# databases"), and web/lib/writes.ts only guards the dev server. A shell
# command reaches the same database around it: `docker exec … psql`, a
# corpus CLI such as `npm run dedupe`, or psql over SSH on the host. Under
# acceptEdits, an allow rule like `Bash(docker exec *)` in a local settings
# file runs those with no prompt at all, and the auto-mode classifier only
# helps in auto mode. This makes the prompt deterministic instead.
#
# It never blocks: it answers "ask", so a deliberate write (a refresh, a
# migration during a deploy, a restore drill) is still one click. A command
# naming scraplify_qa passes untouched, since that database exists to be
# written to. It is a heuristic, not a SQL parser: SQL it cannot see (`psql
# -f`) is treated as a write, and a string literal that merely contains
# "update" prompts once more than needed — both err toward asking. It fails
# open (no jq, unreadable payload → no prompt), like every hook here, because
# a guard that breaks Bash entirely would just get switched off.
set -u
# Git Bash otherwise rewrites arguments that look like POSIX paths (see
# review-nudge.sh, where this mangled a jq argument).
export MSYS2_ARG_CONV_EXCL='*'

payload=$(cat 2>/dev/null || echo '{}')
cmd=$(printf '%s' "$payload" | jq -r '.tool_input.command // empty' 2>/dev/null || echo "")
[ -n "$cmd" ] || exit 0

matches() {
  printf '%s' "$cmd" | grep -Eiq "$1"
}

# Flags are case-sensitive: psql's `-F` is a field separator, `-f` a script.
matches_exact() {
  printf '%s' "$cmd" | grep -Eq "$1"
}

# The disposable QA snapshot (CLAUDE.md, "Local databases").
matches 'scraplify_qa' && exit 0

what=""

# SQL through psql: a write keyword anywhere in a command that runs psql, or
# a script file whose contents this hook cannot read.
if matches '\bpsql\b'; then
  if matches '\b(insert|update|delete|truncate|drop|alter|create|grant|revoke|copy|vacuum|reindex|cluster|refresh|merge|comment|security)\b' ||
    matches_exact '\bpsql\b[^|;&]*[[:space:]](-f|--file)([[:space:]=]|$)'; then
    what="SQL that can write, through psql"
  fi
fi

# Whole-database tools. pg_restore only writes when given a target database
# (`--list` and plain-file output do not).
if [ -z "$what" ] && matches '\bdropdb\b'; then
  what="dropdb"
fi
if [ -z "$what" ] && matches_exact '\bpg_restore\b[^|;&]*[[:space:]](-d|--dbname)'; then
  what="pg_restore into a database"
fi

# The corpus CLIs (package.json): each writes the database DATABASE_URL names,
# which locally is the real corpus. `rank -- profile:list` and a retention
# dry run (no --apply) only read. A compiled CLI only counts when `node` runs
# it, so `ls dist/cli/run-hr-ge-crawl.js` (checking a build) does not ask.
node_cli='\bnode\b[^|;&]*dist/cli/'
if [ -z "$what" ]; then
  if matches '\bnpm run (crawl:|dedupe\b|taxonomy:backfill|sync-policies|matching:build|matching:rollback|db:migrate)' ||
    matches "${node_cli}(run-[a-z-]+-crawl|run-dedupe|backfill-taxonomy|sync-source-policies|build-matching-bundle|rollback-matching-bundle)\\.js" ||
    matches 'run-crawl\.ps1'; then
    what="a corpus-writing CLI (crawl, dedupe, taxonomy, policies, matching bundle or migration)"
  elif matches "\\bnpm run rank\\b|${node_cli}rank\\.js" && ! matches '\bprofile:list\b'; then
    what="the rank CLI"
  elif matches "\\bnpm run retention\\b|${node_cli}run-retention\\.js" && matches '(^|[[:space:]])--apply\b'; then
    what="retention with --apply"
  fi
fi

[ -n "$what" ] || exit 0

reason="db-write-guard: this command looks like it can write to a real database ($what). Approve only if that write is intended now. Commands naming scraplify_qa are exempt (scripts/db-write-guard.sh)."
jq -n --arg r "$reason" '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: $r}}'
