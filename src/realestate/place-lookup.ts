import { INVISIBLE } from '../matching/lexical/text.js';
import { type BuiltSql, type Placeholders, toPsycopg } from './filter-builder.js';

/**
 * Place names to matching keys (Phase 14B, contract C6): the one way both a
 * place's names and a person's words for it are folded, so "ჭავჭავაძე",
 * "ჭავჭავაძის გამზ." and "chavchavadze" meet, and so do Digomi and Dighomi.
 * Hermes calls this through node, the way it calls C1, rather than keeping a
 * copy: a key folded two ways would silently stop matching.
 *
 * Every word goes through the same steps, whatever its script:
 * 1. NFKC and lower case; a Georgian word loses one case ending (ვაკეში →
 *    ვაკე, ჭავჭავაძის → ჭავჭავაძ), a Latin one a final "s". Not CV
 *    matching's stemmer (src/matching/lexical/text.ts): it also strips the
 *    plural -ები, and many place names are plural in form, so ბაგები would
 *    become "bag" while "Bagebi" stays "bageb";
 * 2. Georgian letters romanized by the national system, letter for letter as
 *    Hermes's `_ROMAN` (Hermes repo, workflows/integrations/xtelo.py);
 * 3. Hermes's `_LOOSE` folds, in its order (kh → k, gh → g, ts → c, q → k…);
 * 4. a doubled letter made single, then one final vowel dropped where three
 *    letters stay, so ჭავჭავაძე, ჭავჭავაძის and "Chavchavadze" all end as
 *    "cavcavaz";
 * 5. words that only say what kind of place it is (ქ., გამზ., street, ave)
 *    left out. Initials stay ("ი. ჭავჭავაძის" keeps its "i"), and so do
 *    "district" and რაიონი, which pick the official map (C6's two maps).
 *
 * What it cannot fold, aliases do: a stem Georgian shortens inside the word
 * (დიღომი, დიღმის), and English names ("Turtle Lake" for კუს ტბა).
 */

/** Bump when a rule here changes: stored keys are rebuilt from it, and Hermes reads it. */
export const PLACE_LOOKUP_VERSION = 1;

/** Hermes's `_ROMAN`: Georgian's national romanization, letter for letter. */
const GEORGIAN_LETTERS = 'აბგდევზთიკლმნოპჟრსტუფქღყშჩცძწჭხჯჰ';
const ROMAN_LETTERS = 'a b g d e v z t i k l m n o p zh r s t u p k gh q sh ch ts dz ts ch kh j h';
const ROMAN: ReadonlyMap<string, string> = new Map(
  [...GEORGIAN_LETTERS].map((letter, at) => [letter, ROMAN_LETTERS.split(' ')[at] ?? letter]),
);

/** Hermes's `_LOOSE`, in its order: spellings people mix up fold together. */
const LOOSE: ReadonlyArray<readonly [string, string]> = [
  ['tch', 'c'],
  ['kh', 'k'],
  ['gh', 'g'],
  ['zh', 'z'],
  ['sh', 's'],
  ['ch', 'c'],
  ['ts', 'c'],
  ['dz', 'z'],
  ['q', 'k'],
  ['y', 'i'],
  ['w', 'v'],
];

/** An ending or a final vowel goes only where at least this many letters stay. */
const MIN_STEM = 3;

const GEORGIAN = /[Ⴀ-ჿᲐ-Ჿ]/u;

/**
 * Case endings and postpositions, longest first; never the plural -ებ-
 * before them (ბაგებში → ბაგებ, as ბაგები → "bageb"). A final ი or ო is the
 * final-vowel step's, for both scripts alike.
 */
const GEORGIAN_ENDINGS = [
  'ისთვის',
  'ისგან',
  'ისკენ',
  'თვის',
  'იდან',
  'ამდე',
  'თან',
  'დან',
  'გან',
  'კენ',
  'ში',
  'ზე',
  'ის',
  'ით',
  'ად',
  'ს',
] as const;

/** Step 1 for one lower-case word. */
function stripEnding(word: string): string {
  if (GEORGIAN.test(word)) {
    for (const ending of GEORGIAN_ENDINGS) {
      if (word.endsWith(ending) && word.length - ending.length >= MIN_STEM) {
        return word.slice(0, -ending.length);
      }
    }
    return word;
  }
  // Latin: "gldanis" and "chavchavadzis", typed as Georgian says them.
  return word.length > MIN_STEM && word.endsWith('s') && !word.endsWith('ss')
    ? word.slice(0, -1)
    : word;
}

/** One word's romanized, loosened form (steps 2 and 3), as Hermes's `loose_words` gives it. */
export function looseWord(word: string): string {
  let out = '';
  for (const char of word.toLowerCase()) out += ROMAN.get(char) ?? char;
  for (const [from, to] of LOOSE) out = out.replaceAll(from, to);
  return out;
}

/** One word's key (steps 1 to 4). */
function wordKey(word: string): string {
  let key = looseWord(stripEnding(word)).replace(/(\p{L})\1+/gu, '$1');
  if (key.length > MIN_STEM && /[aeiou]$/.test(key)) key = key.slice(0, -1);
  return key;
}

/**
 * Words that only name a kind of place, as ss.ge abbreviates them, in full,
 * and in English. Their keys come from the same steps, so a spelling that
 * folds to one of them is left out too.
 */
const KIND_WORDS = [
  // Georgian, as ss.ge writes them and in full.
  'ქ',
  'ქუჩა',
  'ქუჩის',
  'გამზ',
  'გამზირი',
  'გამზირის',
  'შეს',
  'შესახ',
  'შესახვევი',
  'შესახვევის',
  'ჩიხი',
  'ჩიხის',
  'მოედ',
  'მოედანი',
  'მოედნის',
  'გზატ',
  'გზატკ',
  'გზატკეცილი',
  'გზატკეცილის',
  'ხეივ',
  'ხეივანი',
  'ხეივნის',
  'კვ',
  'კვარტ',
  'კვარტალი',
  'კვარტლის',
  'კვარტლები',
  'მიკრორაიონი',
  'დას',
  'დასახლება',
  'დასახლების',
  'სოფ',
  'სოფელი',
  'სოფლის',
  'დაბა',
  'ქალაქი',
  'ქალაქის',
  'სანაპ',
  'სანაპირო',
  'სანაპიროს',
  'აღმ',
  'აღმართი',
  'აღმართის',
  'ბულ',
  'ბულვარი',
  'უბანი',
  'უბნის',
  'უბნები',
  // English.
  'st',
  'str',
  'street',
  'ave',
  'av',
  'avenue',
  'lane',
  'ln',
  'road',
  'rd',
  'highway',
  'hwy',
  'blvd',
  'boulevard',
  'alley',
  'sq',
  'square',
  'embankment',
  'quarter',
  'quarters',
  'microdistrict',
  'settlement',
  'village',
  'city',
] as const;

/** Letters and digits; anything else separates words. */
const WORD = /[\p{L}\p{N}]+/gu;
/** ss.ge's "მ/რ" (microdistrict) would leave two stray initials. */
const MICRODISTRICT = /მ\/რ/gu;

function keysOf(text: string): string[] {
  // "№" goes before NFKC, which would make "№12" the word "no12".
  const words =
    text
      .replaceAll('№', ' ')
      .normalize('NFKC')
      .replace(INVISIBLE, '')
      .toLowerCase()
      .replace(MICRODISTRICT, ' ')
      .match(WORD) ?? [];
  return words.map((word) => wordKey(word)).filter((key) => key !== '');
}

const KIND_KEYS: ReadonlySet<string> = new Set(KIND_WORDS.flatMap((word) => keysOf(word)));

/** A place name's matching keys, one per word, in order. Empty when it only names a kind of place. */
export function placeKeys(text: string): string[] {
  return keysOf(text).filter((key) => !KIND_KEYS.has(key));
}

/** A whole name as one key, the words in order: what the catalogue stores and compares. */
export function nameKey(text: string): string {
  return placeKeys(text).join(' ');
}

/**
 * The order a lookup lists matches of one kind in. ss.ge's areas come first,
 * since a bare name means what people mean by it ("Vake": the neighbourhood);
 * then the official map; then streets.
 */
export const LOOKUP_LEVEL_ORDER = [
  'city',
  'district',
  'subdistrict',
  'neighbourhood',
  'municipality',
  'official_district',
  'metro_station',
  'street',
] as const;

/** At most this many matches; the default is 50. */
const LOOKUP_LIMIT_MAX = 500;

/**
 * Places named by some words, on both maps, over `realestate.public_places`
 * (C6). A place matches `exact` when one of its names has the same key, and
 * `partial` when the words come in order inside one ("dighomi" in "Didi
 * Dighomi"). Exact matches come first, then by `LOOKUP_LEVEL_ORDER`, then the
 * busiest. Each row carries its parent's names and, for a street or station,
 * its official district's, so a reply can say how the other map sees it.
 *
 * Null when the words only name a kind of place ("street"). Like C1, it opens
 * no connection: the reader runs the SQL itself.
 */
export function placeLookupSql(
  text: string,
  options: { placeholders?: Placeholders; limit?: number } = {},
): (BuiltSql & { key: string }) | null {
  const key = nameKey(text);
  if (key === '') return null;
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), LOOKUP_LIMIT_MAX);
  const levels = LOOKUP_LEVEL_ORDER.map((level) => `'${level}'`).join(', ');
  const numbered: BuiltSql = {
    sql: `with q as (select $1::text as key)
select p.source_id, p.level, p.ref, p.origin, p.code, p.name_ka, p.name_en,
       p.parent_level, p.parent_ref, parent.name_ka as parent_name_ka, parent.name_en as parent_name_en,
       p.latitude, p.longitude, p.point_status,
       p.official_district_ref, official.name_ka as official_name_ka,
       official.name_en as official_name_en, p.official_basis, p.official_shares,
       p.active_listings,
       case when q.key = any(p.match_keys) then 'exact' else 'partial' end as match
  from realestate.public_places p
  cross join q
  left join realestate.public_places parent
    on parent.source_id = p.source_id and parent.level = p.parent_level and parent.ref = p.parent_ref
  left join realestate.public_places official
    on official.source_id = p.source_id and official.level = 'official_district'
   and official.ref = p.official_district_ref
 where p.match_keys @> array[q.key]
    or exists (select 1 from unnest(p.match_keys) as m(key)
                where (' ' || m.key || ' ') like ('% ' || q.key || ' %'))
 order by (q.key = any(p.match_keys)) desc, array_position(array[${levels}], p.level),
          p.active_listings desc, p.level, p.ref
 limit $2`,
    params: [key, limit],
  };
  return { ...(options.placeholders === 'psycopg' ? toPsycopg(numbered) : numbered), key };
}
