import { MEMORY_LIMITS, type MemoryHighlights } from '@agent-studio/protocol';

/**
 * Turning what somebody typed into something the index can answer, and the
 * answer into ranked results with highlighted snippets.
 *
 * The index is an FTS5 table with the `trigram` tokenizer: every run of three
 * characters is a token, so a quoted string of three or more characters finds
 * that exact substring — in the middle of a word, and in scripts that do not
 * put spaces between words. That gives prefix matching ("depl" finds
 * "deploy") and Chinese/Japanese/Korean search without a word segmenter.
 * Strings shorter than three characters cannot be found that way; those are
 * looked up with LIKE instead.
 *
 * User input never becomes FTS syntax: every unit is emitted as a quoted FTS
 * string (see {@link ftsQuote}), and the expression is passed as a bound
 * parameter.
 */

export interface SearchUnit {
  /** Lower-cased text to look for. */
  readonly text: string;
  /** How much a hit counts: the whole phrase 3, a typed word 2, a derived fragment less. */
  readonly weight: number;
  /** False for fragments derived from a longer word. */
  readonly typed: boolean;
}

export interface ParsedQuery {
  /** The query as it is searched: trimmed, single-spaced. */
  readonly text: string;
  readonly units: readonly SearchUnit[];
  /** FTS5 MATCH expression over the units of three or more characters; null when there are none. */
  readonly match: string | null;
  /** Units of one or two characters, for LIKE. */
  readonly short: readonly string[];
}

const MAX_TERMS = 10;
const MAX_TERM_CHARS = 64;
const MAX_MATCH_UNITS = 28;
const MAX_SHORT_UNITS = 8;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;
/** Scripts written without spaces between words. */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const WORDS =
  /\p{Script=Han}+|[\p{Script=Hiragana}\p{Script=Katakana}ー]+|\p{Script=Hangul}+|(?:(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])[\p{L}\p{N}_])+/gu;

const STOP_WORDS = new Set(
  (
    'the and for are but not you all any can had her was one our out has him his how its may new now see two way who did get let put say she too use ' +
    'that with have this will your from they know want been good much some time very when come here just like long make many more only over such take than them well were what ' +
    'about after again could every first other should their there these thing think those under where which while would please thanks thank does into also then tell need'
  ).split(' '),
);

/**
 * Characters that carry grammar rather than meaning in Chinese. A
 * three-character piece made mostly of these ("什么时", "我们的") says nothing
 * about what a message is about, so it is not looked for.
 */
const FUNCTION_CHARACTERS = new Set('的了是在我你他她它们什么怎时候可以吗呢吧啊和与及或而但如果因为所一个这那就也都要会能不没很还把被给让对从到有着过得地之其此些每各请问想'.split(''));

const characters = (text: string): string[] => [...text];

const functionCharacterCount = (text: string): number => characters(text).filter((character) => FUNCTION_CHARACTERS.has(character)).length;

/**
 * A string as an FTS5 string literal: wrapped in double quotes with embedded
 * quotes doubled. Inside the quotes FTS5 has no operators, column filters,
 * prefix stars or parentheses — it is all text.
 */
export function ftsQuote(text: string): string {
  return `"${text.replace(CONTROL, ' ').replace(/"/g, '""')}"`;
}

/** Any-of expression over literal strings. Strings shorter than three characters are left out: the trigram index cannot hold them. */
export function ftsExpression(texts: readonly string[]): string | null {
  const usable = texts.filter((text) => characters(text.replace(CONTROL, ' ')).length >= 3);
  return usable.length === 0 ? null : usable.map(ftsQuote).join(' OR ');
}

function slidingGrams(text: string, size: number): string[] {
  const all = characters(text);
  const grams: string[] = [];
  for (let index = 0; index + size <= all.length; index += 1) grams.push(all.slice(index, index + size).join(''));
  return grams;
}

function finish(text: string, units: SearchUnit[]): ParsedQuery {
  const seen = new Set<string>();
  const unique = units.filter((unit) => {
    if (unit.text.length === 0 || seen.has(unit.text)) return false;
    seen.add(unit.text);
    return true;
  });
  const long = unique.filter((unit) => characters(unit.text).length >= 3).slice(0, MAX_MATCH_UNITS);
  const short = unique.filter((unit) => characters(unit.text).length < 3).slice(0, MAX_SHORT_UNITS);
  return { text, units: [...long, ...short].sort((a, b) => b.weight - a.weight), match: ftsExpression(long.map((unit) => unit.text)), short: short.map((unit) => unit.text) };
}

/**
 * Reads a search-box query. The words are looked for any-of; a note that has
 * more of them, or has them in its title, keywords or tags, ranks higher.
 *
 * - The whole text counts most when it is found as typed.
 * - Each word (up to ten) is looked for anywhere, so it also matches as a prefix.
 * - A word in an unspaced script longer than three characters is also looked
 *   for by its three- and two-character pieces, at a low weight, because the
 *   note may put other words between the ones typed.
 * - A single character is searched only when it is the whole query.
 */
export function parseQuery(raw: string): ParsedQuery {
  const text = raw.normalize('NFC').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, MEMORY_LIMITS.queryChars);
  if (text === '') return { text, units: [], match: null, short: [] };

  const terms: string[] = [];
  for (const word of text.toLowerCase().split(' ')) {
    // Quotes, brackets and the like around a word are not part of it.
    const term = characters(word.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}]+$/u, '')).slice(0, MAX_TERM_CHARS).join('');
    if (term && !terms.includes(term)) terms.push(term);
    if (terms.length >= MAX_TERMS) break;
  }
  // Nothing but punctuation: search for it as it stands.
  if (terms.length === 0) terms.push(characters(text.toLowerCase()).slice(0, MAX_TERM_CHARS).join(''));

  const units: SearchUnit[] = [];
  if (terms.length > 1) units.push({ text: text.toLowerCase(), weight: 3, typed: true });
  const usable = terms.length > 1 ? terms.filter((term) => characters(term).length > 1) : terms;
  for (const term of usable) units.push({ text: term, weight: 2, typed: true });

  const fragments: SearchUnit[] = [];
  for (const term of usable) {
    if (!UNSPACED.test(term)) continue;
    const length = characters(term).length;
    if (length > 3) for (const gram of slidingGrams(term, 3)) fragments.push({ text: gram, weight: 0.5, typed: false });
    if (length > 2) for (const gram of slidingGrams(term, 2)) fragments.push({ text: gram, weight: 0.4, typed: false });
  }
  const grams3 = fragments.filter((unit) => characters(unit.text).length === 3).slice(0, 16);
  const grams2 = fragments.filter((unit) => characters(unit.text).length === 2).slice(0, 6);
  return finish(text, [...units, ...grams3, ...grams2]);
}

/**
 * Reads a chat message for the notes it might be about. Unlike a search-box
 * query this is a whole sentence or more: filler words are dropped and the
 * longest words are kept. Unspaced text is cut into three-character pieces,
 * leaving out pieces that are mostly grammar; each piece counts like a word
 * of the message, at half the weight. Looks only at the start of a long message.
 */
export function contextUnits(message: string): ParsedQuery {
  const text = message.slice(0, 8_000).normalize('NFC').replace(CONTROL, ' ').slice(0, 4_000).toLowerCase();
  const words: string[] = [];
  const pieces: SearchUnit[] = [];
  for (const match of text.matchAll(WORDS)) {
    const word = match[0];
    const length = characters(word).length;
    if (UNSPACED.test(word)) {
      if (length >= 2 && length <= 4 && functionCharacterCount(word) < length) pieces.push({ text: word, weight: 2, typed: true });
      if (length > 3) {
        for (const gram of slidingGrams(characters(word).slice(0, 66).join(''), 3)) {
          if (functionCharacterCount(gram) < 2) pieces.push({ text: gram, weight: 1, typed: true });
        }
      }
    } else if (length >= 3 && length <= MAX_TERM_CHARS && !STOP_WORDS.has(word) && !/^\d{1,3}$/.test(word)) {
      if (!words.includes(word)) words.push(word);
    }
    if (words.length + pieces.length > 400) break;
  }
  const kept = [...words].sort((a, b) => b.length - a.length).slice(0, 12);
  const units: SearchUnit[] = kept.map((word) => ({ text: word, weight: 2, typed: true }));
  return finish(text.replace(/\s+/g, ' ').trim().slice(0, 200), [...units, ...pieces]);
}

const isWordCharacter = (character: string | undefined): boolean => character !== undefined && /[\p{L}\p{N}_]/u.test(character) && !UNSPACED.test(character);

/**
 * Whether `text` mentions `word` (both lower-cased). In unspaced scripts any
 * occurrence counts; elsewhere the occurrence must be a word of its own, so
 * that the keyword "api" is not found in "capital".
 */
export function mentions(text: string, word: string): boolean {
  if (word === '') return false;
  const first = characters(word)[0];
  const last = characters(word).at(-1);
  for (let from = text.indexOf(word); from !== -1; from = text.indexOf(word, from + 1)) {
    const before = from === 0 ? undefined : characters(text.slice(Math.max(0, from - 2), from)).at(-1);
    const after = characters(text.slice(from + word.length, from + word.length + 2))[0];
    const openEnded = (edge: string | undefined, neighbour: string | undefined) => !isWordCharacter(edge) || !isWordCharacter(neighbour);
    if (openEnded(first, before) && openEnded(last, after)) return true;
  }
  return false;
}

export interface SearchableFields {
  /** All lower-cased. */
  readonly title: string;
  readonly tags: string;
  readonly keywords: string;
  readonly body: string;
}

function countOccurrences(haystack: string, needle: string, max: number): number {
  let count = 0;
  for (let from = haystack.indexOf(needle); from !== -1 && count < max; from = haystack.indexOf(needle, from + needle.length)) count += 1;
  return count;
}

/**
 * How well a note answers a query. A hit in the title weighs most, then the
 * keyword line, then tags, then the body (where repeats count a little).
 * Every typed word that is found adds a bonus, and finding all of them adds
 * another, so notes that cover the query come before notes that repeat one word.
 */
export function scoreFields(fields: SearchableFields, query: ParsedQuery): number {
  let score = 0;
  let typed = 0;
  let typedFound = 0;
  for (const unit of query.units) {
    if (unit.typed) typed += 1;
    let hit = 0;
    if (fields.title.includes(unit.text)) hit += 8;
    if (fields.keywords.includes(unit.text)) hit += 6;
    if (fields.tags.includes(unit.text)) hit += 5;
    hit += countOccurrences(fields.body, unit.text, 3);
    if (hit === 0) continue;
    score += hit * unit.weight;
    if (unit.typed) typedFound += 1;
  }
  if (score === 0) return 0;
  score += typedFound * 4;
  if (typed > 0 && typedFound === typed) score += 6;
  if (fields.title === query.text.toLowerCase()) score += 20;
  return score;
}

/** Lower-cases only when that keeps every offset where it was (it does, except for a few rare letters). */
export function foldCase(text: string): string {
  const lower = text.toLowerCase();
  return lower.length === text.length ? lower : text;
}

/** Where the units occur in `text`: merged, sorted, half-open ranges of UTF-16 offsets. */
export function findHighlights(text: string, units: readonly SearchUnit[], maxRanges = 24): MemoryHighlights {
  const folded = foldCase(text);
  const ranges: [number, number][] = [];
  for (const unit of units) {
    for (let from = folded.indexOf(unit.text); from !== -1 && ranges.length < 200; from = folded.indexOf(unit.text, from + unit.text.length)) {
      ranges.push([from, from + unit.text.length]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged.slice(0, maxRanges);
}

const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/**
 * A window of `plain` (already free of Markdown markers) around the first
 * occurrence of the most important unit that occurs, with the places to
 * highlight. Starts at the beginning when nothing occurs in the text.
 */
export function makeSnippet(plain: string, units: readonly SearchUnit[], maxChars: number = MEMORY_LIMITS.snippetChars): { text: string; highlights: MemoryHighlights } {
  const folded = foldCase(plain);
  let anchor = -1;
  for (const unit of units) {
    anchor = folded.indexOf(unit.text);
    if (anchor !== -1) break;
  }
  let start = Math.max(0, anchor - Math.min(60, Math.floor(maxChars / 4)));
  if (start > 0) {
    // Begin at a word when one starts nearby.
    const space = plain.indexOf(' ', start);
    if (space !== -1 && space < anchor && space - start <= 24) start = space + 1;
    if (isLowSurrogate(plain.charCodeAt(start))) start += 1;
  }
  let end = Math.min(plain.length, start + maxChars);
  if (end < plain.length && isLowSurrogate(plain.charCodeAt(end))) end -= 1;

  const prefix = start > 0 ? '…' : '';
  const window = plain.slice(start, end);
  const text = `${prefix}${window}${end < plain.length ? '…' : ''}`;
  const highlights = findHighlights(window, units).map(([from, to]): [number, number] => [from + prefix.length, to + prefix.length]);
  return { text, highlights };
}
