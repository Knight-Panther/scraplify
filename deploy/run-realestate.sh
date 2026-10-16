#!/usr/bin/env bash
# One real-estate crawl run for a source on a Linux host (Phase 11E). Invoked
# by deploy/systemd/xtelo-realestate@.service with the worker role's
# environment. Kept apart from deploy/run-pipeline.sh on purpose: that
# pipeline runs dedupe, taxonomy, the bundle and retention after each crawl,
# and none of them applies to real estate (guideline §7.2).
#
#   deploy/run-realestate.sh ss-ge [crawl options]
#
# With no options the crawl is a nightly run, which reads each list back to
# the last completed run. Options are passed to the crawl as they are, for a
# run by hand (--mode=sweep, --max-detail-checks=N).
#
# Output goes to the journal (journalctl -u xtelo-realestate@ss-ge).
set -uo pipefail

# A source added here also goes into REAL_ESTATE_PIPELINE_SOURCES in
# src/hermes/schema.ts, in the same change, or its runs send Hermes no event
# (a test holds the two lists together).
source="${1:-}"
case "$source" in
  ss-ge) ;;
  *)
    echo "usage: $0 ss-ge [crawl options]" >&2
    exit 2
    ;;
esac
shift

# The Hermes hook (docs/hermes-hook.md), as in run-pipeline.sh: one event when
# the run ends, off unless HERMES_HOOK_ENABLED=1 in worker.env, and it never
# changes this script's exit code. A crawl that has not ended reports "-".
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
crawl=-

hermes_event() { # hermes_event <exit code> [--interrupted]
  [ "${HERMES_HOOK_ENABLED:-}" = "1" ] || return 0
  node dist/cli/hermes-event.js --source="$source" --started-at="$started_at" \
    --crawl="$crawl" --exit-code="$1" ${2:+"$2"} ||
    echo "----- hermes event not written (exit code $?) -----"
  return 0
}

# Stopped or timed out by systemd, or by hand: report the run as interrupted.
# The crawl saves its progress after every page, so the next run carries on.
interrupted() { # interrupted <signal> <exit code>
  trap - TERM INT
  echo "----- $(date -Is) interrupted by SIG$1 -----"
  hermes_event "$2" --interrupted
  exit "$2"
}
trap 'interrupted TERM 143' TERM
trap 'interrupted INT 130' INT

echo "----- $(date -Is) $source crawl -----"
node "dist/cli/run-$source-crawl.js" "$@"
crawl=$?
echo "----- $source crawl exit code $crawl -----"

trap - TERM INT
hermes_event "$crawl"
exit "$crawl"
