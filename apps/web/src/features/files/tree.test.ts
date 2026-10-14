import type { FileEntry, FileListing } from '@agent-studio/protocol';
import { describe, expect, it } from 'vitest';
import { ROOT, type TreeState, ancestorsOf, emptyTree, filterRows, folderFor, foldersOnShow, foldersToLoad, foldersTouchedBy, normalizePath, parentOf, treeReducer, visibleRows } from './tree';

const entry = (path: string, kind: FileEntry['kind'] = 'file', extra: Partial<FileEntry> = {}): FileEntry => ({ name: path.split('/').pop()!, path, kind, size: 0, modifiedAt: 1, mode: 420, ignored: false, ...extra });
const listing = (path: string, entries: FileEntry[], truncated = false): FileListing => ({ path, entries, truncated });
const loaded = (state: TreeState, path: string, entries: FileEntry[], truncated = false) => treeReducer(state, { type: 'loaded', path, listing: listing(path, entries, truncated) });
const names = (state: TreeState) => visibleRows(state).map((row) => (row.kind === 'entry' ? `${'  '.repeat(row.depth)}${row.entry.name}${row.expanded ? '/' : ''}` : `${'  '.repeat(row.depth)}(${row.kind})`));

const ROOT_ENTRIES = [entry('docs', 'directory'), entry('src', 'directory'), entry('.env', 'file', { ignored: true }), entry('README.md')];

describe('reading folders one at a time', () => {
  it('asks for the project folder first and for nothing else', () => {
    expect(foldersToLoad(emptyTree())).toEqual([ROOT]);
    expect(names(emptyTree())).toEqual(['(loading)']);
  });

  it('lists a folder as the server ordered it, folders first, ignored entries marked', () => {
    const state = loaded(treeReducer(emptyTree(), { type: 'requested', path: ROOT }), ROOT, ROOT_ENTRIES);
    expect(names(state)).toEqual(['docs', 'src', '.env', 'README.md']);
    expect(visibleRows(state).filter((row) => row.kind === 'entry' && row.entry.ignored)).toHaveLength(1);
    expect(foldersToLoad(state)).toEqual([]);
  });

  it('reads a folder only when it is first opened, and shows that it is being read', () => {
    let state = loaded(emptyTree(), ROOT, ROOT_ENTRIES);
    state = treeReducer(state, { type: 'expand', path: 'src' });
    expect(foldersToLoad(state)).toEqual(['src']);
    expect(names(state)).toEqual(['docs', 'src/', '  (loading)', '.env', 'README.md']);

    state = treeReducer(state, { type: 'requested', path: 'src' });
    expect(foldersToLoad(state)).toEqual([]);
    state = loaded(state, 'src', [entry('src/lib', 'directory'), entry('src/app.ts')]);
    expect(names(state)).toEqual(['docs', 'src/', '  lib', '  app.ts', '.env', 'README.md']);
  });

  it('keeps what was read while a folder is closed, so opening it again asks nothing', () => {
    let state = loaded(emptyTree(), ROOT, ROOT_ENTRIES);
    state = loaded(treeReducer(state, { type: 'expand', path: 'src' }), 'src', [entry('src/app.ts')]);
    state = treeReducer(state, { type: 'collapse', path: 'src' });
    expect(names(state)).toEqual(['docs', 'src', '.env', 'README.md']);
    state = treeReducer(state, { type: 'expand', path: 'src' });
    expect(foldersToLoad(state)).toEqual([]);
    expect(names(state)).toContain('  app.ts');
  });

  it('keeps the tree on screen while a refresh is under way', () => {
    let state = loaded(emptyTree(), ROOT, ROOT_ENTRIES);
    state = treeReducer(state, { type: 'requested', path: ROOT });
    expect(names(state)).toEqual(['docs', 'src', '.env', 'README.md']);
  });

  it('says in the tree when a folder is empty, cut short, or could not be read', () => {
    let state = loaded(emptyTree(), ROOT, ROOT_ENTRIES);
    state = loaded(treeReducer(state, { type: 'expand', path: 'docs' }), 'docs', []);
    expect(names(state)).toContain('  (empty)');

    state = loaded(treeReducer(state, { type: 'expand', path: 'src' }), 'src', [entry('src/a.ts')], true);
    const truncated = visibleRows(state).find((row) => row.kind === 'truncated');
    expect(truncated).toMatchObject({ path: 'src', shown: 1, depth: 1 });

    const failed = treeReducer(treeReducer(emptyTree(), { type: 'requested', path: ROOT }), { type: 'failed', path: ROOT, error: new Error('down') });
    expect(names(failed)).toEqual(['(failed)']);
  });

  it('keeps the entries it has when a re-read fails, and says so beneath them', () => {
    let state = loaded(emptyTree(), ROOT, ROOT_ENTRIES);
    state = treeReducer(state, { type: 'failed', path: ROOT, error: new Error('down') });
    expect(names(state)).toEqual(['docs', 'src', '.env', 'README.md', '(failed)']);
  });

  it('forgets a folder that is no longer listed, with everything remembered beneath it', () => {
    let state = loaded(emptyTree(), ROOT, ROOT_ENTRIES);
    state = loaded(treeReducer(state, { type: 'expand', path: 'src' }), 'src', [entry('src/lib', 'directory')]);
    state = loaded(treeReducer(state, { type: 'expand', path: 'src/lib' }), 'src/lib', [entry('src/lib/x.ts')]);
    // "src" was deleted elsewhere.
    state = loaded(state, ROOT, [entry('docs', 'directory'), entry('README.md')]);
    expect(Object.keys(state.folders).sort()).toEqual([ROOT]);
    expect([...state.expanded]).toEqual([]);
    expect(names(state)).toEqual(['docs', 'README.md']);
  });

  it('opens every folder on the way to a revealed path, and reads them outermost first', () => {
    let state = loaded(emptyTree(), ROOT, ROOT_ENTRIES);
    state = treeReducer(state, { type: 'reveal', path: 'src/lib/deep', includeSelf: true });
    expect([...state.expanded].sort()).toEqual(['src', 'src/lib', 'src/lib/deep']);
    expect(foldersToLoad(state).sort()).toEqual(['src', 'src/lib', 'src/lib/deep']);
    // Revealing a file opens its folders, not the file.
    const file = treeReducer(loaded(emptyTree(), ROOT, ROOT_ENTRIES), { type: 'reveal', path: 'src/app.ts', includeSelf: false });
    expect([...file.expanded]).toEqual(['src']);
  });

  it('collapses everything at once without forgetting what was read', () => {
    let state = loaded(emptyTree(), ROOT, ROOT_ENTRIES);
    state = loaded(treeReducer(state, { type: 'expand', path: 'src' }), 'src', [entry('src/app.ts')]);
    state = treeReducer(state, { type: 'collapse-all' });
    expect(names(state)).toEqual(['docs', 'src', '.env', 'README.md']);
    expect(state.folders.src?.entries).toHaveLength(1);
  });
});

describe('re-reading after a change', () => {
  const open = () => {
    let state = loaded(emptyTree(), ROOT, ROOT_ENTRIES);
    state = loaded(treeReducer(state, { type: 'expand', path: 'src' }), 'src', [entry('src/lib', 'directory'), entry('src/app.ts')]);
    return state;
  };

  it('re-reads only the folders on show', () => {
    expect(foldersOnShow(open()).sort()).toEqual([ROOT, 'src']);
    const closed = treeReducer(open(), { type: 'collapse', path: 'src' });
    expect(foldersOnShow(closed)).toEqual([ROOT]);
  });

  it('finds the folders a changed path can have touched', () => {
    expect(foldersTouchedBy(open(), ['src/app.ts'])).toEqual(['src']);
    expect(foldersTouchedBy(open(), ['new.txt'])).toEqual([ROOT]);
    // A folder that is not open is not read just because something changed inside it.
    expect(foldersTouchedBy(open(), ['docs/guide.md'])).toEqual([]);
    expect(foldersTouchedBy(open(), ['./src//app.ts'])).toEqual(['src']);
  });
});

describe('paths', () => {
  it('names the folder a path lives in and the folders above it', () => {
    expect(parentOf('a/b/c.ts')).toBe('a/b');
    expect(parentOf('c.ts')).toBe(ROOT);
    expect(ancestorsOf('a/b/c.ts')).toEqual(['a', 'a/b']);
    expect(ancestorsOf('c.ts')).toEqual([]);
    expect(normalizePath('./a//b/')).toBe('a/b');
    expect(normalizePath('a\\b')).toBe('a/b');
  });

  it('creates inside a folder and beside a file', () => {
    expect(folderFor(null)).toBe(ROOT);
    expect(folderFor(entry('src', 'directory'))).toBe('src');
    expect(folderFor(entry('src/app.ts'))).toBe('src');
  });
});

describe('the name filter', () => {
  it('shows only the branches that lead to a match, opened, folders first', () => {
    const rows = filterRows([
      { path: 'src/lib/test-utils.ts', name: 'test-utils.ts', kind: 'file' },
      { path: 'test', name: 'test', kind: 'directory' },
      { path: 'src/app.test.ts', name: 'app.test.ts', kind: 'file' },
      { path: 'README.test.md', name: 'README.test.md', kind: 'file' },
    ]);
    expect(rows.map((row) => `${'  '.repeat(row.depth)}${row.name}${row.isFolder ? '/' : ''}${row.matched ? ' *' : ''}`)).toEqual([
      'src/',
      '  lib/',
      '    test-utils.ts *',
      '  app.test.ts *',
      'test/ *',
      'README.test.md *',
    ]);
  });

  it('marks a folder that matched itself as well as leading to matches', () => {
    const rows = filterRows([
      { path: 'tests', name: 'tests', kind: 'directory' },
      { path: 'tests/a.test.ts', name: 'a.test.ts', kind: 'file' },
    ]);
    expect(rows).toEqual([
      { key: 'tests', path: 'tests', name: 'tests', isFolder: true, depth: 0, matched: true },
      { key: 'tests/a.test.ts', path: 'tests/a.test.ts', name: 'a.test.ts', isFolder: false, depth: 1, matched: true },
    ]);
  });

  it('shows nothing for no matches', () => {
    expect(filterRows([])).toEqual([]);
  });
});
