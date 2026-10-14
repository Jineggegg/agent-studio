import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff, previewChanges } from './diff';
import { parseFileReference } from './links';
import { splitStreamingMarkdown } from './streaming';
import { changeCounts, collapseStack, countNestedTools, describeTool, filePathOf, tailOf, tidyToolName } from './tools';

describe('unified diffs', () => {
  const patch = ['--- a/src/app.ts', '+++ b/src/app.ts', '@@ -12,4 +12,5 @@ function start() {', ' const a = 1;', '-const b = 2;', '+const b = 3;', '+const c = 4;', ' return a;', '\\ No newline at end of file', ''].join('\n');

  it('labels every line and numbers both sides', () => {
    const diff = parseUnifiedDiff(patch);
    expect(diff.lines.map((line) => [line.kind, line.oldLine, line.newLine])).toEqual([
      ['file', null, null],
      ['file', null, null],
      ['hunk', null, null],
      ['context', 12, 12],
      ['remove', 13, null],
      ['add', null, 13],
      ['add', null, 14],
      ['context', 14, 15],
      ['note', null, null],
    ]);
    expect(diff.lines[4]!.text).toBe('const b = 2;');
    expect([diff.added, diff.removed, diff.hiddenChanges]).toEqual([2, 1, 0]);
  });

  it('shows the first changed lines of a long diff and counts the rest', () => {
    const long = ['@@ -1,400 +1,400 @@', ...Array.from({ length: 400 }, (_, index) => `+line ${index}`)].join('\n');
    const diff = parseUnifiedDiff(long, { maxChangedLines: 300 });
    expect(diff.lines.filter((line) => line.kind === 'add')).toHaveLength(300);
    expect(diff.added).toBe(400);
    expect(diff.hiddenChanges).toBe(100);
  });

  it.each([
    ['no hunk header', '+added\n-removed\n same', ['add', 'remove', 'context']],
    ['windows line endings', '@@ -1 +1 @@\r\n-a\r\n+b\r\n', ['hunk', 'remove', 'add']],
    ['nothing at all', '', []],
    ['prose instead of a diff', 'The file was rewritten.', ['context']],
  ])('does not choke on %s', (_name, input, kinds) => {
    expect(parseUnifiedDiff(input).lines.map((line) => line.kind)).toEqual(kinds);
  });

  it('previews only changed lines', () => {
    expect(previewChanges(patch, 2).map((line) => [line.kind, line.text])).toEqual([
      ['remove', 'const b = 2;'],
      ['add', 'const b = 3;'],
    ]);
  });
});

describe('naming a tool call', () => {
  it.each([
    [{ name: 'Bash', kind: 'execute', title: 'Run npm test', input: { command: 'npm test -- --watch=false\necho done' } }, 'workbench.tool.verb.execute', 'npm test -- --watch=false'],
    [{ name: 'Read', kind: 'read', title: 'Read src/app.ts', input: { file_path: 'src/app.ts' } }, 'workbench.tool.verb.read', 'src/app.ts'],
    [{ name: 'Edit', kind: 'edit', title: 'Edit src/app.ts', input: { path: 'src/app.ts' } }, 'workbench.tool.verb.edit', 'src/app.ts'],
    [{ name: 'Grep', kind: 'search', title: 'Search', input: { pattern: 'TODO', path: 'src' } }, 'workbench.tool.verb.search', 'TODO — src'],
    [{ name: 'WebFetch', kind: 'fetch', title: 'Fetch', input: { url: 'https://example.com/a' } }, 'workbench.tool.verb.fetch', 'https://example.com/a'],
    [{ name: 'Task', kind: 'agent', title: 'Research', input: { description: 'Research the schema' } }, 'workbench.tool.verb.agent', 'Research the schema'],
    // No conventional argument: the adapter's own words.
    [{ name: 'Edit', kind: 'edit', title: 'Rewrite the config', input: {} }, 'workbench.tool.verb.edit', 'Rewrite the config'],
    // Unknown tools keep their own name and show their first plain argument.
    [{ name: 'mcp__github__create_issue', kind: 'other', title: 'mcp__github__create_issue', input: { repo: 'a/b', body: 'x' } }, null, 'a/b'],
    [{ name: 'Mystery', kind: 'other', title: 'Mystery', input: null }, null, ''],
  ] as const)('%o', (tool, verb, target) => {
    const description = describeTool(tool);
    expect(description.verb).toBe(verb);
    expect(description.target).toBe(target);
  });

  it('shows tools from external servers as "tool · server"', () => {
    expect(tidyToolName('mcp__github__create_issue')).toBe('create_issue · github');
    expect(tidyToolName('Bash')).toBe('Bash');
  });

  it('adds up the lines an edit changed', () => {
    expect(changeCounts({ diffs: [] })).toBeNull();
    expect(changeCounts({ diffs: [{ path: 'a', added: 3, removed: 1 }, { path: 'b', added: 2, removed: 4 }] })).toEqual({ added: 5, removed: 5 });
  });

  it('counts the calls of a sub-agent, however deep', () => {
    const tool = (children: unknown[] = []) => ({ type: 'tool', children }) as never;
    expect(countNestedTools([tool([tool(), { type: 'thinking' } as never, tool([tool()])]), { type: 'prose' } as never])).toBe(4);
  });
});

describe('the file a call is about', () => {
  it.each([
    ['a read', { kind: 'read', input: { file_path: 'src/app.ts' } }, 'src/app.ts'],
    ['an edit', { kind: 'edit', input: { path: 'README.md', old: 'a', new: 'b' } }, 'README.md'],
    ['a command, which is not about one file', { kind: 'execute', input: { command: 'cat src/app.ts' } }, null],
    ['a read that names none', { kind: 'read', input: {} }, null],
    ['a path too long to have been kept whole', { kind: 'read', input: { path: `${'deep/'.repeat(60)}file.ts` } }, null],
  ] as const)('%s', (_name, tool, expected) => {
    expect(filePathOf(tool)).toBe(expected);
  });
});

describe('a link in what the agent wrote', () => {
  it.each([
    ['src/app.ts', { path: 'src/app.ts' }],
    ['./docs/plan.md', { path: 'docs/plan.md' }],
    ['src/app.ts#L12', { path: 'src/app.ts', line: 12 }],
    ['src/app.ts#L12-L20', { path: 'src/app.ts', line: 12 }],
    ['server/main.go:40', { path: 'server/main.go', line: 40 }],
    ['server/main.go:40:7', { path: 'server/main.go', line: 40 }],
    ['docs/My%20notes.md', { path: 'docs/My notes.md' }],
    ['/home/me/project/README.md', { path: '/home/me/project/README.md' }],
    ['a/b.ts?raw=1#L3', { path: 'a/b.ts', line: 3 }],
    ['README.md#usage', { path: 'README.md' }],
    // Not files: a heading on this page, a web address, nothing at all.
    ['#usage', null],
    ['https://example.com/a.ts', null],
    ['//example.com/a.ts', null],
    ['', null],
    ['100%.md', { path: '100%.md' }],
  ] as const)('%s', (href, expected) => {
    expect(parseFileReference(href)).toEqual(expected);
  });
});

describe('long stacks and long output', () => {
  it('shows a stack of up to six rows whole', () => {
    expect(collapseStack([1, 2, 3, 4, 5, 6])).toEqual({ head: [1, 2, 3, 4, 5, 6], hidden: [], tail: [] });
  });

  it('folds the middle of a longer one: first two, last three', () => {
    expect(collapseStack([1, 2, 3, 4, 5, 6, 7, 8, 9])).toEqual({ head: [1, 2], hidden: [3, 4, 5, 6], tail: [7, 8, 9] });
  });

  it('keeps the end of long output and says how much came before', () => {
    const text = Array.from({ length: 2000 }, (_, index) => `line ${index}`).join('\n');
    const tail = tailOf(text, 1000);
    expect(tail.text.length).toBeLessThanOrEqual(1000);
    expect(tail.text.startsWith('line ')).toBe(true);
    expect(tail.omitted + tail.text.length).toBe(text.length);
    expect(tailOf('short', 1000)).toEqual({ text: 'short', omitted: 0 });
  });
});

describe('splitting Markdown that is still being written', () => {
  it('settles a paragraph once the next block has begun', () => {
    expect(splitStreamingMarkdown('First paragraph.\n\nSecond para')).toEqual({ settled: ['First paragraph.'], tail: 'Second para' });
  });

  it('does not settle the last block, even after a blank line: it may still grow', () => {
    expect(splitStreamingMarkdown('Only one.\n\n')).toEqual({ settled: [], tail: 'Only one.\n\n' });
  });

  it('never cuts inside a code fence', () => {
    const source = 'Intro.\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nAfter';
    expect(splitStreamingMarkdown(source)).toEqual({ settled: ['Intro.', '```ts\nconst a = 1;\n\nconst b = 2;\n```'], tail: 'After' });
    // An unclosed fence keeps everything after it in the tail.
    expect(splitStreamingMarkdown('Intro.\n\n```ts\nconst a = 1;\n\nconst b').settled).toEqual(['Intro.']);
  });

  it('keeps a list, its nested items and a table together', () => {
    const list = '1. one\n\n2. two\n   - nested\n\n3. three\n\nDone.';
    expect(splitStreamingMarkdown(list)).toEqual({ settled: ['1. one\n\n2. two\n   - nested\n\n3. three'], tail: 'Done.' });
    const table = '| a | b |\n| - | - |\n| 1 | 2 |\n\nAfter';
    expect(splitStreamingMarkdown(table).settled).toEqual(['| a | b |\n| - | - |\n| 1 | 2 |']);
  });

  it('gives back the whole source, in order', () => {
    const source = '# Title\n\nPara one.\n\n- a\n- b\n\n```\ncode\n```\n\nTail';
    const { settled, tail } = splitStreamingMarkdown(source);
    expect([...settled, tail].join('\n\n')).toBe(source);
  });

  it('costs the same for the settled part however long the reply gets', () => {
    const paragraphs = Array.from({ length: 200 }, (_, index) => `Paragraph ${index}.`);
    const first = splitStreamingMarkdown(paragraphs.join('\n\n'));
    const second = splitStreamingMarkdown(`${paragraphs.join('\n\n')} and a few more words`);
    // Everything but the tail is identical text: memoised rendering skips it.
    expect(second.settled).toEqual(first.settled);
    expect(second.tail).toBe('Paragraph 199. and a few more words');
  });
});
