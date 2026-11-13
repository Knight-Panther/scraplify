import { describe, expect, it } from 'vitest';
import { opportunityTypeEnum } from '../../src/db/schema/index.js';
import { OpportunityType } from '../../src/domain/opportunity.js';
import { isProgrammeKind, kindLabel, PROGRAMME_KIND_ORDER } from './kind-labels.js';
import { opportunityTypeLabel } from './labels.js';
import { TYPE_OPTIONS } from './search-params.js';

describe('kindLabel', () => {
  it('every enum value has an English and a Georgian label', () => {
    expect([...opportunityTypeEnum.enumValues].sort()).toEqual([...OpportunityType.options].sort());
    expect(opportunityTypeEnum.enumValues).toEqual(
      expect.arrayContaining(['internship', 'volunteering', 'competition']),
    );
    for (const type of opportunityTypeEnum.enumValues) {
      expect(kindLabel(type, 'en'), type).toMatch(/\S/);
      expect(kindLabel(type, 'ka'), type).toMatch(/[ა-ჿ]/);
    }
  });

  it("uses the owner's words (2026-11-13) and the plan's English", () => {
    expect(kindLabel('summer_school', 'ka')).toBe('საზაფხულო სკოლა');
    expect(kindLabel('grant', 'ka')).toBe('გრანტები');
    expect(kindLabel('internship', 'ka')).toBe('სტაჟირება საზღვარგარეთ');
    expect(kindLabel('tender', 'ka')).toBe('ტენდერი');
    expect(kindLabel('summer_school', 'en')).toBe('course / school');
    expect(kindLabel('internship', 'en')).toBe('internship abroad');
  });

  it('an unknown kind says so rather than printing the raw value', () => {
    expect(kindLabel('apprenticeship', 'en')).toBe('unrecognised kind');
    expect(kindLabel('apprenticeship', 'ka')).toBe('უცნობი ტიპი');
  });

  it('the screens’ English label is the same word', () => {
    for (const type of opportunityTypeEnum.enumValues) {
      expect(opportunityTypeLabel(type).short, type).toBe(kindLabel(type, 'en'));
      expect(opportunityTypeLabel(type).explanation, type).toMatch(/\S/);
    }
  });
});

describe('isProgrammeKind', () => {
  it('is true for the programme kinds and false for job, tender and anything unknown', () => {
    expect(PROGRAMME_KIND_ORDER.every(isProgrammeKind)).toBe(true);
    expect(isProgrammeKind('job')).toBe(false);
    expect(isProgrammeKind('tender')).toBe(false);
    expect(isProgrammeKind('apprenticeship')).toBe(false);
  });
});

describe('the Kind order', () => {
  it('job, tender, then the programme kinds in the order people look for them', () => {
    expect(TYPE_OPTIONS).toEqual([
      'job',
      'tender',
      'summer_school',
      'scholarship',
      'grant',
      'internship',
      'volunteering',
      'competition',
      'event',
    ]);
    expect(TYPE_OPTIONS.slice(2)).toEqual(PROGRAMME_KIND_ORDER);
    expect([...TYPE_OPTIONS].sort()).toEqual([...opportunityTypeEnum.enumValues].sort());
  });
});
