/**
 * Splits Markdown that is still being written into the part that will not
 * change any more and the part that might.
 *
 * A reply can run to thousands of words. Parsing all of it again for every
 * few words that arrive would make each update cost more than the last; with
 * this, the settled blocks are parsed once and only the tail is parsed again.
 *
 * A block is settled once a blank line follows it, outside a code fence and
 * not in the middle of a list or a quotation: those are kept together so that
 * numbering, nesting and tight spacing come out as they will in the end.
 */
export interface SplitMarkdown {
  /** Complete blocks, in order. Each is stable once it appears. */
  settled: string[];
  /** The block still being written. */
  tail: string;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const LIST_OR_QUOTE = /^\s*(?:[-*+]\s|\d{1,9}[.)]\s|>)/;
const INDENTED = /^(?: {2,}|\t)\S/;
const TABLE_ROW = /^\s*\|/;

export function splitStreamingMarkdown(source: string): SplitMarkdown {
  const lines = source.split('\n');
  const settled: string[] = [];
  let block: string[] = [];
  let fence: string | null = null;

  const continuesBlock = (index: number): boolean => {
    // Look past the blank lines: does the same structure carry on?
    let next = index;
    while (next < lines.length && lines[next]!.trim() === '') next += 1;
    if (next >= lines.length) return true; // nothing after it yet: it may still grow
    const following = lines[next]!;
    const lastOfBlock = [...block].reverse().find((line) => line.trim() !== '') ?? '';
    const inList = block.some((line) => LIST_OR_QUOTE.test(line));
    if (inList && (LIST_OR_QUOTE.test(following) || INDENTED.test(following))) return true;
    if (TABLE_ROW.test(lastOfBlock) && TABLE_ROW.test(following)) return true;
    return false;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const marker = FENCE.exec(line)?.[1];
    if (fence !== null) {
      block.push(line);
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = null;
      continue;
    }
    if (marker) {
      fence = marker;
      block.push(line);
      continue;
    }
    if (line.trim() === '' && block.some((entry) => entry.trim() !== '')) {
      if (continuesBlock(index)) {
        block.push(line);
        continue;
      }
      settled.push(block.join('\n').replace(/\n+$/, ''));
      block = [];
      continue;
    }
    block.push(line);
  }

  return { settled, tail: block.join('\n') };
}
