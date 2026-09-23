#!/usr/bin/env sh
#
# Points Claude at the matching specialist reviewer after an edit (PostToolUse
# hook on Write|Edit).
#
# .claude/agents/ defines specialist reviewers for classes of change a
# general review is most likely to skim past — schema migrations,
# cross-source dedupe logic, and (Phase 8B on) the local/public/admin
# surface boundary — but an agent definition only helps if someone
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

# A file can fall under more than one specialist's domain at once — e.g.
# `web/app/(local)/review/actions.ts` is both dedupe/membership logic AND a
# surface-guarded Server Action — so each class is checked independently
# below (three separate `case` statements, not one shared `case`/`esac` whose
# first matching arm would swallow the rest via `;;`), and more than one
# reviewer can be nudged for the same edit.
msg_migration=""
msg_dedupe=""
msg_surface=""

case "$file" in
  */drizzle/migrations/*.sql | */src/db/schema/*)
    msg_migration="Schema/migration file edited ($file). Before running \`npm run db:migrate\` against the real corpus, run the migration-safety-reviewer agent over the generated migration."
    ;;
esac

case "$file" in
  */src/dedupe/* | */src/browse/queries.ts | */web/app/\(local\)/review/* | */web/lib/review-pair.ts)
    msg_dedupe="Dedupe/membership code edited ($file). Once this change is complete, run the dedupe-correctness-reviewer agent over it as a second pass alongside the Codex gate."
    ;;
esac

case "$file" in
  */web/lib/surface.ts | */web/lib/writes.ts | */web/proxy.ts | */web/app/*actions.ts | */src/browse/public-queries.ts | */web/app/\(admin\)/* | */web/app/\(public\)/* | */web/app/\(local\)/*)
    msg_surface="Surface-boundary code edited ($file). Before this change lands, run the surface-boundary-reviewer agent over it — this is the exact class of bug (a Server Action missing its guard, a public-surface path reaching a write-capable credential) that whole-branch review already caught twice on this phase (docs/STATUS.md's Phase 8B round 4/5 notes)."
    ;;
esac

[ -n "$msg_migration$msg_dedupe$msg_surface" ] || exit 0

gitdir=$(git rev-parse --git-common-dir 2>/dev/null || echo .git)
state="$gitdir/review-nudge"
lock="$state.lock"

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

# Each matched reviewer is deduped independently (once per session per
# reviewer, same as before) rather than as one combined key — a file that
# newly matches a second class this edit must still get that reviewer's own
# reminder even if the first class already fired earlier this session.
pending="$state.pending.$$"
: >"$pending" 2>/dev/null
combined=""
add_if_new() {
  agent="$1"
  text="$2"
  [ -n "$text" ] || return 0
  line="$session $agent"
  if [ -f "$state" ] && grep -qxF "$line" "$state" 2>/dev/null; then
    return 0
  fi
  printf '%s\n' "$line" >>"$pending"
  if [ -z "$combined" ]; then
    combined="$text"
  else
    combined="$combined

$text"
  fi
}
add_if_new migration-safety-reviewer "$msg_migration"
add_if_new dedupe-correctness-reviewer "$msg_dedupe"
add_if_new surface-boundary-reviewer "$msg_surface"

# Bounded by line count, not by session: this file is shared across every
# concurrent session/worktree, so filtering to "only this session's lines"
# (an earlier version of this hook) silently deleted every OTHER active
# session's markers on each write, reintroducing the duplicate reminders this
# hook exists to prevent. Keeping the last 500 lines bounds growth just as
# well without discriminating against whoever isn't running right now.
# A PID-suffixed tmp file, not a shared one: two lock-holders in sequence
# (the second acquiring right as the first's trap releases it) must not be
# able to collide on the same "$state.tmp" mid-write either.
if [ -s "$pending" ]; then
  tmp="$state.tmp.$$"
  { tail -n 499 "$state" 2>/dev/null; cat "$pending"; } >"$tmp" 2>/dev/null &&
    mv "$tmp" "$state" 2>/dev/null || rm -f "$tmp" 2>/dev/null
fi
rm -f "$pending" 2>/dev/null

[ -n "$combined" ] || exit 0

jq -n --arg m "$combined" '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $m}}'
