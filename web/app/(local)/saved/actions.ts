'use server';

import { revalidatePath } from 'next/cache.js';
import { db } from '../../../../src/db/client.js';
import { clearDecision, type Decision, recordDecision } from '../../../../src/shortlist/decisions.js';
import { readNote, readOpportunityId } from '../../../lib/decision-input.js';
import { assertWritesEnabled } from '../../../lib/writes.js';

/**
 * The web app's first writes.
 *
 * Every one of these calls `assertWritesEnabled()` **before it reads the form
 * body or touches the database**, which is the ordering `writes.ts` asks for
 * and the reason it is a mechanism rather than a rule. Two prior incidents in
 * this project were procedural failures — someone knowing not to write to the
 * live corpus and doing it anyway — and a browser session is not covered by
 * the vitest real-data guard at all. `npm run dev` points at the live corpus
 * and these throw; `npm run dev:web:qa` points at a disposable copy and they
 * work.
 *
 * Server actions rather than Route Handlers because these are form submits
 * with no meaningful HTTP surface: nothing else calls them, and a handler
 * would mean hand-rolling the redirect and revalidation that a form gets for
 * free. The screens stay server-rendered with no client JavaScript — a
 * `<form action={...}>` posts and re-renders, so the shortlist works with
 * scripting off, like every other control in this app.
 */

async function decide(form: FormData, decision: Decision): Promise<void> {
  assertWritesEnabled();

  const opportunityId = readOpportunityId(form);
  const note = readNote(form);

  await recordDecision(db, {
    opportunityId,
    decision,
    ...(note === undefined ? {} : { note }),
    now: new Date().toISOString(),
  });

  revalidateShortlistViews(opportunityId);
}

export async function saveOpportunity(form: FormData): Promise<void> {
  await decide(form, 'saved');
}

export async function dismissOpportunity(form: FormData): Promise<void> {
  await decide(form, 'dismissed');
}

export async function clearOpportunityDecision(form: FormData): Promise<void> {
  assertWritesEnabled();

  const opportunityId = readOpportunityId(form);
  await clearDecision(db, opportunityId);
  revalidateShortlistViews(opportunityId);
}

/**
 * Every screen that can show a decision, not just the one that made it.
 *
 * A decision made on the detail screen changes the shortlist counts and the
 * opportunity's own row elsewhere, and leaving those stale is how a reader
 * ends up saving the same thing twice because the first one did not appear to
 * take. Every page here is already `force-dynamic`, so this is belt and
 * braces against a cached shell rather than the primary mechanism.
 */
function revalidateShortlistViews(opportunityId: string): void {
  revalidatePath('/saved');
  revalidatePath('/opportunities');
  revalidatePath(`/opportunities/${opportunityId}`);
}
