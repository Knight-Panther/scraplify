/** Test-only: builds NBG API answers (src/fx/nbg.ts) for the parser and sync tests. */

/** One day's answer in the API's shape (2026-11-17), cut to the fields read and two currencies. */
export function nbgAnswer(
  validFrom: string,
  entries: Array<{ code: string; rate: number; quantity?: number }>,
): unknown {
  return [
    {
      date: `${validFrom}T00:00:00.000Z`,
      currencies: entries.map(({ code, rate, quantity = 1 }) => ({
        code,
        quantity,
        rateFormated: rate.toFixed(4),
        diffFormated: '0.0001',
        rate,
        name: code,
        diff: -0.0001,
        date: '2026-11-13T17:01:01.670Z',
        validFromDate: `${validFrom}T00:00:00.000Z`,
      })),
    },
  ];
}
