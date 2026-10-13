import { isSafeMemoryPath, memoryFolderPathSchema, memoryNoteIdSchema, memoryTitleSchema } from '@agent-studio/protocol';
import { describe, expect, it } from 'vitest';
import {
  agentAuthor,
  cleanAuthor,
  cleanKeywords,
  cleanTags,
  cleanTitle,
  disambiguatedFolderName,
  folderNameForDirectory,
  isSafeSegment,
  normaliseSubfolders,
  parseFolderPath,
  parseNoteId,
  slugify,
  splitSubfolder,
  userAuthor,
} from './names.js';

describe('slugify', () => {
  it.each([
    ['Deploy rules', 'deploy-rules'],
    ['Deploy rules.', 'deploy-rules'],
    ['-Deploy rules', 'deploy-rules'],
    ['  Deploy   RULES!!  ', 'deploy-rules'],
    ['deploy_rules', 'deploy-rules'],
    ['v2.0 release (final)', 'v2-0-release-final'],
    ['部署规则', '部署规则'],
    ['部署 规则：上线', '部署-规则-上线'],
    ['Ｆｕｌｌｗｉｄｔｈ　Ｔｅｘｔ', 'fullwidth-text'],
    ['Crème brûlée', 'crème-brûlée'],
    ['../../etc/passwd', 'etc-passwd'],
    ['..', ''],
    ['/', ''],
    ['?!…', ''],
    ['a\u0000b\nc', 'a-b-c'],
    ['C:\\Windows\\System32', 'c-windows-system32'],
  ])('%j → %j', (input, slug) => {
    expect(slugify(input)).toBe(slug);
  });

  it('never yields a name some file systems reserve', () => {
    for (const name of ['CON', 'nul', 'Com1', 'LPT9', 'aux', 'prn']) expect(slugify(name)).toBe(`${name.toLowerCase()}-note`);
    expect(slugify('console')).toBe('console');
  });

  it('keeps names within what file systems accept', () => {
    expect([...slugify('a'.repeat(500))]).toHaveLength(80);
    const chinese = slugify('汉'.repeat(500));
    expect(Buffer.byteLength(chinese)).toBeLessThanOrEqual(200);
    expect(chinese).toMatch(/^汉+$/);
    // The cut never leaves a hyphen at the end.
    expect(slugify(`${'a'.repeat(79)} b`)).toBe('a'.repeat(79));
  });

  it('gives the same slug whatever the Unicode form of the input', () => {
    expect(slugify('cafe\u0301')).toBe(slugify('caf\u00e9'));
  });

  it('is its own fixed point', () => {
    for (const text of ['Deploy rules', '部署 规则', 'Crème brûlée', 'a--b__c', 'CON']) expect(slugify(slugify(text))).toBe(slugify(text));
  });
});

describe('project folder names', () => {
  it.each([
    ['My App', 'my-app'],
    ['my-app', 'my-app'],
    ['agent_studio.v2', 'agent-studio-v2'],
    ['我的项目', '我的项目'],
    ['...', 'project'],
    ['', 'project'],
  ])('directory %j → folder %j', (directory, folder) => {
    expect(folderNameForDirectory(directory)).toBe(folder);
  });

  it('disambiguates by the working directory, the same way every time', () => {
    const first = disambiguatedFolderName('my-app', '/work/a/My App');
    expect(first).toMatch(/^my-app-[0-9a-f]{6}$/);
    expect(disambiguatedFolderName('my-app', '/work/a/My App')).toBe(first);
    expect(disambiguatedFolderName('my-app', '/work/b/my-app')).not.toBe(first);
    expect(disambiguatedFolderName('my-app', '/work/a/My App', 1)).toMatch(/^my-app-[0-9a-f]{10}$/);
    expect(isSafeSegment(first)).toBe(true);
  });
});

const HOSTILE_PATHS = [
  '../secrets/x',
  'alpha/../beta/x',
  'alpha/..',
  '..',
  '/etc/passwd',
  '/alpha/x',
  'alpha//x',
  'alpha/./x',
  'alpha/x/',
  './alpha/x',
  '.hidden/x',
  'alpha/.hidden',
  'alpha/.git/config',
  'alpha\\x',
  'alpha/..\\..\\x',
  'alpha/x\u0000',
  'alpha/x\ny',
  'alpha/\u007fx',
  'C:/Windows/x',
  'c:\\windows\\x',
  ' alpha/x',
  'alpha/x ',
  'alpha/ x',
  '',
];

describe('note ids and folder paths from clients', () => {
  it('accepts plain relative paths and takes them apart', () => {
    expect(parseNoteId('alpha/deploy-rules')).toEqual({ id: 'alpha/deploy-rules', folder: 'alpha', dir: 'alpha', name: 'deploy-rules' });
    expect(parseNoteId('alpha/decisions/2026/部署规则')).toEqual({ id: 'alpha/decisions/2026/部署规则', folder: 'alpha', dir: 'alpha/decisions/2026', name: '部署规则' });
    // Names people chose by hand are addressed as they are, not rewritten.
    expect(parseNoteId('Alpha/My Notes v2.0')?.name).toBe('My Notes v2.0');
    expect(parseFolderPath('alpha')).toEqual({ path: 'alpha', folder: 'alpha', rest: [] });
    expect(parseFolderPath('alpha/decisions')).toEqual({ path: 'alpha/decisions', folder: 'alpha', rest: ['decisions'] });
  });

  it.each(HOSTILE_PATHS)('refuses %j', (value) => {
    expect(parseNoteId(value)).toBeNull();
    expect(parseFolderPath(value)).toBeNull();
    expect(isSafeMemoryPath(value, 1)).toBe(false);
    expect(memoryNoteIdSchema.safeParse(value).success).toBe(false);
    expect(memoryFolderPathSchema.safeParse(value).success).toBe(false);
  });

  it('refuses a note id without a folder, one that is too deep, and one that is too long', () => {
    expect(parseNoteId('lonely')).toBeNull();
    expect(memoryNoteIdSchema.safeParse('lonely').success).toBe(false);
    expect(parseNoteId('f/a/b/c/d/name')).not.toBeNull();
    expect(parseNoteId('f/a/b/c/d/e/name')).toBeNull();
    expect(parseFolderPath('f/a/b/c/d')).not.toBeNull();
    expect(parseFolderPath('f/a/b/c/d/e')).toBeNull();
    expect(parseNoteId(`alpha/${'x'.repeat(400)}`)).toBeNull();
    expect(parseNoteId(`alpha/${'汉'.repeat(100)}`)).toBeNull(); // 300 bytes: longer than a file name may be
  });

  it('refuses values that are not strings', () => {
    for (const value of [null, undefined, 42, ['alpha', 'x'], { id: 'alpha/x' }]) {
      expect(parseNoteId(value)).toBeNull();
      expect(parseFolderPath(value)).toBeNull();
    }
  });
});

describe('sub-folders for new notes', () => {
  it('normalises each name', () => {
    expect(normaliseSubfolders(['Decisions', '2026 Q1'])).toEqual(['decisions', '2026-q1']);
    expect(normaliseSubfolders([])).toEqual([]);
  });

  it('refuses names that normalise to nothing and too many levels', () => {
    expect(normaliseSubfolders(['ok', '!!!'])).toBeNull();
    expect(normaliseSubfolders(['a', 'b', 'c', 'd', 'e'])).toBeNull();
  });

  it('splits what an assistant gives, and refuses anything that is not plain names', () => {
    expect(splitSubfolder('decisions/2026')).toEqual(['decisions', '2026']);
    expect(splitSubfolder(' /decisions/ ')).toEqual(['decisions']);
    expect(splitSubfolder('')).toEqual([]);
    for (const hostile of ['../beta', 'a/../../beta', 'a\\b', '.git', 'a//b', '/abs/../x', 'a/./b']) expect(splitSubfolder(hostile), hostile).toBeNull();
  });
});

describe('titles', () => {
  it('collapses white space', () => {
    expect(cleanTitle('  Deploy \t rules\n ')).toBe('Deploy rules');
    expect(memoryTitleSchema.parse('  Deploy \t rules\n ')).toBe('Deploy rules');
  });

  it.each([
    ['empty', ''],
    ['only spaces', ' \n\t '],
    ['a slash', 'a/b'],
    ['a backslash', 'a\\b'],
    ['a control character', 'a\u0007b'],
    ['121 characters', 'x'.repeat(121)],
  ])('refuses %s', (_what, title) => {
    expect(cleanTitle(title)).toBeNull();
    expect(memoryTitleSchema.safeParse(title).success).toBe(false);
  });

  it('accepts exactly 120 characters, counted as characters', () => {
    expect(cleanTitle('x'.repeat(120))).toHaveLength(120);
    expect(cleanTitle('汉'.repeat(120))).not.toBeNull();
    expect(memoryTitleSchema.safeParse('x'.repeat(120)).success).toBe(true);
  });
});

describe('tags and keywords', () => {
  it('cleans tags up', () => {
    expect(cleanTags(['#Deploy', ' ops  team ', 'DEPLOY', 'c++', '!!!', '', '部署', 'a_b-c', '--x--'])).toEqual(['deploy', 'ops-team', 'c', '部署', 'a_b-c', 'x']);
  });

  it('keeps the first few tags and bounds their length', () => {
    expect(cleanTags(Array.from({ length: 30 }, (_, index) => `tag${index}`))).toHaveLength(8);
    expect(cleanTags(Array.from({ length: 30 }, (_, index) => `tag${index}`), 3)).toEqual(['tag0', 'tag1', 'tag2']);
    expect(cleanTags(['x'.repeat(100)])[0]).toHaveLength(32);
  });

  it('survives entries that are not strings', () => {
    expect(cleanTags(['ok', 5, null, { a: 1 }] as unknown as string[])).toEqual(['ok']);
    expect(cleanKeywords(['ok', 5, null] as unknown as string[])).toEqual(['ok']);
  });

  it('splits keywords into single words and drops repeats', () => {
    expect(cleanKeywords(['部署 发布', 'release,Deploy', 'deploy', '上线、回滚', ' '])).toEqual(['部署', '发布', 'release', 'Deploy', '上线', '回滚']);
  });

  it('removes invisible and control characters from keywords and bounds them', () => {
    expect(cleanKeywords(['de\u200bploy', 'a\u0000b', '\u202eevil'])).toEqual(['deploy', 'ab', 'evil']);
    expect(cleanKeywords(Array.from({ length: 30 }, (_, index) => `k${index}`))).toHaveLength(12);
    expect([...cleanKeywords(['汉'.repeat(100)])[0]!]).toHaveLength(40);
  });
});

describe('author labels', () => {
  it('labels people and assistants differently', () => {
    expect(userAuthor('Alice')).toBe('user:alice');
    expect(agentAuthor('claude-code')).toBe('claude-code');
    expect(agentAuthor('Codex')).toBe('codex');
    expect(agentAuthor('api:openai')).toBe('api:openai');
  });

  it('never lets an assistant look like a person', () => {
    expect(agentAuthor('user:owner')).toBe('agent-user-owner');
    expect(agentAuthor('USER:owner')).toBe('agent-user-owner');
    expect(agentAuthor('user')).toBe('agent-user');
    expect(agentAuthor(':user:owner')).toBe('agent-user-owner');
    expect(agentAuthor('')).toBe('agent');
    expect(agentAuthor('  weird name\n')).toBe('weird-name');
  });

  it('reads an author from a file only when it is one short line', () => {
    expect(cleanAuthor(' claude-code ')).toBe('claude-code');
    expect(cleanAuthor('')).toBeNull();
    expect(cleanAuthor(null)).toBeNull();
    expect(cleanAuthor('x'.repeat(65))).toBeNull();
    expect(cleanAuthor('a\u0000b')).toBeNull();
  });
});
