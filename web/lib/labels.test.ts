import { describe, expect, it } from 'vitest';
import { crawlRunStatusEnum } from '../../src/db/schema/runs.js';
import { sourceListingStatusEnum } from '../../src/db/schema/source-listings.js';
import {
  crawlRunStatusLabel,
  crawlRunStatusLabels,
  listingStatusLabel,
  listingStatusLabels,
  sourceLabel,
} from './labels.js';

/**
 * These enforce the rule the label map exists for: no raw enum value ever
 * reaches a person. The typecheck already catches a missing key, but it cannot
 * catch a label that IS the enum value, which is the likelier mistake.
 */
describe('labels', () => {
  it('covers every listing status the schema defines', () => {
    for (const status of sourceListingStatusEnum.enumValues) {
      expect(listingStatusLabels[status]).toBeDefined();
    }
    expect(Object.keys(listingStatusLabels).sort()).toEqual(
      [...sourceListingStatusEnum.enumValues].sort(),
    );
  });

  it('covers every crawl run status the schema defines', () => {
    expect(Object.keys(crawlRunStatusLabels).sort()).toEqual(
      [...crawlRunStatusEnum.enumValues].sort(),
    );
  });

  it('gives every identifier-shaped enum value a real label', () => {
    // Deliberately NOT "the label must differ from the enum value": several
    // states are already the right English word, and 'closed' should read
    // "closed". What must never survive is an identifier — snake_case, or a
    // term only the schema uses.
    const identifierShaped = (value: string) => value.includes('_');
    for (const status of sourceListingStatusEnum.enumValues) {
      if (identifierShaped(status)) expect(listingStatusLabels[status].short).not.toBe(status);
    }
    for (const status of crawlRunStatusEnum.enumValues) {
      if (identifierShaped(status)) expect(crawlRunStatusLabels[status].short).not.toBe(status);
    }
  });

  it('never uses an underscored identifier as a label', () => {
    // `missing_suspected` leaking through with cosmetic changes would still be
    // a database state on screen.
    for (const label of [
      ...Object.values(listingStatusLabels),
      ...Object.values(crawlRunStatusLabels),
    ]) {
      expect(label.short).not.toMatch(/_/);
      expect(label.short.length).toBeGreaterThan(0);
      expect(label.explanation.length).toBeGreaterThan(20);
    }
  });

  it('never uppercases a label, because Georgian is unicase', () => {
    for (const label of [
      ...Object.values(listingStatusLabels),
      ...Object.values(crawlRunStatusLabels),
    ]) {
      expect(label.short).not.toBe(label.short.toUpperCase());
    }
  });

  it('states that a missing listing is a suspicion, not a fact', () => {
    // The single most consequential wording on the status screens: 96 of 406
    // opportunities are in this state, and presenting it as certainty would
    // misrepresent what the crawler actually knows.
    const label = listingStatusLabels.missing_suspected;
    // The short label must HEDGE. "gone" is fine — "may be gone" is honest;
    // what is forbidden is asserting the removal as settled.
    expect(label.short).toMatch(/may|might|possibly|unconfirmed/i);
    expect(label.short).not.toMatch(/^(gone|removed|deleted|closed)$/i);
    expect(label.explanation).toMatch(/suspicion|not a fact/i);
  });

  it('degrades visibly for an unknown value rather than printing it bare', () => {
    const unknown = listingStatusLabel('some_future_state');
    expect(unknown.short).not.toBe('some_future_state');
    expect(unknown.short).toMatch(/unrecognised/);
    expect(crawlRunStatusLabel('whatever').short).toMatch(/unrecognised/);
  });

  it('renders source slugs as the domains people know', () => {
    expect(sourceLabel('jobs-ge')).toBe('jobs.ge');
    expect(sourceLabel('hr-ge')).toBe('hr.ge');
    // An unknown source still renders, rather than blanking the row.
    expect(sourceLabel('new-board')).toBe('new-board');
  });
});
