import { stem, tokenize } from '../matching/lexical/text.js';

/**
 * A field for a vacancy whose board states none (Phase 16D): jobs.ge lists
 * title, employer and text but no field, while every hr.ge vacancy names its
 * own (`structured_attributes.specialty`, about 40 top-level fields). So the
 * guess is learnt from hr.ge's labelled vacancies rather than a hand-written
 * keyword list: a multinomial naive Bayes over the title's words, the
 * employer, and the description's words, each kind of word weighted
 * separately.
 *
 * Pure and deterministic: the same examples give the same model, and the same
 * model and listing give the same guess. The taxonomy step trains it from the
 * database on every run, so it follows hr.ge's labels as they grow.
 *
 * Bump `FIELD_GUESS_VERSION` when anything here changes how a guess comes out;
 * it is written with every guess.
 */
export const FIELD_GUESS_VERSION = 'field-guess-v1';

export interface FieldText {
  title: string;
  employer: string | null;
  description: string | null;
}

export interface FieldExample extends FieldText {
  /** The board's own top-level fields; a vacancy with several counts toward each in part. */
  fields: readonly string[];
}

export interface FieldGuessOptions {
  /** How much one title word counts against one description word. */
  titleWeight: number;
  employerWeight: number;
  descriptionWeight: number;
  /** Only the first this many description words are read. */
  descriptionWords: number;
  /** Additive (Laplace) smoothing. */
  smoothing: number;
  /**
   * 0 ignores how common a field is; 1 uses its share as it is. Below 1, a
   * field most vacancies carry (sales) is not guessed on thin evidence.
   */
  priorWeight: number;
}

export const DEFAULT_FIELD_GUESS_OPTIONS: Readonly<FieldGuessOptions> = {
  titleWeight: 3,
  employerWeight: 2,
  descriptionWeight: 0.3,
  descriptionWords: 200,
  smoothing: 0.1,
  priorWeight: 0.5,
};

export interface FieldModel {
  readonly options: Readonly<FieldGuessOptions>;
  readonly fields: readonly string[];
  /** Per field, the log of its smoothed prior share. */
  readonly logPrior: Float64Array;
  /** Feature → per-field log probability. */
  readonly logLikelihood: ReadonlyMap<string, Float64Array>;
  /** Per field, the log probability of a feature never seen with it. */
  readonly logUnseen: Float64Array;
}

export interface FieldGuess {
  field: string;
  /** The guessed field's share of the posterior, 0 to 1. */
  probability: number;
  /** The runner-up and its share, for the evidence. */
  runnerUp: { field: string; probability: number } | null;
}

/** Digits-only and one-letter tokens say nothing about a field. */
function keep(token: string): boolean {
  return token.length > 1 && !/^\d+$/u.test(token);
}

function stems(text: string | null, limit = Number.POSITIVE_INFINITY): string[] {
  if (text === null || text === '') return [];
  const out: string[] = [];
  for (const token of tokenize(text)) {
    if (!keep(token.stem)) continue;
    out.push(token.stem);
    if (out.length >= limit) break;
  }
  return out;
}

/** An employer as one feature: lower-cased, legal-form words and punctuation dropped. */
export function employerKey(employer: string | null): string | null {
  if (employer === null) return null;
  const words = employer
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w !== '' && !LEGAL_FORMS.has(w));
  return words.length === 0 ? null : words.map(stem).join(' ');
}

const LEGAL_FORMS = new Set([
  'შპს',
  'სს',
  'ააიპ',
  'იმ',
  'სსიპ',
  'ltd',
  'llc',
  'jsc',
  'inc',
  'georgia',
  'საქართველო',
]);

/** The features of one listing, each with its weight. Distinct within a kind. */
export function features(
  text: FieldText,
  options: Readonly<FieldGuessOptions> = DEFAULT_FIELD_GUESS_OPTIONS,
): Map<string, number> {
  const out = new Map<string, number>();
  const add = (key: string, weight: number) => {
    if (!out.has(key)) out.set(key, weight);
  };
  for (const s of stems(text.title)) add(`t:${s}`, options.titleWeight);
  const employer = employerKey(text.employer);
  if (employer !== null) add(`e:${employer}`, options.employerWeight);
  for (const s of stems(text.description, options.descriptionWords)) {
    add(`d:${s}`, options.descriptionWeight);
  }
  return out;
}

export function trainFieldModel(
  examples: readonly FieldExample[],
  options: Readonly<FieldGuessOptions> = DEFAULT_FIELD_GUESS_OPTIONS,
): FieldModel {
  const fieldSet = new Set<string>();
  for (const example of examples) for (const f of example.fields) fieldSet.add(f);
  // Sorted so the model does not depend on the order the examples came in.
  const fields = [...fieldSet].sort();
  const index = new Map(fields.map((f, i) => [f, i]));
  const n = fields.length;

  const docs = new Float64Array(n);
  const mass = new Float64Array(n);
  const counts = new Map<string, Float64Array>();
  for (const example of examples) {
    const own = [...new Set(example.fields)];
    if (own.length === 0) continue;
    const share = 1 / own.length;
    const feats = features(example, options);
    for (const field of own) {
      const i = index.get(field) as number;
      docs[i] = (docs[i] as number) + share;
      for (const [key, weight] of feats) {
        let row = counts.get(key);
        if (row === undefined) {
          row = new Float64Array(n);
          counts.set(key, row);
        }
        row[i] = (row[i] as number) + weight * share;
        mass[i] = (mass[i] as number) + weight * share;
      }
    }
  }

  const vocabulary = counts.size;
  const totalDocs = docs.reduce((a, b) => a + b, 0);
  const logPrior = new Float64Array(n);
  const logUnseen = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    logPrior[i] = options.priorWeight * Math.log((docs[i] as number) / totalDocs);
    logUnseen[i] = Math.log(
      options.smoothing / ((mass[i] as number) + options.smoothing * vocabulary),
    );
  }
  const logLikelihood = new Map<string, Float64Array>();
  for (const [key, row] of counts) {
    const logs = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      logs[i] = Math.log(
        ((row[i] as number) + options.smoothing) /
          ((mass[i] as number) + options.smoothing * vocabulary),
      );
    }
    logLikelihood.set(key, logs);
  }
  return { options, fields, logPrior, logLikelihood, logUnseen };
}

/**
 * The most likely field and its share of the posterior, or null when the
 * listing has no feature the model has seen. Whether the share is high enough
 * to show is the caller's threshold.
 */
export function guessField(model: FieldModel, text: FieldText): FieldGuess | null {
  const n = model.fields.length;
  if (n === 0) return null;
  const score = Float64Array.from(model.logPrior);
  let seen = 0;
  for (const [key, weight] of features(text, model.options)) {
    const logs = model.logLikelihood.get(key);
    // A word hr.ge never used says nothing either way; skipping it keeps the
    // score from leaning on how much text each field happens to have.
    if (logs === undefined) continue;
    seen++;
    for (let i = 0; i < n; i++) score[i] = (score[i] as number) + weight * (logs[i] as number);
  }
  if (seen === 0) return null;

  let best = 0;
  let second = -1;
  for (let i = 1; i < n; i++) {
    if ((score[i] as number) > (score[best] as number)) {
      second = best;
      best = i;
    } else if (second === -1 || (score[i] as number) > (score[second] as number)) {
      second = i;
    }
  }
  const top = score[best] as number;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.exp((score[i] as number) - top);
  return {
    field: model.fields[best] as string,
    probability: 1 / sum,
    runnerUp:
      second === -1
        ? null
        : {
            field: model.fields[second] as string,
            probability: Math.exp((score[second] as number) - top) / sum,
          },
  };
}
