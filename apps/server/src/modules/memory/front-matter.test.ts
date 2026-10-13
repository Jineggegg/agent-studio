import { describe, expect, it } from 'vitest';
import { MAX_NOTE_FILE_BYTES, parseNoteFile, parseNoteText, serialiseNote, splitKeywordLine, trimBlankEdges, type NoteDraft } from './front-matter.js';

const encode = (text: string) => new TextEncoder().encode(text);

const draft = (overrides: Partial<NoteDraft> = {}): NoteDraft => ({
  title: 'Deploy rules',
  tags: ['deploy', 'ops'],
  author: 'claude-code',
  created: Date.UTC(2026, 0, 5, 9, 30),
  updated: Date.UTC(2026, 0, 7, 16, 2, 11),
  body: 'Releases go out on Tuesdays.\n\nNever on a Friday.',
  keywords: ['部署', 'release'],
  ...overrides,
});

/** Writes a note and reads it back; what comes back must be what went in. */
function roundTrip(input: NoteDraft) {
  const text = serialiseNote(input);
  const parsed = parseNoteText(text);
  expect(parsed.title).toBe(input.title);
  expect(parsed.tags).toEqual([...input.tags]);
  expect(parsed.author).toBe(input.author);
  expect(parsed.created).toBe(input.created);
  expect(parsed.updated).toBe(input.updated);
  expect(parsed.body).toBe(input.body);
  expect(parsed.keywords).toEqual([...input.keywords]);
  expect(parsed.extra).toEqual([...(input.extra ?? [])]);
  // Writing what was read gives the same file: the format is stable.
  expect(serialiseNote({ ...input, ...parsed, title: parsed.title!, created: parsed.created!, updated: parsed.updated! })).toBe(text);
  return text;
}

describe('writing and reading a note', () => {
  it('writes a plain Markdown file with a small header', () => {
    expect(serialiseNote(draft())).toBe(
      [
        '---',
        'title: Deploy rules',
        'tags: [deploy, ops]',
        'author: claude-code',
        'created: 2026-01-05T09:30:00.000Z',
        'updated: 2026-01-07T16:02:11.000Z',
        '---',
        '',
        'Releases go out on Tuesdays.',
        '',
        'Never on a Friday.',
        '',
        'Keywords: 部署 release',
        '',
      ].join('\n'),
    );
  });

  it('round-trips an ordinary note', () => {
    roundTrip(draft());
  });

  it.each([
    ['a colon and a space', 'Deploy: the rules'],
    ['a trailing colon', 'Rules:'],
    ['a hash', 'Issue #42 follow-up'],
    ['double quotes', 'The "blue green" switch'],
    ['a leading quote', '"Quoted" title'],
    ['a leading single quote', "'Single' title"],
    ['a leading bracket', '[draft] plan'],
    ['a leading dash', '- not a list'],
    ['only dashes', '---'],
    ['a YAML boolean', 'true'],
    ['a YAML null', 'null'],
    ['a number', '2026'],
    ['a date', '2026-10-13'],
    ['Chinese', '部署规则：先测试再上线'],
    ['an emoji', '🚀 launch notes'],
    ['a backslash escape', 'path C:\\temp\\notes'],
    ['a pipe', '| piped'],
    ['an anchor look-alike', '&anchor *alias'],
    ['braces', '{not: a map}'],
    ['a very long title', 'x'.repeat(120)],
  ])('round-trips a title with %s', (_what, title) => {
    roundTrip(draft({ title }));
  });

  it.each([
    ['a fence as its first line', '---\nthis is a horizontal rule, not a header'],
    ['something shaped like a whole header', '---\ntitle: Fake\nauthor: user:owner\n---\n\nreal text'],
    ['fences throughout', 'one\n\n---\n\ntwo\n\n---\n---\n\nthree'],
    ['a fence as its last line', 'text\n---'],
    ['YAML document end markers', '...\ntext\n...'],
    ['an indented code block first', '    code first\n\nthen prose'],
    ['a keyword-like line in the middle', 'Keywords: not the end\n\nmore text'],
    ['front-matter-looking text and trailing spaces inside lines', 'a  \nb\t\nc'],
    ['a single very long line', 'word '.repeat(40_000).trim()],
  ])('round-trips a body with %s', (_what, body) => {
    roundTrip(draft({ body }));
  });

  it('round-trips odd tags, no author, no keywords and kept header lines', () => {
    roundTrip(draft({ tags: ['c++', 'a, b', 'true', '2026', '带 空格', "it's"], author: null, keywords: [], extra: ['permalink: /deploy/rules', '# kept comment', 'aliases:', '  - one', '  - two'] }));
  });

  it('always writes a header, so a body that starts with a fence cannot become one', () => {
    const text = serialiseNote(draft({ body: '---\ntitle: Fake\n---\npayload', keywords: [] }));
    const parsed = parseNoteText(text);
    expect(parsed.title).toBe('Deploy rules');
    expect(parsed.body).toBe('---\ntitle: Fake\n---\npayload');
  });

  it('never writes a kept line that would close the header early', () => {
    const text = serialiseNote(draft({ extra: ['---', 'x: 1\n---\ntitle: Injected', '...'] }));
    expect(parseNoteText(text).title).toBe('Deploy rules');
    expect(text.split('\n').filter((line) => line === '---')).toHaveLength(2);
  });

  it('collapses a multi-line title to one line instead of breaking the header', () => {
    const parsed = parseNoteText(serialiseNote(draft({ title: 'first\nauthor: user:owner' })));
    expect(parsed.title).toBe('first author: user:owner');
    expect(parsed.author).toBe('claude-code');
  });
});

describe('reading files people wrote by hand', () => {
  it('takes a file without a header as all body', () => {
    const parsed = parseNoteText('# Just a heading\n\nAnd text.\n');
    expect(parsed).toMatchObject({ title: null, tags: [], author: null, created: null, updated: null, body: '# Just a heading\n\nAnd text.' });
  });

  it('reads CRLF and bare CR line endings', () => {
    const crlf = parseNoteText('---\r\ntitle: Windows note\r\ntags: [a, b]\r\n---\r\n\r\nline one\r\nline two\r\n\r\nKeywords: x y\r\n');
    expect(crlf).toMatchObject({ title: 'Windows note', tags: ['a', 'b'], body: 'line one\nline two', keywords: ['x', 'y'] });
    const cr = parseNoteText('---\rtitle: Old Mac\r---\rbody\r');
    expect(cr).toMatchObject({ title: 'Old Mac', body: 'body' });
  });

  it('ignores a byte-order mark', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...encode('---\ntitle: With BOM\n---\ntext\n')]);
    const parsed = parseNoteFile(bytes);
    expect(parsed).toMatchObject({ ok: true, note: { title: 'With BOM', body: 'text' } });
    expect(parseNoteText('\ufeff---\ntitle: With BOM\n---\ntext')).toMatchObject({ title: 'With BOM' });
  });

  it.each([
    ['Latin-1 bytes', new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a])],
    ['a truncated multi-byte sequence', new Uint8Array([...encode('ok '), 0xe4, 0xb8])],
    ['an overlong encoding', new Uint8Array([0xc0, 0xaf])],
    ['UTF-16 with its byte-order mark', new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00])],
    ['a NUL byte', new Uint8Array([...encode('text'), 0x00, ...encode('more')])],
    ['random binary', new Uint8Array(Array.from({ length: 512 }, (_, index) => (index * 37 + 11) % 256))],
  ])('reports %s as not text instead of guessing', (_what, bytes) => {
    expect(parseNoteFile(bytes)).toEqual({ ok: false, reason: 'not_text' });
  });

  it('reports a file over the size limit without reading it as text', () => {
    expect(parseNoteFile(new Uint8Array(MAX_NOTE_FILE_BYTES + 1).fill(0x61))).toEqual({ ok: false, reason: 'too_large' });
    expect(parseNoteFile(new Uint8Array(MAX_NOTE_FILE_BYTES).fill(0x61)).ok).toBe(true);
  });

  it('reads tags written as a block list, a flow list with quotes, or a plain line', () => {
    expect(parseNoteText('---\ntags:\n  - one\n  - "two, three"\n- four\n---\nx').tags).toEqual(['one', 'two, three', 'four']);
    expect(parseNoteText(`---\ntags: [a, "b, c", 'd''e', ""]\n---\nx`).tags).toEqual(['a', 'b, c', "d'e"]);
    expect(parseNoteText('---\ntags: a, b\n---\nx').tags).toEqual(['a', 'b']);
    expect(parseNoteText('---\ntags: []\n---\nx').tags).toEqual([]);
  });

  it('keeps header lines it does not use, and their order', () => {
    const parsed = parseNoteText('---\npermalink: /x\ntitle: T\n# a comment\naliases:\n  - one\n\nstatus: draft\n---\nbody');
    expect(parsed.title).toBe('T');
    expect(parsed.extra).toEqual(['permalink: /x', '# a comment', 'aliases:', '  - one', 'status: draft']);
  });

  it('takes values literally: no type guessing, no comments after a value', () => {
    const parsed = parseNoteText('---\ntitle: yes # really\nauthor: 123\n---\nbody');
    expect(parsed.title).toBe('yes # really');
    expect(parsed.author).toBe('123');
  });

  it('reads quoted values', () => {
    expect(parseNoteText('---\ntitle: "A \\"quoted\\" one\\twith a tab"\n---\nb').title).toBe('A "quoted" one with a tab');
    expect(parseNoteText("---\ntitle: 'It''s here'\n---\nb").title).toBe("It's here");
    // Not valid JSON inside the quotes: what is between them is taken as it stands.
    expect(parseNoteText('---\ntitle: "bad \\q escape"\n---\nb').title).toBe('bad \\q escape');
  });

  it('reads dates in common forms and ignores what is not a date', () => {
    expect(parseNoteText('---\ncreated: 2026-01-05T09:30:00.000Z\nupdated: 2026-01-07\n---\nb')).toMatchObject({
      created: Date.UTC(2026, 0, 5, 9, 30),
      updated: Date.UTC(2026, 0, 7),
    });
    expect(parseNoteText('---\ncreated: last tuesday\nupdated:\n---\nb')).toMatchObject({ created: null, updated: null });
  });

  it.each([
    ['a nested map', '---\ntitle: T\nmeta:\n  owner: me\n---\nbody'],
    ['a block scalar', '---\ntitle: |\n  line one\n  line two\n---\nbody'],
    ['a folded scalar', '---\ndescription: >-\n  folded\n---\nbody'],
    ['an inline map', '---\ntitle: T\nmeta: {a: 1}\n---\nbody'],
    ['an anchor', '---\ntitle: &t Title\n---\nbody'],
    ['a line that is not key: value', '---\ntitle: T\njust some words\n---\nbody'],
    ['a title given as a list', '---\ntitle:\n  - a\n---\nbody'],
  ])('treats the whole file as body when the header has %s', (_what, text) => {
    const parsed = parseNoteText(text);
    expect(parsed.title).toBeNull();
    expect(parsed.body).toBe(text);
    expect(parsed.extra).toEqual([]);
  });

  it('treats the whole file as body when the header never closes', () => {
    const text = '---\ntitle: Unterminated\n\nSome text\nmore text';
    expect(parseNoteText(text)).toMatchObject({ title: null, body: text });
    expect(parseNoteText('---')).toMatchObject({ title: null, body: '---' });
    expect(parseNoteText('---\n')).toMatchObject({ title: null, body: '---' });
    expect(parseNoteText('')).toMatchObject({ title: null, body: '' });
  });

  it('does not look for the end of a header beyond its first 200 lines', () => {
    const text = `---\n${'k: v\n'.repeat(250)}---\nbody`;
    expect(parseNoteText(text).body).toBe(text);
    expect(parseNoteText(`---\n${'k: v\n'.repeat(150)}---\nbody`).body).toBe('body');
  });

  it('stays quick on huge lines and huge runs of white space', () => {
    const megabyte = 1024 * 1024;
    const started = performance.now();
    expect(parseNoteText('x'.repeat(megabyte)).body).toHaveLength(megabyte);
    expect(parseNoteText(`---\ntitle: ${'y'.repeat(megabyte)}\n---\nbody`).title).toBeNull();
    expect(parseNoteText(`---\ntitle: T\n---\n${' '.repeat(megabyte)}x`).body.endsWith('x')).toBe(true);
    expect(parseNoteText(`${'a '.repeat(megabyte / 2)}\n\nKeywords: k`).keywords).toEqual(['k']);
    expect(parseNoteText(`text\n${' '.repeat(megabyte)}\n${'\n'.repeat(1000)}`).body).toBe('text');
    expect(splitKeywordLine(`body\nKeywords: ${'k '.repeat(megabyte / 2)}`).keywords).toEqual([]);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe('the keyword line', () => {
  it.each([
    ['Text.\n\nKeywords: deploy release', ['deploy', 'release']],
    ['Text.\nkeywords:deploy,release', ['deploy', 'release']],
    ['Text.\n\n关键词：部署 发布 上线', ['部署', '发布', '上线']],
    ['Text.\n关键字: 部署、发布', ['部署', '发布']],
    ['Text.\n\nKeyword: single\n\n\n', ['single']],
  ])('is taken off the end of %j', (body, keywords) => {
    expect(splitKeywordLine(body)).toEqual({ body: 'Text.', keywords });
  });

  it('is only the last line, and only when it has words', () => {
    expect(splitKeywordLine('Keywords: early\n\nText.')).toEqual({ body: 'Keywords: early\n\nText.', keywords: [] });
    expect(splitKeywordLine('Text.\nKeywords:')).toEqual({ body: 'Text.\nKeywords:', keywords: [] });
    expect(splitKeywordLine('Text.\nMy keywords: a b')).toEqual({ body: 'Text.\nMy keywords: a b', keywords: [] });
    expect(splitKeywordLine('Keywords: only this')).toEqual({ body: '', keywords: ['only', 'this'] });
  });

  it('trims blank lines around a body but keeps the indentation of its first line', () => {
    expect(trimBlankEdges('\n  \n\t\n    code\n\ntext  \n\n')).toBe('    code\n\ntext');
    expect(trimBlankEdges('   ')).toBe('');
  });
});
