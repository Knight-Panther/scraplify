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
 * (დიღომი, დიღმის), and English names ("Turtle Lake" for კუს ტბა). A place
 * whose name has ჟ also gets the key with ჟ written "j" (`nameKeys`): English
 * writes ვაჟა as "Vaja" as often as "Vazha". Folding every j into z instead
 * would merge ჯ with ჟ for everyone.
 */

/**
 * Bump when a rule here or the lookup's output changes: stored keys are
 * rebuilt from it, and Hermes reads it. 2 (Phase 14C): ჟ also keyed as "j",
 * and every row carries its city.
 */
export const PLACE_LOOKUP_VERSION = 2;

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

/** A place's name as every key it is stored under: `nameKey`, and the same with ჟ as "j" where it has one. */
export function nameKeys(text: string): string[] {
  const keys = new Set([nameKey(text)]);
  if (text.includes('ჟ')) keys.add(nameKey(text.replaceAll('ჟ', 'j')));
  keys.delete('');
  return [...keys];
}

/**
 * The order a lookup lists matches of one kind in, as groups. ss.ge's areas
 * come first, since a bare name means what people mean by it ("Vake": the
 * neighbourhood); then the official map; then its stations; then streets.
 * Within a group the busiest comes first: production has a village called
 * ვაკე with one listing (city 572, 2026-11-08), and the neighbourhood with
 * 21,367 must still come before it.
 */
export const LOOKUP_LEVEL_GROUPS = [
  ['city', 'district', 'subdistrict', 'neighbourhood', 'municipality'],
  ['official_district'],
  ['metro_station'],
  ['street'],
] as const;

/** Every level a lookup returns, in group order. */
export const LOOKUP_LEVEL_ORDER: readonly string[] = LOOKUP_LEVEL_GROUPS.flat();

/** At most this many matches per name; the default is 50. */
const LOOKUP_LIMIT_MAX = 500;
const LOOKUP_LIMIT_DEFAULT = 50;

/** A lower-case letter where a word starts, for capitalizing. */
const CAPITALIZED_WORD = /(^|[\s\-(/"'«])(\p{Ll})/gu;

/**
 * A Georgian name in Latin letters, for showing where a place has no English
 * name: the national system, each word capitalized. "ჭავჭავაძის გამზ." is
 * "Chavchavadzis Gamz.", "წავკისი" is "Tsavkisi". Latin letters stay as they
 * are. Not a key: two spellings of one place can differ here.
 */
export function romanizedName(text: string): string {
  let out = '';
  for (const char of text.normalize('NFKC')) {
    const letter = char.toLowerCase();
    out += ROMAN.get(letter) ?? char;
  }
  return out.replace(
    CAPITALIZED_WORD,
    (_, before: string, first: string) => before + first.toUpperCase(),
  );
}

/** The SQL behind both lookups: for each key in `$1` (a JSON array), its places, at most `$2` each. */
function lookupSql(): string {
  const levels = LOOKUP_LEVEL_ORDER.map((level) => `'${level}'`).join(', ');
  const group = `case ${LOOKUP_LEVEL_GROUPS.map(
    (members, i) =>
      `when p.level in (${members.map((level) => `'${level}'`).join(', ')}) then ${i + 1}`,
  ).join(' ')} end`;
  return `with q as (select distinct key from jsonb_array_elements_text($1::jsonb) as k(key)),
matched as (
  select q.key, p.*,
         case when q.key = any(p.match_keys) then 'exact' else 'partial' end as match,
         row_number() over (
           partition by q.key
           order by (q.key = any(p.match_keys)) desc, ${group}, p.active_listings desc,
                    array_position(array[${levels}], p.level), p.ref
         ) as rank
    from q
    join realestate.public_places p
      on p.match_keys @> array[q.key]
      or exists (select 1 from unnest(p.match_keys) as m(key)
                  where (' ' || m.key || ' ') like ('% ' || q.key || ' %'))
)
select m.key, m.rank, m.match, m.source_id, m.level, m.ref, m.origin, m.code,
       m.name_ka, m.name_en, m.name_roman,
       m.parent_level, m.parent_ref, parent.name_ka as parent_name_ka,
       parent.name_en as parent_name_en, parent.name_roman as parent_name_roman,
       m.latitude, m.longitude, m.point_status,
       m.official_district_ref, official.name_ka as official_name_ka,
       official.name_en as official_name_en, m.official_basis, m.official_shares,
       top.code as official_top_code, top.name_ka as official_top_name_ka,
       top.name_en as official_top_name_en, top.listings as official_top_listings,
       m.active_listings,
       city.ref as city_ref, city.name_ka as city_name_ka, city.name_en as city_name_en,
       city.name_roman as city_name_roman
  from matched m
  left join realestate.public_places parent
    on parent.source_id = m.source_id and parent.level = m.parent_level and parent.ref = m.parent_ref
  left join realestate.public_places official
    on official.source_id = m.source_id and official.level = 'official_district'
   and official.ref = m.official_district_ref
  left join lateral (
    select o.code, o.name_ka, o.name_en, s.listings::integer as listings
      from jsonb_each_text(m.official_shares -> 'by_district') as s(code, listings)
      join realestate.public_places o
        on o.source_id = m.source_id and o.level = 'official_district' and o.code = s.code
     order by s.listings::integer desc, o.code
     limit 1
  ) top on true
  left join realestate.public_places up2
    on up2.source_id = parent.source_id and up2.level = parent.parent_level and up2.ref = parent.parent_ref
  left join realestate.public_places up3
    on up3.source_id = up2.source_id and up3.level = up2.parent_level and up3.ref = up2.parent_ref
  left join lateral (
    -- The nearest city up the chain: a street, a neighbourhood or a station is
    -- at most three levels below one. A recursive walk cost 400 ms a lookup.
    select c.ref, c.name_ka, c.name_en, c.name_roman
      from (values (0, m.level, m.ref, m.name_ka, m.name_en, m.name_roman),
                   (1, parent.level, parent.ref, parent.name_ka, parent.name_en, parent.name_roman),
                   (2, up2.level, up2.ref, up2.name_ka, up2.name_en, up2.name_roman),
                   (3, up3.level, up3.ref, up3.name_ka, up3.name_en, up3.name_roman))
           as c(depth, level, ref, name_ka, name_en, name_roman)
     where c.level = 'city'
     order by c.depth
     limit 1
  ) city on true
 where m.rank <= $2
 order by m.key, m.rank`;
}

function built(
  keys: readonly string[],
  options: { placeholders?: Placeholders; limit?: number },
): BuiltSql {
  const asked = Number.isFinite(options.limit)
    ? Math.trunc(options.limit as number)
    : LOOKUP_LIMIT_DEFAULT;
  const limit = Math.min(Math.max(asked, 1), LOOKUP_LIMIT_MAX);
  const numbered: BuiltSql = { sql: lookupSql(), params: [JSON.stringify(keys), limit] };
  return options.placeholders === 'psycopg' ? toPsycopg(numbered) : numbered;
}

/**
 * The places one name names, on both maps, over `realestate.public_places`
 * (C6). A place matches `exact` when one of its names has the same key, and
 * `partial` when the words come in order inside one ("dighomi" in "Didi
 * Dighomi"). Rows come by `rank`: exact first, then by `LOOKUP_LEVEL_GROUPS`
 * (ss.ge's areas, the official map, stations, streets), the busiest first in
 * each. Each row carries its parent's names, for a street or
 * station its official district's, and for an ss.ge area the official
 * district holding most of its located listings, so a reply can say how the
 * other map sees it. Each row also carries the city it is in (null for a
 * municipality), so "Rustaveli, Batumi" can keep Batumi's street and say when
 * a city has no street of that name. For a text that may name several places, use
 * `placeTextLookupSql`.
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
  return { ...built([key], options), key };
}

/** The most words one place name is taken to have. */
const MAX_NAME_WORDS = 4;
/** What a text may hold: more is cut, so a pasted page cannot become a huge query. */
const MAX_PARTS = 10;
const MAX_PART_WORDS = 12;

/** A text as people write several places: parts split on "/", "," or ";", each a run of words split on spaces. */
export interface PlaceText {
  parts: { text: string; words: string[] }[];
  /** The key of each run of up to `MAX_NAME_WORDS` words, by "part:start:end". */
  runs: ReadonlyMap<string, string>;
}

export function splitPlaceText(text: string): PlaceText {
  const parts = text
    .normalize('NFKC')
    .split(/[/,;]+/u)
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .slice(0, MAX_PARTS)
    .map((part) => ({ text: part, words: part.split(/\s+/u).slice(0, MAX_PART_WORDS) }));
  const runs = new Map<string, string>();
  parts.forEach((part, at) => {
    for (let start = 0; start < part.words.length; start++) {
      for (let end = start + 1; end <= Math.min(part.words.length, start + MAX_NAME_WORDS); end++) {
        const key = nameKey(part.words.slice(start, end).join(' '));
        if (key !== '') runs.set(`${at}:${start}:${end}`, key);
      }
    }
  });
  return { parts, runs };
}

/**
 * The places a whole text names, which may be several ("Vake, Saburtalo",
 * "Temka/Zgvisubani"): the lookup's SQL for every run of words in it. Read
 * the rows with `resolvePlaceText`. Null when no word names anything.
 */
export function placeTextLookupSql(
  text: string,
  options: { placeholders?: Placeholders; limit?: number } = {},
): (BuiltSql & { text: PlaceText }) | null {
  const split = splitPlaceText(text);
  const keys = [...new Set(split.runs.values())];
  if (keys.length === 0) return null;
  return { ...built(keys, options), text: split };
}

/** A row of either lookup's answer, as the database returns it. */
export interface PlaceLookupRow {
  key: string;
  rank: number | string;
  match: 'exact' | 'partial';
  level: string;
  [column: string]: unknown;
}

/** One place name found in a text, with the places it names, best first. */
export interface PlaceTextSegment {
  /** The words as typed. */
  text: string;
  key: string;
  /** `partial` only for a single word no place has as a whole name; null when nothing matched. */
  match: 'exact' | 'partial' | null;
  places: PlaceLookupRow[];
}

/** Levels that make a word a place of its own (anything but a street). */
const AREA_LEVELS: ReadonlySet<string> = new Set(
  LOOKUP_LEVEL_ORDER.filter((level) => level !== 'street'),
);

/**
 * Which places a text names, from `placeTextLookupSql`'s rows. Each part is
 * read left to right, taking the longest run of words that is a place's whole
 * name, as Hermes did (its fix N75, 2026-11-06): words that each name a place
 * by themselves stay that many places, so "Vake Saburtalo" is two
 * sub-districts, while "vake-saburtalo", one word, is ss.ge's district, and
 * "Old Tbilisi", "Didi Dighomi" and "Lisi Lake" are one place each. A single
 * word no place has as a whole name keeps its partial matches.
 */
export function resolvePlaceText(
  text: PlaceText,
  rows: readonly PlaceLookupRow[],
): { parts: { text: string; segments: PlaceTextSegment[] }[] } {
  const byKey = new Map<string, PlaceLookupRow[]>();
  for (const row of [...rows].sort((a, b) => Number(a.rank) - Number(b.rank))) {
    const list = byKey.get(row.key);
    if (list === undefined) byKey.set(row.key, [row]);
    else list.push(row);
  }
  const exact = (key: string) => (byKey.get(key) ?? []).filter((row) => row.match === 'exact');
  const namesAPlace = (key: string | undefined) =>
    key !== undefined && exact(key).some((row) => AREA_LEVELS.has(row.level));

  return {
    parts: text.parts.map((part, at) => {
      const segments: PlaceTextSegment[] = [];
      const run = (start: number, end: number) => text.runs.get(`${at}:${start}:${end}`);
      let start = 0;
      while (start < part.words.length) {
        let end = Math.min(part.words.length, start + MAX_NAME_WORDS);
        for (; end > start + 1; end--) {
          const key = run(start, end);
          if (key === undefined || exact(key).length === 0) continue;
          const words = Array.from({ length: end - start }, (_, i) => start + i);
          if (words.every((word) => namesAPlace(run(word, word + 1)))) continue;
          break;
        }
        const key = run(start, end);
        if (key !== undefined) {
          const hits = exact(key);
          const places = hits.length > 0 ? hits : (byKey.get(key) ?? []);
          segments.push({
            text: part.words.slice(start, end).join(' '),
            key,
            match: hits.length > 0 ? 'exact' : places.length > 0 ? 'partial' : null,
            places,
          });
        }
        start = end;
      }
      return { text: part.text, segments };
    }),
  };
}
