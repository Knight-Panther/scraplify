import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  pgSchema,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sources } from './sources.js';

/**
 * The private poster directory (Phase 17B, docs/PHASE_17_PLAN.md): who posts
 * real-estate listings, the phones and emails they post under, and which of
 * their accounts are one person or agency. Owner decision 2026-11-17: never
 * on jobster.fun, never in a public view, never readable by
 * `scraplify_public` or `scraplify_admin`; only the worker writes and reads
 * it (the statistics role of 17E comes later). Kept for good, each fact with
 * when it was first and last seen.
 *
 * Every source is a page the crawler reads anyway, so the directory costs
 * no request: the account id on each results row, the contact name and
 * phone on a listing's own page, and phones and emails typed into
 * descriptions. Written as pages are read (`src/realestate/posters.ts`); the
 * links and identities are worked out once a night
 * (`src/realestate/poster-identity.ts`).
 */
export const realEstateContacts = pgSchema('realestate_contacts');

const timestamps = {
  firstSeenAt: timestamp('first_seen_at', { mode: 'string', withTimezone: true }).notNull(),
  lastSeenAt: timestamp('last_seen_at', { mode: 'string', withTimezone: true }).notNull(),
};

/** One row per account on a source (ss.ge's `userId`). */
export const posterAccounts = realEstateContacts.table(
  'poster_accounts',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id),
    /** The source's own account id: on ss.ge a GUID, lower-cased. */
    sourceUserId: text('source_user_id').notNull(),
    /** `userInfo.name` on a results row: a business's display name. The latest seen. */
    displayName: text('display_name'),
    /** The contact name a listing page shows (`contactPerson`). The latest seen. */
    contactName: text('contact_name'),
    /** `userInfo.userType`, ss.ge's code. */
    userType: smallint('user_type'),
    /** `userEntityType` on a listing page ("Broker", "Individual"…). */
    entityType: text('entity_type'),
    /** `userApplicationCount`: the account's listings, as its last listing page read said. */
    listingCount: integer('listing_count'),
    agencyRef: integer('agency_ref'),
    agencyName: text('agency_name'),
    companyRef: integer('company_ref'),
    companyName: text('company_name'),
    companyType: smallint('company_type'),
    agentInfoType: smallint('agent_info_type'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('poster_accounts_source_user_idx').on(table.sourceId, table.sourceUserId),
  ],
);

/** A phone (`+995` and 9 digits) or an email (lower-cased), shared by every source. */
export const contacts = realEstateContacts.table(
  'contacts',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    kind: text('kind').notNull(),
    value: text('value').notNull(),
    ...timestamps,
    /** How many accounts it links, as the last identity step counted. */
    accountCount: integer('account_count').notNull().default(0),
    /**
     * Used by more accounts than `MAX_ACCOUNTS_PER_CONTACT` (an office, a
     * call centre, a portal's own number): flagged, and never merges.
     */
    mergeBlocked: boolean('merge_blocked').notNull().default(false),
  },
  (table) => [
    uniqueIndex('contacts_kind_value_idx').on(table.kind, table.value),
    check('contacts_kind_check', sql`${table.kind} in ('phone', 'email')`),
  ],
);

/**
 * Account × contact: the identity graph's edges, one per place the link was
 * seen. Derived each night from `listing_contacts` × `listing_posters`.
 */
export const accountContacts = realEstateContacts.table(
  'account_contacts',
  {
    accountId: bigint('account_id', { mode: 'number' })
      .notNull()
      .references(() => posterAccounts.id, { onDelete: 'cascade' }),
    contactId: bigint('contact_id', { mode: 'number' })
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    /** listing_page (its phone list), description (typed into the text) or row. */
    seenIn: text('seen_in').notNull(),
    ...timestamps,
  },
  (table) => [
    primaryKey({
      name: 'account_contacts_pk',
      columns: [table.accountId, table.contactId, table.seenIn],
    }),
    index('account_contacts_contact_idx').on(table.contactId),
    check(
      'account_contacts_seen_in_check',
      sql`${table.seenIn} in ('listing_page', 'description', 'row')`,
    ),
  ],
);

/**
 * Which account posted each listing, by the source's own listing key, so
 * the link outlives the live row (archiving) and covers a key's every life.
 * A listing posted again from the same account keeps one row; the same
 * listing's photos under another account's key is a cross-account copy.
 */
export const listingPosters = realEstateContacts.table(
  'listing_posters',
  {
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id),
    sourceListingKey: text('source_listing_key').notNull(),
    accountId: bigint('account_id', { mode: 'number' })
      .notNull()
      .references(() => posterAccounts.id, { onDelete: 'cascade' }),
    ...timestamps,
  },
  (table) => [
    primaryKey({
      name: 'listing_posters_pk',
      columns: [table.sourceId, table.sourceListingKey, table.accountId],
    }),
    index('listing_posters_account_idx').on(table.accountId),
  ],
);

/**
 * Listing × contact × the name shown beside it: an agency's account shows
 * different agents' phones on different listings, so who posted what is
 * kept per listing. `contact_name` is '' when none is shown.
 */
export const listingContacts = realEstateContacts.table(
  'listing_contacts',
  {
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id),
    sourceListingKey: text('source_listing_key').notNull(),
    contactId: bigint('contact_id', { mode: 'number' })
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    contactName: text('contact_name').notNull().default(''),
    seenIn: text('seen_in').notNull(),
    ...timestamps,
  },
  (table) => [
    primaryKey({
      name: 'listing_contacts_pk',
      columns: [
        table.sourceId,
        table.sourceListingKey,
        table.contactId,
        table.contactName,
        table.seenIn,
      ],
    }),
    index('listing_contacts_contact_idx').on(table.contactId),
    index('listing_contacts_seen_idx').on(table.sourceId, table.lastSeenAt),
    check(
      'listing_contacts_seen_in_check',
      sql`${table.seenIn} in ('listing_page', 'description', 'row')`,
    ),
  ],
);

/**
 * One person or agency: accounts joined by a shared phone or email,
 * recomputed each night under `rule_version` (a derived layer). An id stays
 * with the largest part of its accounts from night to night; one no account
 * maps to any more is retired, never deleted.
 */
export const posterEntities = realEstateContacts.table('poster_entities', {
  id: uuid('id').primaryKey(),
  ruleVersion: smallint('rule_version').notNull(),
  accountCount: integer('account_count').notNull(),
  firstBuiltAt: timestamp('first_built_at', { mode: 'string', withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { mode: 'string', withTimezone: true }).notNull(),
  retiredAt: timestamp('retired_at', { mode: 'string', withTimezone: true }),
});

/** Each account's entity, as the last identity step left it. */
export const posterEntityMembers = realEstateContacts.table(
  'poster_entity_members',
  {
    accountId: bigint('account_id', { mode: 'number' })
      .primaryKey()
      .references(() => posterAccounts.id, { onDelete: 'cascade' }),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => posterEntities.id),
    ruleVersion: smallint('rule_version').notNull(),
    /** When the account joined this entity. */
    since: timestamp('since', { mode: 'string', withTimezone: true }).notNull(),
  },
  (table) => [index('poster_entity_members_entity_idx').on(table.entityId)],
);

/**
 * The owner's corrections, applied by every identity step:
 * - `merge`: `account_id` and `other_account_id` are one entity;
 * - `split` with an account and a contact: that link never merges (a
 *   recycled number, an agent who changed agency);
 * - `split` with an account only: none of its links merges;
 * - `split` with a contact only: that contact never merges.
 */
export const posterEntityOverrides = realEstateContacts.table(
  'poster_entity_overrides',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    kind: text('kind').notNull(),
    accountId: bigint('account_id', { mode: 'number' }).references(() => posterAccounts.id, {
      onDelete: 'cascade',
    }),
    otherAccountId: bigint('other_account_id', { mode: 'number' }).references(
      () => posterAccounts.id,
      { onDelete: 'cascade' },
    ),
    contactId: bigint('contact_id', { mode: 'number' }).references(() => contacts.id, {
      onDelete: 'cascade',
    }),
    note: text('note'),
    createdAt: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      'poster_entity_overrides_shape_check',
      sql`(${table.kind} = 'merge' and ${table.accountId} is not null and ${table.otherAccountId} is not null and ${table.contactId} is null)
        or (${table.kind} = 'split' and ${table.otherAccountId} is null and (${table.accountId} is not null or ${table.contactId} is not null))`,
    ),
  ],
);

/**
 * Each entity's size, night by night, on one source: its listings on show
 * by the Real estate tab's own rule at the night's instant, the listings
 * first seen that Tbilisi day, and the distinct look-alike groups (about the
 * distinct properties) among those on show.
 */
export const posterDaily = realEstateContacts.table(
  'poster_daily',
  {
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => posterEntities.id),
    day: date('day', { mode: 'string' }).notNull(),
    listingsOnShow: integer('listings_on_show').notNull(),
    newListings: integer('new_listings').notNull(),
    distinctGroups: integer('distinct_groups').notNull(),
  },
  (table) => [
    primaryKey({ name: 'poster_daily_pk', columns: [table.sourceId, table.entityId, table.day] }),
    index('poster_daily_day_idx').on(table.sourceId, table.day),
  ],
);

/** One row per run of the nightly poster step, whether it worked or not. */
export const posterSteps = realEstateContacts.table(
  'poster_steps',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id),
    takenAt: timestamp('taken_at', { mode: 'string', withTimezone: true }).notNull(),
    crawlRunId: uuid('crawl_run_id'),
    ruleVersion: smallint('rule_version').notNull(),
    linksWritten: integer('links_written').notNull().default(0),
    accounts: integer('accounts').notNull().default(0),
    entities: integer('entities').notNull().default(0),
    membersChanged: integer('members_changed').notNull().default(0),
    contactsFlagged: integer('contacts_flagged').notNull().default(0),
    dailyRows: integer('daily_rows').notNull().default(0),
    durationMs: integer('duration_ms').notNull(),
    ok: boolean('ok').notNull(),
    error: text('error'),
  },
  (table) => [index('poster_steps_source_idx').on(table.sourceId, table.takenAt)],
);

export type PosterAccountRow = typeof posterAccounts.$inferSelect;
export type ContactRow = typeof contacts.$inferSelect;
export type PosterEntityRow = typeof posterEntities.$inferSelect;
export type PosterStepRow = typeof posterSteps.$inferSelect;
