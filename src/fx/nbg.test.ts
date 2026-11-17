import { describe, expect, it } from 'vitest';
import { nbgDayUrl, nbgFetcher, parseNbgAnswer } from './nbg.js';
import { nbgAnswer } from './test-answers.js';

describe('parseNbgAnswer', () => {
  it('reads each currency with its day, quantity and publication time', () => {
    const { rates, skipped } = parseNbgAnswer(
      nbgAnswer('2026-11-14', [
        { code: 'USD', rate: 2.5934 },
        { code: 'JPY', rate: 1.6789, quantity: 100 },
      ]),
    );
    expect(skipped).toEqual([]);
    expect(rates).toEqual([
      {
        currency: 'USD',
        validFrom: '2026-11-14',
        quantity: 1,
        rate: 2.5934,
        publishedAt: '2026-11-13T17:01:01.670Z',
      },
      {
        currency: 'JPY',
        validFrom: '2026-11-14',
        quantity: 100,
        rate: 1.6789,
        publishedAt: '2026-11-13T17:01:01.670Z',
      },
    ]);
  });

  it('skips and names an entry it cannot read, keeping the rest', () => {
    const answer = nbgAnswer('2026-11-14', [{ code: 'USD', rate: 2.5934 }]) as Array<{
      currencies: unknown[];
    }>;
    answer[0]?.currencies.push({ code: 'XYZ', quantity: 1, rate: 'n/a', validFromDate: 'x' });
    answer[0]?.currencies.push(null);
    const { rates, skipped } = parseNbgAnswer(answer);
    expect(rates.map((rate) => rate.currency)).toEqual(['USD']);
    expect(skipped).toEqual(['XYZ', '?']);
  });

  it('throws on an answer whose outer shape is not one day', () => {
    expect(() => parseNbgAnswer({ error: 'x' })).toThrow();
    expect(() => parseNbgAnswer([])).toThrow();
  });
});

describe('nbgFetcher', () => {
  it('sends the User-Agent and throws on a non-2xx answer', async () => {
    const seen: Array<{ url: string; agent: string | null }> = [];
    const fake = (async (url: string, init?: RequestInit) => {
      seen.push({ url, agent: new Headers(init?.headers).get('user-agent') });
      return new Response('{}', { status: url.includes('2026-11-15') ? 503 : 200 });
    }) as typeof fetch;
    const fetchJson = nbgFetcher('TestBot/1', fake);
    await expect(fetchJson(nbgDayUrl('2026-11-14'))).resolves.toEqual({});
    await expect(fetchJson(nbgDayUrl('2026-11-15'))).rejects.toThrow('NBG answered 503');
    expect(seen[0]).toEqual({
      url: 'https://nbg.gov.ge/gw/api/ct/monetarypolicy/currencies/en/json/?date=2026-11-14',
      agent: 'TestBot/1',
    });
  });
});
