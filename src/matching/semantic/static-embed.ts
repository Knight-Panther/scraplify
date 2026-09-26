/**
 * Static (Model2Vec-style) text embeddings for browser CV matching: a
 * Unigram tokenizer plus an int8 table of one vector per token piece; a
 * text's vector is the mean of its pieces' rows, L2-normalised. No neural
 * network runs, so a CV and ~3,000 titles embed in milliseconds and the
 * whole model is ~8 MB gzipped (spike/semantic E1: the only candidate
 * inside change.md §14's 20 s cold-load gate at 10 Mbps).
 *
 * The table was distilled offline from `multilingual-e5-small` (the model
 * Phase 8A evaluated) and restricted to the pieces Georgian and English
 * vacancy text uses. Browser-safe: pure, no Node import, no fetch.
 */

export interface UnigramVocab {
  /** [piece, log-probability score], indexed by token id. */
  pieces: readonly (readonly [string, number])[];
  unkId: number;
}

export interface StaticTable {
  rows: Int8Array;
  /** Per-dimension dequantisation scale. */
  scales: Float32Array;
  dims: number;
}

const METASPACE = '▁';
/** Ids below this are <s>, <pad>, </s>, <unk>: never part of a text's meaning. */
const FIRST_CONTENT_ID = 4;
// C0/C1 controls and format characters SentencePiece's nmt_nfkc removes.
const CONTROL = /[\p{Cc}\p{Cf}]/gu;
const GEORGIAN_LETTER = /\p{Script=Georgian}/gu;
const MTAVRULI_FIRST = 0x1c90;
const MTAVRULI_LAST = 0x1cbf;

/**
 * Mtavruli capitals (ᲑᲣᲦᲐᲚᲢᲔᲠᲘ) are not in e5's vocabulary at all, so the
 * reference tokenizer turns a capitalised Georgian heading or title into
 * <unk>. Folding them to ordinary Mkhedruli first is a deliberate departure
 * from the reference: the lexical matcher already reads them that way.
 */
function foldMtavruli(char: string): string {
  const code = char.codePointAt(0) ?? 0;
  return code >= MTAVRULI_FIRST && code <= MTAVRULI_LAST ? char.toLowerCase() : char;
}

/**
 * The e5 (XLM-R) tokenizer normalises with SentencePiece's precompiled
 * nmt_nfkc map. For CV and title text that is NFKC with control and format
 * characters removed and whitespace runs collapsed; agreement with the
 * reference tokenizer is measured in `static-embed.test.ts` rather than
 * assumed.
 */
function normalize(text: string): string {
  return text
    .normalize('NFKC')
    .replace(GEORGIAN_LETTER, foldMtavruli)
    .replace(CONTROL, (char) => (char === '\t' || char === '\n' || char === '\r' ? ' ' : ''))
    .replace(/\s+/gu, ' ')
    .trim();
}

export interface Tokenizer {
  encode(text: string): number[];
}

const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/g;

/**
 * `spacePunctuation`: some static models' tokenizers (potion) put spaces
 * around every ASCII punctuation mark before splitting; e5's does not.
 */
export function createTokenizer(
  vocab: UnigramVocab,
  options: { spacePunctuation?: boolean } = {},
): Tokenizer {
  const ids = new Map<string, number>();
  let maxLength = 1;
  let minScore = 0;
  vocab.pieces.forEach(([piece, score], id) => {
    if (id < FIRST_CONTENT_ID) return;
    ids.set(piece, id);
    maxLength = Math.max(maxLength, piece.length);
    minScore = Math.min(minScore, score);
  });
  // SentencePiece scores an unknown character well below any real piece.
  const unkScore = minScore - 10;

  /** Viterbi: the highest-scoring split of one ▁-prefixed word into pieces. */
  function segment(word: string): number[] {
    const chars = Array.from(word);
    const n = chars.length;
    const best = new Float64Array(n + 1).fill(Number.NEGATIVE_INFINITY);
    const from = new Int32Array(n + 1);
    const piece = new Int32Array(n + 1);
    best[0] = 0;
    for (let end = 1; end <= n; end++) {
      for (let start = Math.max(0, end - maxLength); start < end; start++) {
        if (best[start] === Number.NEGATIVE_INFINITY) continue;
        const id = ids.get(chars.slice(start, end).join(''));
        let score: number;
        let token: number;
        if (id !== undefined) {
          score = (best[start] ?? 0) + (vocab.pieces[id]?.[1] ?? unkScore);
          token = id;
        } else if (end - start === 1) {
          score = (best[start] ?? 0) + unkScore;
          token = vocab.unkId;
        } else continue;
        if (score > (best[end] ?? Number.NEGATIVE_INFINITY)) {
          best[end] = score;
          from[end] = start;
          piece[end] = token;
        }
      }
    }
    const out: number[] = [];
    for (let end = n; end > 0; end = from[end] ?? 0) out.push(piece[end] ?? vocab.unkId);
    return out.reverse();
  }

  return {
    encode(text: string): number[] {
      const normalized = normalize(
        options.spacePunctuation ? text.replace(ASCII_PUNCTUATION, (mark) => ` ${mark} `) : text,
      );
      if (normalized === '') return [];
      const out: number[] = [];
      for (const word of normalized.split(' ')) out.push(...segment(`${METASPACE}${word}`));
      return out;
    },
  };
}

/** Mean of the pieces' rows, L2-normalised; all zeros when no piece is known. */
export function embed(ids: readonly number[], table: StaticTable): Float32Array {
  const { rows, scales, dims } = table;
  const sum = new Float32Array(dims);
  let used = 0;
  for (const id of ids) {
    if (id < FIRST_CONTENT_ID || (id + 1) * dims > rows.length) continue;
    const base = id * dims;
    for (let d = 0; d < dims; d++)
      sum[d] = (sum[d] ?? 0) + (rows[base + d] ?? 0) * (scales[d] ?? 0);
    used++;
  }
  if (used === 0) return sum;
  let norm = 0;
  for (const value of sum) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  for (let d = 0; d < dims; d++) sum[d] = (sum[d] ?? 0) / norm;
  return sum;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let d = 0; d < a.length; d++) dot += (a[d] ?? 0) * (b[d] ?? 0);
  return dot;
}

export interface WordPieceVocab {
  /** Token strings indexed by id; continuation pieces start with "##". */
  tokens: readonly string[];
  unkId: number;
  /** BERT uncased: lowercase and strip accents. */
  lowercase: boolean;
}

const MAX_WORD_CHARS = 100;
const COMBINING_MARK = /\p{Mn}/gu;
const WORD_OR_MARK = /[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu;

/**
 * BERT WordPiece: clean and (optionally) lowercase, split on whitespace and
 * punctuation, then greedy longest-match-first pieces with "##" for a
 * word's continuation. Ids below FIRST_CONTENT_ID are never embedded, so a
 * vocabulary laid out that way can reuse `embed`.
 */
export function createWordPieceTokenizer(vocab: WordPieceVocab): Tokenizer {
  const ids = new Map<string, number>();
  vocab.tokens.forEach((token, id) => {
    ids.set(token, id);
  });
  return {
    encode(text: string): number[] {
      let normalized = normalize(text);
      if (vocab.lowercase) {
        normalized = normalized.toLowerCase().normalize('NFD').replace(COMBINING_MARK, '');
      }
      const out: number[] = [];
      for (const [word] of normalized.matchAll(WORD_OR_MARK)) {
        const chars = Array.from(word);
        if (chars.length > MAX_WORD_CHARS) {
          out.push(vocab.unkId);
          continue;
        }
        const pieces: number[] = [];
        let start = 0;
        while (start < chars.length) {
          let end = chars.length;
          let found: number | undefined;
          while (end > start) {
            const piece = (start > 0 ? '##' : '') + chars.slice(start, end).join('');
            found = ids.get(piece);
            if (found !== undefined) break;
            end--;
          }
          if (found === undefined) {
            pieces.length = 0;
            pieces.push(vocab.unkId);
            break;
          }
          pieces.push(found);
          start = end;
        }
        out.push(...pieces);
      }
      return out;
    },
  };
}

export interface StaticModel {
  tokenizer: Tokenizer;
  table: StaticTable;
}

/**
 * Builds a model from the two files `src/matching/models/static-e1.ts`
 * pins: `model.json` (pieces, unknown id, per-dimension scales) and the
 * row-major int8 table, one row per piece. Checksums are the caller's job;
 * this refuses any shape the embedder could not use safely.
 */
export function parseStaticModel(json: unknown, table: Uint8Array): StaticModel {
  if (typeof json !== 'object' || json === null) throw new Error('model.json is not an object');
  const { dims, unkId, scales, pieces } = json as Record<string, unknown>;
  if (typeof dims !== 'number' || !Number.isInteger(dims) || dims <= 0) {
    throw new Error('model.json dims');
  }
  if (!Array.isArray(scales) || scales.length !== dims || !scales.every(Number.isFinite)) {
    throw new Error('model.json scales');
  }
  const valid = (entry: unknown): entry is [string, number] =>
    Array.isArray(entry) &&
    entry.length === 2 &&
    typeof entry[0] === 'string' &&
    Number.isFinite(entry[1]);
  if (!Array.isArray(pieces) || pieces.length <= FIRST_CONTENT_ID || !pieces.every(valid)) {
    throw new Error('model.json pieces');
  }
  if (
    typeof unkId !== 'number' ||
    !Number.isInteger(unkId) ||
    unkId < 0 ||
    unkId >= pieces.length
  ) {
    throw new Error('model.json unkId');
  }
  if (table.byteLength !== pieces.length * dims) throw new Error('table size does not match');
  return {
    tokenizer: createTokenizer({ pieces, unkId }),
    table: {
      rows: new Int8Array(table.buffer, table.byteOffset, table.byteLength),
      scales: Float32Array.from(scales as number[]),
      dims,
    },
  };
}
