import { describe, expect, it } from 'vitest';
import { matchStrength } from './strength.js';

describe('matchStrength', () => {
  it('is strong when the title names a role, whatever else matched', () => {
    expect(
      matchStrength([
        { kind: 'location', term: 'Tbilisi' },
        { kind: 'role', term: 'Accountant', exact: true },
        { kind: 'field', term: 'Finance', label: 'Finance' },
      ]),
    ).toBe('strong');
  });

  it('is good when the title is only close to a role', () => {
    expect(matchStrength([{ kind: 'role', term: 'Data analyst', exact: false }])).toBe('good');
    expect(matchStrength([{ kind: 'translated-role', term: 'Courier' }])).toBe('good');
    expect(
      matchStrength([
        { kind: 'similar', term: 'Graphic designer', from: 'role' },
        { kind: 'field', term: 'Design', label: 'Design' },
      ]),
    ).toBe('good');
  });

  it('is partial with no role evidence', () => {
    expect(matchStrength([{ kind: 'field', term: 'Finance', label: 'Finance' }])).toBe('partial');
    expect(matchStrength([{ kind: 'skill', term: 'Excel', where: 'title' }])).toBe('partial');
    expect(matchStrength([{ kind: 'similar', term: 'Senior accountant', from: 'cv' }])).toBe(
      'partial',
    );
    expect(matchStrength([])).toBe('partial');
  });
});
