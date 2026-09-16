#!/usr/bin/env sh
#
# Counts compactions per session and escalates a warning (PreCompact hook).
#
# Compaction is lossy and it compounds: each pass summarizes a context that
# already contains summaries, so by the third round the detail a long task
# actually depends on — exact paths, a decision made twenty turns back, the
# precise symptom of a bug — is usually gone, and the session keeps working
# confidently from a blurrier picture.
#
# It deliberately does NOT block compaction. A blocked compaction on a context
# that is genuinely full kills the session mid-task, which is strictly worse
# than one more lossy summary. This only says plainly when starting fresh has
# become the better trade, and points at the handoff note (CLAUDE.md's
# "save state" convention) that makes starting fresh cheap.
#
# Keyed by session_id rather than reset from the SessionStart hook, because
# SessionStart can itself fire after a compaction — resetting there would zero
# the very count this is keeping.
set -u

payload=$(cat 2>/dev/null || echo '{}')
session=$(printf '%s' "$payload" | jq -r '.session_id // "unknown"' 2>/dev/null || echo "unknown")

gitdir=$(git rev-parse --git-common-dir 2>/dev/null || echo .git)
state="$gitdir/compact-count"

count=0
if [ -f "$state" ]; then
  prev_session=$(cut -d' ' -f1 "$state" 2>/dev/null || echo "")
  prev_count=$(cut -d' ' -f2 "$state" 2>/dev/null || echo 0)
  case "$prev_count" in '' | *[!0-9]*) prev_count=0 ;; esac
  [ "$prev_session" = "$session" ] && count=$prev_count
fi

count=$((count + 1))
printf '%s %s\n' "$session" "$count" >"$state" 2>/dev/null || true

if [ "$count" -ge 3 ]; then
  msg="Compaction #$count this session. Each pass summarizes a context that already holds summaries, so detail this session was relying on is probably gone by now. Better trade from here: say \"save state\" (writes .git/session-handoff), then /clear — a fresh session with a handoff note beats a fourth summary of a summary."
else
  msg="Compaction #$count this session. Earlier detail may have been summarized away — re-read files rather than trusting recall of them."
fi

jq -n --arg m "$msg" '{systemMessage: $m}'
