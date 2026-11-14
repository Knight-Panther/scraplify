import { stem, tokenize } from '../matching/lexical/text.js';

/**
 * A city named in a vacancy's own text (Phase 16E): jobs.ge states no city,
 * but most of its vacancies say where the work is ("თბილისში", "Batumi
 * office"). This reads the places hr.ge's own vacancies use, in any Georgian
 * case, from the title and the description. It is reading, not guessing: a
 * place the text never names gives nothing.
 *
 * Bump `CITY_READ_VERSION` when anything here changes what is read; it is
 * written with every reading.
 */
export const CITY_READ_VERSION = 'city-read-v1';

/**
 * hr.ge's places that are not a place one can name in a sentence: abroad,
 * nationwide, and Tbilisi's outskirts (read as Tbilisi instead).
 */
const NOT_NAMED = new Set(['საზღვარგარეთ', 'საქართველოს მაშტაბით', 'თბილისის შემოგარენი']);

/** Words a place name is never on its own: "მუნიციპალიტეტი" in "ქედის მუნიციპალიტეტი". */
const DROPPED_WORDS = new Set([stem('მუნიციპალიტეტი')]);

/**
 * The word after a place name that makes it something else: a street or an
 * avenue named after a city (Tbilisi has a Kutaisi Street), a university
 * (Tbilisi State University is where someone studied, not where the job is).
 */
const NOT_A_PLACE_AFTER = new Set(
  [
    'ქუჩა',
    'ქ',
    'გამზირი',
    'ხეივანი',
    'შესახვევი',
    'ჩიხი',
    'უნივერსიტეტი',
    'სახელმწიფო',
    'street',
    'st',
    'avenue',
    'ave',
    'university',
    'state',
  ].map(stem),
);

/** The shortest stem matched: shorter ones ("ონი") collide with ordinary words. */
const MIN_STEM = 3;

export interface CityReader {
  /** Stem of the place's (first) word → the place as hr.ge writes it. */
  readonly byStem: ReadonlyMap<string, string>;
}

/**
 * A reader for hr.ge's places, plus Latin spellings (`latin`: place → its
 * English name, as Browse shows it).
 */
export function cityReader(
  places: readonly string[],
  latin: ReadonlyMap<string, string> = new Map(),
): CityReader {
  const byStem = new Map<string, string>();
  const add = (name: string, place: string) => {
    const words = tokenize(name)
      .map((t) => t.stem)
      .filter((s) => !DROPPED_WORDS.has(s));
    const key = words.join(' ');
    if (words.length === 0 || (words.length === 1 && key.length < MIN_STEM)) return;
    // The first place to claim a key keeps it, so the order places come in decides a clash.
    if (!byStem.has(key)) byStem.set(key, place);
  };
  for (const place of places) {
    if (NOT_NAMED.has(place)) continue;
    add(place, place);
    const english = latin.get(place);
    if (english !== undefined) add(english, place);
  }
  return { byStem };
}

/**
 * The places a vacancy's text names, in the order it first names them; at
 * most `limit`, since a list of every branch says little about one vacancy.
 * Returns an empty list when the text names more than `limit` places.
 */
export function readCities(
  reader: CityReader,
  text: { title: string; description: string | null },
  limit = 3,
): string[] {
  const stems = tokenize(`${text.title}\n${text.description ?? ''}`).map((t) => t.stem);
  const found: string[] = [];
  for (let i = 0; i < stems.length; i++) {
    // Two-word names first ("ქედის მუნიციპალიტეტი" is one word once the second is dropped).
    const two = i + 1 < stems.length ? `${stems[i]} ${stems[i + 1]}` : null;
    let place: string | undefined;
    let width = 1;
    if (two !== null && reader.byStem.has(two)) {
      place = reader.byStem.get(two);
      width = 2;
    } else {
      place = reader.byStem.get(stems[i] as string);
    }
    if (place === undefined) continue;
    const next = stems[i + width];
    if (next !== undefined && NOT_A_PLACE_AFTER.has(next)) continue;
    if (!found.includes(place)) found.push(place);
  }
  return found.length > limit ? [] : found;
}
