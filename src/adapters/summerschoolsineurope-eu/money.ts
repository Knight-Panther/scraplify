/**
 * Fees and credits as summerschoolsineurope.eu prints them: "1850 EUR",
 * "1.450 EUR" (a dot grouping thousands), "14560 NOK", "7.5 EC". The amount
 * and currency are exactly the source's: nothing is converted here, and an
 * amount or currency that cannot be read keeps its raw text with nulls
 * rather than a guess (docs/PHASE_15_PLAN.md, choice H).
 */

export interface Fee {
  /** 0 for a course the source calls free; null when the text could not be read. */
  amount: number | null;
  /** An ISO 4217 code as printed (or from € and £); null when free or unreadable. */
  currency: string | null;
  raw: string;
}

export interface Credits {
  amount: number;
  unit: 'EC';
}

const SIGNS: Record<string, string> = { '€': 'EUR', '£': 'GBP' };
const CODE_AFTER = /^([0-9][0-9.,\s]*)\s*([A-Z]{3})$/;
const CODE_BEFORE = /^([A-Z]{3}|[€£])\s*([0-9][0-9.,\s]*)$/;
const FREE = /^free\b/i;
const CREDITS = /^([0-9]+(?:[.,][0-9]+)?)\s*EC$/;

/**
 * A printed number: a dot or comma before exactly three digits groups
 * thousands ("1.450", "1,450"); before one or two digits it is a decimal
 * point ("99.50").
 */
function readAmount(text: string): number | null {
  const compact = text.replace(/\s+/g, '');
  if (!/^[0-9]+(?:[.,][0-9]+)*$/.test(compact)) return null;
  const parts = compact.split(/[.,]/);
  const last = parts.at(-1) ?? '';
  let value: string;
  if (parts.length === 1) value = compact;
  else if (parts.slice(1).every((part) => part.length === 3)) value = parts.join('');
  else if (parts.length === 2 && last.length <= 2) value = `${parts[0]}.${last}`;
  else return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

export function parseFee(text: string | null | undefined): Fee | null {
  const raw = text?.replace(/\s+/g, ' ').trim() || null;
  if (raw === null) return null;
  if (FREE.test(raw)) return { amount: 0, currency: null, raw };
  const after = CODE_AFTER.exec(raw);
  const before = after === null ? CODE_BEFORE.exec(raw) : null;
  const amountText = after?.[1] ?? before?.[2];
  const codeText = after?.[2] ?? before?.[1];
  if (amountText === undefined || codeText === undefined) {
    return { amount: null, currency: null, raw };
  }
  const amount = readAmount(amountText);
  if (amount === null) return { amount: null, currency: null, raw };
  return { amount, currency: SIGNS[codeText] ?? codeText, raw };
}

export function parseCredits(text: string | null | undefined): Credits | null {
  const raw = text?.replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  const match = CREDITS.exec(raw);
  if (match?.[1] === undefined) return null;
  return { amount: Number(match[1].replace(',', '.')), unit: 'EC' };
}
