import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  FileContent,
  FileContentSearch,
  FileEntry,
  FileLimits,
  FileListing,
  FileNameSearch,
  FileTree,
  FileTreeNode,
  Project,
  SavedFile,
  UploadResult,
} from '@agent-studio/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StudioEvent } from '../../src/kernel/events.js';
import { readZip } from '../../src/modules/files/testing/zip-reader.js';
import { createGitSandbox, type GitSandbox } from '../../src/modules/git/testing/fixtures.js';
import { createTestStudio, type TestClient, type TestResponse, type TestStudio } from '../../src/testing/harness.js';

let sandbox: GitSandbox;
let t: TestStudio;
let owner: TestClient;
/** A folder next to the workspace: everything in it is "outside" every project. */
let outside: string;

beforeEach(async () => {
  sandbox = await createGitSandbox();
  t = await createTestStudio();
  owner = await t.owner();
  outside = path.join(path.dirname(t.workspace), 'outside');
  await sandbox.write(outside, { 'secret.txt': 'outside secret\n', 'dir/inner.txt': 'outside inner\n' });
});
afterEach(async () => {
  await t.close();
  await sandbox.restore();
});

interface P {
  project: Project;
  dir: string;
  url: (suffix: string) => string;
}

async function project(name = 'demo', files: Record<string, string | Buffer> = {}): Promise<P> {
  const dir = path.join(t.workspace, name);
  await mkdir(dir, { recursive: true });
  await sandbox.write(dir, files);
  const response = await owner.post<Project>('/api/projects', { name, rootDir: dir });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  const created = response.body;
  return { project: created, dir: created.rootDir, url: (suffix) => `/api/projects/${created.id}/files/${suffix}` };
}

const q = (params: Record<string, string>) => new URLSearchParams(params).toString();
const errorOf = (response: { status: number; body: unknown }): [number, string | undefined] => [response.status, (response.body as { error?: { code?: string } } | undefined)?.error?.code];
const names = (entries: readonly FileEntry[]) => entries.map((entry) => entry.name);
const read = (p: P, file: string, client: TestClient = owner) => client.get<FileContent>(p.url(`content?${q({ path: file })}`));
const save = (p: P, body: Record<string, unknown>, client: TestClient = owner) => client.put<SavedFile>(p.url('content'), body);
const outsideSecret = () => readFile(path.join(outside, 'secret.txt'), 'utf8');

/** Links that lead out of the project, in every flavour. */
async function plantLinks(p: P): Promise<void> {
  await symlink(path.join(outside, 'secret.txt'), path.join(p.dir, 'link-to-file'));
  await symlink(outside, path.join(p.dir, 'link-to-dir'));
  await symlink(path.join(outside, 'does-not-exist.txt'), path.join(p.dir, 'dangling'));
  await symlink('../../outside/secret.txt', path.join(p.dir, 'relative-link'));
}

interface Part {
  path?: string;
  filename: string;
  content: string | Buffer;
  field?: string;
}

function multipart(parts: readonly Part[]): { body: Buffer; headers: Record<string, string> } {
  const boundary = '----studio-test-boundary-7f3a';
  const chunks: Buffer[] = [];
  for (const part of parts) {
    if (part.path !== undefined) {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="path"\r\n\r\n`), Buffer.from(part.path), Buffer.from('\r\n'));
    }
    chunks.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${part.field ?? 'file'}"; filename="${part.filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      Buffer.isBuffer(part.content) ? part.content : Buffer.from(part.content),
      Buffer.from('\r\n'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

function upload(p: P, parts: readonly Part[], query: Record<string, string> = {}, client: TestClient = owner): Promise<TestResponse<UploadResult>> {
  const form = multipart(parts);
  return client.request<UploadResult>('POST', p.url(`upload?${q(query)}`), form.body, form.headers);
}

async function allFiles(dir: string, base = dir): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await allFiles(full, base)));
    else found.push(path.relative(base, full));
  }
  return found.sort();
}

describe('listing', () => {
  it('shows the tree a repository wants seen: ignore rules honoured, dependencies and metadata hidden, folders first', async () => {
    const p = await project('listed', {
      '.gitignore': '*.log\n!keep.log\nbuild/\n',
      'a.log': 'noise',
      'keep.log': 'kept',
      'src/x.ts': 'export {}',
      'src/debug.log': 'noise',
      'node_modules/pkg/index.js': 'dep',
      'build/out.js': 'built',
      'zeta.txt': 'z',
      'Alpha.txt': 'a',
      'docs/guide.md': '# guide',
    });
    await sandbox.git(p.dir, 'init', '--quiet');

    const tree = (await owner.get<FileTree>(p.url('tree'))).body;
    expect(tree).toMatchObject({ path: '', truncated: false, truncatedBy: null });
    expect(names(tree.entries)).toEqual(['docs', 'src', '.gitignore', 'Alpha.txt', 'keep.log', 'zeta.txt']);
    const src = tree.entries.find((entry) => entry.name === 'src')!;
    expect(src.children!.map((child) => child.path)).toEqual(['src/x.ts']);
    expect(tree.entryCount).toBe(8);

    // One folder at a time gives the same picture…
    const listing = (await owner.get<FileListing>(p.url('list'))).body;
    expect(names(listing.entries)).toEqual(['docs', 'src', '.gitignore', 'Alpha.txt', 'keep.log', 'zeta.txt']);
    expect(names((await owner.get<FileListing>(p.url(`list?${q({ path: 'src' })}`))).body.entries)).toEqual(['x.ts']);
    // …and can include what is ignored, marked as such. Dependencies and .git stay hidden regardless.
    const everything = (await owner.get<FileListing>(p.url('list?ignored=show'))).body.entries;
    expect(everything.map((entry) => [entry.name, entry.ignored])).toEqual([
      ['build', true],
      ['docs', false],
      ['src', false],
      ['.gitignore', false],
      ['a.log', true],
      ['Alpha.txt', false],
      ['keep.log', false],
      ['zeta.txt', false],
    ]);
  });

  it('falls back to conventional build folders when there is no repository to ask', async () => {
    const p = await project('plain', { 'dist/app.js': 'x', '__pycache__/m.pyc': 'x', 'node_modules/a/b.js': 'x', 'src/main.py': 'x', 'notes.log': 'kept: no rule says otherwise' });
    expect(names((await owner.get<FileTree>(p.url('tree'))).body.entries)).toEqual(['src', 'notes.log']);
    expect((await owner.get<FileListing>(p.url('list?ignored=show'))).body.entries.map((entry) => [entry.name, entry.ignored])).toEqual([
      ['__pycache__', true],
      ['dist', true],
      ['src', false],
      ['notes.log', false],
    ]);
  });

  it('describes each entry, and reports links as links without following them', async () => {
    const p = await project('entries', { 'script.sh': '#!/bin/sh\n', 'data.bin': Buffer.alloc(1234), 'inner/file.txt': 'x' });
    await chmod(path.join(p.dir, 'script.sh'), 0o755);
    await plantLinks(p);
    await symlink('inner/file.txt', path.join(p.dir, 'inside-link'));
    await symlink('inner', path.join(p.dir, 'inside-dir-link'));

    const entries = Object.fromEntries((await owner.get<FileListing>(p.url('list'))).body.entries.map((entry) => [entry.name, entry]));
    expect(entries['data.bin']).toMatchObject({ kind: 'file', size: 1234, path: 'data.bin', ignored: false });
    expect(entries['script.sh']).toMatchObject({ kind: 'file', mode: 0o755 });
    expect(entries.inner).toMatchObject({ kind: 'directory', size: 0 });
    expect(Math.abs(entries['data.bin']!.modifiedAt - Date.now())).toBeLessThan(60_000);
    expect(entries['link-to-file']).toMatchObject({ kind: 'symlink', linkTarget: 'outside' });
    expect(entries['link-to-dir']).toMatchObject({ kind: 'symlink', linkTarget: 'outside' });
    expect(entries.dangling).toMatchObject({ kind: 'symlink', linkTarget: 'missing' });
    expect(entries['inside-link']).toMatchObject({ kind: 'symlink', linkTarget: 'file' });
    expect(entries['inside-dir-link']).toMatchObject({ kind: 'symlink', linkTarget: 'directory' });

    // The tree never walks through a link, wherever it leads.
    const tree = (await owner.get<FileTree>(p.url('tree'))).body;
    const text = JSON.stringify(tree);
    expect(text).not.toContain('secret.txt');
    expect(text).not.toContain('outside inner');
    expect(tree.entries.find((entry) => entry.name === 'inside-dir-link')!.children).toBeUndefined();
    // Listing a folder through a link that leaves the project is refused, like reading through it.
    expect(errorOf(await owner.get(p.url(`list?${q({ path: 'link-to-dir' })}`)))).toEqual([403, 'path_outside_root']);
    expect(errorOf(await owner.get(p.url(`tree?${q({ path: 'link-to-dir/dir' })}`)))).toEqual([403, 'path_outside_root']);
    expect(names((await owner.get<FileListing>(p.url(`list?${q({ path: 'inside-dir-link' })}`))).body.entries)).toEqual(['file.txt']);
  });

  it('bounds a whole-tree read by depth and by entry count, and says which', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 30; i += 1) files[`wide/file-${String(i).padStart(2, '0')}.txt`] = 'x';
    files['a/b/c/d/e/deep.txt'] = 'x';
    const p = await project('bounded', files);

    const shallow = (await owner.get<FileTree>(p.url('tree?depth=2'))).body;
    expect(shallow).toMatchObject({ truncated: true, truncatedBy: 'depth', limits: { depth: 2 } });
    const b = shallow.entries.find((entry) => entry.name === 'a')!.children!.find((entry) => entry.name === 'b')!;
    expect(b.childrenOmitted).toBe(true);
    expect(b.children).toBeUndefined();

    const few = (await owner.get<FileTree>(p.url('tree?limit=10'))).body;
    expect(few).toMatchObject({ truncated: true, truncatedBy: 'entries', entryCount: 10, limits: { entries: 10 } });
    const count = (nodes: readonly FileTreeNode[]): number => nodes.reduce((sum, node) => sum + 1 + count(node.children ?? []), 0);
    expect(count(few.entries)).toBe(10);

    // The server's own ceilings win over what a client asks for.
    t.studio.context.services.files.limits.maxTreeEntries = 5;
    t.studio.context.services.files.limits.maxTreeDepth = 1;
    expect((await owner.get<FileTree>(p.url('tree?limit=5000&depth=30'))).body).toMatchObject({ entryCount: 2, truncatedBy: 'depth', limits: { depth: 1, entries: 5 } });
    t.studio.context.services.files.limits.maxListEntries = 7;
    const wide = (await owner.get<FileListing>(p.url(`list?${q({ path: 'wide' })}`))).body;
    expect([wide.entries.length, wide.truncated]).toEqual([7, true]);
    for (const bad of ['depth=0', 'depth=x', 'limit=0', 'limit=-3']) expect((await owner.get(p.url(`tree?${bad}`))).status, bad).toBe(400);
  });

  it('answers precisely when the folder is a file, missing, or the whole project is gone', async () => {
    const p = await project('missing', { 'file.txt': 'x' });
    expect(errorOf(await owner.get(p.url(`list?${q({ path: 'file.txt' })}`)))).toEqual([400, 'not_a_directory']);
    expect(errorOf(await owner.get(p.url(`tree?${q({ path: 'nope' })}`)))).toEqual([404, 'file_not_found']);
    await rm(p.dir, { recursive: true });
    for (const route of ['list', 'tree', 'search?query=x', 'grep?query=x', 'content?path=file.txt', 'raw?path=file.txt', 'archive']) {
      expect(errorOf(await owner.get(p.url(route))), route).toEqual([404, 'project_folder_missing']);
    }
  });

  it('reports the limits in force', async () => {
    const limits = (await owner.get<FileLimits>('/api/files/limits')).body;
    expect(limits).toMatchObject({ maxTextBytes: 5 * 1024 * 1024, maxTreeDepth: 10, maxTreeEntries: 10_000, maxUploadFiles: 100 });
    expect((await t.anonymous().get('/api/files/limits')).status).toBe(401);
  });
});

describe('searching', () => {
  it('finds files by name for the mention picker: case-insensitive, bounded, best matches first', async () => {
    const files: Record<string, string> = { '.gitignore': 'ignored/\n', 'ignored/test-secret.txt': 'x', 'node_modules/test-dep/index.js': 'x', 'docs/Testing.md': 'x', 'test.config.js': 'x', 'src/contest/entry.ts': 'x' };
    for (let i = 0; i < 30; i += 1) files[`src/unit/case-${String(i).padStart(2, '0')}.test.ts`] = 'x';
    const p = await project('names', files);
    await sandbox.git(p.dir, 'init', '--quiet');

    const found = (await owner.get<FileNameSearch>(p.url('search?query=TEST'))).body;
    expect(found.results).toHaveLength(10);
    expect(found.truncated).toBe(true);
    // Names that start with the query come before names that merely contain it.
    expect(found.results.slice(0, 2).map((match) => match.path)).toEqual(['test.config.js', 'docs/Testing.md']);
    expect(found.results[2]).toMatchObject({ path: 'src/contest', kind: 'directory' });
    const all = (await owner.get<FileNameSearch>(p.url('search?query=test&limit=200'))).body;
    const paths = all.results.map((match) => match.path);
    // 30 test files, Testing.md, test.config.js, the folder "contest" and the file inside it.
    expect(paths).toHaveLength(34);
    expect(paths.some((file) => file.startsWith('ignored/') || file.startsWith('node_modules/'))).toBe(false);
    expect((await owner.get<FileNameSearch>(p.url('search?query=unit/case-07'))).body.results.map((match) => match.path)).toEqual(['src/unit/case-07.test.ts']);
    expect((await owner.get<FileNameSearch>(p.url('search?query=no-such-thing'))).body).toMatchObject({ results: [], truncated: false });
    for (const bad of ['search', 'search?query=', 'search?query=x&limit=0', `search?query=${'x'.repeat(201)}`]) expect((await owner.get(p.url(bad))).status, bad).toBe(400);

    // Without a repository the folder is walked instead, with the same result shape.
    const plain = await project('plain-names', { 'src/alpha.test.js': 'x', 'dist/alpha.test.js': 'x', 'Alphabet.md': 'x' });
    expect((await owner.get<FileNameSearch>(plain.url('search?query=alpha'))).body.results.map((match) => match.path)).toEqual(['Alphabet.md', 'src/alpha.test.js']);
  });

  it.each(['git', 'scan'] as const)('searches file contents literally, skipping binary and ignored files (%s)', async (engine) => {
    const p = await project(`grep-${engine}`, {
      '.gitignore': 'dist/\n',
      'src/a.ts': 'const needle = 1;\nconst other = 2;\n// NEEDLE in capitals\n',
      'src/b.ts': 'nothing here\nfound a needle on line two\r\n',
      'docs/regex.md': 'a.c matches literally: a.c\nabc should not match\n-e is not an option\n',
      'dist/bundle.js': 'needle in build output',
      'node_modules/dep/index.js': 'needle in a dependency',
      'image.bin': Buffer.concat([Buffer.from('needle'), Buffer.from([0, 1, 2]), Buffer.from('needle')]),
      'long.txt': `${'x'.repeat(1000)} needle ${'y'.repeat(1000)}\n`,
    });
    if (engine === 'git') await sandbox.git(p.dir, 'init', '--quiet');
    const grep = async (params: Record<string, string>) => (await owner.get<FileContentSearch>(p.url(`grep?${q(params)}`))).body;

    const insensitive = await grep({ query: 'needle' });
    expect(insensitive.engine).toBe(engine);
    expect(insensitive.matches.map((match) => [match.path, match.line]).sort()).toEqual([
      ['long.txt', 1],
      ['src/a.ts', 1],
      ['src/a.ts', 3],
      ['src/b.ts', 2],
    ]);
    expect(insensitive.matches.find((match) => match.path === 'src/b.ts')!.text).toBe('found a needle on line two');
    expect(insensitive.matches.find((match) => match.path === 'long.txt')!.text.length).toBeLessThanOrEqual(401);
    expect((await grep({ query: 'NEEDLE', caseSensitive: 'true' })).matches.map((match) => [match.path, match.line])).toEqual([['src/a.ts', 3]]);
    // The query is text, never a pattern and never an option.
    expect((await grep({ query: 'a.c' })).matches.map((match) => match.line)).toEqual([1]);
    expect((await grep({ query: '-e' })).matches.map((match) => [match.path, match.line])).toEqual([['docs/regex.md', 3]]);
    expect((await grep({ query: '--help' })).matches).toEqual([]);
    expect((await grep({ query: 'needle', path: 'src' })).matches.every((match) => match.path.startsWith('src/'))).toBe(true);
    const limited = await grep({ query: 'needle', limit: '2' });
    expect([limited.matches.length, limited.truncated]).toEqual([2, true]);

    expect(errorOf(await owner.get(p.url(`grep?${q({ query: 'x', path: '../outside' })}`)))).toEqual([403, 'path_outside_root']);
    expect(errorOf(await owner.get(p.url(`grep?${q({ query: 'two\nlines' })}`)))).toEqual([400, 'invalid_query']);
    expect((await owner.get(p.url('grep'))).status).toBe(400);
  });
});

describe('reading', () => {
  it('returns text exactly, with a version, and recognises what is not text', async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)]);
    const p = await project('reading', {
      'unix.txt': 'one\ntwo\n',
      'windows.txt': 'one\r\ntwo\r\n',
      'mixed.txt': 'one\r\ntwo\n',
      'oneline.txt': 'no newline',
      'bom.txt': '\ufeffwith a mark\n',
      'unicode.txt': '汉字 and émojis 🙂\n',
      'empty.txt': '',
      'latin1.txt': Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]),
      'nul.dat': Buffer.from([0x61, 0x00, 0x62]),
      'picture.png': png,
      'fake.png': 'this is text pretending',
      'folder/inner.txt': 'x',
    });

    const unix = (await read(p, 'unix.txt')).body;
    expect(unix).toMatchObject({ kind: 'text', path: 'unix.txt', content: 'one\ntwo\n', size: 8, lineEnding: 'lf' });
    expect(unix.version).toMatch(/^[0-9a-f]{32}$/);
    expect((await read(p, 'unix.txt')).body.version).toBe(unix.version);
    expect((await read(p, 'windows.txt')).body).toMatchObject({ kind: 'text', content: 'one\r\ntwo\r\n', lineEnding: 'crlf' });
    expect((await read(p, 'mixed.txt')).body).toMatchObject({ lineEnding: 'mixed' });
    expect((await read(p, 'oneline.txt')).body).toMatchObject({ lineEnding: 'none' });
    expect((await read(p, 'bom.txt')).body).toMatchObject({ kind: 'text', content: '\ufeffwith a mark\n' });
    expect((await read(p, 'unicode.txt')).body).toMatchObject({ content: '汉字 and émojis 🙂\n' });
    expect((await read(p, 'empty.txt')).body).toMatchObject({ kind: 'text', content: '', size: 0 });

    // Only UTF-8 counts as text; everything else is "binary", with a hint whether it can be previewed.
    expect((await read(p, 'latin1.txt')).body).toMatchObject({ kind: 'binary', previewable: false, mediaType: 'application/octet-stream' });
    expect((await read(p, 'nul.dat')).body).toMatchObject({ kind: 'binary', previewable: false });
    expect((await read(p, 'picture.png')).body).toMatchObject({ kind: 'binary', previewable: true, mediaType: 'image/png', size: png.length });
    expect((await read(p, 'fake.png')).body).toMatchObject({ kind: 'text', content: 'this is text pretending' });
    expect(JSON.stringify((await read(p, 'nul.dat')).body)).not.toContain('content');

    expect(errorOf(await read(p, 'folder'))).toEqual([400, 'is_directory']);
    expect(errorOf(await read(p, ''))).toEqual([400, 'is_directory']);
    expect(errorOf(await read(p, 'nope.txt'))).toEqual([404, 'file_not_found']);
    expect(errorOf(await read(p, 'unix.txt/child'))).toEqual([400, 'not_a_directory']);
    expect((await owner.get(p.url('content'))).status).toBe(400);
  });

  it('does not open text beyond the size limit', async () => {
    const p = await project('big', { 'big.txt': 'line\n'.repeat(500), 'big.bin': Buffer.alloc(3000), 'small.txt': 'ok' });
    t.studio.context.services.files.limits.maxTextBytes = 1000;
    expect((await read(p, 'big.txt')).body).toEqual(expect.objectContaining({ kind: 'too_large', size: 2500, limit: 1000 }));
    expect(JSON.stringify((await read(p, 'big.txt')).body)).not.toContain('line');
    expect((await read(p, 'big.bin')).body).toMatchObject({ kind: 'binary', size: 3000 });
    expect((await read(p, 'small.txt')).body).toMatchObject({ kind: 'text' });
  });

  it.each([
    ['..', 403],
    ['../outside/secret.txt', 403],
    ['../../../../../../etc/passwd', 403],
    ['sub/../../outside/secret.txt', 403],
    ['/etc/passwd', 403],
    ['//etc/passwd', 403],
    ['C:\\Windows\\system.ini', 403],
    ['.git/config', 403],
    ['.git/HEAD', 403],
    ['.GIT/config', 403],
    ['sub/.git/config', 403],
    ['x/../.git/config', 403],
    ['%2e%2e%2f%2e%2e%2foutside%2fsecret.txt', 404],
    ['..%2foutside%2fsecret.txt', 404],
    ['..\\..\\outside\\secret.txt', 404],
    ['....//outside/secret.txt', 404],
    ['nul\u0000/../../outside/secret.txt', 400],
    ['secret.txt\u0000.png', 400],
  ])('refuses to read %j', async (target, expected) => {
    const p = await project('confined', { 'inside.txt': 'inside\n', 'sub/x.txt': 'x' });
    await sandbox.git(p.dir, 'init', '--quiet');
    for (const route of ['content', 'raw', 'raw?disposition=inline']) {
      const separator = route.includes('?') ? '&' : '?';
      const response = await owner.get(p.url(`${route}${separator}${q({ path: target })}`));
      expect(response.status, `${route} ${JSON.stringify(response.body)}`).toBe(expected);
      expect(response.raw.body, route).not.toContain('outside secret');
      expect(response.raw.body, route).not.toContain('root:');
      expect(response.raw.body, route).not.toContain('[core]');
    }
  });

  it('refuses to read through a link that leaves the project, and follows one that stays inside', async () => {
    const p = await project('links', { 'real.txt': 'really inside\n', 'inner/file.txt': 'inner\n' });
    await plantLinks(p);
    await symlink('real.txt', path.join(p.dir, 'inside-link'));
    await symlink('inner', path.join(p.dir, 'inside-dir'));

    for (const target of ['link-to-file', 'relative-link', 'link-to-dir/secret.txt', 'link-to-dir/dir/inner.txt', 'dangling']) {
      for (const route of ['content', 'raw', 'raw?disposition=inline']) {
        const separator = route.includes('?') ? '&' : '?';
        const response = await owner.get(p.url(`${route}${separator}${q({ path: target })}`));
        expect(errorOf(response), `${route} ${target}`).toEqual([403, 'path_outside_root']);
        expect(response.raw.body).not.toContain('outside secret');
        expect(response.raw.body).not.toContain('outside inner');
      }
    }
    expect((await read(p, 'inside-link')).body).toMatchObject({ kind: 'text', content: 'really inside\n', path: 'real.txt' });
    expect((await read(p, 'inside-dir/file.txt')).body).toMatchObject({ content: 'inner\n', path: 'inner/file.txt' });
    expect((await owner.get(p.url(`raw?${q({ path: 'inside-link' })}`))).raw.body).toBe('really inside\n');
  });
});

describe('downloading and previewing', () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(Array.from({ length: 300 }, (_, i) => i % 256))]);
  const pdf = Buffer.from('%PDF-1.7\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\n');
  const raw = (p: P, params: Record<string, string>, headers: Record<string, string> = {}) => owner.request('GET', p.url(`raw?${q(params)}`), undefined, headers);

  it('downloads the exact bytes as an opaque attachment', async () => {
    const p = await project('downloads', { 'picture.png': png, 'page.html': '<script>alert(1)</script>', 'vector.svg': '<svg onload="alert(1)"/>', 'empty.bin': '' });
    const download = await raw(p, { path: 'picture.png' });
    expect(download.status).toBe(200);
    expect(download.raw.rawPayload.equals(png)).toBe(true);
    expect(download.headers['content-type']).toBe('application/octet-stream');
    expect(download.headers['content-disposition']).toBe(`attachment; filename="picture.png"; filename*=UTF-8''picture.png`);
    expect(download.headers['x-content-type-options']).toBe('nosniff');
    expect(download.headers['content-security-policy']).toContain('sandbox');
    expect(download.headers['content-length']).toBe(String(png.length));
    expect(download.headers['cache-control']).toBe('no-store');

    // Active content is only ever a download, whatever is asked for.
    for (const file of ['page.html', 'vector.svg']) {
      const attachment = await raw(p, { path: file });
      expect(attachment.headers['content-type'], file).toBe('application/octet-stream');
      expect(attachment.headers['content-disposition'], file).toMatch(/^attachment;/);
      expect(errorOf(await raw(p, { path: file, disposition: 'inline' })), file).toEqual([415, 'not_previewable']);
    }
    const empty = await raw(p, { path: 'empty.bin' });
    expect([empty.status, empty.raw.rawPayload.length, empty.headers['content-length']]).toEqual([200, 0, '0']);
    expect(errorOf(await raw(p, { path: '' }))).toEqual([400, 'is_directory']);
    expect((await raw(p, { path: 'picture.png', disposition: 'whatever' })).status).toBe(400);
  });

  it('previews only passive media, sandboxed, and only when the bytes match the name', async () => {
    const p = await project('previews', {
      'picture.png': png,
      'photo.JPG': Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]),
      'doc.pdf': pdf,
      'clip.mp4': Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(16)]),
      'song.mp3': Buffer.concat([Buffer.from('ID3'), Buffer.alloc(20)]),
      'renamed.pdf': 'just text renamed to .pdf\n',
      'script.png': '<script>alert(1)</script>',
      'notes.txt': 'plain text',
      'app.js': 'alert(1)',
      'data.json': '{}',
      'feed.xml': '<x/>',
    });
    for (const [file, type] of [['picture.png', 'image/png'], ['photo.JPG', 'image/jpeg'], ['doc.pdf', 'application/pdf'], ['clip.mp4', 'video/mp4'], ['song.mp3', 'audio/mpeg']] as const) {
      const preview = await raw(p, { path: file, disposition: 'inline' });
      expect(preview.status, file).toBe(200);
      expect(preview.headers['content-type'], file).toBe(type);
      expect(preview.headers['content-disposition'], file).toMatch(/^inline;/);
      expect(preview.headers['x-content-type-options'], file).toBe('nosniff');
      // The sandbox directive is what keeps a previewed file from ever scripting the app.
      const csp = String(preview.headers['content-security-policy']);
      expect(csp, file).toMatch(/^sandbox;/);
      expect(csp, file).toContain("default-src 'none'");
      expect(csp, file).not.toMatch(/allow-scripts|allow-same-origin|script-src/);
    }
    for (const file of ['renamed.pdf', 'script.png', 'notes.txt', 'app.js', 'data.json', 'feed.xml']) {
      expect(errorOf(await raw(p, { path: file, disposition: 'inline' })), file).toEqual([415, 'not_previewable']);
    }
  });

  it('serves byte ranges so that media can be seeked', async () => {
    const p = await project('ranges', { 'picture.png': png });
    const size = png.length;
    const middle = await raw(p, { path: 'picture.png', disposition: 'inline' }, { range: 'bytes=10-19' });
    expect(middle.status).toBe(206);
    expect(middle.headers['content-range']).toBe(`bytes 10-19/${size}`);
    expect(middle.raw.rawPayload.equals(png.subarray(10, 20))).toBe(true);
    const tail = await raw(p, { path: 'picture.png' }, { range: 'bytes=-5' });
    expect([tail.status, tail.raw.rawPayload.equals(png.subarray(size - 5))]).toEqual([206, true]);
    const open = await raw(p, { path: 'picture.png' }, { range: `bytes=${size - 3}-` });
    expect(open.raw.rawPayload.equals(png.subarray(size - 3))).toBe(true);
    const clipped = await raw(p, { path: 'picture.png' }, { range: `bytes=0-${size + 500}` });
    expect([clipped.status, clipped.raw.rawPayload.length]).toEqual([206, size]);
    expect(errorOf(await raw(p, { path: 'picture.png' }, { range: `bytes=${size}-` }))).toEqual([416, 'range_not_satisfiable']);
    expect(errorOf(await raw(p, { path: 'picture.png' }, { range: 'bytes=9-3' }))).toEqual([416, 'range_not_satisfiable']);
    // Anything that is not a single byte range gets the whole file.
    for (const range of ['bytes=0-1,5-6', 'lines=1-2', 'bytes=abc']) {
      const whole = await raw(p, { path: 'picture.png' }, { range });
      expect([whole.status, whole.raw.rawPayload.length], range).toEqual([200, size]);
    }
  });

  it('keeps odd file names from breaking out of the response header', async () => {
    const odd = 'we"ird\nna;me 文件.txt';
    const p = await project('odd-names', { [odd]: 'content' });
    const download = await raw(p, { path: odd });
    expect(download.status).toBe(200);
    const disposition = String(download.headers['content-disposition']);
    expect(disposition).not.toMatch(/[\r\n]/);
    expect(disposition).toBe(`attachment; filename="we_ird_na;me __.txt"; filename*=UTF-8''we%22ird%0Ana%3Bme%20%E6%96%87%E4%BB%B6.txt`);
  });
});

describe('saving', () => {
  it('creates, saves with the version it was read with, and refuses to overwrite a change made elsewhere', async () => {
    const p = await project('saving', { 'folder/keep.txt': 'x' });
    const events: StudioEvent[] = [];
    t.studio.context.bus.onTopic(`project:${p.project.id}`, (event) => events.push(event));

    const created = await save(p, { path: 'notes.md', content: '# one\n', baseVersion: null });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(created.body).toMatchObject({ path: 'notes.md', size: 6, created: true });
    expect(await readFile(path.join(p.dir, 'notes.md'), 'utf8')).toBe('# one\n');
    expect(events.at(-1)).toMatchObject({ type: 'files.changed', data: { projectId: p.project.id, kind: 'created', paths: ['notes.md'], userId: owner.userId } });
    // "I expect no file" is refused when there is one.
    expect(errorOf(await save(p, { path: 'notes.md', content: 'clobber', baseVersion: null }))).toEqual([409, 'file_exists']);

    const opened = (await read(p, 'notes.md')).body;
    expect(opened.version).toBe(created.body.version);
    const saved = await save(p, { path: 'notes.md', content: '# two\r\n', baseVersion: opened.version });
    expect(saved.body).toMatchObject({ created: false, size: 7 });
    expect(saved.body.version).not.toBe(opened.version);
    expect(await readFile(path.join(p.dir, 'notes.md'), 'utf8')).toBe('# two\r\n');
    expect(events.at(-1)).toMatchObject({ data: { kind: 'saved', paths: ['notes.md'] } });

    // Something else changes the file; the editor still holds the old version.
    await new Promise((resolve) => setTimeout(resolve, 15));
    await writeFile(path.join(p.dir, 'notes.md'), 'changed by an agent\n');
    const stale = await save(p, { path: 'notes.md', content: 'my edit', baseVersion: saved.body.version });
    expect(errorOf(stale)).toEqual([409, 'file_changed']);
    const current = (await read(p, 'notes.md')).body;
    expect((stale.body as unknown as { error: { details: { currentVersion: string } } }).error.details.currentVersion).toBe(current.version);
    expect(await readFile(path.join(p.dir, 'notes.md'), 'utf8')).toBe('changed by an agent\n');
    // The user may then decide to overwrite — explicitly.
    expect((await save(p, { path: 'notes.md', content: 'my edit', baseVersion: saved.body.version, force: true })).status).toBe(200);
    expect(await readFile(path.join(p.dir, 'notes.md'), 'utf8')).toBe('my edit');

    // A file deleted underneath is a conflict too, not a silent re-creation.
    const before = (await read(p, 'notes.md')).body.version;
    await rm(path.join(p.dir, 'notes.md'));
    expect(errorOf(await save(p, { path: 'notes.md', content: 'again', baseVersion: before }))).toEqual([409, 'file_changed']);
    expect(existsSync(path.join(p.dir, 'notes.md'))).toBe(false);
    for (const body of [{ path: 'x.txt', content: 'x' }, { path: 'x.txt', baseVersion: null }, { path: 'x.txt', content: 5, baseVersion: null }, { path: '', content: 'x', baseVersion: null }, { path: 'x.txt', content: 'x', baseVersion: null, force: 'true' }]) {
      expect((await save(p, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(existsSync(path.join(p.dir, 'x.txt'))).toBe(false);
  });

  it('keeps permissions, and writes through a link that stays inside the project without replacing the link', async () => {
    const p = await project('modes', { 'run.sh': '#!/bin/sh\n', 'real.txt': 'old\n' });
    await chmod(path.join(p.dir, 'run.sh'), 0o750);
    await symlink('real.txt', path.join(p.dir, 'alias.txt'));
    const script = (await read(p, 'run.sh')).body;
    await save(p, { path: 'run.sh', content: '#!/bin/sh\necho hi\n', baseVersion: script.version });
    expect((await stat(path.join(p.dir, 'run.sh'))).mode & 0o777).toBe(0o750);

    const viaLink = (await read(p, 'alias.txt')).body;
    const saved = await save(p, { path: 'alias.txt', content: 'new\n', baseVersion: viaLink.version });
    expect(saved.body.path).toBe('real.txt');
    expect(await readFile(path.join(p.dir, 'real.txt'), 'utf8')).toBe('new\n');
    expect((await lstat(path.join(p.dir, 'alias.txt'))).isSymbolicLink()).toBe(true);
    expect(await readlink(path.join(p.dir, 'alias.txt'))).toBe('real.txt');
  });

  it('never writes outside the project, into .git, onto the project folder, or under an odd new name', async () => {
    const p = await project('guarded', { 'file.txt': 'x', 'dir/inner.txt': 'x' });
    await sandbox.git(p.dir, 'init', '--quiet');
    await plantLinks(p);
    const config = await readFile(path.join(p.dir, '.git/config'), 'utf8');
    const attempt = async (target: string) => errorOf(await save(p, { path: target, content: 'PWNED', baseVersion: null, force: true }));

    for (const target of ['link-to-file', 'relative-link', 'dangling', 'link-to-dir/new.txt', 'link-to-dir/secret.txt', 'link-to-dir/dir/inner.txt', '../outside/new.txt', '../new.txt', '/tmp/studio-pwned.txt', 'dir/../../new.txt']) {
      expect(await attempt(target), target).toEqual([403, 'path_outside_root']);
    }
    for (const target of ['.git/config', '.git/hooks/pre-commit', '.GIT/config', 'dir/.git/hooks/x', '.git']) expect(await attempt(target), target).toEqual([403, 'protected_path']);
    expect(await attempt('.')).toEqual([403, 'project_root']);
    expect(await attempt('dir')).toEqual([400, 'is_directory']);
    expect(await attempt('missing-folder/new.txt')).toEqual([404, 'parent_missing']);
    expect(await attempt('file.txt/child.txt')).toEqual([400, 'not_a_directory']);
    for (const name of ['bad:name.txt', 'what?.txt', 'star*.txt', 'pipe|.txt', 'quo"te.txt', 'lt<gt>.txt', 'ctrl\u0001.txt', 'new\nline.txt', 'CON', 'nul', 'com1', 'LPT9', '...', ' leading.txt', 'trailing.txt ', 'x'.repeat(256)]) {
      expect(await attempt(name), JSON.stringify(name)).toEqual([400, 'invalid_name']);
    }

    expect(await outsideSecret()).toBe('outside secret\n');
    expect(await allFiles(outside)).toEqual(['dir/inner.txt', 'secret.txt']);
    expect(existsSync('/tmp/studio-pwned.txt')).toBe(false);
    expect(existsSync(path.join(path.dirname(t.workspace), 'new.txt'))).toBe(false);
    expect(await readFile(path.join(p.dir, '.git/config'), 'utf8')).toBe(config);
    expect(existsSync(path.join(p.dir, '.git/hooks/pre-commit'))).toBe(false);
    expect((await allFiles(p.dir)).filter((file) => !file.startsWith('.git/'))).toEqual(['dangling', 'dir/inner.txt', 'file.txt', 'link-to-dir', 'link-to-file', 'relative-link']);
  });

  it('refuses content beyond the limit and leaves the file as it was', async () => {
    const p = await project('limits', { 'file.txt': 'original' });
    const version = (await read(p, 'file.txt')).body.version;
    t.studio.context.services.files.limits.maxTextBytes = 1000;
    expect(errorOf(await save(p, { path: 'file.txt', content: 'x'.repeat(1001), baseVersion: version }))).toEqual([413, 'too_large']);
    expect(errorOf(await save(p, { path: 'fresh.txt', content: '汉'.repeat(400), baseVersion: null }))).toEqual([413, 'too_large']);
    expect((await save(p, { path: 'file.txt', content: 'x'.repeat(1000), baseVersion: version })).status).toBe(200);
    // A request body beyond what the route accepts at all is cut off by the server itself.
    const huge = await save(p, { path: 'file.txt', content: 'y'.repeat(11 * 1024 * 1024), baseVersion: null, force: true });
    expect(huge.status).toBe(413);
    expect(await readFile(path.join(p.dir, 'file.txt'), 'utf8')).toBe('x'.repeat(1000));
    expect(existsSync(path.join(p.dir, 'fresh.txt'))).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)('saves in one step: a save that cannot complete leaves the old file whole and nothing half-written', async () => {
    const p = await project('atomic', { 'locked/file.txt': 'the old content\n' });
    const version = (await read(p, 'locked/file.txt')).body.version;
    await chmod(path.join(p.dir, 'locked'), 0o555);
    try {
      const failed = await save(p, { path: 'locked/file.txt', content: 'new content that must not appear\n', baseVersion: version });
      expect(errorOf(failed)).toEqual([403, 'permission_denied']);
      expect(await readFile(path.join(p.dir, 'locked/file.txt'), 'utf8')).toBe('the old content\n');
      expect(await readdir(path.join(p.dir, 'locked'))).toEqual(['file.txt']);
      expect((await read(p, 'locked/file.txt')).body.version).toBe(version);
    } finally {
      await chmod(path.join(p.dir, 'locked'), 0o755);
    }
    // A successful save leaves no temporary file either.
    expect((await save(p, { path: 'locked/file.txt', content: 'fine\n', baseVersion: version })).status).toBe(200);
    expect(await readdir(path.join(p.dir, 'locked'))).toEqual(['file.txt']);
  });
});

describe('creating, moving and deleting', () => {
  it('creates files and folders with sane names, and nothing twice', async () => {
    const p = await project('creating', { 'src/existing.ts': 'x' });
    const made = await owner.post<FileEntry>(p.url('entries'), { parent: 'src', name: 'new.ts', kind: 'file' });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ name: 'new.ts', path: 'src/new.ts', kind: 'file', size: 0 });
    expect((await owner.post<FileEntry>(p.url('entries'), { name: 'docs', kind: 'directory' })).body).toMatchObject({ path: 'docs', kind: 'directory' });
    expect((await stat(path.join(p.dir, 'docs'))).isDirectory()).toBe(true);
    expect((await owner.post<FileEntry>(p.url('entries'), { parent: 'docs', name: '.env.local', kind: 'file' })).status).toBe(201);

    await symlink(path.join(outside, 'does-not-exist'), path.join(p.dir, 'dangling'));
    for (const [body, expected] of [
      [{ parent: 'src', name: 'existing.ts', kind: 'file' }, [409, 'already_exists']],
      [{ parent: 'src', name: 'existing.ts', kind: 'directory' }, [409, 'already_exists']],
      [{ name: 'docs', kind: 'file' }, [409, 'already_exists']],
      [{ name: 'dangling', kind: 'file' }, [409, 'already_exists']],
      [{ parent: 'missing', name: 'x.txt', kind: 'file' }, [404, 'parent_missing']],
      [{ parent: 'src/existing.ts', name: 'x.txt', kind: 'file' }, [400, 'not_a_directory']],
      [{ name: 'x.txt', kind: 'socket' }, [400, 'invalid_request']],
      [{ name: 'x.txt' }, [400, 'invalid_request']],
      [{ kind: 'file' }, [400, 'invalid_request']],
    ] as const) {
      expect(errorOf(await owner.post(p.url('entries'), body)), JSON.stringify(body)).toEqual(expected);
    }
    for (const name of ['a/b', '../up', '..', '.', '...', '', '   ', 'tab\tname', 'nul\u0000', 'CON', 'prn', 'aux', 'COM7', 'lpt1', 'q?', 'a<b', 'a>b', 'a:b', 'a"b', 'a|b', 'a*b', 'back\\slash', '.git', '.GIT']) {
      for (const kind of ['file', 'directory']) expect((await owner.post(p.url('entries'), { name, kind })).status, JSON.stringify(name)).toBe(400);
    }
    expect((await allFiles(p.dir)).sort()).toEqual(['dangling', 'docs/.env.local', 'src/existing.ts', 'src/new.ts']);
  });

  it('renames and moves entries inside the project, overwriting nothing', async () => {
    const p = await project('moving', { 'a.txt': 'a', 'b.txt': 'b', 'folder/inner.txt': 'i', 'other/keep.txt': 'k' });
    const move = (from: string, to: string) => owner.post<{ from: string; entry: FileEntry }>(p.url('move'), { from, to });

    expect((await move('a.txt', 'renamed.txt')).body).toMatchObject({ from: 'a.txt', entry: { path: 'renamed.txt', kind: 'file' } });
    expect((await move('renamed.txt', 'folder/moved.txt')).body.entry.path).toBe('folder/moved.txt');
    expect((await move('folder', 'other/nested')).body.entry).toMatchObject({ path: 'other/nested', kind: 'directory' });
    expect(await allFiles(p.dir)).toEqual(['b.txt', 'other/keep.txt', 'other/nested/inner.txt', 'other/nested/moved.txt']);
    // Moving something onto itself changes nothing and is not an error.
    expect((await move('b.txt', 'b.txt')).status).toBe(200);

    expect(errorOf(await move('b.txt', 'other/keep.txt'))).toEqual([409, 'already_exists']);
    expect(errorOf(await move('other', 'b.txt'))).toEqual([409, 'already_exists']);
    expect(errorOf(await move('nope.txt', 'x.txt'))).toEqual([404, 'file_not_found']);
    expect(errorOf(await move('b.txt', 'missing/b.txt'))).toEqual([404, 'parent_missing']);
    expect(errorOf(await move('other', 'other/nested/deeper'))).toEqual([400, 'invalid_move']);
    expect(errorOf(await move('.', 'elsewhere'))).toEqual([403, 'project_root']);
    expect(errorOf(await move('b.txt', '../b.txt'))).toEqual([403, 'path_outside_root']);
    expect(errorOf(await move('b.txt', '/tmp/b.txt'))).toEqual([403, 'path_outside_root']);
    expect(errorOf(await move('../outside/secret.txt', 'stolen.txt'))).toEqual([403, 'path_outside_root']);
    for (const to of ['bad:name', 'other/CON', 'other/a?b', '.git', 'other/.git']) expect((await move('b.txt', to)).status, to).toBe(400);
    expect(await allFiles(p.dir)).toEqual(['b.txt', 'other/keep.txt', 'other/nested/inner.txt', 'other/nested/moved.txt']);
    expect(await outsideSecret()).toBe('outside secret\n');
  });

  it('moves and deletes a link as a link, and never reaches through one', async () => {
    const p = await project('links', { 'keep.txt': 'k', 'target/inside.txt': 'i' });
    await sandbox.git(p.dir, 'init', '--quiet');
    await plantLinks(p);
    const move = (from: string, to: string) => owner.post<{ entry: FileEntry }>(p.url('move'), { from, to });
    const remove = (target: string, recursive = false) => owner.post(p.url('delete'), { path: target, recursive });

    // Through a link that leaves: refused for every kind of change.
    expect(errorOf(await move('link-to-dir/secret.txt', 'stolen.txt'))).toEqual([403, 'path_outside_root']);
    expect(errorOf(await move('keep.txt', 'link-to-dir/planted.txt'))).toEqual([403, 'path_outside_root']);
    expect(errorOf(await remove('link-to-dir/secret.txt'))).toEqual([403, 'path_outside_root']);
    expect(errorOf(await remove('link-to-dir/dir', true))).toEqual([403, 'path_outside_root']);
    expect(errorOf(await owner.post(p.url('entries'), { parent: 'link-to-dir', name: 'planted.txt', kind: 'file' }))).toEqual([403, 'path_outside_root']);
    expect(errorOf(await owner.post(p.url('entries'), { parent: 'link-to-dir/dir', name: 'planted', kind: 'directory' }))).toEqual([403, 'path_outside_root']);
    for (const target of ['.git', '.git/config', '.git/objects']) {
      expect(errorOf(await remove(target, true)), target).toEqual([403, 'protected_path']);
      expect(errorOf(await move(target, 'git-moved')), target).toEqual([403, 'protected_path']);
    }
    expect(errorOf(await move('keep.txt', '.git/hooks/pre-commit'))).toEqual([403, 'protected_path']);

    // The link itself can be renamed and deleted; what it points to is untouched.
    const renamed = await move('link-to-file', 'renamed-link');
    expect(renamed.body.entry).toMatchObject({ kind: 'symlink', linkTarget: 'outside' });
    expect(await readlink(path.join(p.dir, 'renamed-link'))).toBe(path.join(outside, 'secret.txt'));
    expect((await remove('renamed-link')).status).toBe(204);
    expect((await remove('dangling')).status).toBe(204);
    // Even "recursive" on a link to a folder removes just the link.
    expect((await remove('link-to-dir', true)).status).toBe(204);
    expect(await allFiles(outside)).toEqual(['dir/inner.txt', 'secret.txt']);
    expect(await outsideSecret()).toBe('outside secret\n');
    expect(existsSync(path.join(p.dir, '.git/config'))).toBe(true);
  });

  it('deletes files at once and folders only when told to take their contents along', async () => {
    const p = await project('deleting', { 'file.txt': 'f', 'full/a.txt': 'a', 'full/deep/b.txt': 'b', 'keep.txt': 'k' });
    await mkdir(path.join(p.dir, 'empty'));
    const events: StudioEvent[] = [];
    t.studio.context.bus.onTopic(`project:${p.project.id}`, (event) => events.push(event));
    const remove = (body: Record<string, unknown>) => owner.post(p.url('delete'), body);

    expect((await remove({ path: 'file.txt' })).status).toBe(204);
    expect(events.at(-1)).toMatchObject({ type: 'files.changed', data: { kind: 'deleted', paths: ['file.txt'] } });
    expect((await remove({ path: 'empty' })).status).toBe(204);
    expect(errorOf(await remove({ path: 'full' }))).toEqual([409, 'directory_not_empty']);
    for (const recursive of ['true', 1, 'yes']) expect((await remove({ path: 'full', recursive })).status, String(recursive)).toBe(400);
    expect(await allFiles(p.dir)).toEqual(['full/a.txt', 'full/deep/b.txt', 'keep.txt']);
    expect((await remove({ path: 'full', recursive: true })).status).toBe(204);
    expect(await allFiles(p.dir)).toEqual(['keep.txt']);

    expect(errorOf(await remove({ path: 'nope' }))).toEqual([404, 'file_not_found']);
    for (const root of ['.', './']) expect(errorOf(await remove({ path: root, recursive: true })), root).toEqual([403, 'project_root']);
    expect((await remove({ path: '', recursive: true })).status).toBe(400);
    for (const target of ['..', '../outside', '../outside/secret.txt', '/etc/hostname', 'keep.txt/../../outside']) {
      expect(errorOf(await remove({ path: target, recursive: true })), target).toEqual([403, 'path_outside_root']);
    }
    expect(existsSync(p.dir)).toBe(true);
    expect(await allFiles(outside)).toEqual(['dir/inner.txt', 'secret.txt']);
  });
});

describe('uploading', () => {
  it('stores several files and recreates a folder structure from the declared paths', async () => {
    const p = await project('uploads', { 'existing.txt': 'old' });
    const events: StudioEvent[] = [];
    t.studio.context.bus.onTopic(`project:${p.project.id}`, (event) => events.push(event));
    const binary = Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 7) % 256));
    // Larger than the server's ordinary request-body limit: uploads are streamed, not buffered.
    const large = Buffer.alloc(3 * 1024 * 1024, 0x41);

    const result = await upload(
      p,
      [
        { filename: 'top.txt', content: 'top' },
        { path: 'photos/2024/a/b/c.txt', filename: 'c.txt', content: 'deep' },
        { path: 'photos/pic.bin', filename: 'pic.bin', content: binary },
        { path: 'photos/文件 名.txt', filename: 'x.txt', content: '内容' },
        { filename: 'large.bin', content: large },
      ],
      { target: 'incoming/batch' },
    );
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body).toMatchObject({ target: 'incoming/batch', requested: 5, skipped: [] });
    expect(result.body.stored).toEqual([
      { path: 'incoming/batch/top.txt', size: 3, replaced: false },
      { path: 'incoming/batch/photos/2024/a/b/c.txt', size: 4, replaced: false },
      { path: 'incoming/batch/photos/pic.bin', size: 5000, replaced: false },
      { path: 'incoming/batch/photos/文件 名.txt', size: 6, replaced: false },
      { path: 'incoming/batch/large.bin', size: large.length, replaced: false },
    ]);
    expect((await readFile(path.join(p.dir, 'incoming/batch/photos/pic.bin'))).equals(binary)).toBe(true);
    expect((await readFile(path.join(p.dir, 'incoming/batch/large.bin'))).equals(large)).toBe(true);
    expect(await readFile(path.join(p.dir, 'incoming/batch/photos/2024/a/b/c.txt'), 'utf8')).toBe('deep');
    // No temporary files are left, and open clients are told what arrived.
    expect((await allFiles(p.dir)).some((file) => file.includes('.studio-upload-') || file.endsWith('.tmp'))).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'files.changed', data: { kind: 'uploaded', paths: result.body.stored.map((entry) => entry.path) } });
  });

  it('does not overwrite unless asked', async () => {
    const p = await project('overwrite', { 'existing.txt': 'old', 'folder/x.txt': 'x' });
    const kept = await upload(p, [{ filename: 'existing.txt', content: 'new' }, { filename: 'fresh.txt', content: 'fresh' }, { filename: 'folder', content: 'a file named like a folder' }]);
    expect(kept.body).toMatchObject({ requested: 3, stored: [{ path: 'fresh.txt' }], skipped: [{ name: 'existing.txt', reason: 'exists' }, { name: 'folder', reason: 'is_directory' }] });
    expect(await readFile(path.join(p.dir, 'existing.txt'), 'utf8')).toBe('old');

    const replaced = await upload(p, [{ filename: 'existing.txt', content: 'new' }, { filename: 'folder', content: 'still a folder' }], { overwrite: 'true' });
    expect(replaced.body).toMatchObject({ stored: [{ path: 'existing.txt', size: 3, replaced: true }], skipped: [{ name: 'folder', reason: 'is_directory' }] });
    expect(await readFile(path.join(p.dir, 'existing.txt'), 'utf8')).toBe('new');
    // The same name twice in one request: the first wins, the second is reported.
    const twice = await upload(p, [{ filename: 'dup.txt', content: 'first' }, { filename: 'dup.txt', content: 'second' }], { overwrite: 'true' });
    expect(twice.body).toMatchObject({ stored: [{ path: 'dup.txt' }], skipped: [{ name: 'dup.txt', reason: 'exists' }] });
    expect(await readFile(path.join(p.dir, 'dup.txt'), 'utf8')).toBe('first');
  });

  it('skips files whose declared path is hostile, stores the rest, and writes nothing outside', async () => {
    const p = await project('hostile', {});
    await sandbox.git(p.dir, 'init', '--quiet');
    await plantLinks(p);
    const hostile: Array<[string, string]> = [
      ['../evil.txt', 'outside_project'],
      ['../../outside/evil.txt', 'outside_project'],
      ['ok/../../evil.txt', 'outside_project'],
      ['/etc/cron.d/evil', 'outside_project'],
      ['/tmp/studio-upload-evil.txt', 'outside_project'],
      ['C:/Windows/evil.txt', 'outside_project'],
      ['link-to-dir/evil.txt', 'outside_project'],
      ['link-to-dir/dir/evil.txt', 'outside_project'],
      ['.git/hooks/pre-commit', 'protected'],
      ['sub/.GIT/config', 'protected'],
      ['.git', 'protected'],
      ['back\\slash.txt', 'invalid_name'],
      ['..\\..\\evil.txt', 'invalid_name'],
      ['folder/CON', 'invalid_name'],
      ['what?.txt', 'invalid_name'],
      ['pipe|name.txt', 'invalid_name'],
      ['new\nline.txt', 'invalid_name'],
      ['nul\u0000byte.txt', 'invalid_name'],
      ['...', 'invalid_name'],
      ['', 'invalid_name'],
      ['/', 'outside_project'],
    ];
    const parts: Part[] = hostile.map(([declared]) => ({ path: declared, filename: 'x.txt', content: 'PWNED' }));
    parts.splice(3, 0, { path: 'good/one.txt', filename: 'one.txt', content: 'fine' });
    parts.push({ filename: 'two.txt', content: 'fine too' });

    const result = await upload(p, parts, { overwrite: 'true' });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.requested).toBe(hostile.length + 2);
    expect(result.body.stored.map((entry) => entry.path)).toEqual(['good/one.txt', 'two.txt']);
    expect(result.body.skipped.map((entry) => [entry.name, entry.reason])).toEqual(hostile);

    expect(await allFiles(outside)).toEqual(['dir/inner.txt', 'secret.txt']);
    expect(await outsideSecret()).toBe('outside secret\n');
    for (const place of [path.dirname(t.workspace), t.workspace, '/tmp']) {
      expect(existsSync(path.join(place, 'evil.txt')), place).toBe(false);
    }
    expect(existsSync('/tmp/studio-upload-evil.txt')).toBe(false);
    expect(existsSync(path.join(p.dir, '.git/hooks/pre-commit'))).toBe(false);
    expect((await allFiles(p.dir)).filter((file) => !file.startsWith('.git/'))).toEqual(['dangling', 'good/one.txt', 'link-to-dir', 'link-to-file', 'relative-link', 'two.txt']);
    // With a target that itself leads out, or is protected, the whole upload is refused.
    for (const [target, code] of [['link-to-dir', 'path_outside_root'], ['../outside', 'path_outside_root'], ['.git/hooks', 'protected_path'], ['/tmp', 'path_outside_root']] as const) {
      expect(errorOf(await upload(p, [{ filename: 'x.txt', content: 'PWNED' }], { target })), target).toEqual([403, code]);
    }
    expect(await allFiles(outside)).toEqual(['dir/inner.txt', 'secret.txt']);
  });

  it('replaces a link with the uploaded file instead of writing through it', async () => {
    const p = await project('over-link', {});
    await plantLinks(p);
    expect((await upload(p, [{ filename: 'link-to-file', content: 'x' }, { filename: 'dangling', content: 'x' }])).body.skipped.map((entry) => entry.reason)).toEqual(['exists', 'exists']);
    const replaced = await upload(p, [{ filename: 'link-to-file', content: 'now a real file' }, { filename: 'dangling', content: 'real too' }], { overwrite: 'true' });
    expect(replaced.body.stored).toHaveLength(2);
    expect((await lstat(path.join(p.dir, 'link-to-file'))).isFile()).toBe(true);
    expect(await readFile(path.join(p.dir, 'link-to-file'), 'utf8')).toBe('now a real file');
    expect(await outsideSecret()).toBe('outside secret\n');
    expect(existsSync(path.join(outside, 'does-not-exist.txt'))).toBe(false);
  });

  it('stores nothing at all when a request breaks a limit', async () => {
    const p = await project('limited', { 'existing.txt': 'old' });
    const limits = t.studio.context.services.files.limits;
    limits.maxUploadFiles = 3;
    limits.maxUploadFileBytes = 1000;
    limits.maxUploadTotalBytes = 2500;
    const small = (name: string, size = 10): Part => ({ path: `batch/${name}`, filename: name, content: 'x'.repeat(size) });

    const tooMany = await upload(p, [small('1.txt'), small('2.txt'), small('3.txt'), small('4.txt')]);
    expect(errorOf(tooMany)).toEqual([413, 'too_many_files']);
    expect((tooMany.body as unknown as { error: { message: string } }).error.message).toContain('3 files');

    const tooBig = await upload(p, [small('ok.txt'), small('huge.txt', 1001)]);
    expect(errorOf(tooBig)).toEqual([413, 'file_too_large']);

    const tooMuch = await upload(p, [small('a.txt', 900), small('b.txt', 900), small('c.txt', 900)]);
    expect(errorOf(tooMuch)).toEqual([413, 'upload_too_large']);

    // Not a single file of the refused requests exists, nor the folder they would have created, nor a leftover.
    expect(await allFiles(p.dir)).toEqual(['existing.txt']);
    expect(existsSync(path.join(p.dir, 'batch'))).toBe(false);
    // Exactly at the limits is fine.
    const fits = await upload(p, [small('a.txt', 1000), small('b.txt', 1000), small('c.txt', 500)]);
    expect(fits.body.stored).toHaveLength(3);

    expect(errorOf(await upload(p, []))).toEqual([400, 'no_files']);
    expect(errorOf(await upload(p, [{ field: 'something-else', filename: 'x.txt', content: 'x' }]))).toEqual([400, 'no_files']);
    expect((await owner.post(p.url('upload'), { not: 'multipart' })).status).toBeGreaterThanOrEqual(400);
    expect(errorOf(await upload(p, [small('x.txt')], { target: 'existing.txt' }))).toEqual([400, 'not_a_directory']);
    expect((await upload(p, [small('x.txt')], { overwrite: 'yes' })).status).toBe(400);
  });
});

describe('downloading a folder as an archive', () => {
  it('contains exactly what the tree shows, byte for byte, and never follows a link', async () => {
    const binary = Buffer.from(Array.from({ length: 4000 }, (_, i) => (i * 13) % 256));
    const p = await project('archived', {
      '.gitignore': '*.log\nsecret/\n',
      'readme.md': '# hello\n',
      'src/app.ts': 'export const a = 1;\n',
      'src/deep/er/file.txt': 'deep\n',
      'src/data.bin': binary,
      'src/文件 名.txt': '内容\n',
      'debug.log': 'ignored',
      'secret/key.pem': 'ignored',
      'node_modules/dep/index.js': 'hidden',
    });
    await sandbox.git(p.dir, 'init', '--quiet');
    await mkdir(path.join(p.dir, 'empty-folder'));
    await chmod(path.join(p.dir, 'readme.md'), 0o640);
    await plantLinks(p);
    await symlink('readme.md', path.join(p.dir, 'inside-link'));

    const response = await owner.get(p.url('archive'));
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('application/zip');
    expect(response.headers['content-disposition']).toBe(`attachment; filename="archived.zip"; filename*=UTF-8''archived.zip`);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    const archive = response.raw.rawPayload;
    const entries = readZip(archive);
    const tree = (await owner.get<FileTree>(p.url('tree'))).body;
    const shown: string[] = [];
    const collect = (nodes: readonly FileTreeNode[]) => {
      for (const node of nodes) {
        if (node.kind !== 'symlink') shown.push(`archived/${node.path}${node.kind === 'directory' ? '/' : ''}`);
        collect(node.children ?? []);
      }
    };
    collect(tree.entries);
    expect(entries.map((entry) => entry.name).sort()).toEqual(shown.sort());
    expect(entries.map((entry) => entry.name).sort()).toEqual([
      'archived/.gitignore',
      'archived/empty-folder/',
      'archived/readme.md',
      'archived/src/',
      'archived/src/app.ts',
      'archived/src/data.bin',
      'archived/src/deep/',
      'archived/src/deep/er/',
      'archived/src/deep/er/file.txt',
      'archived/src/文件 名.txt',
    ]);
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    expect(byName.get('archived/src/data.bin')!.data.equals(binary)).toBe(true);
    expect(byName.get('archived/src/文件 名.txt')!.data.toString('utf8')).toBe('内容\n');
    expect(byName.get('archived/readme.md')!.mode).toBe(0o640);
    // Nothing from outside the project, by any route.
    expect(archive.includes(Buffer.from('outside secret'))).toBe(false);
    expect(archive.includes(Buffer.from('outside inner'))).toBe(false);
    for (const entry of entries) expect(entry.name).not.toMatch(/link|dangling|secret|node_modules|\.log/);

    if (spawnSync('unzip', ['-v'], { stdio: 'ignore' }).status === 0) {
      const folder = await mkdtemp(path.join(os.tmpdir(), 'studio-unzip-'));
      try {
        await writeFile(path.join(folder, 'a.zip'), archive);
        execFileSync('unzip', ['-q', path.join(folder, 'a.zip'), '-d', path.join(folder, 'out')]);
        expect((await readFile(path.join(folder, 'out/archived/src/data.bin'))).equals(binary)).toBe(true);
        expect((await stat(path.join(folder, 'out/archived/empty-folder'))).isDirectory()).toBe(true);
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
    }

    // A sub-folder can be archived on its own.
    const sub = readZip((await owner.get(p.url(`archive?${q({ path: 'src/deep' })}`))).raw.rawPayload);
    expect(sub.map((entry) => entry.name)).toEqual(['deep/er/', 'deep/er/file.txt']);
  });

  it('refuses what is too big before sending anything, and what is not a folder inside the project', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 12; i += 1) files[`many/f${i}.txt`] = 'x'.repeat(100);
    const p = await project('too-big', files);
    await plantLinks(p);
    const limits = t.studio.context.services.files.limits;
    limits.maxArchiveEntries = 10;
    expect(errorOf(await owner.get(p.url('archive')))).toEqual([413, 'archive_too_large']);
    limits.maxArchiveEntries = 1000;
    limits.maxArchiveBytes = 1000;
    const tooMuch = await owner.get(p.url(`archive?${q({ path: 'many' })}`));
    expect(errorOf(tooMuch)).toEqual([413, 'archive_too_large']);
    expect(tooMuch.headers['content-type']).toMatch(/application\/json/);
    limits.maxArchiveBytes = 5000;
    expect(readZip((await owner.get(p.url(`archive?${q({ path: 'many' })}`))).raw.rawPayload)).toHaveLength(12);

    expect(errorOf(await owner.get(p.url(`archive?${q({ path: 'many/f1.txt' })}`)))).toEqual([400, 'not_a_directory']);
    expect(errorOf(await owner.get(p.url(`archive?${q({ path: 'nope' })}`)))).toEqual([404, 'file_not_found']);
    for (const target of ['..', '../outside', '/etc', 'link-to-dir', 'link-to-dir/dir']) {
      expect(errorOf(await owner.get(p.url(`archive?${q({ path: target })}`))), target).toEqual([403, 'path_outside_root']);
    }
    expect(errorOf(await owner.get(p.url(`archive?${q({ path: '.git' })}`)))).toEqual([403, 'protected_path']);
  });
});

describe('over a real connection', () => {
  it('streams uploads, ranged downloads and archives through an actual socket', async () => {
    const p = await project('socket', { 'docs/readme.md': '# hi\n' });
    const { url } = await t.listen();
    const headers = { cookie: owner.cookie!, origin: url, 'x-studio-csrf': owner.csrfToken! };
    const payload = Buffer.from(Array.from({ length: 2 * 1024 * 1024 + 123 }, (_, i) => (i * 31) % 251));

    const form = new FormData();
    form.append('path', 'media/clip.bin');
    form.append('file', new Blob([payload]), 'clip.bin');
    form.append('file', new Blob(['small']), 'small.txt');
    const uploaded = await fetch(`${url}${p.url('upload?target=incoming')}`, { method: 'POST', headers, body: form });
    expect(uploaded.status).toBe(200);
    expect(((await uploaded.json()) as UploadResult).stored).toEqual([
      { path: 'incoming/media/clip.bin', size: payload.length, replaced: false },
      { path: 'incoming/small.txt', size: 5, replaced: false },
    ]);
    expect((await readFile(path.join(p.dir, 'incoming/media/clip.bin'))).equals(payload)).toBe(true);

    const whole = await fetch(`${url}${p.url(`raw?${q({ path: 'incoming/media/clip.bin' })}`)}`, { headers });
    expect([whole.status, whole.headers.get('content-length'), whole.headers.get('content-type')]).toEqual([200, String(payload.length), 'application/octet-stream']);
    expect(Buffer.from(await whole.arrayBuffer()).equals(payload)).toBe(true);
    const part = await fetch(`${url}${p.url(`raw?${q({ path: 'incoming/media/clip.bin' })}`)}`, { headers: { ...headers, range: 'bytes=1000000-1000099' } });
    expect([part.status, part.headers.get('content-range'), part.headers.get('content-length')]).toEqual([206, `bytes 1000000-1000099/${payload.length}`, '100']);
    expect(Buffer.from(await part.arrayBuffer()).equals(payload.subarray(1_000_000, 1_000_100))).toBe(true);

    const archive = await fetch(`${url}${p.url('archive')}`, { headers });
    expect([archive.status, archive.headers.get('content-type')]).toEqual([200, 'application/zip']);
    const entries = readZip(Buffer.from(await archive.arrayBuffer()));
    expect(entries.map((entry) => entry.name).sort()).toEqual(['socket/docs/', 'socket/docs/readme.md', 'socket/incoming/', 'socket/incoming/media/', 'socket/incoming/media/clip.bin', 'socket/incoming/small.txt']);
    expect(entries.find((entry) => entry.name.endsWith('clip.bin'))!.data.equals(payload)).toBe(true);

    // Without the session, the same addresses give nothing away.
    expect((await fetch(`${url}${p.url('archive')}`)).status).toBe(401);
    expect((await fetch(`${url}${p.url('upload')}`, { method: 'POST', body: form })).status).toBe(401);
    // A request from another site's page is refused even with the cookie.
    expect((await fetch(`${url}${p.url('upload')}`, { method: 'POST', headers: { ...headers, origin: 'https://evil.example' }, body: form })).status).toBe(403);
    expect(await allFiles(path.join(p.dir, 'incoming'))).toEqual(['media/clip.bin', 'small.txt']);
  });
});

describe('who may do what', () => {
  it('turns away anonymous callers, hides projects from strangers, and lets read-only members only read', async () => {
    const p = await project('guarded', { 'file.txt': 'content\n', 'folder/inner.txt': 'x' });
    const reader = await t.member('reader');
    const writer = await t.member('writer');
    const stranger = await t.member('stranger');
    await owner.put(`/api/projects/${p.project.id}/members/${reader.userId}`, { access: 'read' });
    await owner.put(`/api/projects/${p.project.id}/members/${writer.userId}`, { access: 'write' });
    const unknown = (suffix: string) => `/api/projects/00000000000000000000000000/files/${suffix}`;
    const form = multipart([{ filename: 'up.txt', content: 'uploaded' }]);

    const reads = ['list', 'tree', 'search?query=file', 'grep?query=content', 'content?path=file.txt', 'raw?path=file.txt', 'archive'];
    for (const route of reads) {
      expect((await t.anonymous().get(p.url(route))).status, `anonymous ${route}`).toBe(401);
      const hidden = await stranger.get(p.url(route));
      expect(hidden.status, `stranger ${route}`).toBe(404);
      expect(hidden.body, `stranger ${route}`).toEqual((await stranger.get(unknown(route))).body);
      expect((await reader.get(p.url(route))).status, `reader ${route}`).toBe(200);
    }

    const writes: Array<[string, (client: TestClient, base: (suffix: string) => string) => Promise<TestResponse>]> = [
      ['save', (client, base) => client.put(base('content'), { path: 'file.txt', content: 'CHANGED', baseVersion: null, force: true })],
      ['create', (client, base) => client.post(base('entries'), { name: 'made.txt', kind: 'file' })],
      ['move', (client, base) => client.post(base('move'), { from: 'file.txt', to: 'moved.txt' })],
      ['delete', (client, base) => client.post(base('delete'), { path: 'folder', recursive: true })],
      ['upload', (client, base) => client.request('POST', base('upload'), form.body, form.headers)],
    ];
    for (const [name, call] of writes) {
      expect((await call(t.anonymous(), p.url)).status, `anonymous ${name}`).toBe(401);
      const hidden = await call(stranger, p.url);
      expect(hidden.status, `stranger ${name}`).toBe(404);
      expect(hidden.body, `stranger ${name}`).toEqual((await call(stranger, unknown)).body);
      expect(errorOf(await call(reader, p.url)), `reader ${name}`).toEqual([403, 'project_read_only']);
    }
    expect(await allFiles(p.dir)).toEqual(['file.txt', 'folder/inner.txt']);
    expect(await readFile(path.join(p.dir, 'file.txt'), 'utf8')).toBe('content\n');

    // A member who may write can do all of it.
    for (const [name, call] of writes) expect((await call(writer, p.url)).status, `writer ${name}`).toBeLessThan(300);
    expect(await allFiles(p.dir)).toEqual(['made.txt', 'moved.txt', 'up.txt']);
  });
});
