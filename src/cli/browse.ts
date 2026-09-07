import { parseArgs } from 'node:util';
import {
  countListings,
  countOpportunities,
  countReviewQueue,
  getSourceHealth,
  listReviewQueue,
  searchListings,
  searchOpportunities,
} from '../browse/queries.js';
import { db } from '../db/client.js';

/**
 * Read-only corpus inspection — Phase 3's exit gate ("the stored corpus can be
 * inspected ... without direct database access") for the inspect half.
 *
 * Prints human-readable text by default and JSON with `--json`, so the same
 * command serves an operator reading a terminal and a later UI or script
 * consuming structured output.
 */

function truncate(value: string, width: number): string {
  return value.length <= width ? value : `${value.slice(0, width - 1)}…`;
}

function formatListing(listing: {
  sourceSlug: string;
  status: string;
  title: string;
  organization: string | null;
  deadlineAt: string | null;
}): string {
  const deadline = listing.deadlineAt === null ? 'no deadline' : listing.deadlineAt.slice(0, 10);
  return `  [${listing.sourceSlug.padEnd(7)}] ${truncate(listing.title, 52).padEnd(52)} ${truncate(
    listing.organization ?? '—',
    24,
  ).padEnd(24)} ${listing.status.padEnd(17)} ${deadline}`;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      text: { type: 'string' },
      source: { type: 'string' },
      status: { type: 'string', multiple: true },
      'deadline-from': { type: 'string' },
      'deadline-to': { type: 'string' },
      'first-seen-from': { type: 'string' },
      'cross-posted': { type: 'boolean', default: false },
      sort: { type: 'string' },
      offset: { type: 'string' },
      limit: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  const command = positionals[0] ?? 'listings';
  const limit = values.limit === undefined ? undefined : Number(values.limit);
  const offset = values.offset === undefined ? undefined : Number(values.offset);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error('--limit must be a positive integer');
  }

  const emit = (label: string, data: unknown, render: () => void): void => {
    if (values.json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    console.log(label);
    render();
  };

  switch (command) {
    case 'listings': {
      const listingFilters = {
        text: values.text,
        sourceSlug: values.source,
        statuses: values.status,
        deadlineFrom: values['deadline-from'],
        deadlineTo: values['deadline-to'],
        firstSeenFrom: values['first-seen-from'],
      };
      const rows = await searchListings(db, { ...listingFilters, limit, offset });
      // The total, not just this page's length — otherwise a default limit of
      // 50 silently reads as "50 listings" on a 410-listing corpus.
      const total = await countListings(db, listingFilters);
      emit(`${rows.length} of ${total} listing(s)`, rows, () => {
        for (const row of rows) console.log(formatListing(row));
      });
      break;
    }

    case 'opportunities': {
      const sort = values.sort;
      if (sort !== undefined && !['recent', 'deadline', 'title'].includes(sort)) {
        console.error(`Unknown --sort ${sort}. Expected recent, deadline or title.`);
        process.exitCode = 1;
        return;
      }
      const opportunityFilters = {
        text: values.text,
        statuses: values.status,
        sourceSlug: values.source,
        crossPostedOnly: values['cross-posted'] === true ? true : undefined,
        deadlineFrom: values['deadline-from'],
        deadlineTo: values['deadline-to'],
        firstSeenFrom: values['first-seen-from'],
      };
      const rows = await searchOpportunities(db, {
        ...opportunityFilters,
        sort: sort as 'recent' | 'deadline' | 'title' | undefined,
        limit,
        offset,
      });
      const total = await countOpportunities(db, opportunityFilters);
      emit(`${rows.length} of ${total} canonical opportunit(ies)`, rows, () => {
        for (const row of rows) {
          console.log(`\n${row.canonicalTitle}  (${row.members.length} source listing(s))`);
          for (const member of row.members) console.log(formatListing(member));
        }
      });
      break;
    }

    case 'review': {
      const rows = await listReviewQueue(db, { limit, offset });
      const total = await countReviewQueue(db);
      emit(`${rows.length} of ${total} pair(s) awaiting review`, rows, () => {
        for (const row of rows) {
          console.log(
            `\ncandidate ${row.candidateId}  similarity ${row.similarityScore.toFixed(3)}`,
          );
          console.log(formatListing(row.a));
          console.log(formatListing(row.b));
        }
      });
      break;
    }

    case 'health': {
      const rows = await getSourceHealth(db);
      emit('source health', rows, () => {
        for (const row of rows) {
          const statuses = Object.entries(row.listingsByStatus)
            .map(([status, count]) => `${status}=${count}`)
            .join(' ');
          console.log(`\n${row.sourceSlug}`);
          console.log(`  listings           ${statuses || '(none)'}`);
          console.log(`  last run           ${row.lastRunAt ?? '—'} (${row.lastRunStatus ?? '—'})`);
          // Called out separately because a source polled hourly by bounded
          // runs can still be weeks without full coverage, and in that state
          // absence reconciliation is silently not happening (§10.2).
          console.log(`  last FULL coverage ${row.lastFullCoverageRunAt ?? 'never'}`);
          console.log(`  open incidents     ${row.unresolvedIncidents}`);
        }
      });
      break;
    }

    default:
      throw new Error(
        `unknown command "${command}" — expected one of: listings, opportunities, review, health`,
      );
  }
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$client.end();
  });
