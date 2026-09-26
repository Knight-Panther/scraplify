/**
 * The CV Ranked switch (Phase 8E, change.md §15 rollback step 1: "Disable CV
 * entry while leaving Browse/Listings available"). `XTELO_CV_RANKED=off`
 * removes the nav link and the landing chooser and turns `/cv-ranked` into a
 * notice, with a process restart and no deploy. Unset or `on` is the normal
 * state. Any other value refuses startup (`instrumentation.ts`), so a typo
 * can never leave CV entry on when someone meant to switch it off.
 */

export class InvalidCvRankedSwitchError extends Error {
  constructor(value: string) {
    super(`XTELO_CV_RANKED=${JSON.stringify(value)} must be unset, 'on' or 'off'.`);
    this.name = 'InvalidCvRankedSwitchError';
  }
}

export function cvRankedEnabled(value: string | undefined = process.env.XTELO_CV_RANKED): boolean {
  if (value === undefined || value === 'on') return true;
  if (value === 'off') return false;
  throw new InvalidCvRankedSwitchError(value);
}
