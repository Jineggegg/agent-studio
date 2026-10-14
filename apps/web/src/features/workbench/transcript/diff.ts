/**
 * Reads a unified diff into lines that can be drawn: which were added, which
 * removed, which are context, and the line numbers on each side.
 *
 * It is deliberately forgiving — agents produce diffs with and without file
 * headers, with "\ No newline at end of file" markers, sometimes with no hunk
 * header at all — and never throws: text it does not understand is shown as
 * context.
 */
export type DiffLineKind = 'add' | 'remove' | 'context' | 'hunk' | 'file' | 'note';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  /** Line number in the old file (context and removed lines). */
  oldLine: number | null;
  /** Line number in the new file (context and added lines). */
  newLine: number | null;
}

export interface ParsedDiff {
  lines: DiffLine[];
  added: number;
  removed: number;
  /** Changed lines left out because the diff is longer than the limit. */
  hiddenChanges: number;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

export function parseUnifiedDiff(patch: string, options: { maxChangedLines?: number } = {}): ParsedDiff {
  const limit = options.maxChangedLines ?? Number.POSITIVE_INFINITY;
  const lines: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  let added = 0;
  let removed = 0;
  let hiddenChanges = 0;

  const raw = patch.replace(/\r\n/g, '\n').split('\n');
  if (raw[raw.length - 1] === '') raw.pop();

  for (const line of raw) {
    const hunk = HUNK.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      if (added + removed < limit) lines.push({ kind: 'hunk', text: line, oldLine: null, newLine: null });
      continue;
    }
    if (!inHunk && (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('diff ') || line.startsWith('index '))) {
      lines.push({ kind: 'file', text: line, oldLine: null, newLine: null });
      continue;
    }
    if (line.startsWith('\\')) {
      if (added + removed <= limit) lines.push({ kind: 'note', text: line.slice(1).trim(), oldLine: null, newLine: null });
      continue;
    }
    if (line.startsWith('+')) {
      added += 1;
      if (added + removed <= limit) lines.push({ kind: 'add', text: line.slice(1), oldLine: null, newLine: inHunk ? newLine : null });
      else hiddenChanges += 1;
      newLine += 1;
      continue;
    }
    if (line.startsWith('-')) {
      removed += 1;
      if (added + removed <= limit) lines.push({ kind: 'remove', text: line.slice(1), oldLine: inHunk ? oldLine : null, newLine: null });
      else hiddenChanges += 1;
      oldLine += 1;
      continue;
    }
    // Context: a leading space inside a hunk, anything at all outside one.
    if (added + removed < limit) {
      lines.push({ kind: 'context', text: line.startsWith(' ') ? line.slice(1) : line, oldLine: inHunk ? oldLine : null, newLine: inHunk ? newLine : null });
    }
    oldLine += 1;
    newLine += 1;
  }

  return { lines, added, removed, hiddenChanges };
}

/** The first few changed lines of a diff, for the folded preview of an edit. */
export function previewChanges(patch: string, count: number): DiffLine[] {
  return parseUnifiedDiff(patch)
    .lines.filter((line) => line.kind === 'add' || line.kind === 'remove')
    .slice(0, count);
}
