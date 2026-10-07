/**
 * Money and VAT text from etenders.ge detail pages, e.g.
 *   price basis  "დ.ღ.გ-ს ჩათვლით ლარში"        (VAT included, in GEL)
 *                "დ.ღ.გ.-ს გარეშე დოლარში"       (VAT excluded, in USD; note the extra dot)
 *                "დ.ღ.გ-ს ჩათვლით"               (VAT included, no currency)
 *   amounts      "12 200 ლარი დ.ღ.გ-ს ჩათვლით"
 *                "120 000 დოლარი დ.ღ.გ.-ს გარეშე"
 *                "1 000 დოლარი"
 *   unknown      "არ არის მითითებული"           ("not specified")
 * Every parse keeps the raw text; anything unrecognised becomes an explicit
 * null rather than a guess (concept §6.2).
 */

export type Currency = 'GEL' | 'USD' | 'EUR';
export type VatBasis = 'included' | 'excluded';

export interface PriceBasis {
  raw: string;
  vat: VatBasis | null;
  currency: Currency | null;
}

export interface MoneyAmount {
  raw: string;
  amount: number | null;
  vat: VatBasis | null;
  currency: Currency | null;
}

/** "Not specified": the site's own explicit unknown. */
export const NOT_SPECIFIED = 'არ არის მითითებული';

const CURRENCY_STEMS: ReadonlyArray<readonly [string, Currency]> = [
  ['ლარ', 'GEL'],
  ['დოლარ', 'USD'],
  ['ევრო', 'EUR'],
];

function detectCurrency(text: string): Currency | null {
  // Matched as word prefixes, so every Georgian case ending matches (ლარი,
  // ლარში, ლარის) and "ლარ" can never match inside "დოლარ".
  for (const word of text.split(/\s+/)) {
    for (const [stem, currency] of CURRENCY_STEMS) {
      if (word.startsWith(stem)) return currency;
    }
  }
  return null;
}

function detectVat(text: string): VatBasis | null {
  // "დ.ღ.გ" (VAT), written with and without a trailing dot before "-ს".
  if (!/დ\.?ღ\.?გ/.test(text)) return null;
  if (text.includes('ჩათვლით')) return 'included';
  if (text.includes('გარეშე')) return 'excluded';
  return null;
}

function clean(text: string | null | undefined): string | null {
  const value = text?.replace(/\s+/g, ' ').trim();
  return value ? value : null;
}

export function parsePriceBasis(text: string | null | undefined): PriceBasis | null {
  const raw = clean(text);
  if (raw === null || raw === NOT_SPECIFIED) return null;
  return { raw, vat: detectVat(raw), currency: detectCurrency(raw) };
}

/**
 * A leading number with spaces as thousands separators, and an optional
 * decimal part after a comma or dot ("12 200", "1 000", "120 000,50").
 */
const AMOUNT_RE = /^(\d{1,3}(?:[  ]\d{3})*|\d+)(?:[.,](\d{1,2}))?(?=\s|$)/;

export function parseMoneyAmount(text: string | null | undefined): MoneyAmount | null {
  const raw = clean(text);
  if (raw === null || raw === NOT_SPECIFIED) return null;
  const match = AMOUNT_RE.exec(raw);
  const amount =
    match === null
      ? null
      : Number(`${(match[1] ?? '').replace(/[  ]/g, '')}${match[2] ? `.${match[2]}` : ''}`);
  return {
    raw,
    amount: amount !== null && Number.isFinite(amount) ? amount : null,
    vat: detectVat(raw),
    currency: detectCurrency(raw),
  };
}
