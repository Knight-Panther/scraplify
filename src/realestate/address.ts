/**
 * A listing's house number as a number (Phase 14A), read from what the poster
 * typed (`street_number`, which is kept as typed). Of the active Tbilisi
 * listings on 2026-11-06, 111,427 had none, 96,941 plain digits, 5,585 digits
 * and a letter ("117დ"), 798 a range or a slash ("49-51"), and about 10,000
 * something else: punctuation ("0", ".", ","), a place's name, a block.
 *
 * - "117დ" is 117, letter დ; "12A" is 12, letter a.
 * - "49-51", "9–11", "12/14" are the first number, with no letter: the
 *   address is still on that street at that number.
 * - "№12", "N 12", "#12" drop the sign.
 * - "7ბ ბლოკი" or "12 კორპ." name a block or a building, not a house number:
 *   none. So does anything with no digit, and 0.
 */
export interface HouseNumber {
  houseNumber: number | null;
  houseSuffix: string | null;
}

const NONE: HouseNumber = { houseNumber: null, houseSuffix: null };
const SIGN_RE = /^(?:№|#|n\s*°?|no\.?)\s*(?=\d)/iu;
const NUMBER_RE = /^(\d{1,4})\s*([ა-ჰa-z])?$/iu;
const RANGE_RE = /^(\d{1,4})\s*[-–/]\s*\d{1,4}\s*[ა-ჰa-z]?$/iu;

export function parseHouseNumber(raw: string | null): HouseNumber {
  if (raw === null) return NONE;
  const plain = raw.trim().replace(SIGN_RE, '');
  const single = NUMBER_RE.exec(plain);
  const range = single === null ? RANGE_RE.exec(plain) : null;
  const digits = single?.[1] ?? range?.[1];
  if (digits === undefined) return NONE;
  const houseNumber = Number(digits);
  if (houseNumber === 0) return NONE;
  return { houseNumber, houseSuffix: single?.[2]?.toLowerCase() ?? null };
}
