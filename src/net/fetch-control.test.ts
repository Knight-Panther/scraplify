import { expect, it } from 'vitest';
import { responseBackoffUntil } from './fetch-control.js';

const now = '2026-09-05T12:00:00Z';
const response = {
  status: 200,
  headers: {},
  body: '',
  finalUrl: 'https://example.test/',
  redirectCount: 0,
};
it('does not pause ordinary successful responses', () => {
  expect(responseBackoffUntil(response, now)).toBeNull();
});
it.each([
  [{ 'retry-after': '120' }, '2026-09-05T12:02:00.000Z'],
  [{ 'retry-after': 'Sat, 05 Sep 2026 13:00:00 GMT' }, '2026-09-05T13:00:00.000Z'],
  [{ 'retry-after': 'invalid' }, '2026-09-05T12:01:00.000Z'],
  [{ 'retry-after': '9'.repeat(400) }, '2026-09-05T12:01:00.000Z'],
])(
  'honors supported Retry-After shapes and safely handles invalid values: %j',
  (headers, expected) => {
    expect(responseBackoffUntil({ ...response, status: 429, headers }, now)).toBe(expected);
  },
);
it('uses the longest reset signal, including on a successful exhausted response', () => {
  expect(
    responseBackoffUntil(
      {
        ...response,
        headers: { 'ratelimit-remaining': '0', 'ratelimit-reset': '180', 'retry-after': '120' },
      },
      now,
    ),
  ).toBe('2026-09-05T12:03:00.000Z');
});
it('honors Retry-After on service-unavailable responses', () => {
  expect(
    responseBackoffUntil({ ...response, status: 503, headers: { 'retry-after': '120' } }, now),
  ).toBe('2026-09-05T12:02:00.000Z');
});
