import { randomUUID } from 'node:crypto';
import type { Session } from 'next-auth';
import { db } from '../../src/db/client.js';
import { adminAuditEvents, type AdminAuditAction } from '../../src/db/schema/index.js';
import type { DatabaseOrTransaction } from '../../src/db/types.js';
import { isDeniedError, requireAdmin } from './admin-auth.js';
import { writesEnabled } from './writes.js';

/**
 * Stage 11 (change.md §13, concept §30.2): "all three outcomes durable, not
 * just two." Three distinct write paths, matching the plan's own reasoning
 * for why they must differ:
 *
 * - `recordRefusal`: `requireAdmin()` rejects before anything starts, so
 *   there is no mutation transaction to attach to — written immediately, on
 *   its own. Gated on `writesEnabled()` (Codex, 2026-09-24): this app's one
 *   hard rule is that nothing writes to the real corpus without explicit
 *   opt-in (`CLAUDE.md`'s "Local databases" section; `web/lib/writes.ts`'s
 *   own header comment records TWO past real incidents from this exact class
 *   of gap) — an audit row is still a write, and a refusal can be reached by
 *   an unauthenticated or non-admin caller specifically BEFORE the later
 *   `assertWritesEnabled()` in each action ever runs. Authorization is still
 *   checked first (`requireAdminAudited` below) — this gate is only about
 *   whether the resulting audit INSERT is allowed to happen, not about
 *   reordering the security check itself.
 * - `recordFailure`: for a genuinely authorized, writes-enabled admin whose
 *   attempt still fails — either before `auditedMutation` ever starts (a
 *   preflight check: a missing live membership, an unparsable form field) or
 *   because `auditedMutation` itself threw. Callers own this call (not
 *   `auditedMutation` itself) so every failure in one admin action, preflight
 *   or not, is audited exactly once at the SAME point, matching
 *   `AGENTS.md`/`docs/THREAT_MODEL.md`'s requirement that an attempted admin
 *   mutation carry a real actor/action/outcome even when it never reaches the
 *   database (Codex, 2026-09-24). No `writesEnabled()` gate needed here: this
 *   is only ever reached after each action's own `assertWritesEnabled()` has
 *   already passed.
 * - `auditedMutation`: wraps a real mutation in ONE transaction that the
 *   'succeeded' audit row also commits inside, so the two rise or fall
 *   together. The underlying business-logic functions this wraps
 *   (`acceptDuplicateCandidate`, `correctClassification`, …) each open their
 *   OWN internal `db.transaction(...)` — passing THIS function's own
 *   transaction object as their `db` argument turns that inner call into a
 *   SAVEPOINT within the outer one, not a second independent transaction:
 *   confirmed directly (a throwaway probe, then formally in
 *   `admin-audit.test.ts` against the real business-logic functions) that
 *   rolling back the outer transaction also rolls back a nested inner one
 *   under this project's drizzle-orm/node-postgres setup. On any throw, the
 *   whole transaction (mutation AND the would-be `succeeded` row) rolls back
 *   automatically — this function does not catch it; the caller's own
 *   `recordFailure` call is what makes the `failed` outcome durable, in a
 *   separate, un-transactioned statement.
 */

async function insertAuditEvent(
  executor: DatabaseOrTransaction,
  params: {
    actorGithubId: string | null;
    entityType: string;
    entityId: string | null;
    action: AdminAuditAction;
    outcome: 'succeeded' | 'refused' | 'failed';
    at: string;
    details: Record<string, string | number | boolean | null>;
  },
): Promise<void> {
  await executor.insert(adminAuditEvents).values({
    id: randomUUID(),
    actorGithubId: params.actorGithubId,
    entityType: params.entityType,
    entityId: params.entityId,
    action: params.action,
    outcome: params.outcome,
    occurredAt: params.at,
    details: params.details,
  });
}

export async function recordRefusal(params: {
  actorGithubId: string | null;
  entityType: string;
  entityId: string | null;
  action: AdminAuditAction;
  at: string;
}): Promise<void> {
  if (!writesEnabled()) return;
  await insertAuditEvent(db, { ...params, outcome: 'refused', details: {} });
}

/**
 * `requireAdmin()`, wrapped so a rejection is audited before it propagates.
 * `entityId` is read from the form BEFORE this call — side-effect-free
 * string parsing only (no database access), which is why it doesn't violate
 * the "authorization first" principle every admin action still follows for
 * anything that actually touches data. Callers should still re-read and
 * fully validate the id AFTER this resolves, for the real mutation — this
 * one is audit-only and best-effort (`null` on a malformed field, not a
 * throw, so a bad request still reaches the real `requireAdmin()` check
 * rather than failing before it).
 */
export async function requireAdminAudited(
  action: AdminAuditAction,
  entityType: string,
  entityId: string | null,
): Promise<Session> {
  try {
    return await requireAdmin();
  } catch (error) {
    const actorGithubId = isDeniedError(error) ? error.deniedActorGithubId : null;
    await recordRefusal({
      actorGithubId,
      entityType,
      entityId,
      action,
      at: new Date().toISOString(),
    });
    throw error;
  }
}

/**
 * `message`: stored only when the error carries one of this codebase's own
 * recognizable, static conflict prefixes (`acceptDuplicateCandidate:`,
 * `rejectDuplicateCandidate:`, `correctClassification:`,
 * `undoClassificationCorrection:`, or this file's own action-level preflight
 * errors like `acceptReviewPair:`/`rejectReviewPair:`) — those are hardcoded
 * internal strings, never derived from admin-typed or listing-sourced
 * content, so storing them does not violate the "ids/hashes only" discipline
 * `admin_audit_events`'s own schema comment states. Anything else (an
 * unrecognized, potentially content-bearing error) is recorded only as a
 * category, never the raw message.
 */
const KNOWN_FAILURE_PREFIXES = [
  'acceptDuplicateCandidate:',
  'rejectDuplicateCandidate:',
  'correctClassification:',
  'undoClassificationCorrection:',
  'acceptReviewPair:',
  'rejectReviewPair:',
] as const;

export function failureDetails(error: unknown): Record<string, string> {
  if (error instanceof Error && KNOWN_FAILURE_PREFIXES.some((p) => error.message.startsWith(p))) {
    return { reason: 'known_conflict', message: error.message };
  }
  return { reason: 'unexpected_error' };
}

/**
 * Records a `failed` outcome for an authorized, writes-enabled admin attempt
 * that did not succeed — call this from each action's own outer `catch`,
 * whether the throw came from a preflight check or from `auditedMutation`
 * itself, so every real attempt is audited exactly once.
 */
export async function recordFailure(params: {
  actorGithubId: string;
  entityType: string;
  /** `null` when even the id itself failed to parse — an honest "unknown", not a guess. */
  entityId: string | null;
  action: AdminAuditAction;
  at: string;
  error: unknown;
}): Promise<void> {
  await insertAuditEvent(db, {
    actorGithubId: params.actorGithubId,
    entityType: params.entityType,
    entityId: params.entityId,
    action: params.action,
    outcome: 'failed',
    at: params.at,
    details: failureDetails(params.error),
  });
}

export async function auditedMutation<T>(params: {
  actorGithubId: string;
  entityType: string;
  entityId: string;
  action: AdminAuditAction;
  at: string;
  mutate: (tx: DatabaseOrTransaction) => Promise<T>;
}): Promise<T> {
  return db.transaction(async (tx) => {
    const result = await params.mutate(tx);
    await insertAuditEvent(tx, {
      actorGithubId: params.actorGithubId,
      entityType: params.entityType,
      entityId: params.entityId,
      action: params.action,
      outcome: 'succeeded',
      at: params.at,
      details: {},
    });
    return result;
  });
}
