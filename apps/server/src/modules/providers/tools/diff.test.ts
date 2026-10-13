import { describe, expect, it } from 'vitest';
import { MAX_PATCH_CHARS, unifiedDiff } from './diff.js';
import { boundResult } from './tool.js';

/** Applies a unified diff produced by `unifiedDiff` to its source, to prove the diff says what happened. */
function apply(before: string, patch: string): string {
  const source = before === '' ? [] : before.replace(/\n$/, '').split('\n');
  const out: string[] = [];
  let cursor = 0;
  const lines = patch.split('\n').slice(2);
  for (let i = 0; i < lines.length; i += 1) {
    const header = /^@@ -(\d+),(\d+) \+\d+,\d+ @@$/.exec(lines[i]!);
    if (!header) throw new Error(`Not a hunk header: ${lines[i]}`);
    const start = Number(header[2]) === 0 ? Number(header[1]) : Number(header[1]) - 1;
    while (cursor < start) out.push(source[cursor++]!);
    for (i += 1; i < lines.length && !lines[i]!.startsWith('@@'); i += 1) {
      const line = lines[i]!;
      if (line.startsWith('+')) out.push(line.slice(1));
      else if (line.startsWith('-')) {
        expect(source[cursor]).toBe(line.slice(1));
        cursor += 1;
      } else {
        expect(source[cursor]).toBe(line.slice(1));
        out.push(source[cursor++]!);
      }
    }
    i -= 1;
  }
  while (cursor < source.length) out.push(source[cursor++]!);
  return out.length === 0 ? '' : `${out.join('\n')}\n`;
}

const numbered = (count: number): string => `${Array.from({ length: count }, (_unused, index) => `line ${index + 1}`).join('\n')}\n`;

describe('unifiedDiff', () => {
  it('shows a new file as all additions', () => {
    const diff = unifiedDiff('notes/new.txt', null, 'one\ntwo\n');
    expect(diff).toMatchObject({ path: 'notes/new.txt', added: 2, removed: 0 });
    expect(diff.patch).toBe('--- /dev/null\n+++ b/notes/new.txt\n@@ -0,0 +1,2 @@\n+one\n+two');
  });

  it('shows one changed line with three lines of context', () => {
    const before = numbered(10);
    const after = before.replace('line 5\n', 'line five\n');
    const diff = unifiedDiff('a.txt', before, after);
    expect(diff).toMatchObject({ added: 1, removed: 1 });
    expect(diff.patch).toBe(['--- a/a.txt', '+++ b/a.txt', '@@ -2,7 +2,7 @@', ' line 2', ' line 3', ' line 4', '-line 5', '+line five', ' line 6', ' line 7', ' line 8'].join('\n'));
  });

  it('keeps changes that are far apart in separate hunks', () => {
    const before = numbered(40);
    const after = before.replace('line 3\n', 'line three\n').replace('line 30\n', '');
    const diff = unifiedDiff('a.txt', before, after);
    expect(diff).toMatchObject({ added: 1, removed: 2 });
    expect(diff.patch.match(/^@@/gm)).toHaveLength(2);
    expect(apply(before, diff.patch)).toBe(after);
  });

  it.each([
    ['an insertion at the start', numbered(5), `new\n${numbered(5)}`],
    ['a deletion at the end', numbered(5), numbered(4)],
    ['everything removed', numbered(3), ''],
    ['an empty file filled', '', numbered(3)],
    ['interleaved edits', 'a\nb\nc\nd\ne\nf\ng\nh\n', 'a\nB\nc\nd2\nd3\ne\ng\nh\ni\n'],
    ['a file without a final newline', 'a\nb', 'a\nc\n'],
  ])('produces a diff that turns the old text into the new one: %s', (_what, before, after) => {
    const diff = unifiedDiff('f', before, after);
    expect(apply(before, diff.patch)).toBe(after === '' || after.endsWith('\n') ? after : `${after}\n`);
  });

  it('reports no change as no hunks', () => {
    const diff = unifiedDiff('same.txt', 'a\nb\n', 'a\nb\n');
    expect(diff).toMatchObject({ added: 0, removed: 0 });
    expect(diff.patch).toBe('--- a/same.txt\n+++ b/same.txt');
  });

  it('gives up on finding the smallest edit for a huge rewrite, and stays bounded', () => {
    const before = Array.from({ length: 3000 }, (_unused, index) => `old ${index}`).join('\n');
    const after = Array.from({ length: 3000 }, (_unused, index) => `new ${index}`).join('\n');
    const started = Date.now();
    const diff = unifiedDiff('big.txt', before, after);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(diff).toMatchObject({ added: 3000, removed: 3000 });
    expect(diff.patch.length).toBeLessThan(MAX_PATCH_CHARS + 100);
    expect(diff.patch).toContain('the rest of this diff is not shown');
  });
});

describe('boundResult', () => {
  it('leaves a short result alone', () => {
    expect(boundResult('all of it', 100)).toEqual({ text: 'all of it', omittedBytes: 0 });
  });

  it('keeps the start and the end of a long result and says how much is missing', () => {
    const text = `START ${'x'.repeat(5000)} END`;
    const bounded = boundResult(text, 400);
    expect(Buffer.byteLength(bounded.text)).toBeLessThanOrEqual(400);
    expect(bounded.text.startsWith('START')).toBe(true);
    expect(bounded.text.endsWith('END')).toBe(true);
    expect(bounded.text).toContain(`${bounded.omittedBytes} bytes left out`);
    expect(bounded.omittedBytes).toBeGreaterThan(4500);
  });

  it('does not leave half a character at the seams', () => {
    const bounded = boundResult('汉字'.repeat(2000), 300);
    expect(bounded.text).not.toContain('�');
    expect(Buffer.byteLength(bounded.text)).toBeLessThanOrEqual(300);
  });
});
