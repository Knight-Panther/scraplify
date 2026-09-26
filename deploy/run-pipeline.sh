#!/usr/bin/env bash
# One crawl pipeline run for a source on a Linux host (Phase 8E): the same
# steps and exit rules as scripts/run-crawl.ps1, which the Windows operator
# machine runs. Invoked by deploy/systemd/xtelo-pipeline@.service with the
# worker role's environment (never the public or admin one).
#
#   deploy/run-pipeline.sh jobs-ge|hr-ge
#
# Output goes to the journal (journalctl -u xtelo-pipeline@jobs-ge), so a
# failed or skipped run is never silent (concept §19.1).
set -uo pipefail

source="${1:-}"
case "$source" in
  jobs-ge | hr-ge) ;;
  *)
    echo "usage: $0 jobs-ge|hr-ge" >&2
    exit 2
    ;;
esac

step() {
  local name="$1"
  shift
  echo "----- $(date -Is) $name -----"
  node "$@"
  local code=$?
  echo "----- $name exit code $code -----"
  return "$code"
}

step "$source crawl" "dist/cli/run-$source-crawl.js"
crawl=$?

# Dedupe and classify after every crawl attempt, successful or not: a failed
# or partial run can still have written listings (see run-crawl.ps1).
step dedupe dist/cli/run-dedupe.js --auto-link
dedupe=$?
step "taxonomy backfill" dist/cli/backfill-taxonomy.js
taxonomy=$?

# The bundle only once dedupe and taxonomy have settled (change.md §10). The
# builder has its own health gate and never replaces the active bundle on
# failure.
bundle=0
if [ "$dedupe" -eq 0 ] && [ "$taxonomy" -eq 0 ]; then
  step "matching bundle" dist/cli/build-matching-bundle.js
  bundle=$?
else
  echo "----- matching bundle skipped: dedupe or taxonomy failed -----"
fi

# The crawl's own failure wins; otherwise the first failed step's code.
code=$crawl
for step_code in "$dedupe" "$taxonomy" "$bundle"; do
  if [ "$code" -eq 0 ] && [ "$step_code" -ne 0 ]; then code=$step_code; fi
done
exit "$code"
