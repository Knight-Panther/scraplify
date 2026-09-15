---
name: ship-phase
description: Walk the current phase branch through scraplify's merge-to-main sequence — push, PR, whole-branch adversarial review, STATUS.md exit-gate check, merge, branch cleanup — pausing for confirmation before any step that pushes, opens a PR, or merges.
disable-model-invocation: true
---

# Ship a phase branch

This encodes the "Before merging a phase branch into `main`" sequence from the
repo's `CLAUDE.md` Git workflow section, so it doesn't have to be re-read and
re-assembled by hand every phase. It does **not** replace judgment — it is a
checklist runner, and every step that pushes, opens a PR, or merges stops for
explicit confirmation first, per this user's global git/push discipline.

Do not run this if there are unrelated uncommitted changes in the working
tree — check `git status` first and ask the user to stash or commit them,
since a stray file could otherwise ride into the PR.

## Steps

1. **Confirm branch and target.** Read `docs/STATUS.md`'s "Current phase"
   heading and confirm the current branch (`git rev-parse --abbrev-ref HEAD`)
   matches what that phase expects. Stop and ask if they don't line up —
   don't guess which phase is being shipped.

2. **Confirm the exit-gate checklist.** Find this phase's exit-gate section in
   `docs/STATUS.md`. Report which items are checked and which aren't. If any
   are unchecked, ask the user whether to finish them first or ship with a
   recorded waiver (this repo has precedent for explicit, documented waivers
   — see `docs/STATUS.md`'s waiver notes at the top — but a waiver is the
   user's call, never assumed).

3. **Push the branch.** `git push -u origin <branch>` if not already pushed,
   or a plain `git push` if it is and has new commits. **Ask for explicit
   confirmation before running this** — this is exactly the case the user's
   global git/push discipline calls out.

4. **Open the PR** with `gh pr create`, if one doesn't already exist for this
   branch. Summarize the phase's changes in the PR body from the commit log,
   not from guesswork.

5. **Check for a Codex cooldown first.** `.githooks/pre-commit` records one
   (`$(git rev-parse --git-common-dir)/codex-cooldown`, a local epoch-seconds
   timestamp shared across every worktree of this repo, not a per-worktree
   one) the moment a per-commit review hits a usage-limit exhaustion,
   and the same file is the answer to "is Codex actually usable right now"
   for this step too — read it and compare against the current time rather
   than attempting the review and discovering the outage fresh. If a
   cooldown is active, don't run step 5's review at all: report the
   recorded reset time, note the whole-branch review as owed (matching this
   repo's existing "OWED" convention in `docs/STATUS.md`), and stop here
   unless the user explicitly says to proceed without it.

   Otherwise, **run the whole-branch review**: `/codex:adversarial-review
   --base main`. This is the step that catches cross-commit issues the
   per-commit gate can't see. Wait for it to finish; don't skip it because
   the per-commit gate already passed on every individual commit — that's a
   different check.

6. **Triage the review.** If it reports any P0/P1, stop here and report them
   — do not proceed to merge. Fixing them is normal implementation work, not
   part of this skill; re-run step 5 after fixes land.

7. **Update `docs/STATUS.md`** to check off the exit-gate items that are now
   actually true, in the same commit/PR as the phase's own changes (per
   `CLAUDE.md`). Don't check off an item that isn't genuinely done.

8. **Merge**, once review is clean and the exit gate is checked off (or
   explicitly waived per step 2). **Ask for explicit confirmation before
   merging** — same reasoning as step 3.

9. **Delete the branch** after a successful merge (local and remote).

## What this skill will not do on its own

- It will not push, open a PR, or merge without the user confirming that
  specific action in that moment — a prior approval for one phase does not
  carry over to the next.
- It will not mark an exit-gate item done to make the checklist look
  cleaner. If something is unclear, ask rather than assume.
