#!/usr/bin/env sh
#
# PostToolUse hook (Bash): right after a PR merge or a deploy script ran,
# remind the session to update the Board at the top of docs/STATUS.md and the
# active plan tracker (docs/PHASE_*_PLAN.md) in the same docs commit as the
# gate the step closed (CLAUDE.md, "Tracking").
#
# Reminds, never blocks: it only adds context for the session. Fails open: no
# jq, no repository, or any other command prints nothing.
set -u

cmd=$(jq -r '.tool_input.command // empty' 2>/dev/null) || exit 0
case "$cmd" in
  # A syntax check of a deploy script (`bash -n`) is not a deploy.
  *"bash -n "*) exit 0 ;;
  *"gh pr merge"*|*"bash "*deploy-*.sh*) ;;
  *) exit 0 ;;
esac

root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
plans=$(cd "$root" && ls docs/PHASE_*_PLAN.md 2>/dev/null | tr '\n' ' ')
plans=${plans% }

msg="A merge or deploy just ran. Update docs/STATUS.md: the gate it closed and that item's row in the Board at the top"
[ -n "$plans" ] && msg="$msg, and the plan tracker ($plans)"
msg="$msg, in one docs commit (CLAUDE.md, \"Tracking\")."

jq -n --arg m "$msg" '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $m}}'
