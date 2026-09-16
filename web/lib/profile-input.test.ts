import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  InvalidProfileInputError,
  readConsent,
  readCorrectedClaims,
  readCvFile,
  readLabel,
  readProfileId,
} from './profile-input.js';

describe('readProfileId', () => {
  it('accepts a uuid', () => {
    const id = randomUUID();
    const form = new FormData();
    form.set('profileId', ` ${id} `);
    expect(readProfileId(form)).toBe(id);
  });

  it('refuses anything that is not one', () => {
    for (const value of ['', '   ', 'not-a-uuid', "'; delete from candidate_profiles--"]) {
      const form = new FormData();
      form.set('profileId', value);
      expect(() => readProfileId(form)).toThrow(InvalidProfileInputError);
    }
  });
});

describe('readLabel', () => {
  it('trims and accepts a real label', () => {
    const form = new FormData();
    form.set('label', '  my 2026 CV  ');
    expect(readLabel(form)).toBe('my 2026 CV');
  });

  it('refuses an empty or missing label', () => {
    expect(() => readLabel(new FormData())).toThrow(InvalidProfileInputError);
    const blank = new FormData();
    blank.set('label', '   ');
    expect(() => readLabel(blank)).toThrow(InvalidProfileInputError);
  });

  it('caps an unreasonably long label', () => {
    const form = new FormData();
    form.set('label', 'x'.repeat(500));
    expect(readLabel(form).length).toBe(120);
  });
});

describe('readConsent', () => {
  it('is true only when the checkbox value is "on"', () => {
    const checked = new FormData();
    checked.set('consent', 'on');
    expect(readConsent(checked)).toBe(true);

    expect(readConsent(new FormData())).toBe(false);
  });
});

describe('readCvFile', () => {
  it('accepts a non-empty File', () => {
    const form = new FormData();
    form.set('file', new File(['content'], 'cv.pdf', { type: 'application/pdf' }));
    expect(readCvFile(form).name).toBe('cv.pdf');
  });

  it('refuses a missing file or an empty one', () => {
    expect(() => readCvFile(new FormData())).toThrow(InvalidProfileInputError);

    const empty = new FormData();
    empty.set('file', new File([], 'cv.pdf'));
    expect(() => readCvFile(empty)).toThrow(InvalidProfileInputError);
  });
});

describe('readCorrectedClaims', () => {
  it('reads an edited existing claim as "confirmed"', () => {
    const form = new FormData();
    form.set('rowCount', '1');
    form.set('claims[0].existing', '1');
    form.set('claims[0].kind', 'skill');
    form.set('claims[0].value', 'TypeScript');
    form.set('claims[0].evidence', 'Skilled in TypeScript.');

    expect(readCorrectedClaims(form)).toEqual([
      {
        kind: 'skill',
        value: 'TypeScript',
        evidence: 'Skilled in TypeScript.',
        origin: 'confirmed',
        years: null,
      },
    ]);
  });

  it('reads a newly added row as "manual" with no evidence', () => {
    const form = new FormData();
    form.set('rowCount', '1');
    form.set('claims[0].kind', 'language');
    form.set('claims[0].value', 'Georgian');
    // No `existing` marker and no `evidence` field — a hand-added row.

    expect(readCorrectedClaims(form)).toEqual([
      { kind: 'language', value: 'Georgian', evidence: null, origin: 'manual', years: null },
    ]);
  });

  it('skips a row marked for deletion', () => {
    const form = new FormData();
    form.set('rowCount', '1');
    form.set('claims[0].existing', '1');
    form.set('claims[0].kind', 'skill');
    form.set('claims[0].value', 'TypeScript');
    form.set('claims[0].delete', 'on');

    expect(readCorrectedClaims(form)).toEqual([]);
  });

  it('skips a blank "add a claim" slot', () => {
    const form = new FormData();
    form.set('rowCount', '1');
    form.set('claims[0].kind', 'skill');
    form.set('claims[0].value', '   ');

    expect(readCorrectedClaims(form)).toEqual([]);
  });

  it('reads a role claim’s years', () => {
    const form = new FormData();
    form.set('rowCount', '1');
    form.set('claims[0].existing', '1');
    form.set('claims[0].kind', 'role');
    form.set('claims[0].value', 'Software Engineer');
    form.set('claims[0].years', '5');

    const [claim] = readCorrectedClaims(form);
    expect(claim?.years).toBe(5);
  });

  it('rejects an unrecognized claim kind', () => {
    const form = new FormData();
    form.set('rowCount', '1');
    form.set('claims[0].kind', 'not_a_real_kind');
    form.set('claims[0].value', 'x');

    expect(() => readCorrectedClaims(form)).toThrow(InvalidProfileInputError);
  });

  it('rejects a negative years value', () => {
    const form = new FormData();
    form.set('rowCount', '1');
    form.set('claims[0].existing', '1');
    form.set('claims[0].kind', 'role');
    form.set('claims[0].value', 'Engineer');
    form.set('claims[0].years', '-3');

    expect(() => readCorrectedClaims(form)).toThrow(InvalidProfileInputError);
  });

  it('rejects a malformed rowCount', () => {
    const form = new FormData();
    form.set('rowCount', 'not-a-number');
    expect(() => readCorrectedClaims(form)).toThrow(InvalidProfileInputError);
  });

  it('reads multiple rows by index', () => {
    const form = new FormData();
    form.set('rowCount', '2');
    form.set('claims[0].existing', '1');
    form.set('claims[0].kind', 'skill');
    form.set('claims[0].value', 'TypeScript');
    form.set('claims[1].kind', 'skill');
    form.set('claims[1].value', 'PostgreSQL');

    const claims = readCorrectedClaims(form);
    expect(claims).toHaveLength(2);
    expect(claims.map((c) => c.value)).toEqual(['TypeScript', 'PostgreSQL']);
    expect(claims.map((c) => c.origin)).toEqual(['confirmed', 'manual']);
  });
});
