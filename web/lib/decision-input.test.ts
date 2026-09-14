import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  capNote,
  InvalidDecisionInputError,
  MAX_NOTE,
  readNote,
  readOpportunityId,
} from './decision-input.js';

const graphemes = (text: string) => [
  ...new Intl.Segmenter('ka', { granularity: 'grapheme' }).segment(text),
];

describe('readOpportunityId', () => {
  it('accepts a uuid', () => {
    const id = randomUUID();
    const form = new FormData();
    form.set('opportunityId', ` ${id} `);
    expect(readOpportunityId(form)).toBe(id);
  });

  /**
   * Postgres answers a malformed uuid with an error rather than an empty
   * result, so a mangled form field would be a 500 instead of a refused
   * submit — the same defect `getOpportunity` guards against on the read side.
   */
  it('refuses anything that is not one', () => {
    for (const value of [
      '',
      '   ',
      'not-a-uuid',
      "'; delete from opportunity_decisions--",
      '123',
    ]) {
      const form = new FormData();
      form.set('opportunityId', value);
      expect(() => readOpportunityId(form)).toThrow(InvalidDecisionInputError);
    }
  });

  it('refuses a missing field', () => {
    expect(() => readOpportunityId(new FormData())).toThrow(InvalidDecisionInputError);
  });
});

describe('readNote', () => {
  /**
   * The distinction the whole note flow rests on: a control with no note input
   * must not wipe the note that is stored, and an emptied input must.
   */
  it('separates “no note field” from “an emptied note field”', () => {
    expect(readNote(new FormData())).toBeUndefined();

    const emptied = new FormData();
    emptied.set('note', '');
    expect(readNote(emptied)).toBeNull();

    const blank = new FormData();
    blank.set('note', '   ');
    expect(readNote(blank)).toBeNull();
  });

  it('trims and keeps a real note', () => {
    const form = new FormData();
    form.set('note', '  wrong city  ');
    expect(readNote(form)).toBe('wrong city');
  });

  it('keeps Georgian text intact', () => {
    const form = new FormData();
    form.set('note', 'არასწორი ქალაქი');
    expect(readNote(form)).toBe('არასწორი ქალაქი');
  });
});

describe('capNote', () => {
  /**
   * `georgian-typography.md` rule 7 forbids index-based truncation of this
   * corpus: Georgian characters are multi-byte, so `slice` counts UTF-16 code
   * units and can cut one in half. The same defect in the search box was a P1
   * during Stage 5.
   */
  it('cuts by grapheme, not by code unit', () => {
    const long = 'ა'.repeat(MAX_NOTE + 50);
    const capped = capNote(long);

    expect(graphemes(capped)).toHaveLength(MAX_NOTE);
    // Every character survives whole — a byte-wise cut leaves a replacement
    // character or an orphaned surrogate here.
    expect(capped).not.toContain('�');
    expect([...capped].every((character) => character === 'ა')).toBe(true);
  });

  /** The case a UTF-16 cut mangles most obviously. */
  it('does not split a surrogate pair', () => {
    const emoji = '👍'.repeat(10);
    const capped = capNote(emoji, 5);

    expect(graphemes(capped)).toHaveLength(5);
    expect(capped).toBe('👍👍👍👍👍');
  });

  it('leaves a short note untouched', () => {
    expect(capNote('short')).toBe('short');
    expect(capNote('')).toBe('');
  });
});
