import { describe, expect, it } from 'vitest';
import { heroCopy } from './hero-copy.js';

describe('heroCopy', () => {
  it.each(['en', 'ka'] as const)(
    '%s: the Real estate link words occur in the subhead once',
    (locale) => {
      const { subhead, subheadRealEstateLink } = heroCopy(locale);
      expect(subheadRealEstateLink).not.toBe('');
      expect(subhead.split(subheadRealEstateLink)).toHaveLength(2);
    },
  );

  it.each(['en', 'ka'] as const)('%s: the subhead names all four sources', (locale) => {
    for (const source of ['jobs.ge', 'hr.ge', 'etenders.ge', 'ss.ge']) {
      expect(heroCopy(locale).subhead).toContain(source);
    }
  });
});
