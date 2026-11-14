import type { BrowseItem } from '../../src/browse/browse-index.js';
import { loadBrowseIndex, loadPublicBrowseIndex } from '../../src/browse/browse-index.js';
import { db } from '../../src/db/client.js';
import { refreshingFor } from './cached.js';
import type { Surface } from './surface.js';

/**
 * Browse's rows, held per surface process and rebuilt in the background once
 * a minute (Phase 16C): about 0.2 s to read on the full local corpus, so a
 * page never waits on it after the first. The public process reads the
 * public views only; the local and admin ones the base tables.
 */
const REFRESH_MS = 60_000;

const local = refreshingFor(REFRESH_MS, () => loadBrowseIndex(db));
const pub = refreshingFor(REFRESH_MS, () => loadPublicBrowseIndex(db));

export function browseItems(surface: Surface): Promise<BrowseItem[]> {
  return surface === 'public' ? pub() : local();
}
