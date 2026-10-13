import type { FileDiff } from '@agent-studio/protocol';

/**
 * A unified diff of one file, for showing a change before it is approved and
 * after it was made. It is a preview for people, not input for `patch`: a
 * missing newline at the end of a file is not marked.
 *
 * Lines are compared with Myers' algorithm after the common start and end are
 * set aside. A change too large to compare cheaply (more than
 * {@link MAX_EDIT_DISTANCE} differing lines in the middle) is shown as "these
 * lines out, those lines in" instead of being searched for the smallest edit.
 */

const CONTEXT_LINES = 3;
const MAX_EDIT_DISTANCE = 1_000;
export const MAX_PATCH_CHARS = 40_000;

type Op = { readonly kind: 'same' | 'remove' | 'add'; readonly line: string };

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** The edit script between two line arrays, or null when it is longer than the cap. */
function myers(a: readonly string[], b: readonly string[]): Op[] | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = max;
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found === -1; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  if (found === -1) return null;

  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d -= 1) {
    const previous = trace[d]!;
    const k = x - y;
    const down = k === -d || (k !== d && previous[offset + k - 1]! < previous[offset + k + 1]!);
    const prevK = down ? k + 1 : k - 1;
    const prevX = previous[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ kind: 'same', line: a[x - 1]! });
      x -= 1;
      y -= 1;
    }
    if (down) {
      ops.push({ kind: 'add', line: b[y - 1]! });
      y -= 1;
    } else {
      ops.push({ kind: 'remove', line: a[x - 1]! });
      x -= 1;
    }
  }
  while (x > 0 && y > 0) {
    ops.push({ kind: 'same', line: a[x - 1]! });
    x -= 1;
    y -= 1;
  }
  return ops.reverse();
}

function editScript(before: readonly string[], after: readonly string[]): Op[] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore -= 1;
    endAfter -= 1;
  }
  const middleBefore = before.slice(start, endBefore);
  const middleAfter = after.slice(start, endAfter);
  const middle =
    myers(middleBefore, middleAfter) ??
    [...middleBefore.map((line): Op => ({ kind: 'remove', line })), ...middleAfter.map((line): Op => ({ kind: 'add', line }))];
  return [
    ...before.slice(0, start).map((line): Op => ({ kind: 'same', line })),
    ...middle,
    ...before.slice(endBefore).map((line): Op => ({ kind: 'same', line })),
  ];
}

/**
 * `before` is null for a file that does not exist yet. `path` is shown as
 * written (project-relative, forward slashes).
 */
export function unifiedDiff(path: string, before: string | null, after: string): FileDiff & { patch: string } {
  const oldLines = before === null ? [] : splitLines(before);
  const newLines = splitLines(after);
  const ops = editScript(oldLines, newLines);
  const added = ops.filter((op) => op.kind === 'add').length;
  const removed = ops.filter((op) => op.kind === 'remove').length;

  const out: string[] = [before === null ? '--- /dev/null' : `--- a/${path}`, `+++ b/${path}`];
  // Group changes into hunks with a little context around each.
  let index = 0;
  let oldLine = 1;
  let newLine = 1;
  while (index < ops.length) {
    // Skip to the next change.
    let next = index;
    while (next < ops.length && ops[next]!.kind === 'same') next += 1;
    if (next >= ops.length) break;
    const from = Math.max(index, next - CONTEXT_LINES);
    oldLine += from - index;
    newLine += from - index;
    // Extend until a run of unchanged lines long enough to end the hunk.
    let to = next;
    let quiet = 0;
    for (let k = next; k < ops.length; k += 1) {
      if (ops[k]!.kind === 'same') {
        quiet += 1;
        if (quiet > CONTEXT_LINES * 2) break;
      } else {
        quiet = 0;
        to = k;
      }
    }
    const end = Math.min(ops.length, to + 1 + CONTEXT_LINES);
    const hunk = ops.slice(from, end);
    const oldCount = hunk.filter((op) => op.kind !== 'add').length;
    const newCount = hunk.filter((op) => op.kind !== 'remove').length;
    out.push(`@@ -${oldCount === 0 ? oldLine - 1 : oldLine},${oldCount} +${newCount === 0 ? newLine - 1 : newLine},${newCount} @@`);
    for (const op of hunk) out.push(`${op.kind === 'same' ? ' ' : op.kind === 'add' ? '+' : '-'}${op.line}`);
    oldLine += oldCount;
    newLine += newCount;
    index = end;
  }

  let patch = out.join('\n');
  if (patch.length > MAX_PATCH_CHARS) patch = `${patch.slice(0, MAX_PATCH_CHARS)}\n… (the rest of this diff is not shown)`;
  return { path, added, removed, patch };
}
