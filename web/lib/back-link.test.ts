import { describe, expect, it } from 'vitest';
import { backLink } from './back-link.js';

const ID = '00000000-0000-4000-8000-000000000001';

describe('backLink', () => {
  it('goes back to Browse with the list’s own query and this row’s anchor', () => {
    expect(backLink({ back: 'type=job&sort=recent', from: undefined, opportunityId: ID })).toEqual({
      href: `/opportunities?type=job&sort=recent#opp-${ID}`,
      label: 'Back to opportunities',
    });
    expect(backLink({ back: undefined, from: undefined, opportunityId: ID }).href).toBe(
      `/opportunities#opp-${ID}`,
    );
  });

  it('honours from=programmes, and only names it allows', () => {
    expect(backLink({ back: 'kind=summer_school', from: 'programmes', opportunityId: ID })).toEqual(
      {
        href: `/programmes?kind=summer_school#opp-${ID}`,
        label: 'Back to programmes',
      },
    );
    for (const from of ['https://evil.example', '//evil.example', 'admin', ['programmes', 'x']]) {
      const link = backLink({ back: undefined, from, opportunityId: ID });
      expect(link.href.startsWith('/opportunities') || link.href.startsWith('/programmes')).toBe(
        true,
      );
    }
    expect(backLink({ back: undefined, from: 'admin', opportunityId: ID }).label).toBe(
      'Back to opportunities',
    );
  });
});
