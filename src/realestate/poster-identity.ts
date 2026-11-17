import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  accountContacts,
  contacts,
  listingContacts,
  listingPosters,
  posterAccounts,
  posterDaily,
  posterEntities,
  posterEntityMembers,
  posterEntityOverrides,
  posterSteps,
  realEstateListings,
} from '../db/schema/index.js';
import type { DatabaseOrTransaction } from '../db/types.js';
import { onShowIds } from './history.js';
import { tbilisiDay } from './totals.js';

/**
 * The nightly poster step (Phase 17B, docs/PHASE_17_PLAN.md), after the
 * history and the totals, at their instant. One transaction:
 *
 * 1. **links**: every listing's contacts are tied to the account that posted
 *    it (`account_contacts`, from `listing_contacts` × `listing_posters`).
 *    Done here rather than as pages are read, so a description read before
 *    its account was known (the backfill) is tied the first night the
 *    account is;
 * 2. **identity**: accounts are joined into one person or agency where they
 *    share a phone (the strongest proof) or an email (also strong, as the
 *    owner set): a union-find over the account–contact graph, recomputed
 *    whole under `POSTER_RULE_VERSION`. A contact more than
 *    `MAX_ACCOUNTS_PER_CONTACT` accounts use is flagged and joins nothing;
 *    the owner's overrides are applied; an entity keeps its id from night
 *    to night (`assignEntityIds`). Only what changed is written;
 * 3. **size**: each entity's listings on show tonight by the Real estate
 *    tab's own rule, its listings first seen today and its distinct
 *    look-alike groups (`poster_daily`).
 *
 * Like the history step it never throws for a failure of its own: it rolls
 * back, logs the failure in `poster_steps` and returns it, and the next night
 * does the whole of it again.
 *
 * Telling a same-account relist (deleted and posted again for a fresh date)
 * from a cross-account copy needs no table of its own yet: `listing_posters`
 * keeps each listing key's account with first and last seen, and
 * `realestate_media.listing_photo_refs` each key's photos.
 */

/** Bumped whenever a rule below changes, so a night's identities say which rules made them. */
export const POSTER_RULE_VERSION = 1;

/**
 * A contact more accounts than this use is an office, a call centre or a
 * portal's own number: it is flagged (`contacts.merge_blocked`) and never
 * joins accounts. Ten covers an agency's branches and an agent's few
 * accounts without letting one shared switchboard swallow a city's brokers.
 */
export const MAX_ACCOUNTS_PER_CONTACT = 10;

export interface PosterStepResult {
  ok: boolean;
  /** Account × contact links written or extended. */
  linksWritten: number;
  accounts: number;
  /** Entities with at least one account after the step. */
  entities: number;
  /** Accounts whose entity changed, or that got their first. */
  membersChanged: number;
  /** Contacts over the cap. */
  contactsFlagged: number;
  dailyRows: number;
  durationMs: number;
  error: string | null;
}

export interface IdentityInput {
  accounts: readonly number[];
  /** Account × contact, each once or more. */
  edges: readonly { accountId: number; contactId: number }[];
  overrides: readonly {
    kind: 'merge' | 'split';
    accountId: number | null;
    otherAccountId: number | null;
    contactId: number | null;
  }[];
  maxAccountsPerContact?: number;
}

export interface IdentityGroups {
  /** Each group of accounts, each sorted, the largest first (ties: lowest account first). */
  groups: number[][];
  /** Contact → the distinct accounts using it. */
  accountsPerContact: Map<number, number>;
  /** Contacts over the cap. */
  blocked: Set<number>;
}

/** Union-find over accounts and contacts; pure, so the rules are tested without a database. */
export function groupAccounts(input: IdentityInput): IdentityGroups {
  const cap = input.maxAccountsPerContact ?? MAX_ACCOUNTS_PER_CONTACT;
  const parent = new Map<number, number>();
  const find = (account: number): number => {
    let root = account;
    while (parent.get(root) !== root) root = parent.get(root) as number;
    let at = account;
    while (at !== root) {
      const next = parent.get(at) as number;
      parent.set(at, root);
      at = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(Math.max(ra, rb), Math.min(ra, rb));
  };
  for (const account of input.accounts) parent.set(account, account);

  const users = new Map<number, Set<number>>();
  for (const { accountId, contactId } of input.edges) {
    if (!parent.has(accountId)) parent.set(accountId, accountId);
    let set = users.get(contactId);
    if (set === undefined) {
      set = new Set();
      users.set(contactId, set);
    }
    set.add(accountId);
  }
  const accountsPerContact = new Map([...users].map(([contact, set]) => [contact, set.size]));
  const blocked = new Set(
    [...users].filter(([, set]) => set.size > cap).map(([contact]) => contact),
  );

  const splitAccounts = new Set<number>();
  const splitContacts = new Set<number>();
  const splitEdges = new Set<string>();
  for (const override of input.overrides) {
    if (override.kind !== 'split') continue;
    if (override.accountId !== null && override.contactId !== null) {
      splitEdges.add(`${override.accountId}:${override.contactId}`);
    } else if (override.accountId !== null) splitAccounts.add(override.accountId);
    else if (override.contactId !== null) splitContacts.add(override.contactId);
  }

  for (const [contact, set] of users) {
    if (blocked.has(contact) || splitContacts.has(contact)) continue;
    let first: number | null = null;
    for (const account of set) {
      if (splitAccounts.has(account) || splitEdges.has(`${account}:${contact}`)) continue;
      if (first === null) first = account;
      else union(first, account);
    }
  }
  for (const override of input.overrides) {
    if (
      override.kind !== 'merge' ||
      override.accountId === null ||
      override.otherAccountId === null
    )
      continue;
    if (!parent.has(override.accountId) || !parent.has(override.otherAccountId)) continue;
    union(override.accountId, override.otherAccountId);
  }

  const byRoot = new Map<number, number[]>();
  for (const account of parent.keys()) {
    const root = find(account);
    const group = byRoot.get(root);
    if (group === undefined) byRoot.set(root, [account]);
    else group.push(account);
  }
  const groups = [...byRoot.values()]
    .map((group) => group.sort((a, b) => a - b))
    .sort((a, b) => b.length - a.length || (a[0] as number) - (b[0] as number));
  return { groups, accountsPerContact, blocked };
}

/**
 * An id per group, stable from night to night: each group, largest first,
 * takes the previous id that most of its accounts had (ties: the lower id)
 * and that no larger group took; a group none of whose accounts had a free
 * id gets a new one.
 */
export function assignEntityIds(
  groups: readonly (readonly number[])[],
  previous: ReadonlyMap<number, string>,
  newId: () => string = randomUUID,
): string[] {
  const taken = new Set<string>();
  return groups.map((group) => {
    const overlap = new Map<string, number>();
    for (const account of group) {
      const id = previous.get(account);
      if (id !== undefined) overlap.set(id, (overlap.get(id) ?? 0) + 1);
    }
    const best = [...overlap]
      .filter(([id]) => !taken.has(id))
      .sort(([a, na], [b, nb]) => nb - na || (a < b ? -1 : 1))[0];
    const id = best?.[0] ?? newId();
    taken.add(id);
    return id;
  });
}

const json = (value: unknown) => sql`${JSON.stringify(value)}::jsonb`;

/**
 * A failure as it may be logged: never the failed query's parameters, which
 * drizzle puts in its own message and which hold phones and names; the
 * database's message and code instead.
 */
export function describeFailure(err: unknown): string {
  const cause = err instanceof Error && err.cause !== undefined ? err.cause : null;
  if (cause !== null) {
    const code = typeof cause === 'object' ? (cause as { code?: unknown }).code : undefined;
    const message = cause instanceof Error ? cause.message : String(cause);
    return `${typeof code === 'string' ? `SQLSTATE ${code}: ` : ''}${message.slice(0, 300)}`;
  }
  return err instanceof Error
    ? `${err.name}: ${err.message.slice(0, 300)}`
    : String(err).slice(0, 300);
}

/**
 * Runs the poster step for one source at `now`, the instant of that night's
 * history and totals. Run twice at the same instant, the second writes
 * nothing new.
 */
export async function recordPosterStep(
  db: DatabaseOrTransaction,
  input: { sourceId: string; now: string; crawlRunId: string | null },
): Promise<PosterStepResult> {
  const { sourceId, now, crawlRunId } = input;
  const startedAtMs = Date.now();
  try {
    const counts = await db.transaction(async (tx) => {
      // One identity build at a time, whichever source asked for it.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('realestate-posters'))`);

      // 1. Links: each listing's contacts to the account that posted it.
      const links = await tx.execute(sql`
        insert into ${accountContacts} as ac (account_id, contact_id, seen_in, first_seen_at, last_seen_at)
        select lp.account_id, lc.contact_id, lc.seen_in, min(lc.first_seen_at), max(lc.last_seen_at)
          from ${listingContacts} lc
          join ${listingPosters} lp
            on lp.source_id = lc.source_id and lp.source_listing_key = lc.source_listing_key
         where lc.source_id = ${sourceId}
         group by lp.account_id, lc.contact_id, lc.seen_in
        on conflict (account_id, contact_id, seen_in) do update set
          first_seen_at = least(ac.first_seen_at, excluded.first_seen_at),
          last_seen_at = greatest(ac.last_seen_at, excluded.last_seen_at)
        where ac.last_seen_at < excluded.last_seen_at or ac.first_seen_at > excluded.first_seen_at`);

      // 2. Identity, over every source's accounts.
      const accounts = (
        await tx.execute<{ id: number }>(sql`select id::float8 as id from ${posterAccounts}`)
      ).rows.map((row) => Number(row.id));
      const edges = (
        await tx.execute<{ account_id: number; contact_id: number }>(sql`
          select distinct account_id::float8 as account_id, contact_id::float8 as contact_id
            from ${accountContacts}`)
      ).rows.map((row) => ({
        accountId: Number(row.account_id),
        contactId: Number(row.contact_id),
      }));
      const overrides = (
        await tx.execute<{
          kind: string;
          account_id: number | null;
          other_account_id: number | null;
          contact_id: number | null;
        }>(sql`
          select kind, account_id::float8 as account_id, other_account_id::float8 as other_account_id,
                 contact_id::float8 as contact_id
            from ${posterEntityOverrides} order by id`)
      ).rows.map((row) => ({
        kind: row.kind === 'merge' ? ('merge' as const) : ('split' as const),
        accountId: row.account_id === null ? null : Number(row.account_id),
        otherAccountId: row.other_account_id === null ? null : Number(row.other_account_id),
        contactId: row.contact_id === null ? null : Number(row.contact_id),
      }));
      const { groups, accountsPerContact, blocked } = groupAccounts({
        accounts,
        edges,
        overrides,
      });

      const previousRows = (
        await tx.execute<{ account_id: number; entity_id: string; rule_version: number }>(sql`
          select account_id::float8 as account_id, entity_id::text as entity_id, rule_version
            from ${posterEntityMembers}`)
      ).rows;
      const previous = new Map(previousRows.map((row) => [Number(row.account_id), row.entity_id]));
      const previousVersion = new Map(
        previousRows.map((row) => [Number(row.account_id), Number(row.rule_version)]),
      );
      const ids = assignEntityIds(groups, previous);

      const entityRows = groups.map((group, index) => ({
        id: ids[index] as string,
        account_count: group.length,
      }));
      // New and changed entities; the unchanged write nothing.
      await tx.execute(sql`
        insert into ${posterEntities} as e (id, rule_version, account_count, first_built_at, updated_at)
        select r.id, ${POSTER_RULE_VERSION}, r.account_count, ${now}::timestamptz, ${now}::timestamptz
          from jsonb_to_recordset(${json(entityRows)}) as r(id uuid, account_count integer)
        on conflict (id) do update set
          rule_version = excluded.rule_version,
          account_count = excluded.account_count,
          updated_at = excluded.updated_at,
          retired_at = null
        where e.account_count <> excluded.account_count
           or e.rule_version <> excluded.rule_version
           or e.retired_at is not null`);

      const changed: { account_id: number; entity_id: string }[] = [];
      groups.forEach((group, index) => {
        const id = ids[index] as string;
        for (const account of group) {
          if (
            previous.get(account) !== id ||
            previousVersion.get(account) !== POSTER_RULE_VERSION
          ) {
            changed.push({ account_id: account, entity_id: id });
          }
        }
      });
      if (changed.length > 0) {
        await tx.execute(sql`
          insert into ${posterEntityMembers} as m (account_id, entity_id, rule_version, since)
          select r.account_id, r.entity_id, ${POSTER_RULE_VERSION}, ${now}::timestamptz
            from jsonb_to_recordset(${json(changed)}) as r(account_id bigint, entity_id uuid)
          on conflict (account_id) do update set
            entity_id = excluded.entity_id,
            rule_version = excluded.rule_version,
            since = case when m.entity_id = excluded.entity_id then m.since else excluded.since end`);
      }
      // An entity no account maps to any more is retired, never deleted.
      await tx.execute(sql`
        update ${posterEntities} e set retired_at = ${now}::timestamptz, updated_at = ${now}::timestamptz
         where e.retired_at is null
           and not exists (select 1 from ${posterEntityMembers} m where m.entity_id = e.id)`);

      // Each contact's count and flag, where they changed.
      const contactRows = [...accountsPerContact].map(([id, count]) => ({
        id,
        account_count: count,
        merge_blocked: blocked.has(id),
      }));
      await tx.execute(sql`
        update ${contacts} c set account_count = r.account_count, merge_blocked = r.merge_blocked
          from jsonb_to_recordset(${json(contactRows)}) as r(id bigint, account_count integer, merge_blocked boolean)
         where c.id = r.id
           and (c.account_count <> r.account_count or c.merge_blocked <> r.merge_blocked)`);

      // 3. Size tonight, on this source: rewritten whole for the day.
      const day = tbilisiDay(now);
      await tx.execute(
        sql`delete from ${posterDaily} where source_id = ${sourceId} and day = ${day}::date`,
      );
      const live = sql.raw('live');
      const daily = await tx.execute(sql`
        with shown as (${onShowIds(sourceId, now)}),
        listed as (
          select ${live}.id, ${live}.group_key, ${live}.source_listing_key,
                 ${live}.id in (select id from shown) as on_show,
                 ((${live}.first_seen_at at time zone 'UTC') + interval '4 hours')::date = ${day}::date as is_new
            from ${realEstateListings} ${live}
           where ${live}.source_id = ${sourceId}
        ), posted as (
          select listed.*, (
                   select lp.account_id from ${listingPosters} lp
                    where lp.source_id = ${sourceId} and lp.source_listing_key = listed.source_listing_key
                    order by lp.last_seen_at desc, lp.account_id limit 1) as account_id
            from listed
           where listed.on_show or listed.is_new
        )
        insert into ${posterDaily}
          (source_id, entity_id, day, listings_on_show, new_listings, distinct_groups)
        select ${sourceId}, m.entity_id, ${day}::date,
               count(*) filter (where posted.on_show),
               count(*) filter (where posted.is_new),
               count(distinct coalesce(posted.group_key, posted.id::text)) filter (where posted.on_show)
          from posted
          join ${posterEntityMembers} m on m.account_id = posted.account_id
         group by m.entity_id`);

      const result = {
        linksWritten: links.rowCount ?? 0,
        accounts: accounts.length,
        entities: groups.length,
        membersChanged: changed.length,
        contactsFlagged: blocked.size,
        dailyRows: daily.rowCount ?? 0,
      };
      await tx.insert(posterSteps).values({
        sourceId,
        takenAt: now,
        crawlRunId,
        ruleVersion: POSTER_RULE_VERSION,
        ...result,
        durationMs: Date.now() - startedAtMs,
        ok: true,
      });
      return result;
    });
    return { ok: true, ...counts, durationMs: Date.now() - startedAtMs, error: null };
  } catch (err) {
    let error = describeFailure(err);
    try {
      await db.insert(posterSteps).values({
        sourceId,
        takenAt: now,
        crawlRunId,
        ruleVersion: POSTER_RULE_VERSION,
        durationMs: Date.now() - startedAtMs,
        ok: false,
        error,
      });
    } catch {
      error += '; recording the failure failed too';
    }
    return {
      ok: false,
      linksWritten: 0,
      accounts: 0,
      entities: 0,
      membersChanged: 0,
      contactsFlagged: 0,
      dailyRows: 0,
      durationMs: Date.now() - startedAtMs,
      error,
    };
  }
}
