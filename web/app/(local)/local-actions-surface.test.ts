import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { InvalidSurfaceError, NotLocalSurfaceError } from '../../lib/surface.js';
import { WritesDisabledError } from '../../lib/writes.js';

/**
 * Phase 8B exit gate: the crafted-action matrix for every
 * `assertLocalSurface()`-guarded Server Action under `(local)`.
 *
 * A Server Action is reachable by a direct POST no matter which page renders
 * it, so each one must refuse on its own. This suite calls every action the
 * way a crafted request would (junk form fields, writes enabled so the
 * writes guard cannot be the thing refusing) and proves:
 *
 * - on `public`/`admin` it throws `NotLocalSurfaceError` before touching the
 *   database at all. `db` is replaced by a proxy that records any access, so
 *   a guard that is missing, or placed after the first query, fails here even
 *   if the query would have been harmless;
 * - an unrecognized `XTELO_SURFACE` fails closed (`InvalidSurfaceError`);
 * - on `local` the surface guard lets the call through. Writes-guarded
 *   actions then stop at `assertWritesEnabled()`, still before any database
 *   access, and the one read-only action reaches the data layer.
 *
 * Actions are DISCOVERED from every `'use server'` module under `(local)`,
 * not listed by hand, so a new action is covered the moment it exists. The
 * pinned name list below is only there to catch discovery itself breaking
 * (a changed directory layout silently matching nothing): adding an action
 * means adding its name there too.
 */
const { dbAccesses } = vi.hoisted(() => ({ dbAccesses: [] as string[] }));

class DatabaseTouchedError extends Error {
  constructor(prop: string) {
    super(`database accessed (db.${prop}) before the action's guards refused`);
  }
}

vi.mock('../../../src/db/client.js', () => {
  const trap = (): unknown =>
    new Proxy(
      {},
      {
        get(_target, prop) {
          if (typeof prop === 'symbol' || prop === 'then') return undefined;
          dbAccesses.push(prop);
          throw new DatabaseTouchedError(prop);
        },
      },
    );
  return { db: trap(), pool: trap() };
});
vi.mock('next/cache.js', () => ({ revalidatePath: vi.fn() }));

/** Exactly the 18 actions Stage 2 guarded. Read-only ones don't call assertWritesEnabled(). */
const EXPECTED = new Map<string, { readOnly?: true }>([
  ['drafts/actions.ts#generateDraftAction', {}],
  ['drafts/actions.ts#saveDraftAction', {}],
  ['drafts/actions.ts#approveDraftAction', {}],
  ['drafts/actions.ts#checkApprovalCurrentAction', { readOnly: true }],
  ['drafts/actions.ts#deleteDraftAction', {}],
  ['opportunities/[id]/actions.ts#detachFromOpportunity', {}],
  ['profile/actions.ts#uploadCv', {}],
  ['profile/actions.ts#deleteProfile', {}],
  ['profile/actions.ts#rankProfile', {}],
  ['profile/[id]/actions.ts#saveCorrections', {}],
  ['review/actions.ts#acceptReviewPair', {}],
  ['review/actions.ts#rejectReviewPair', {}],
  ['saved/actions.ts#saveOpportunity', {}],
  ['saved/actions.ts#dismissOpportunity', {}],
  ['saved/actions.ts#clearOpportunityDecision', {}],
  ['taxonomy-review/actions.ts#confirmClassification', {}],
  ['taxonomy-review/actions.ts#rejectClassification', {}],
  ['taxonomy-review/actions.ts#undoCorrection', {}],
]);

type Action = (...args: unknown[]) => Promise<unknown>;

const LOCAL_DIR = dirname(fileURLToPath(import.meta.url));

function serverActionModules(): string[] {
  return (readdirSync(LOCAL_DIR, { recursive: true }) as string[])
    .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
    .filter((file) => /^\s*['"]use server['"]/.test(readFileSync(join(LOCAL_DIR, file), 'utf8')))
    .map((file) => relative(LOCAL_DIR, join(LOCAL_DIR, file)).replaceAll('\\', '/'));
}

/** A crafted request: plausible-looking but attacker-chosen fields. */
function craftedForm(): FormData {
  const form = new FormData();
  for (const field of [
    'opportunityId',
    'candidateId',
    'survivorListingId',
    'movingListingId',
    'sourceListingId',
    'classificationId',
    'correctionId',
    'profileId',
    'draftId',
  ]) {
    form.set(field, '00000000-0000-4000-8000-000000000000');
  }
  form.set('note', 'crafted');
  return form;
}

function craftedArgs(key: string): unknown[] {
  return EXPECTED.get(key)?.readOnly
    ? ['00000000-0000-4000-8000-000000000000', 'a'.repeat(64)]
    : [craftedForm()];
}

describe('local Server Actions refuse off the local surface', () => {
  const actions = new Map<string, Action>();
  const original = { ...process.env };

  beforeAll(async () => {
    for (const file of serverActionModules()) {
      const mod = (await import(pathToFileURL(join(LOCAL_DIR, file)).href)) as Record<
        string,
        unknown
      >;
      for (const [name, value] of Object.entries(mod)) {
        if (typeof value === 'function') actions.set(`${file}#${name}`, value as Action);
      }
    }
  });

  afterEach(() => {
    process.env = { ...original };
    dbAccesses.length = 0;
  });

  it('discovers exactly the expected set of local actions', () => {
    expect([...actions.keys()].sort()).toEqual([...EXPECTED.keys()].sort());
  });

  describe.each(['public', 'admin'] as const)('XTELO_SURFACE=%s', (surface) => {
    it.each([...EXPECTED.keys()])(
      '%s throws NotLocalSurfaceError before any database access',
      async (key) => {
        process.env.XTELO_SURFACE = surface;
        process.env.XTELO_WRITES_ENABLED = 'true';
        const action = actions.get(key);
        expect(action).toBeDefined();

        await expect(action?.(...craftedArgs(key))).rejects.toBeInstanceOf(NotLocalSurfaceError);
        expect(dbAccesses).toEqual([]);
      },
    );
  });

  it.each([...EXPECTED.keys()])('%s fails closed on an unrecognized XTELO_SURFACE', async (key) => {
    process.env.XTELO_SURFACE = 'Local';
    process.env.XTELO_WRITES_ENABLED = 'true';

    await expect(actions.get(key)?.(...craftedArgs(key))).rejects.toBeInstanceOf(
      InvalidSurfaceError,
    );
    expect(dbAccesses).toEqual([]);
  });

  describe.each([
    ['unset', undefined],
    ['local', 'local'],
  ] as const)('XTELO_SURFACE %s', (_label, surface) => {
    it.each([...EXPECTED.keys()])('%s passes the surface guard', async (key) => {
      if (surface === undefined) delete process.env.XTELO_SURFACE;
      else process.env.XTELO_SURFACE = surface;
      delete process.env.XTELO_WRITES_ENABLED;

      const result = actions.get(key)?.(...craftedArgs(key));
      if (EXPECTED.get(key)?.readOnly) {
        // No writes guard: the call reaches the data layer, which the proxy refuses.
        await expect(result).rejects.toBeInstanceOf(DatabaseTouchedError);
        expect(dbAccesses.length).toBeGreaterThan(0);
      } else {
        await expect(result).rejects.toBeInstanceOf(WritesDisabledError);
        expect(dbAccesses).toEqual([]);
      }
    });
  });
});
