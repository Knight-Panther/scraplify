---
name: discharge-codex-debt
description: After a Codex usage-limit cooldown ends, find every per-commit review recorded as OWED in docs/STATUS.md that has not been discharged yet, run `codex review --commit <sha>` on each, fix what it finds, and record the discharge the way this file already does.
disable-model-invocation: true
---

# Discharge owed Codex reviews

When Codex hits its usage limit, the pre-commit gate records a cooldown in
`.git/codex-cooldown` and skips review. Commits made during that window get
an **OWED** note in `docs/STATUS.md`. This skill pays that debt back. The
shape it follows was already used twice by hand (`docs/STATUS.md`, "These two
reviews are now discharged" and "Both owed reviews discharged on this
branch"): review each commit **on its own**, since later commits already sit
on top, then record the result next to the original OWED note.

## Steps

1. **Is Codex actually back?** Read `.git/codex-cooldown` (at
   `git rev-parse --git-common-dir`). It holds an epoch; compare it to now.
   If the reset time is still in the future, **stop and report the time**.
   Per this user's standing rule, never make a review call before the
   reported reset time.

2. **Build the owed list. Read it, don't guess.**
   - Find every `OWED` mention in `docs/STATUS.md` (`rg -n "OWED" docs/STATUS.md`),
     plus any unchecked exit-gate line that says "recorded OWED".
   - Drop each one that a later paragraph already records as **discharged**
     or **WAIVED**. Read the text around each mention, since this file often
     resolves an OWED note a few paragraphs later.
   - Resolve each remaining one to a concrete commit SHA. STATUS.md usually
     describes the commit instead of naming it. Match the description against
     `git log --oneline` on the branch it belongs to (for merged work, `main`;
     for the current phase, `git log main..HEAD`). A commit with no Codex
     review is also recognizable because the per-commit gate printed a
     cooldown skip for it, but the log doesn't keep that, so the prose is
     the source of truth.
   - **Show the user the list (note → SHA → one-line subject) and confirm it
     before running anything.** A wrong SHA gives a clean review of the wrong
     commit, and that is worse than no review.

3. **Review one commit at a time.** `codex review --commit <sha> --title "<subject>"`.
   Do not batch them into one `--base` review. The goal is to discharge
   specific per-commit debts, and a whole-branch review is a separate gate.
   If Codex hits the usage limit again partway through, stop, record which
   commits were done, and leave the rest OWED.

4. **Triage each result against the code as it is now, not as it was.** A
   finding may already be fixed by a later commit. Say so, with the commit
   that fixed it, rather than re-fixing it. For findings that are still live:
   - Fix P0/P1 **and** P2 and below. This user's gate policy is that lower
     severities get fixed too, not skipped.
   - Implementation fixes go on a branch, never directly on `main` (the
     pre-commit hook enforces this). If the owed commit's phase is already
     merged, ask which branch the fix belongs on.
   - Each fix commit goes through the normal gate. Don't use `--no-verify`
     now that Codex is back.

5. **Record the discharge in `docs/STATUS.md`**, next to (not replacing) each
   original OWED note: date, the exact `codex review --commit <sha>` command,
   the findings, and for each one whether it was fixed here (with SHA), already
   fixed earlier (with SHA), or not applicable (with the reason). Update the
   phase exit-gate line if this clears it. Commit that doc change separately
   so the record is easy to find.

6. **Report**: commits reviewed, findings by severity, what was fixed and
   where, and anything still owed.
