#!/usr/bin/env sh
#
# Points Claude at the matching specialist reviewer after an edit (PostToolUse
# hook on Write|Edit).
#
# .claude/agents/ defines two reviewers for the two classes of change a
# general review is most likely to skim past — schema migrations and
# cross-source dedupe logic — but an agent definition only helps if someone
# remembers to invoke it. This makes the reminder deterministic instead of
# memory-dependent. It never blocks and never runs the reviewer itself: it
# adds one line of context, and the judgment of when to actually run the
# review (usually once the change is complete, not after every keystroke of
# it) stays with the session.
#
# Once per session per reviewer, keyed by session_id: a dedupe change is often
# a dozen edits, and a dozen identical reminders become noise that trains the
# reader to ignore them.
set -u
# Git Bash otherwise rewrites any argument that looks like a POSIX path —
# including the message handed to jq below, which it mangled into
# "C;C:\Program Files\Git\..." (found by pipe-testing, not assumed).
export MSYS2_ARG_CONV_EXCL='*'

payload=$(cat 2>/dev/null || echo '{}')
session=$(printf '%s' "$payload" | jq -r '.session_id // "unknown"' 2>/dev/null || echo "unknown")
# Windows paths arrive with backslashes; normalize before matching.
file=$(printf '%s' "$payload" | jq -r '.tool_input.file_path // empty | gsub("\\\\"; "/")' 2>/dev/null || echo "")
[ -n "$file" ] || exit 0

case "$file" in
  */drizzle/migrations/*.sql | */src/db/schema/*)
    agent="migration-safety-reviewer"
    msg="Schema/migration file edited ($file). Before running \`npm run db:migrate\` against the real corpus, run the migration-safety-reviewer agent over the generated migration."
    ;;
  */src/dedupe/* | */src/browse/queries.ts | */web/app/review/* | */web/lib/review-pair.ts)
    agent="dedupe-correctness-reviewer"
    msg="Dedupe/membership code edited ($file). Once this change is complete, run the dedupe-correctness-reviewer agent over it as a second pass alongside the Codex gate."
    ;;
  *) exit 0 ;;
esac

gitdir=$(git rev-parse --git-common-dir 2>/dev/null || echo .git)
state="$gitdir/review-nudge"
lock="$state.lock"
line="$session $agent"

# mkdir is atomic on both POSIX and NTFS (git-bash), so it doubles as a lock:
# exactly one concurrent invocation can create it. Without this, two hooks
# firing at once (two edits landing back-to-back across sessions, or a tool
# call that touches two matching files) can both pass the "not yet notified"
# check below before either writes, each emitting a reminder and each racing
# the other's tmp-file mv — the exact bug found in review here. Spin briefly
# rather than fail closed: this hook must never block the edit it's reacting
# to, so give up and skip silently (no reminder this time) rather than retry
# forever.
acquired=0
i=0
while [ "$i" -lt 40 ]; do
  if mkdir "$lock" 2>/dev/null; then
    acquired=1
    break
  fi
  # Break a stale lock from a process that died mid-update instead of
  # spinning against it forever.
  if [ -d "$lock" ]; then
    lock_age=$(( $(date +%s) - $(date -r "$lock" +%s 2>/dev/null || echo 0) ))
    [ "$lock_age" -gt 5 ] && rm -rf "$lock" 2>/dev/null
  fi
  i=$((i + 1))
  sleep 0.05
done
[ "$acquired" -eq 1 ] || exit 0
trap 'rm -rf "$lock" 2>/dev/null' EXIT HUP INT TERM

if [ -f "$state" ] && grep -qxF "$line" "$state" 2>/dev/null; then
  exit 0
fi
# Bounded by line count, not by session: this file is shared across every
# concurrent session/worktree, so filtering to "only this session's lines"
# (an earlier version of this hook) silently deleted every OTHER active
# session's markers on each write, reintroducing the duplicate reminders this
# hook exists to prevent. Keeping the last 500 lines bounds growth just as
# well without discriminating against whoever isn't running right now.
# A PID-suffixed tmp file, not a shared one: two lock-holders in sequence
# (the second acquiring right as the first's trap releases it) must not be
# able to collide on the same "$state.tmp" mid-write either.
tmp="$state.tmp.$$"
{ tail -n 499 "$state" 2>/dev/null; printf '%s\n' "$line"; } >"$tmp" 2>/dev/null &&
  mv "$tmp" "$state" 2>/dev/null || rm -f "$tmp" 2>/dev/null

jq -n --arg m "$msg" '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $m}}'
