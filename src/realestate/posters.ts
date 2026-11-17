import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  contacts,
  listingContacts,
  listingPhotoRefs,
  listingPosters,
  photoRefs,
  posterAccounts,
} from '../db/schema/index.js';
import type { DatabaseOrTransaction } from '../db/types.js';
import type { Contact } from './contacts.js';

/**
 * Writes what a page the crawler read says about who posted its listings
 * and which photos they show (Phases 17B and 17G, docs/PHASE_17_PLAN.md),
 * into the private schemas `realestate_contacts` and `realestate_media`.
 * Called once per results page and once per listing page, with every
 * sighting of that page in one transaction of at most six set-based
 * statements, so a night of ~10,000 results pages adds seconds, not
 * minutes. Nothing here makes a request.
 *
 * Only changes are written: an account, contact or link seen again in the
 * same hour, or an unchanged photo set, writes nothing; a link's
 * `last_seen_at` moves at most once a night per listing. The account ×
 * contact edges, the identities and the daily sizes are worked out once a
 * night (`recordPosterStep`, src/realestate/poster-identity.ts).
 */

/** What a page states about the account behind a listing; a field it does not state is null. */
export interface AccountFacts {
  userId: string;
  displayName?: string | null;
  contactName?: string | null;
  userType?: number | null;
  entityType?: string | null;
  listingCount?: number | null;
  agencyRef?: number | null;
  agencyName?: string | null;
  companyRef?: number | null;
  companyName?: string | null;
  companyType?: number | null;
  agentInfoType?: number | null;
}

export type ContactSeenIn = 'listing_page' | 'description' | 'row';

export interface ListingContactSighting extends Contact {
  /** The name shown beside it, '' for none. */
  contactName: string;
  seenIn: ContactSeenIn;
}

/** One photo as a page lists it, already canonical. */
export interface PhotoRefSighting {
  ref: string;
  /** The date in its path, `YYYY-MM-DD`, or null. */
  uploadDay: string | null;
  is360: boolean;
  imageType: number | null;
}

export interface PhotoSetSighting {
  origin: 'row' | 'listing_page';
  /** Canonical refs in the page's order. */
  refs: readonly string[];
  mainRef: string | null;
  imageCount: number | null;
  photos: readonly PhotoRefSighting[];
}

export interface PosterSighting {
  sourceListingKey: string;
  account: AccountFacts | null;
  contacts: readonly ListingContactSighting[];
  photos: PhotoSetSighting | null;
  /** When it was seen, if not the page's own time (the backfill: the listing's first and last sightings). */
  firstSeenAt?: string;
  lastSeenAt?: string;
}

export interface PosterSightingCounts {
  accountsWritten: number;
  postersWritten: number;
  contactsWritten: number;
  listingContactsWritten: number;
  photoSetsOpened: number;
  photoSetsClosed: number;
}

const NONE: PosterSightingCounts = {
  accountsWritten: 0,
  postersWritten: 0,
  contactsWritten: 0,
  listingContactsWritten: 0,
  photoSetsOpened: 0,
  photoSetsClosed: 0,
};

/** A photo set's identity: its refs in order, its cover and its count. */
export function photoSetHash(
  set: Pick<PhotoSetSighting, 'refs' | 'mainRef' | 'imageCount'>,
): string {
  return createHash('md5')
    .update(JSON.stringify([set.refs, set.mainRef, set.imageCount]))
    .digest('hex');
}

const json = (value: unknown) => sql`${JSON.stringify(value)}::jsonb`;

/**
 * Records one page's sightings at `seenAt` (the page's fetch time). One
 * transaction: all of the page or none of it. Throws on a database error;
 * the crawl catches it, logs it and carries on (`recordPageSightings` in
 * src/adapters/ss-ge/crawl.ts), and the next sighting writes it again.
 */
export async function recordPosterSightings(
  db: DatabaseOrTransaction,
  input: { sourceId: string; seenAt: string; sightings: readonly PosterSighting[] },
): Promise<PosterSightingCounts> {
  const { sourceId, seenAt } = input;
  const sightings = input.sightings.filter(
    (sighting) =>
      sighting.account !== null || sighting.contacts.length > 0 || sighting.photos !== null,
  );
  if (sightings.length === 0) return NONE;
  const from = (sighting: PosterSighting) => sighting.firstSeenAt ?? seenAt;
  const to = (sighting: PosterSighting) => sighting.lastSeenAt ?? seenAt;

  const accounts = sightings.flatMap((sighting) =>
    sighting.account === null
      ? []
      : [
          {
            key: sighting.sourceListingKey,
            user_id: sighting.account.userId,
            display_name: sighting.account.displayName ?? null,
            contact_name: sighting.account.contactName ?? null,
            user_type: sighting.account.userType ?? null,
            entity_type: sighting.account.entityType ?? null,
            listing_count: sighting.account.listingCount ?? null,
            agency_ref: sighting.account.agencyRef ?? null,
            agency_name: sighting.account.agencyName ?? null,
            company_ref: sighting.account.companyRef ?? null,
            company_name: sighting.account.companyName ?? null,
            company_type: sighting.account.companyType ?? null,
            agent_info_type: sighting.account.agentInfoType ?? null,
            first_seen_at: from(sighting),
            last_seen_at: to(sighting),
          },
        ],
  );
  const listingContactRows = sightings.flatMap((sighting) =>
    sighting.contacts.map((contact) => ({
      key: sighting.sourceListingKey,
      kind: contact.kind,
      value: contact.value,
      contact_name: contact.contactName,
      seen_in: contact.seenIn,
      first_seen_at: from(sighting),
      last_seen_at: to(sighting),
    })),
  );
  const photoSets = sightings.flatMap((sighting) =>
    sighting.photos === null
      ? []
      : [
          {
            key: sighting.sourceListingKey,
            origin: sighting.photos.origin,
            refs: sighting.photos.refs,
            main_ref: sighting.photos.mainRef,
            image_count: sighting.photos.imageCount,
            set_hash: photoSetHash(sighting.photos),
          },
        ],
  );
  const photoAttributes = new Map<string, PhotoRefSighting>();
  for (const sighting of sightings) {
    for (const photo of sighting.photos?.photos ?? []) {
      if (!photoAttributes.has(photo.ref)) photoAttributes.set(photo.ref, photo);
    }
  }

  return db.transaction(async (tx) => {
    const counts = { ...NONE };
    if (accounts.length > 0) {
      const upserted = await tx.execute(sql`
        with x as (
          select user_id, max(display_name) as display_name, max(contact_name) as contact_name,
                 max(user_type) as user_type, max(entity_type) as entity_type,
                 max(listing_count) as listing_count, max(agency_ref) as agency_ref,
                 max(agency_name) as agency_name, max(company_ref) as company_ref,
                 max(company_name) as company_name, max(company_type) as company_type,
                 max(agent_info_type) as agent_info_type,
                 min(first_seen_at) as first_seen_at, max(last_seen_at) as last_seen_at
            from jsonb_to_recordset(${json(accounts)}) as r(
                   user_id text, display_name text, contact_name text, user_type smallint,
                   entity_type text, listing_count integer, agency_ref integer, agency_name text,
                   company_ref integer, company_name text, company_type smallint,
                   agent_info_type smallint, first_seen_at timestamptz, last_seen_at timestamptz)
           group by user_id
        )
        insert into ${posterAccounts} as a
          (source_id, source_user_id, display_name, contact_name, user_type, entity_type,
           listing_count, agency_ref, agency_name, company_ref, company_name, company_type,
           agent_info_type, first_seen_at, last_seen_at)
        select ${sourceId}, user_id, display_name, contact_name, user_type, entity_type,
               listing_count, agency_ref, agency_name, company_ref, company_name, company_type,
               agent_info_type, first_seen_at, last_seen_at
          from x
        on conflict (source_id, source_user_id) do update set
          display_name = coalesce(excluded.display_name, a.display_name),
          contact_name = coalesce(excluded.contact_name, a.contact_name),
          user_type = coalesce(excluded.user_type, a.user_type),
          entity_type = coalesce(excluded.entity_type, a.entity_type),
          listing_count = coalesce(excluded.listing_count, a.listing_count),
          agency_ref = coalesce(excluded.agency_ref, a.agency_ref),
          agency_name = coalesce(excluded.agency_name, a.agency_name),
          company_ref = coalesce(excluded.company_ref, a.company_ref),
          company_name = coalesce(excluded.company_name, a.company_name),
          company_type = coalesce(excluded.company_type, a.company_type),
          agent_info_type = coalesce(excluded.agent_info_type, a.agent_info_type),
          first_seen_at = least(a.first_seen_at, excluded.first_seen_at),
          last_seen_at = greatest(a.last_seen_at, excluded.last_seen_at)
        where a.last_seen_at < excluded.last_seen_at - interval '1 hour'
           or a.first_seen_at > excluded.first_seen_at
           or (excluded.display_name is not null and excluded.display_name is distinct from a.display_name)
           or (excluded.contact_name is not null and excluded.contact_name is distinct from a.contact_name)
           or (excluded.user_type is not null and excluded.user_type is distinct from a.user_type)
           or (excluded.entity_type is not null and excluded.entity_type is distinct from a.entity_type)
           or (excluded.listing_count is not null and excluded.listing_count is distinct from a.listing_count)
           or (excluded.agency_ref is not null and excluded.agency_ref is distinct from a.agency_ref)
           or (excluded.agency_name is not null and excluded.agency_name is distinct from a.agency_name)
           or (excluded.company_ref is not null and excluded.company_ref is distinct from a.company_ref)
           or (excluded.company_name is not null and excluded.company_name is distinct from a.company_name)
           or (excluded.company_type is not null and excluded.company_type is distinct from a.company_type)
           or (excluded.agent_info_type is not null and excluded.agent_info_type is distinct from a.agent_info_type)`);
      counts.accountsWritten = upserted.rowCount ?? 0;

      const posters = await tx.execute(sql`
        insert into ${listingPosters} as lp
          (source_id, source_listing_key, account_id, first_seen_at, last_seen_at)
        select ${sourceId}, r.key, a.id, min(r.first_seen_at), max(r.last_seen_at)
          from jsonb_to_recordset(${json(accounts)}) as r(key text, user_id text, first_seen_at timestamptz, last_seen_at timestamptz)
          join ${posterAccounts} a on a.source_id = ${sourceId} and a.source_user_id = r.user_id
         group by r.key, a.id
        on conflict (source_id, source_listing_key, account_id) do update set
          first_seen_at = least(lp.first_seen_at, excluded.first_seen_at),
          last_seen_at = greatest(lp.last_seen_at, excluded.last_seen_at)
        where lp.last_seen_at < excluded.last_seen_at or lp.first_seen_at > excluded.first_seen_at`);
      counts.postersWritten = posters.rowCount ?? 0;
    }

    if (listingContactRows.length > 0) {
      const written = await tx.execute(sql`
        insert into ${contacts} as c (kind, value, first_seen_at, last_seen_at)
        select kind, value, min(first_seen_at), max(last_seen_at)
          from jsonb_to_recordset(${json(listingContactRows)}) as r(kind text, value text, first_seen_at timestamptz, last_seen_at timestamptz)
         group by kind, value
        on conflict (kind, value) do update set
          first_seen_at = least(c.first_seen_at, excluded.first_seen_at),
          last_seen_at = greatest(c.last_seen_at, excluded.last_seen_at)
        where c.last_seen_at < excluded.last_seen_at - interval '1 hour'
           or c.first_seen_at > excluded.first_seen_at`);
      counts.contactsWritten = written.rowCount ?? 0;

      const linked = await tx.execute(sql`
        insert into ${listingContacts} as lc
          (source_id, source_listing_key, contact_id, contact_name, seen_in, first_seen_at, last_seen_at)
        select ${sourceId}, r.key, c.id, r.contact_name, r.seen_in, min(r.first_seen_at), max(r.last_seen_at)
          from jsonb_to_recordset(${json(listingContactRows)}) as r(
                 key text, kind text, value text, contact_name text, seen_in text,
                 first_seen_at timestamptz, last_seen_at timestamptz)
          join ${contacts} c on c.kind = r.kind and c.value = r.value
         group by r.key, c.id, r.contact_name, r.seen_in
        on conflict (source_id, source_listing_key, contact_id, contact_name, seen_in) do update set
          first_seen_at = least(lc.first_seen_at, excluded.first_seen_at),
          last_seen_at = greatest(lc.last_seen_at, excluded.last_seen_at)
        where lc.last_seen_at < excluded.last_seen_at or lc.first_seen_at > excluded.first_seen_at`);
      counts.listingContactsWritten = linked.rowCount ?? 0;
    }

    if (photoSets.length > 0) {
      // A set that changed ends now; a sighting older than the open set changes nothing.
      const closed = await tx.execute(sql`
        update ${listingPhotoRefs} p
           set valid_to = ${seenAt}::timestamptz
          from jsonb_to_recordset(${json(photoSets)}) as r(key text, origin text, set_hash text)
         where p.source_id = ${sourceId} and p.source_listing_key = r.key and p.origin = r.origin
           and p.valid_to is null and p.set_hash <> r.set_hash
           and p.valid_from <= ${seenAt}::timestamptz`);
      counts.photoSetsClosed = closed.rowCount ?? 0;

      // Every set with no open row opens one; its photos not seen before are recorded.
      const photos = [...photoAttributes.values()].map((photo) => ({
        ref: photo.ref,
        upload_day: photo.uploadDay,
        is_360: photo.is360,
        image_type: photo.imageType,
      }));
      const opened = await tx.execute(sql`
        with r as (
          select distinct on (key, origin) *
            from jsonb_to_recordset(${json(photoSets)}) as r(
                   key text, origin text, refs text[], main_ref text, image_count smallint, set_hash text)
           order by key, origin
        ), opened as (
          insert into ${listingPhotoRefs}
            (source_id, source_listing_key, origin, valid_from, refs, main_ref, image_count, set_hash)
          select ${sourceId}, r.key, r.origin, ${seenAt}::timestamptz, r.refs, r.main_ref, r.image_count, r.set_hash
            from r
           where not exists (
             select 1 from ${listingPhotoRefs} p
              where p.source_id = ${sourceId} and p.source_listing_key = r.key
                and p.origin = r.origin and p.valid_to is null)
          returning source_listing_key, refs
        ), used as (
          select distinct on (ref) ref, opened.source_listing_key
            from opened cross join unnest(opened.refs) as ref
           order by ref, opened.source_listing_key
        ), noted as (
          insert into ${photoRefs}
            (source_id, ref, first_seen_at, first_listing_key, upload_day, is_360, image_type)
          select ${sourceId}, used.ref, ${seenAt}::timestamptz, used.source_listing_key,
                 p.upload_day, p.is_360, p.image_type
            from used
            left join jsonb_to_recordset(${json(photos)}) as p(
                        ref text, upload_day date, is_360 boolean, image_type smallint)
                   on p.ref = used.ref
          on conflict (source_id, ref) do nothing
        )
        select count(*)::int as opened from opened`);
      counts.photoSetsOpened = (opened.rows[0] as { opened: number } | undefined)?.opened ?? 0;
    }
    return counts;
  });
}
