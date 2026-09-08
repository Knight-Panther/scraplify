import type {
  dedupeDecidedByEnum,
  dedupeDecisionEnum,
  opportunityTypeEnum,
} from '../../src/db/schema/opportunities.js';
import type { crawlRunStatusEnum } from '../../src/db/schema/runs.js';
import type {
  extractionMethodEnum,
  sourceListingStatusEnum,
} from '../../src/db/schema/source-listings.js';

/**
 * The single place a database enum becomes something a person reads.
 *
 * `anti-patterns.md` forbids rendering raw enums — `missing_suspected` is a
 * database state, not a label. Every map here is keyed by the Drizzle enum's own
 * union type, so adding a value to the schema without giving it a label is a
 * typecheck failure rather than a string that leaks to screen.
 *
 * `explanation` is not decoration. Several of these states mean something
 * non-obvious and consequential — "missing" is a *suspicion* produced by one
 * crawl not seeing a listing, not a fact about the vacancy — and
 * `data-density.md` requires that meaning to be reachable rather than implied.
 */

export interface Label {
  /** What appears in the interface. Sentence case; never uppercased. */
  short: string;
  /** The honest meaning, for a title attribute or a detail panel. */
  explanation: string;
}

type SourceListingStatus = (typeof sourceListingStatusEnum.enumValues)[number];
type CrawlRunStatus = (typeof crawlRunStatusEnum.enumValues)[number];

/**
 * §13 lifecycle states.
 *
 * The wording is deliberately cautious where the underlying fact is: a listing
 * is `missing_suspected` because it was not seen on the last full crawl, which
 * can equally mean the source changed its markup. Presenting that as "gone"
 * would assert something the system does not know.
 */
export const listingStatusLabels: Record<SourceListingStatus, Label> = {
  discovered: {
    short: 'not yet fetched',
    explanation: 'Found in a listing index, but its detail page has not been fetched yet.',
  },
  active: {
    short: 'open',
    explanation: 'Seen on this source’s most recent crawl.',
  },
  missing_suspected: {
    short: 'may be gone',
    explanation:
      'Not seen on the last crawl. That is a suspicion, not a fact — the source may simply have changed how it lists jobs. It is closed only after several consecutive misses.',
  },
  closed: {
    short: 'closed',
    explanation: 'Missing from several consecutive full crawls, so treated as taken down.',
  },
  expired: {
    short: 'past deadline',
    explanation: 'The source stated an application deadline and it has passed.',
  },
  quarantined: {
    short: 'held back',
    explanation:
      'Something about this listing failed to parse cleanly, so it is withheld rather than shown as if it were understood.',
  },
};

/** Crawl outcomes, as shown on the source-health screen. */
export const crawlRunStatusLabels: Record<CrawlRunStatus, Label> = {
  running: { short: 'running', explanation: 'A crawl is in progress.' },
  completed: {
    short: 'completed',
    explanation: 'The crawl finished and covered what it set out to.',
  },
  failed: { short: 'failed', explanation: 'The crawl stopped early with an error.' },
  partial: {
    short: 'partial',
    explanation:
      'The crawl finished but did not cover everything it intended, so it cannot be used to close missing listings.',
  },
  quarantined: {
    short: 'held back',
    explanation: 'The crawl looked anomalous enough that its results were not trusted.',
  },
};

type OpportunityType = (typeof opportunityTypeEnum.enumValues)[number];

/**
 * §12.3 opportunity types.
 *
 * Every one of the 406 canonical opportunities is currently a `job`, and the
 * screens deliberately do NOT print that label 406 times — a column whose every
 * cell reads the same word is noise in a scanning tool. The map exists because
 * the other four types are real schema values that will appear the moment a
 * source carrying scholarships or grants is added, and an unlabelled enum
 * reaching the screen then is exactly the failure this file exists to prevent.
 */
export const opportunityTypeLabels: Record<OpportunityType, Label> = {
  job: { short: 'job', explanation: 'A paid vacancy.' },
  summer_school: {
    short: 'summer school',
    explanation: 'A fixed-term educational programme rather than employment.',
  },
  scholarship: {
    short: 'scholarship',
    explanation: 'Funding for study, awarded to a person rather than a project.',
  },
  grant: { short: 'grant', explanation: 'Funding awarded for a project or activity.' },
  event: { short: 'event', explanation: 'A one-off event, such as a conference or competition.' },
};

export function opportunityTypeLabel(type: string): Label {
  return (
    opportunityTypeLabels[type as OpportunityType] ?? {
      short: 'unrecognised kind',
      explanation: `This build has no label for the opportunity kind "${type}".`,
    }
  );
}

/** Human-facing source names. Slugs are internal identifiers. */
export const sourceLabels: Record<string, string> = {
  'jobs-ge': 'jobs.ge',
  'hr-ge': 'hr.ge',
};

export function sourceLabel(slug: string): string {
  return sourceLabels[slug] ?? slug;
}

/**
 * Looks up a status label, tolerating a value the map does not know.
 *
 * A database that has gained an enum value this build predates should degrade to
 * showing something honest rather than crashing the page — but it must not
 * silently print the raw enum either, so the fallback is explicitly marked.
 */
export function listingStatusLabel(status: string): Label {
  return (
    listingStatusLabels[status as SourceListingStatus] ?? {
      short: 'unrecognised state',
      explanation: `This build has no label for the state "${status}".`,
    }
  );
}

export function crawlRunStatusLabel(status: string): Label {
  return (
    crawlRunStatusLabels[status as CrawlRunStatus] ?? {
      short: 'unrecognised state',
      explanation: `This build has no label for the crawl state "${status}".`,
    }
  );
}

type DedupeDecision = (typeof dedupeDecisionEnum.enumValues)[number];
type DedupeDecidedBy = (typeof dedupeDecidedByEnum.enumValues)[number];
type ExtractionMethod = (typeof extractionMethodEnum.enumValues)[number];

/**
 * Why a listing sits in a cluster (§14.1 stage 5).
 *
 * The wording keeps the confidence honest. `probable_same` is not a weaker way
 * of saying yes — it is the system declining to be certain, and the detail
 * screen is where a reader decides whether to trust the grouping. Every one of
 * the four live memberships in the corpus is `confirmed_same`, so the other
 * three exist here for the moment they do not.
 *
 * None of these explanations names the evidence behind a decision, and that is
 * deliberate. `confirmed_same` used to say the match rested on "a shared
 * application link or address", which is how the ruleset reaches it today and
 * not how a human reassignment does — so the label asserted a basis that the
 * stored evidence rendered beside it could flatly contradict. The enum says
 * what was decided; `evidence` says why.
 */
export const dedupeDecisionLabels: Record<DedupeDecision, Label> = {
  confirmed_same: {
    short: 'the same vacancy',
    explanation:
      'Judged to be one vacancy carried by both boards. The evidence behind that judgement is shown with it.',
  },
  probable_same: {
    short: 'probably the same vacancy',
    explanation:
      'The evidence points the same way but is not conclusive. Worth checking both listings before relying on the grouping.',
  },
  needs_review: {
    short: 'awaiting a decision',
    explanation: 'Proposed as the same vacancy, but nobody has judged it yet.',
  },
  distinct: {
    short: 'judged different',
    explanation: 'Considered as a possible duplicate and ruled out.',
  },
};

/** Who or what made the grouping decision. */
export const dedupeDecidedByLabels: Record<DedupeDecidedBy, Label> = {
  ruleset: {
    short: 'matched automatically',
    explanation: 'Decided by the scoring rules, with no person involved.',
  },
  model: {
    short: 'matched by a model',
    explanation: 'Decided by a model rather than the deterministic rules.',
  },
  human: {
    short: 'decided by a person',
    explanation: 'Someone reviewed this pair and decided it.',
  },
};

/** How the page behind a listing was retrieved. */
export const extractionMethodLabels: Record<ExtractionMethod, Label> = {
  http: { short: 'plain fetch', explanation: 'The page was read directly, without a browser.' },
  browser: {
    short: 'browser',
    explanation: 'The page needed a real browser to render before it could be read.',
  },
};

export function dedupeDecisionLabel(decision: string): Label {
  return (
    dedupeDecisionLabels[decision as DedupeDecision] ?? {
      short: 'unrecognised decision',
      explanation: `This build has no label for the decision "${decision}".`,
    }
  );
}

export function dedupeDecidedByLabel(decidedBy: string): Label {
  return (
    dedupeDecidedByLabels[decidedBy as DedupeDecidedBy] ?? {
      short: 'unrecognised source',
      explanation: `This build has no label for the decision-maker "${decidedBy}".`,
    }
  );
}

export function extractionMethodLabel(method: string): Label {
  return (
    extractionMethodLabels[method as ExtractionMethod] ?? {
      short: 'unrecognised method',
      explanation: `This build has no label for the extraction method "${method}".`,
    }
  );
}
