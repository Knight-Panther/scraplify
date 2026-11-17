/**
 * Phone numbers and emails, as the private poster directory keeps them
 * (Phase 17B, docs/PHASE_17_PLAN.md): phones in E.164 form under Georgia's
 * +995, emails lower-cased. Nothing here is ever shown on the public site.
 *
 * Two strengths of reading:
 *
 * - `normalisePhone` reads a field that the source states is a phone (a
 *   listing page's `applicationPhones`): any Georgian national number,
 *   9 digits from 3 to 7 (landlines, mobiles, VoIP), with or without +995;
 * - `extractContacts` reads free text (a description), where most runs of
 *   digits are prices, areas, cadastral codes, years or floors. It takes only
 *   the two shapes posters type, a mobile (5xx xxx xxx) or a Tbilisi landline
 *   (32 2xx xx xx), each optionally after +995, spaced only by single spaces
 *   or dashes, and not touching another digit, dot, comma or slash. Dots are
 *   never a separator: a cadastral code (52.06.12.345) has nine digits too.
 */

export type ContactKind = 'phone' | 'email';

export interface Contact {
  kind: ContactKind;
  /** `+995` and 9 digits, or a lower-cased email. */
  value: string;
}

const GEORGIAN_NATIONAL_RE = /^[3-7]\d{8}$/;

/** A phone a field names as one, in +995 form; null when it is not a Georgian number. */
export function normalisePhone(raw: unknown): string | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const text = String(raw);
  // A masked number ("598 90 99 **") identifies nobody: never stored.
  if (/[*xX#]/.test(text)) return null;
  let digits = text.replace(/\D/g, '');
  if (digits.startsWith('00995')) digits = digits.slice(2);
  if (digits.length === 12 && digits.startsWith('995')) digits = digits.slice(3);
  return GEORGIAN_NATIONAL_RE.test(digits) ? `+995${digits}` : null;
}

const EMAIL_SHAPE_RE = /^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}$/;

/** An email in the form kept: trimmed, lower-cased, a plain address; null otherwise. */
export function normaliseEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().replace(/\.+$/, '').toLowerCase();
  if (value.length > 254 || !EMAIL_SHAPE_RE.test(value)) return null;
  return value;
}

/**
 * The phone shapes a description is searched for. Group by group, so a run
 * of digits that only looks like a phone once its spacing is ignored (a
 * price "550 000 000 2") never is one. A separator is one space or dash.
 */
const SEP = '[ \\-]?';
const PREFIX = `(?:\\+?995${SEP})?`;
const MOBILE = [
  // 5xx xx xx xx
  `\\(?5\\d{2}\\)?${SEP}\\d{2}${SEP}\\d{2}${SEP}\\d{2}`,
  // 5xx xxx xxx
  `\\(?5\\d{2}\\)?${SEP}\\d{3}${SEP}\\d{3}`,
];
const TBILISI = [
  // 32 2xx xx xx, also as (032) 2xx xx xx
  `\\(?0?32\\)?${SEP}2\\d{2}${SEP}\\d{2}${SEP}\\d{2}`,
  // 32 2 xx xx xx
  `\\(?0?32\\)?${SEP}2${SEP}\\d{2}${SEP}\\d{2}${SEP}\\d{2}`,
];
/**
 * Not after a digit, nor after a digit and a dot, comma or slash (a decimal,
 * a thousands group, a floor "5/12"); the same after it.
 */
const DESCRIPTION_PHONE_RE = new RegExp(
  `(?<![\\d+])(?<!\\d[.,/])${PREFIX}(?:${[...MOBILE, ...TBILISI].join('|')})(?!\\d)(?![.,/]\\d)`,
  'g',
);

const MOBILE_NATIONAL_RE = /^5\d{8}$/;
const TBILISI_NATIONAL_RE = /^322\d{6}$/;

/** What a description match reads as, or null: a round number ending in six zeros is a price. */
function descriptionPhone(match: string): string | null {
  let digits = match.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('995')) digits = digits.slice(3);
  // (032) 2xx xx xx: the trunk 0 of the old dialling.
  if (digits.length === 10 && digits.startsWith('0322')) digits = digits.slice(1);
  if (!MOBILE_NATIONAL_RE.test(digits) && !TBILISI_NATIONAL_RE.test(digits)) return null;
  if (/0{6}$/.test(digits)) return null;
  return `+995${digits}`;
}

const DESCRIPTION_EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}/g;

/** Every distinct phone and email typed into a text, phones first, each in the order first found. */
export function extractContacts(text: string | null | undefined): Contact[] {
  if (typeof text !== 'string' || text === '') return [];
  const found = new Map<string, Contact>();
  for (const match of text.matchAll(DESCRIPTION_PHONE_RE)) {
    const value = descriptionPhone(match[0]);
    if (value !== null && !found.has(`phone:${value}`)) {
      found.set(`phone:${value}`, { kind: 'phone', value });
    }
  }
  for (const match of text.matchAll(DESCRIPTION_EMAIL_RE)) {
    const value = normaliseEmail(match[0]);
    if (value !== null && !found.has(`email:${value}`)) {
      found.set(`email:${value}`, { kind: 'email', value });
    }
  }
  return [...found.values()];
}
