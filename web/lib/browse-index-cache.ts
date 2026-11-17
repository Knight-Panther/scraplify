import type { BrowseItem } from '../../src/browse/browse-index.js';
import { loadBrowseIndex, loadPublicBrowseIndex } from '../../src/browse/browse-index.js';
import { loadReferenceRates } from '../../src/browse/reference-rates.js';
import { db } from '../../src/db/client.js';
import { refreshingFor } from './cached.js';
import type { Surface } from './surface.js';

/**
 * Browse's rows, held per surface process and rebuilt in the background once
 * a minute (Phase 16C): about 0.2 s to read on the full local corpus, so a
 * page never waits on it after the first. The public process reads the
 * public views only; the local and admin ones the base tables.
 *
 * Each rebuild reads NBG's latest rates first (Phase 17D) and converts with
 * them, so the rows and the day the unit note names always go together.
 */
const REFRESH_MS = 60_000;

interface LoadedIndex {
  items: BrowseItem[];
  ratesDate: string;
}

async function withRates(
  load: typeof loadBrowseIndex | typeof loadPublicBrowseIndex,
): Promise<LoadedIndex> {
  const rates = await loadReferenceRates(db);
  return { items: await load(db, rates), ratesDate: rates.date };
}

const local = refreshingFor(REFRESH_MS, () => withRates(loadBrowseIndex));
const pub = refreshingFor(REFRESH_MS, () => withRates(loadPublicBrowseIndex));

function loaded(surface: Surface): Promise<LoadedIndex> {
  return surface === 'public' ? pub() : local();
}

export async function browseItems(surface: Surface): Promise<BrowseItem[]> {
  return (await loaded(surface)).items;
}

/** The day of the rates the current rows were converted at. */
export async function browseRatesDate(surface: Surface): Promise<string> {
  return (await loaded(surface)).ratesDate;
}
