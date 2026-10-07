import { normalizeOrganizationName } from '../normalize/organization.js';

/**
 * Buyer matching for tender dedupe (docs/addEtender.md §11, §14.6).
 *
 * The vacancy organization key (`normalizeOrganizationName`) is deliberately
 * timid and versioned, and it stays exactly as it is. Tenders need three more
 * things from it, all measured on the etenders.ge and job-board copies of the
 * same procurements (2026-10-07):
 *
 * - Dotted legal forms and dashes: etenders.ge writes `ს.ს. ლომისი`,
 *   `ს. ს. ენერგო-პრო ჯორჯია`, `შ.პ.ს ტრანსკომ გრუპ` and `შპს ავერსი–ფარმა`
 *   (an en dash) where the boards write `ავერსი ფარმა`.
 * - A Georgian and an English name for one buyer: `UNDP` on etenders.ge,
 *   `გაეროს განვითარების პროგრამა` on jobs.ge. A curated alias list folds
 *   these; it holds buyers that post on both kinds of site, and grows with
 *   operations.
 * - A branch or trading name after the legal name: `ლომისი - ლუდსახარში
 *   ნატახტარი` (Lomisi, Natakhtari brewery) on jobs.ge for `ს.ს. ლომისი`.
 *   `buyersMatch` accepts one key being the other's leading words.
 *
 * As with the organization key, a match here only lets a pair be scored; the
 * tender scorer still needs the deadline and the title to agree.
 */

/** Dotted or spaced spellings of Georgian legal forms, stripped before normalizing. */
const DOTTED_LEGAL_FORMS =
  /(?<![\p{L}])(?:ს\.\s*ს\.?|შ\.\s*პ\.\s*ს\.?|ა\.\s*ა\.\s*ი\.\s*პ\.?|ს\.\s*ს\.\s*ი\.\s*პ\.?|შპს\.|სს\.)(?![\p{L}])/gu;
const DASHES = /[‐‑‒–—―]/g;

/**
 * Names one buyer goes by, each group folded to its first entry. Written in
 * the form `normalizeBuyerName` produces (lowercase, no punctuation or legal
 * forms), so the table needs no normalizing of its own.
 */
const BUYER_ALIAS_GROUPS: readonly (readonly string[])[] = [
  ['undp', 'გაეროს განვითარების პროგრამა', 'united nations development programme'],
  ['unicef', 'გაეროს ბავშვთა ფონდი', 'იუნისეფი', 'united nations children s fund'],
  ['un women', 'გაეროს ქალთა ორგანიზაცია', 'გაერო ქალები'],
  ['world vision', 'world vision georgia', 'ვორლდ ვიჟენი', 'ვორლდ ვიჟენ საქართველო'],
  ['sos ბავშვთა სოფელი', 'sos children s villages', 'sos children s villages georgia'],
  ['giz', 'გერმანიის საერთაშორისო თანამშრომლობის საზოგადოება'],
  ['nalag', 'საქართველოს ადგილობრივ თვითმმართველობათა ეროვნული ასოციაცია'],
  ['ავერსის კლინიკა', 'aversi clinic'],
  ['ავერსი ფარმა', 'aversi pharma'],
];

const ALIASES = new Map<string, string>();
for (const group of BUYER_ALIAS_GROUPS) {
  const [canonical] = group;
  if (canonical === undefined) continue;
  for (const name of group) ALIASES.set(name, canonical);
}

/**
 * Words that say nothing about which buyer this is. A leading-words match on
 * these alone (`კომპანია`, "company", the boards' placeholder for an
 * anonymous employer) would pair unrelated buyers.
 */
const GENERIC_BUYER_WORDS = new Set([
  'კომპანია',
  'company',
  'საქართველოს',
  'საქართველო',
  'georgia',
  'ჯგუფი',
  'group',
  'გაეროს',
  'un',
]);

/** The buyer's matching key, or null when the name carries no usable signal. */
export function normalizeBuyerName(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const prepared = raw.normalize('NFKC').replace(DASHES, ' ').replace(DOTTED_LEGAL_FORMS, ' ');
  const key = normalizeOrganizationName(prepared);
  if (key === null) return null;
  return ALIASES.get(key) ?? key;
}

/** The blocking key for a buyer: its first word that identifies anyone. */
export function buyerHeadWord(key: string): string | null {
  const [first] = key.split(' ');
  if (first === undefined || GENERIC_BUYER_WORDS.has(first)) return null;
  return first;
}

/**
 * True when two buyer names name the same buyer: equal keys after aliasing,
 * or one key is the other's leading words and is not made of generic words only.
 */
export function buyersMatch(
  rawA: string | null | undefined,
  rawB: string | null | undefined,
): boolean {
  const a = normalizeBuyerName(rawA);
  const b = normalizeBuyerName(rawB);
  if (a === null || b === null) return false;
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  const shortWords = shorter.split(' ');
  const longWords = longer.split(' ');
  if (shortWords.every((word) => GENERIC_BUYER_WORDS.has(word))) return false;
  return shortWords.every((word, index) => longWords[index] === word);
}
