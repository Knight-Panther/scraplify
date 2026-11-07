#!/usr/bin/env sh
#
# Asks before a shell command that can destroy database data runs
# (PreToolUse hook on Bash|PowerShell).
#
# Owner decision 2026-11-07: Claude works with no permission prompts (a bare
# `Bash` allow rule in .claude/settings.local.json, "edit automatically"
# mode) except for destructive or critical database operations. This hook is
# that exception. It sees the whole command text, which permission rules do
# not: SQL inside `docker exec … psql`, a `node -e` one-off, or psql over SSH
# on the host.
#
# What asks:
#   - SQL that drops, truncates, deletes rows or removes a column, run
#     through a database client, or `psql -f` whose script it cannot read;
#   - whole-database tools: dropdb, dropuser, pg_restore into a database or
#     with --clean;
#   - retention with --apply (it deletes old crawled data);
#   - deleting the real local Postgres container, or any Docker volume;
#   - stopping, disabling or uninstalling Postgres;
#   - deleting a backup copy (rclone, aws s3, wrangler r2);
#   - SQL from a file, a redirect or a piped dump, which it cannot read;
#   - a force push, or a push that deletes a remote branch (also ask rules
#     in .claude/settings.json).
#
# What passes, by design: reads, inserts and updates, migrations (additive by
# rule, and a deploy backs up first), the corpus CLIs (crawl, dedupe, rank,
# totals, places, matching bundle). A command naming scraplify_qa passes
# untouched, since those databases exist to be written to.
#
# It never blocks: it answers "ask", so a deliberate delete is one click. It
# is a heuristic, not a SQL parser, and errs toward asking. It fails open (no
# jq, unreadable payload: no prompt), like every hook here. It cannot see
# inside a script file a command runs, such as a deploy script on the host.
#
# Cases: scripts/db-write-guard-cases.sh runs it on commands that must ask and
# commands that must pass; run it after changing this file.
set -u
# Git Bash otherwise rewrites arguments that look like POSIX paths (see
# review-nudge.sh, where this mangled a jq argument).
export MSYS2_ARG_CONV_EXCL='*'

payload=$(cat 2>/dev/null || echo '{}')
cmd=$(printf '%s' "$payload" | jq -r '.tool_input.command // empty' 2>/dev/null || echo "")
# Without jq (or with a payload it cannot read), match the raw payload: the
# command text is inside it, quotes escaped, which the patterns below still
# find. This hook is the only routine prompt, so it must not lapse silently.
[ -n "$cmd" ] || cmd="$payload"
[ -n "$cmd" ] || exit 0
# One line, so SQL split across lines (a heredoc, "DROP\nTABLE") still
# matches: grep reads line by line.
cmd=$(printf '%s' "$cmd" | tr '\r\n' '  ')

matches() {
  printf '%s' "$cmd" | grep -Eiq "$1"
}

# Flags are case-sensitive: psql's `-F` is a field separator, `-f` a script.
matches_exact() {
  printf '%s' "$cmd" | grep -Eq "$1"
}

# The disposable QA databases (CLAUDE.md, "Local databases") are exempt only
# on positive proof: the command names a scraplify_qa database as its target
# (`-d`/`--dbname`, a URL's database, dropdb's argument, DROP DATABASE), not
# inside a shell comment, and names no real target besides. Real targets: the
# real local corpus (`-d scraplify`, a URL ending in `/scraplify`, its
# container, DROP DATABASE scraplify), whatever `$DATABASE_URL` or PGDATABASE
# point at (the shell's default is the real corpus), and the host. A command
# that names no database at all is not exempt.
q="[\"']?"
qa_target="(-d|--dbname)[= ]*${q}scraplify_qa|@[^/[:space:]]+/scraplify_qa|\\bdropdb\\b[^|;&]*[[:space:]]${q}scraplify_qa|drop[[:space:]]+database[[:space:]]+(if[[:space:]]+exists[[:space:]]+)?${q}scraplify_qa"
real_target="scraplify-postgres|(-d|--dbname)[= ]*${q}scraplify([^_a-z0-9]|$)|@[^/[:space:]]+/scraplify([^_a-z0-9]|$)|drop[[:space:]]+database[[:space:]]+(if[[:space:]]+exists[[:space:]]+)?${q}scraplify([^_a-z0-9]|$)|\\\$\\{?DATABASE_URL|PGDATABASE|\\bssh\\b|152\\.228\\.171\\.98|xtelo-host"
# The proof is read with shell comments cut off, so "# -d scraplify_qa" proves
# nothing; the real targets are read in the whole command.
uncommented=$(printf '%s' "$cmd" | sed -E 's/(^|[[:space:]])#.*$//')
if printf '%s' "$uncommented" | grep -Eiq "$qa_target" && ! matches "$real_target"; then
  exit 0
fi

what=""

# Destructive SQL, only where a database client is in the command, so a grep
# for "delete from" in the source does not ask.
client='\b(psql|pg_dump|pg_restore|node|tsx|ssh)\b|postgres(ql)?://|DATABASE_URL|docker[[:space:]]+exec'
if matches "$client"; then
  if matches '\b(drop[[:space:]]+(table|schema|database|view|materialized|index|role|user|owned|type|function|extension)|truncate[[:space:]]+(table[[:space:]]+)?["a-z_]|delete[[:space:]]+from|alter[[:space:]]+table[^;]*[[:space:]]drop[[:space:]])'; then
    what="SQL that drops, truncates or deletes data"
  elif matches_exact '\bpsql\b[^|;&]*[[:space:]](-f|--file)([[:space:]=]|$)' ||
    matches_exact '\bpsql\b[^|;&]*[[:space:]]<[[:space:]]*[^<[:space:]]' ||
    matches '\.sql\b[^;&]*\|[^;&]*\bpsql\b' ||
    matches '\bpg_dump\b[^;&]*\|[^;&]*\bpsql\b'; then
    # SQL from a file, a redirect or another dump: this hook cannot read it.
    # A heredoc (`psql <<SQL`) is part of the command text and is matched above.
    what="SQL from a file or a dump, which this hook cannot read"
  fi
fi

# Whole-database tools. pg_restore only writes when given a target database
# (`--list` and plain-file output do not).
if [ -z "$what" ] && matches '\b(dropdb|dropuser)\b'; then
  what="dropdb or dropuser"
fi
if [ -z "$what" ] && matches_exact '\bpg_restore\b[^|;&]*[[:space:]](-d|--dbname|-c|--clean)'; then
  what="pg_restore into a database"
fi

# Retention deletes old crawled data; its dry run (no --apply) only reads.
if [ -z "$what" ] &&
  matches '\bnpm run retention\b|\bnode\b[^|;&]*dist/cli/run-retention\.js' &&
  matches '(^|[[:space:]])--apply\b'; then
  what="retention with --apply"
fi

# The database's own storage and service: the real local corpus lives in the
# scraplify-postgres container's volume; production's Postgres runs on the
# host as a system service.
if [ -z "$what" ]; then
  if matches '\bdocker[[:space:]]+(volume[[:space:]]+(rm|prune)|system[[:space:]]+prune)\b' ||
    matches '\bdocker[[:space:]]+compose\b[^|;&]*\bdown\b[^|;&]*[[:space:]](-v|--volumes)\b' ||
    matches '\bdocker[[:space:]]+(container[[:space:]]+)?rm\b[^|;&]*scraplify-postgres'; then
    what="deleting a database container or volume"
  elif matches '\bsystemctl[[:space:]]+(stop|disable|mask)[[:space:]][^|;&]*postgres' ||
    matches '\bpg_ctlcluster\b[^|;&]*[[:space:]](stop|drop)\b' ||
    matches '\bpg_dropcluster\b' ||
    matches '\bapt(-get)?[[:space:]]+(remove|purge|autoremove)\b[^|;&]*postgres'; then
    what="stopping, dropping or removing Postgres itself"
  fi
fi

# Backup copies (RUNBOOK §6): the off-host bucket and the host's dumps.
if [ -z "$what" ] &&
  matches '\brclone[[:space:]]+(delete|deletefile|purge|rmdir|rmdirs|cleanup|sync)\b|\baws[[:space:]]+s3[[:space:]]+(rm|rb)\b|\bwrangler[[:space:]]+r2[[:space:]]+(object[[:space:]]+delete|bucket[[:space:]]+delete)\b'; then
  what="deleting a backup copy"
fi

# A force push rewrites history others (CI, the host's clones) already have;
# a deleting push removes a remote branch. A merged PR's branch is deleted by
# `gh pr merge --delete-branch`, which does not pass through here.
if [ -z "$what" ] &&
  matches_exact "\\bgit[[:space:]]+push\\b[^|;&]*([[:space:]]${q}(--force|--force-with-lease|-f|--mirror)\\b|[[:space:]]${q}\\+[^[:space:]])"; then
  what="a force push"
fi
if [ -z "$what" ] &&
  matches_exact "\\bgit[[:space:]]+push\\b[^|;&]*([[:space:]]${q}(--delete|-d|--prune)\\b|[[:space:]]${q}:[^[:space:]])"; then
  what="a push that deletes a remote branch"
fi

[ -n "$what" ] || exit 0

# Written without jq, so the answer does not depend on it either; every
# `what` above is a fixed string with no quote or backslash in it.
printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"db-write-guard: this command looks destructive (%s). Approve only if it is intended now. Commands on scraplify_qa databases alone are exempt (scripts/db-write-guard.sh)."}}\n' "$what"
