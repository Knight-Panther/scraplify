import { describe, expect, it } from 'vitest';
import {
  ORGANIZATION_NORMALIZER_VERSION,
  normalizeOrganizationName,
  organizationNamesMatch,
} from './organization.js';

describe('normalizeOrganizationName', () => {
  it('returns null for input carrying no usable signal', () => {
    // Null rather than '' on purpose: an empty key would bucket every
    // signal-less organization together and mass-merge them (§14.2).
    for (const input of [null, undefined, '', '   ', '...', '- , -', 'შპს', 'LLC']) {
      expect(normalizeOrganizationName(input)).toBeNull();
    }
  });

  it('folds case so a shouted name meets an ordinary one', () => {
    // Real pairing shape from the corpus: hr.ge posts employer names in caps
    // (AUTOPAPA, KEYPOINT, AMBER STUDIOS) where jobs.ge uses title case.
    expect(normalizeOrganizationName('AUTOPAPA')).toBe('autopapa');
    expect(organizationNamesMatch('AUTOPAPA', 'Autopapa')).toBe(true);
    expect(organizationNamesMatch('AMBER STUDIOS', 'Amber Studios')).toBe(true);
  });

  it('collapses whitespace and trims', () => {
    expect(normalizeOrganizationName('  Match   Up    Consulting  ')).toBe('match up consulting');
  });

  it('strips legal-form tokens as whole words only', () => {
    // From the live corpus — the one organization carrying a legal form.
    expect(normalizeOrganizationName('შპს იუ ეიჩ უაი საქართველო')).toBe('იუ ეიჩ უაი საქართველო');
    expect(normalizeOrganizationName('Financial Chain Corporation')).toBe('financial chain');
    expect(organizationNamesMatch('შპს ალტა', 'ალტა')).toBe(true);
  });

  it('never strips a legal-form token found inside a longer word', () => {
    // 'სს' is two letters and occurs inside ordinary Georgian words; a
    // substring replace here would silently corrupt real employer names.
    const inner = normalizeOrganizationName('სსიპ განათლების ცენტრი');
    expect(inner).toBe('განათლების ცენტრი');
    // A word merely CONTAINING the token survives intact.
    expect(normalizeOrganizationName('ასსოცი')).toBe('ასსოცი');
    expect(normalizeOrganizationName('Incubator')).toBe('incubator');
  });

  it('removes quote characters used around Georgian trade names', () => {
    expect(organizationNamesMatch('„ალტა"', 'ალტა')).toBe(true);
    expect(organizationNamesMatch('«ვოლტა გრუპ»', 'ვოლტა გრუპ')).toBe(true);
    expect(organizationNamesMatch('"Evolution"', 'Evolution')).toBe(true);
  });

  it('folds domain-style names toward their spoken form', () => {
    // All four are real corpus strings.
    expect(normalizeOrganizationName('Shop.ge')).toBe('shop ge');
    expect(normalizeOrganizationName('HOME.GE')).toBe('home ge');
    expect(normalizeOrganizationName('elplus.ge')).toBe('elplus ge');
    expect(normalizeOrganizationName('კოტეჯები.ჯი')).toBe('კოტეჯები ჯი');
    expect(organizationNamesMatch('Shop.ge', 'Shop GE')).toBe(true);
  });

  it('handles the punctuation actually present in the corpus', () => {
    expect(normalizeOrganizationName('020-ეპოსი')).toBe('020 ეპოსი');
    expect(normalizeOrganizationName('ბებე +')).toBe('ბებე');
    expect(normalizeOrganizationName('მ. იაშვილის სახ. ბავშვთა ცენტრალური საავადმყოფო')).toBe(
      'მ იაშვილის სახ ბავშვთა ცენტრალური საავადმყოფო',
    );
  });

  it('matches the four organizations that genuinely appear on both sources', () => {
    // Measured against the live corpus on 2026-09-06: these four employers
    // post on jobs.ge and hr.ge alike, and are the real duplicate candidates
    // Phase 2's scoring will have to reason about.
    for (const name of ['თიბისი', 'იფქლი', 'ჯიაიჯი ჰოლდინგი', 'Evolution']) {
      expect(organizationNamesMatch(name, name)).toBe(true);
    }
    // Case and spacing variants of the same, since the two boards format
    // independently.
    expect(organizationNamesMatch('Evolution', 'EVOLUTION')).toBe(true);
    expect(organizationNamesMatch(' ჯიაიჯი  ჰოლდინგი ', 'ჯიაიჯი ჰოლდინგი')).toBe(true);
  });

  it('does not merge genuinely different employers', () => {
    // The normalizer folds formatting, never meaning: no stemming, no
    // transliteration, no 'Group' ~ 'ჯგუფი' equivalence.
    expect(organizationNamesMatch('MS Holding', 'ჯიაიჯი ჰოლდინგი')).toBe(false);
    expect(organizationNamesMatch('Geosky', 'Geo Green')).toBe(false);
    expect(organizationNamesMatch('NMG ჯგუფი', 'NMG Group')).toBe(false);
    expect(organizationNamesMatch('Point', 'One Point')).toBe(false);
  });

  it('is idempotent — normalizing an already-normalized key changes nothing', () => {
    // Required for the stored-key design: re-running the normalizer during a
    // backfill must not drift the value and silently re-cluster history.
    for (const input of [
      'შპს იუ ეიჩ უაი საქართველო',
      'AUTOPAPA',
      'Shop.ge',
      '020-ეპოსი',
      'Financial Chain Corporation',
    ]) {
      const once = normalizeOrganizationName(input);
      expect(once).not.toBeNull();
      expect(normalizeOrganizationName(once)).toBe(once);
    }
  });

  it('treats two signal-less names as not matching, despite both being null', () => {
    expect(organizationNamesMatch('შპს', 'LLC')).toBe(false);
    expect(organizationNamesMatch(null, null)).toBe(false);
    expect(organizationNamesMatch('', '')).toBe(false);
  });

  it('exposes a version so a rule change is a visible data migration', () => {
    expect(ORGANIZATION_NORMALIZER_VERSION).toBe('v1');
  });
});
