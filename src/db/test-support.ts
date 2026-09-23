import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { db } from './client.js';
import {
  auditEvents,
  type CrawlRunRow,
  crawlCursors,
  crawlRuns,
  duplicateCandidates,
  fetchAttempts,
  listingClassifications,
  type NewCrawlRunRow,
  type NewSourceListingRow,
  opportunities,
  opportunityDecisions,
  opportunityRevisions,
  opportunitySourceMemberships,
  organizationAliases,
  outreachApprovals,
  outreachDrafts,
  parserIncidents,
  rankings,
  resources,
  type SourceListingRow,
  sourceListingRevisions,
  sourceListings,
  sourcePolicies,
  sources,
  sourceTaxonomyMappings,
  taxonomyTerms,
} from './schema/index.js';

/**
 * Every slug shape a test can leave in `sources`, in one place.
 *
 * `createTestSource` makes the first. The adapter tests make the others: they
 * mock `hrGeSource`/`jobsGeSource` with a random id AND a random slug, because
 * `sources.slug` is UNIQUE and reusing the real slug made `ensureSourceSeeded`
 * insert nothing, which broke 20 hr-ge tests against any database that had
 * actually crawled (2026-09-06). Those mocked rows are inserted by the adapters'
 * own seeding code, so they are real rows in every sense except that nothing
 * crawled them.
 *
 * The orphan sweep in `real-data-guard.ts` reads this list. It covered only
 * `test-source-` at first, which left `crawl-test-*`, `isolation-test-*` and
 * `reliability-*` sources from interrupted adapter runs sitting in the corpus
 * and visible in the product — the same recurrence it was written to stop
 * (commit gate, 2026-09-14). **A new test slug shape must be added here**, and
 * an allow-list is used rather than "anything that is not jobs-ge or hr-ge"
 * on purpose: the latter would sweep a genuinely new board the first time one
 * is added.
 */
export const DISPOSABLE_SOURCE_SLUG_PREFIXES = [
  'test-source-',
  'crawl-test-',
  'isolation-test-',
  'reliability-',
] as const;

/** Whether a `sources.slug` was made by a test rather than by a real board. */
export function isDisposableSourceSlug(slug: string): boolean {
  return DISPOSABLE_SOURCE_SLUG_PREFIXES.some((prefix) => slug.startsWith(prefix));
}

/** A throwaway `sources` row for one test, with a random slug so parallel test runs never collide. */
export async function createTestSource(): Promise<string> {
  const id = randomUUID();
  await db.insert(sources).values({
    id,
    slug: `test-source-${id}`,
    displayName: 'Test source',
    baseUrl: 'https://example.invalid/',
  });
  return id;
}

/** A throwaway `resources` row (e.g. to satisfy a revision's provenanceResourceId FK). */
export async function createTestResource(sourceId: string): Promise<string> {
  const id = randomUUID();
  await db.insert(resources).values({
    id,
    sourceId,
    role: 'OPPORTUNITY',
    originalUrl: `/listing/${id}`,
    canonicalUrl: `https://example.invalid/listing/${id}`,
    finalUrl: null,
    status: 'fetched',
    fetchedAt: new Date().toISOString(),
    contentHash: 'c'.repeat(64),
    byteSize: 1024,
    mimeType: 'text/html',
  });
  return id;
}

/**
 * A throwaway `source_listings` row for one test, inserted directly (not via
 * writeSourceListingRevision) so reconciliation tests can set up a listing's
 * status/lastSeenAt/missingStreak/sourceDeadlineAt exactly, without coupling
 * to that function's own behavior.
 */
export async function createTestSourceListing(
  sourceId: string,
  overrides: Partial<NewSourceListingRow> = {},
): Promise<SourceListingRow> {
  const id = randomUUID();
  const [row] = await db
    .insert(sourceListings)
    .values({
      id,
      sourceId,
      sourceRecordId: id,
      canonicalSourceUrl: `https://example.invalid/listing/${id}`,
      currentRevisionId: null,
      firstSeenAt: '2026-01-01T00:00:00Z',
      lastSeenAt: '2026-01-01T00:00:00Z',
      status: 'active',
      missingStreak: 0,
      sourcePublishedAt: null,
      sourceDeadlineAt: null,
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('createTestSourceListing: insert returned no row');
  return row;
}

/**
 * A throwaway `crawl_runs` row for one test, inserted directly so
 * reconciliation tests can set up a run's status/fullCoverage/startedAt
 * exactly, without running an actual crawl.
 */
export async function createTestCrawlRun(
  sourceId: string,
  overrides: Partial<NewCrawlRunRow> = {},
): Promise<CrawlRunRow> {
  const id = randomUUID();
  const [row] = await db
    .insert(crawlRuns)
    .values({
      id,
      sourceId,
      startedAt: '2026-01-05T00:00:00Z',
      finishedAt: '2026-01-05T01:00:00Z',
      // Settled by default (not the DB's own null default) — the partial
      // unique index allows only one row per source with reconciledAt
      // still null, so a test creating several runs for the same source
      // (e.g. to compare across them) would collide on the second insert
      // otherwise.
      reconciledAt: '2026-01-05T01:00:00Z',
      status: 'completed',
      fullCoverage: true,
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('createTestCrawlRun: insert returned no row');
  return row;
}

/**
 * Deletes everything this test may have written under one source, in FK
 * dependency order — no ON DELETE CASCADE is declared on any of these
 * tables (deliberately: see src/db/schema/source-listings.ts), so cleanup
 * has to unwind the same references the write path builds up.
 *
 * `taxonomyTermIds` is EXPLICIT ownership, not inferred: `taxonomy_terms`
 * carries no FK to `sources` (the domain contract keeps it
 * source-independent, `src/domain/taxonomy.ts`), so nothing about a term
 * itself proves a given test created it. A first version of this function
 * inferred ownership from "this source's mapping was the last one pointing
 * at it" — real-sounding, but wrong: a term with zero CURRENT references is
 * not the same claim as "this test created it", and treating them as
 * equivalent could delete a term this test never touched (commit gate,
 * 2026-09-15). The caller passes the exact ids it created (this suite's
 * tests already track them via `sourceTaxonomyMappings.sourceId` before
 * calling this); this function only ever deletes one of those NAMED ids,
 * and even then only if nothing else still depends on it — a mapping, a
 * classification, or another live term's `parentId` (the self-referencing
 * FK a term-only reference check missed, which would otherwise abort the
 * whole cleanup transaction rather than merely leave debris).
 */
export async function cleanupTestSource(
  sourceId: string,
  options: { taxonomyTermIds?: readonly string[] } = {},
): Promise<void> {
  // ONE transaction for the whole unwind.
  //
  // It was a sequence of autocommitted statements, and that failure mode is
  // unrecoverable rather than untidy: the membership deletes are what identify
  // which clusters belonged to this source, so a crash or an FK error after
  // them leaves an opportunity nothing can still attribute to a test listing.
  // A test-derived title, revision or ranking would then survive every future
  // sweep, permanently (commit gate, 2026-09-14).
  const entangled = await db.transaction(async (tx) => {
    const listingRows = await tx
      .select({ id: sourceListings.id })
      .from(sourceListings)
      .where(eq(sourceListings.sourceId, sourceId));
    const listingIds = listingRows.map((row) => row.id);

    const runRows = await tx
      .select({ id: crawlRuns.id })
      .from(crawlRuns)
      .where(eq(crawlRuns.sourceId, sourceId));
    const runIds = runRows.map((row) => row.id);

    const entangledIds: string[] = [];

    // parser_incidents references both sources and crawl_runs — must go
    // before either is deleted below, regardless of whether this source ever
    // had any runs (its own FK to sources.id is independent of crawlRunId).
    await tx.delete(parserIncidents).where(eq(parserIncidents.sourceId, sourceId));

    if (runIds.length > 0) {
      await tx.delete(fetchAttempts).where(inArray(fetchAttempts.crawlRunId, runIds));
    }

    if (listingIds.length > 0) {
      // Everything that FKs into source_listings, before the listings go.
      //
      // These three were missing, and the gap was not theoretical: the orphan
      // sweep in `real-data-guard.ts` calls this helper, and on a source whose
      // listings had reached dedupe the delete below raised
      // `duplicate_candidates_source_listing_id_a_source_listings_id_fk` and
      // aborted the entire test run — "No test files found, exiting with code 1"
      // — after the revision deletes had already committed. That is the exact
      // debris the sweep exists to remove, so the sweep failed on precisely the
      // case it was written for (commit gate, 2026-09-14).
      //
      // None of the three cascade: every FK into source_listings is NO ACTION,
      // checked against the live schema rather than assumed.
      //
      // Outreach drafts (Phase 6A) FK into source_listings, their revisions and
      // opportunities, so they go first, with their approvals and — since these
      // are test drafts — their audit events, which carry no FK and would
      // otherwise outlive the run as debris.
      const draftIds = (
        await tx
          .select({ id: outreachDrafts.id })
          .from(outreachDrafts)
          .where(inArray(outreachDrafts.sourceListingId, listingIds))
      ).map((row) => row.id);
      if (draftIds.length > 0) {
        await tx.delete(outreachApprovals).where(inArray(outreachApprovals.draftId, draftIds));
        await tx.delete(auditEvents).where(inArray(auditEvents.entityId, draftIds));
        await tx.delete(outreachDrafts).where(inArray(outreachDrafts.id, draftIds));
      }

      await tx
        .delete(duplicateCandidates)
        .where(
          or(
            inArray(duplicateCandidates.sourceListingIdA, listingIds),
            inArray(duplicateCandidates.sourceListingIdB, listingIds),
          ),
        );

      // Which canonical clusters these listings sit in, and whether any of them
      // also holds a listing from somewhere else.
      //
      // A run interrupted after `runDedupe(..., { autoLink: true })` leaves
      // opportunities and opportunity_revisions behind, and deleting the
      // memberships alone orphans rather than removes them. That is not inert:
      // `runRanking` enumerates `opportunities` with **no join requiring a live
      // member**, so an orphan keeps its test `canonicalTitle` and can be scored
      // and shown as a real result — the fabricated-data failure `AGENTS.md`
      // classes P1.
      //
      // Classified over EVERY membership, live and RETIRED. Counting only live
      // ones would call a cluster "test-only" when its real membership merely
      // happens to be superseded, and then try to delete an opportunity that the
      // retired real membership still references — destroying genuine history
      // and violating its own FK on the way.
      const touched = await tx
        .select({
          opportunityId: opportunitySourceMemberships.opportunityId,
          sourceListingId: opportunitySourceMemberships.sourceListingId,
          sourceSlug: sources.slug,
        })
        .from(opportunitySourceMemberships)
        .innerJoin(
          sourceListings,
          eq(sourceListings.id, opportunitySourceMemberships.sourceListingId),
        )
        .innerJoin(sources, eq(sources.id, sourceListings.sourceId))
        .where(
          inArray(
            opportunitySourceMemberships.opportunityId,
            tx
              .select({ id: opportunitySourceMemberships.opportunityId })
              .from(opportunitySourceMemberships)
              .where(inArray(opportunitySourceMemberships.sourceListingId, listingIds)),
          ),
        );

      // Membership counted by what the other listing's SOURCE is, not by
      // whether it happens to be in this call's listing set. Two disposable
      // sources can share a cluster — a dedupe test linking two of its own
      // fixtures does exactly that — and counting by listing id reported the
      // second one as real-data contamination, producing a false alarm and
      // routing an ordinary test-to-test cluster through the repair path.
      const testListingIds = new Set(listingIds);
      const realMembers = new Map<string, number>();
      const otherTestMembers = new Map<string, number>();
      for (const row of touched) {
        if (testListingIds.has(row.sourceListingId)) continue;
        const bucket = isDisposableSourceSlug(row.sourceSlug) ? otherTestMembers : realMembers;
        bucket.set(row.opportunityId, (bucket.get(row.opportunityId) ?? 0) + 1);
      }

      const touchedIds = [...new Set(touched.map((row) => row.opportunityId))];
      // Entangled means a REAL listing is in the cluster — the only case that
      // needs repairing and reporting.
      entangledIds.push(...touchedIds.filter((id) => (realMembers.get(id) ?? 0) > 0));
      // Deletable means nothing else is left once this source's memberships go.
      // A cluster still held by ANOTHER disposable source is left alone rather
      // than deleted: its memberships would fail the FK, and that source's own
      // cleanup will take it.
      const testOnly = touchedIds.filter(
        (id) => (realMembers.get(id) ?? 0) === 0 && (otherTestMembers.get(id) ?? 0) === 0,
      );

      await tx
        .delete(opportunitySourceMemberships)
        .where(inArray(opportunitySourceMemberships.sourceListingId, listingIds));
      if (testOnly.length > 0) {
        // `rankings` and `opportunity_decisions` both reference opportunities
        // (and rankings also references the canonical revision), all NO ACTION
        // — checked against the live schema. A stranded cluster that had been
        // ranked or shortlisted would otherwise fail the delete below and
        // abort the sweep mid-way, which is the same defect this helper was
        // just fixed for one table down.
        await tx.delete(rankings).where(inArray(rankings.opportunityId, testOnly));
        await tx
          .delete(opportunityDecisions)
          .where(inArray(opportunityDecisions.opportunityId, testOnly));

        // The ownership FK forbids deleting a revision the opportunity still
        // points at, exactly as with listings and their revisions.
        await tx
          .update(opportunities)
          .set({ currentCanonicalRevisionId: null })
          .where(inArray(opportunities.id, testOnly));
        await tx
          .delete(opportunityRevisions)
          .where(inArray(opportunityRevisions.opportunityId, testOnly));
        await tx.delete(opportunities).where(inArray(opportunities.id, testOnly));
      }

      // An entangled cluster — one holding these listings AND a real one — is
      // NOT deleted: a real listing's membership, live or retired, is genuine
      // history that §12.5 keeps. But its canonical title and resolved fields
      // may have been computed FROM the test revision, so leaving them as they
      // are strands fabricated content on a real opportunity, where browsing
      // and ranking cannot tell it from real source data.
      //
      // Re-resolved through the project's own path rather than a bespoke
      // rewrite. Where live members remain this recomputes the canonical
      // revision from them; the test-derived revision becomes history, and
      // `listRankedOpportunities` already refuses rankings pinned to a
      // superseded revision, so the old content cannot resurface there.
      //
      // Deliberately NOT deleted: the historical revisions, or the rankings
      // pinned to them. §17.2 forbids destroying prior assessments, and a test
      // janitor silently rewriting a real opportunity's canonical history is a
      // worse failure than the one it would be repairing. The caller is told
      // instead — see the report after the transaction.
      if (entangledIds.length > 0) {
        const { resolveCanonicalOpportunity } = await import('../dedupe/resolve-canonical.js');
        const now = new Date().toISOString();
        for (const id of entangledIds) {
          await resolveCanonicalOpportunity(tx, id, now);
        }

        // The case re-resolution cannot repair: an entangled cluster whose
        // real memberships are ALL retired is left with zero live members once
        // the test membership goes, so there is nothing to recompute a
        // canonical revision from and the test-derived title stays current.
        // The reasoning that covers the other entangled clusters — that a
        // superseded revision stops `listRankedOpportunities` returning the
        // old ranking — does not apply here, because nothing superseded it.
        //
        // The opportunity row itself cannot be deleted: the retired real
        // memberships reference it, and §12.5 keeps them. So the derived rows
        // that would SURFACE the fabricated title are removed instead — a
        // ranking and a shortlist entry are recomputable and re-decidable,
        // whereas membership history is not. §17.2 protects assessments of
        // real content from being overwritten by a model change; it is not a
        // reason to keep publishing a score for a title that came from a test
        // fixture.
        const stillLive = await tx
          .select({ id: opportunitySourceMemberships.opportunityId })
          .from(opportunitySourceMemberships)
          .where(
            and(
              inArray(opportunitySourceMemberships.opportunityId, entangledIds),
              isNull(opportunitySourceMemberships.supersededAt),
            ),
          );
        const live = new Set(stillLive.map((row) => row.id));
        const emptied = entangledIds.filter((id) => !live.has(id));
        if (emptied.length > 0) {
          await tx.delete(rankings).where(inArray(rankings.opportunityId, emptied));
          await tx
            .delete(opportunityDecisions)
            .where(inArray(opportunityDecisions.opportunityId, emptied));
        }
      }
      await tx
        .delete(organizationAliases)
        .where(inArray(organizationAliases.sourceListingId, listingIds));

      // listing_classifications FKs into source_listing_revisions (Phase
      // 3C-2, migration 0020), NO ACTION like every other FK this helper
      // already unwinds by hand — a classification test that leaves a row
      // behind would abort the revision delete below with exactly the
      // failure class every comment in this function already documents for
      // the other tables.
      const revisionRows = await tx
        .select({ id: sourceListingRevisions.id })
        .from(sourceListingRevisions)
        .where(inArray(sourceListingRevisions.sourceListingId, listingIds));
      const revisionIds = revisionRows.map((row) => row.id);
      if (revisionIds.length > 0) {
        await tx
          .delete(listingClassifications)
          .where(inArray(listingClassifications.sourceListingRevisionId, revisionIds));
      }

      // Null out currentRevisionId first — the ownership FK forbids deleting
      // a revision a listing still points at.
      await tx
        .update(sourceListings)
        .set({ currentRevisionId: null })
        .where(inArray(sourceListings.id, listingIds));
      await tx
        .delete(sourceListingRevisions)
        .where(inArray(sourceListingRevisions.sourceListingId, listingIds));
    }

    await tx.delete(crawlRuns).where(eq(crawlRuns.sourceId, sourceId));
    await tx.delete(sourceListings).where(eq(sourceListings.sourceId, sourceId));
    await tx.delete(resources).where(eq(resources.sourceId, sourceId));
    // Only ever populated for a fixed, real source id (e.g. jobsGeSource.id in
    // crawl.test.ts) — a throwaway createTestSource() id never has one, so
    // this delete is a routine no-op for every other test using this helper.
    await tx.delete(sourcePolicies).where(eq(sourcePolicies.sourceId, sourceId));
    // crawl_cursors.source_id FKs into sources.id — only ever populated for
    // an adapter that uses cursor-based resumption (hr.ge), a no-op delete
    // for every other test using this helper.
    await tx.delete(crawlCursors).where(eq(crawlCursors.sourceId, sourceId));
    // source_taxonomy_mappings.source_id FKs into sources.id too (Phase
    // 3C-2, migration 0020), NO ACTION — a no-op delete for every test that
    // never seeds taxonomy data, but without it a taxonomy test's disposable
    // source would abort the sources delete below on the same FK-violation
    // class this function already unwinds by hand for every other table.
    await tx.delete(sourceTaxonomyMappings).where(eq(sourceTaxonomyMappings.sourceId, sourceId));

    // Only ever deletes a term the CALLER named — see this function's own
    // doc comment for why inferring ownership from "nothing currently
    // references it" was rejected. Even a named term is refused if
    // something still needs it: another mapping, a classification, or
    // (missed by an earlier version of this check, commit gate 2026-09-15)
    // another live term's parentId — deleting a parent out from under a
    // still-referenced child would violate taxonomy_terms' own
    // self-referencing FK and abort this entire transaction, turning a
    // debris-avoidance feature into a cleanup-breaking one.
    //
    // Iterative, not one pass: the ordinary caller here is a source that
    // seeded a whole tree and names EVERY node it created in one array —
    // exactly `seedTaxonomyTerms`'s own shape, parent and child both. A
    // single pass checking parentId against that same candidate set finds
    // the child's row still present (nothing has deleted it yet within
    // that pass) and protects the parent every time, leaking it forever —
    // a real bug this caught on real test runs, not a hypothetical
    // (confirmed via `docker exec psql`: seven leaked top-level terms, each
    // missing exactly the child that should have unblocked it). Looping
    // deletes leaves first, then re-checks what's left with the leaves
    // actually gone, the same way a real topological deletion would.
    if (options.taxonomyTermIds !== undefined && options.taxonomyTermIds.length > 0) {
      let remainingIds = [...new Set(options.taxonomyTermIds)];
      while (remainingIds.length > 0) {
        const stillMapped = await tx
          .select({ taxonomyTermId: sourceTaxonomyMappings.taxonomyTermId })
          .from(sourceTaxonomyMappings)
          .where(inArray(sourceTaxonomyMappings.taxonomyTermId, remainingIds));
        const stillClassified = await tx
          .select({ taxonomyTermId: listingClassifications.taxonomyTermId })
          .from(listingClassifications)
          .where(inArray(listingClassifications.taxonomyTermId, remainingIds));
        const stillParent = await tx
          .select({ parentId: taxonomyTerms.parentId })
          .from(taxonomyTerms)
          .where(inArray(taxonomyTerms.parentId, remainingIds));
        const stillReferenced = new Set([
          ...stillMapped.map((row) => row.taxonomyTermId),
          ...stillClassified.map((row) => row.taxonomyTermId),
          ...stillParent.map((row) => row.parentId),
        ]);
        const safeToDeleteIds = remainingIds.filter((id) => !stillReferenced.has(id));
        // No progress possible this pass — whatever remains is genuinely
        // still needed by something outside this candidate set (or forms a
        // cycle, which the schema doesn't allow a self-referencing FK to
        // produce in practice). Stop rather than loop forever.
        if (safeToDeleteIds.length === 0) break;
        await tx.delete(taxonomyTerms).where(inArray(taxonomyTerms.id, safeToDeleteIds));
        const deleted = new Set(safeToDeleteIds);
        remainingIds = remainingIds.filter((id) => !deleted.has(id));
      }
    }

    await tx.delete(sources).where(eq(sources.id, sourceId));

    return entangledIds;
  });

  // Reported loudly rather than swallowed. A cluster holding both a test
  // listing and a real one means test data reached real canonical state — the
  // 2026-09-06 incident, recurring — and the re-resolve above repairs the
  // CURRENT revision without undoing the history that already recorded it.
  //
  // A warning rather than a throw, deliberately: this helper runs in every
  // test's afterEach and inside the orphan sweep, so throwing would wedge every
  // run on pre-existing debris instead of letting each run clean what it can.
  // The hard failure for real-data contamination is the guard's fingerprint,
  // which covers any change to a real source's rows independently of this path.
  if (entangled.length > 0) {
    console.error(
      `cleanupTestSource: ${entangled.length} cluster(s) held BOTH a test listing and a real one, ` +
        'so test data had reached real canonical state. Their current revision was recomputed from ' +
        'the remaining members; earlier revisions still record the test listing and are kept, since ' +
        `§12.5 and §17.2 forbid destroying them. Inspect: ${entangled.join(', ')}`,
    );
  }
}

/**
 * Everything the database records about one source, ordered deterministically
 * so two snapshots can be compared directly with `toEqual`.
 *
 * This is the concrete form of Phase 1C's "a failing source cannot affect the
 * other source's state": the claim is only as strong as the set of tables it
 * covers, so this deliberately captures every table that carries per-source
 * state rather than only the listing rows a reader might first think of.
 * `fetch_attempts` is keyed by crawl run rather than by source, so it is
 * gathered through this source's runs; `source_listing_revisions` likewise
 * through its listings.
 *
 * Not included: `sources` and `source_policies`. Both are seeded configuration
 * rather than crawl-produced state, and a crawl for another source has no code
 * path that writes them — except the seeding collision that broke 20 hr-ge
 * tests on 2026-09-06 (docs/STATUS.md), which is a test-isolation concern
 * covered where the adapters mock their own policy modules.
 */
export interface SourceStateSnapshot {
  listings: SourceListingRow[];
  revisions: Array<typeof sourceListingRevisions.$inferSelect>;
  runs: CrawlRunRow[];
  cursors: Array<typeof crawlCursors.$inferSelect>;
  resources: Array<typeof resources.$inferSelect>;
  incidents: Array<typeof parserIncidents.$inferSelect>;
  fetchAttempts: Array<typeof fetchAttempts.$inferSelect>;
}

export async function snapshotSourceState(sourceId: string): Promise<SourceStateSnapshot> {
  const listings = await db
    .select()
    .from(sourceListings)
    .where(eq(sourceListings.sourceId, sourceId))
    .orderBy(sourceListings.id);
  const listingIds = listings.map((row) => row.id);

  const runs = await db
    .select()
    .from(crawlRuns)
    .where(eq(crawlRuns.sourceId, sourceId))
    .orderBy(crawlRuns.id);
  const runIds = runs.map((row) => row.id);

  return {
    listings,
    revisions:
      listingIds.length === 0
        ? []
        : await db
            .select()
            .from(sourceListingRevisions)
            .where(inArray(sourceListingRevisions.sourceListingId, listingIds))
            .orderBy(sourceListingRevisions.id),
    runs,
    cursors: await db
      .select()
      .from(crawlCursors)
      .where(eq(crawlCursors.sourceId, sourceId))
      .orderBy(crawlCursors.sourceId),
    resources: await db
      .select()
      .from(resources)
      .where(eq(resources.sourceId, sourceId))
      .orderBy(resources.id),
    incidents: await db
      .select()
      .from(parserIncidents)
      .where(eq(parserIncidents.sourceId, sourceId))
      .orderBy(parserIncidents.id),
    fetchAttempts:
      runIds.length === 0
        ? []
        : await db
            .select()
            .from(fetchAttempts)
            .where(inArray(fetchAttempts.crawlRunId, runIds))
            .orderBy(fetchAttempts.id),
  };
}
