import { CvRankedView } from './cv-ranked-view.js';

export const metadata = { title: 'CV Ranked · Xtelo' };

/**
 * CV Ranked (Phase 8D, change.md §6). Everything on this screen is computed
 * in the visitor's browser from their CV and the public matching bundle; the
 * server renders only the empty shell, so it never sees any of it.
 */
export default function Page() {
  return <CvRankedView />;
}
