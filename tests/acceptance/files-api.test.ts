import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initRepository } from './support/git.js';
import { Realtime } from './support/realtime.js';
import type { ApiClient, RunningStudio } from './support/studio.js';
import {
  createMember,
  createProject,
  download,
  shareProject,
  startAgentStudio,
  type ErrorBody,
  type Json,
  type Project,
} from './support/workbench.js';
import { readZip } from './support/zip.js';

/**
 * 6.5 — Files (requirements 02 §6.5, §7.2).
 *
 * Every path is relative to the project's folder. Reads are confined exactly
 * like writes; a link that leads outside the project is followed by
 * nothing; the repository's own data (`.git`) can be neither read nor written
 * through the file API. Saving carries the version that was read, so two
 * editors cannot silently overwrite each other.
 *
 * Adapted limits: a tree that is too large reports that it was cut instead of
 * answering 413 (AT-PJ-060); an upload takes 100 files, not 20 (AT-PJ-067).
 */

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
    '1f15c4890000000d4944415478da63fccfc0500f0004850181' +
    'f2b6f6d00000000049454e44ae426082',
  'hex',
);

describe('6.5 files', () => {
  let studio: RunningStudio;
  let owner: ApiClient;
  let project: Project;
  let other: Project;
  let outside: string;
  let base: string;

  beforeAll(async () => {
    studio = await startAgentStudio();
    owner = await studio.owner();
    project = await createProject(studio, owner, 'files');
    other = await createProject(studio, owner, 'files-other');
    base = `/api/projects/${project.id}/files`;
    const root = project.rootDir;
    initRepository(root);
    await writeFile(path.join(root, '.gitignore'), '*.log\n!keep.log\n');
    await writeFile(path.join(root, 'a.log'), 'ignored\n');
    await writeFile(path.join(root, 'keep.log'), 'kept\n');
    await writeFile(path.join(root, 'README.md'), '# Files\n\nThe needle is in this haystack.\n');
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'src', 'x.ts'), 'export const x = 1;\n');
    await mkdir(path.join(root, 'node_modules', 'dep'), { recursive: true });
    await writeFile(path.join(root, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
    await mkdir(path.join(root, 'docs', 'deep', 'deeper'), { recursive: true });
    await writeFile(path.join(root, 'docs', 'guide.md'), 'guide\n');
    await writeFile(path.join(root, 'docs', 'deep', 'deeper', 'note.txt'), 'deep note\n');
    await writeFile(path.join(root, 'docs', 'pixel.png'), PNG);
    await writeFile(
      path.join(root, 'docs', 'data.bin'),
      Buffer.from(Array.from({ length: 512 }, (_unused, index) => index % 256)),
    );
    await writeFile(path.join(other.rootDir, 'secret.txt'), 'another project’s secret\n');

    // Things outside the project that links inside it point at.
    outside = path.join(studio.workspace, '..', 'outside-files');
    await mkdir(path.join(outside, 'folder'), { recursive: true });
    await writeFile(path.join(outside, 'target.txt'), 'outside and untouched\n');
    await mkdir(path.join(root, 'links'));
    await symlink(path.join(outside, 'target.txt'), path.join(root, 'links', 'file-out'));
    await symlink(path.join(outside, 'folder'), path.join(root, 'links', 'folder-out'));
    await symlink(path.join(outside, 'not-there.txt'), path.join(root, 'links', 'dangling'));
    await writeFile(path.join(root, 'links', 'inside-target.txt'), 'inside\n');
    await symlink('inside-target.txt', path.join(root, 'links', 'inside-link'));
  });
  afterAll(() => studio?.destroy());

  const q = (value: string) => encodeURIComponent(value);
  const read = (client: ApiClient, file: string) =>
    client.get<Json>(`${base}/content?path=${q(file)}`);
  const list = (client: ApiClient, folder = '', extra = '') =>
    client.get<Json>(`${base}/list?path=${q(folder)}${extra}`);
  const names = (listing: Json) =>
    (listing.entries as Array<{ name: string }>).map((entry) => entry.name);
  const save = (
    client: ApiClient,
    file: string,
    content: string,
    baseVersion: string | null,
    extra: Record<string, unknown> = {},
  ) => client.put<Json>(`${base}/content`, { path: file, content, baseVersion, ...extra });
  const refusedOutside = (response: { status: number; body: unknown }, what: string) => {
    expect(response.status, what).toBe(403);
    expect((response.body as ErrorBody).error.code, what).toBe('path_outside_root');
  };

  function upload(
    client: ApiClient,
    target: string,
    files: Array<{ name: string; content: string | Buffer; relativePath?: string }>,
    overwrite = false,
  ) {
    const form = new FormData();
    for (const file of files) {
      if (file.relativePath !== undefined) form.append('path', file.relativePath);
      form.append(
        'file',
        new Blob([
          new Uint8Array(
            typeof file.content === 'string' ? Buffer.from(file.content) : file.content,
          ),
        ]),
        file.name,
      );
    }
    return client.post<Json>(
      `${base}/upload?target=${q(target)}${overwrite ? '&overwrite=true' : ''}`,
      form,
    );
  }

  it('AT-PJ-059: a folder lists folders before files; ignored files, the dependency folder and the repository’s own data are hidden; the ignore file and a negated pattern are shown', async () => {
    const listing = (await list(owner)).body;
    expect(names(listing)).toEqual(['docs', 'links', 'src', '.gitignore', 'keep.log', 'README.md']);
    expect(listing.entries.find((entry: Json) => entry.name === 'src')).toMatchObject({
      kind: 'directory',
      path: 'src',
      ignored: false,
    });
    expect(listing.entries.find((entry: Json) => entry.name === 'README.md')).toMatchObject({
      kind: 'file',
      path: 'README.md',
      size: 41,
    });
    // Asked to show them, ignored files are listed and marked; the two always-hidden folders stay hidden.
    const withIgnored = (await list(owner, '', '&ignored=show')).body;
    expect(names(withIgnored)).toContain('a.log');
    expect(withIgnored.entries.find((entry: Json) => entry.name === 'a.log').ignored).toBe(true);
    expect(names(withIgnored)).not.toContain('node_modules');
    expect(names(withIgnored)).not.toContain('.git');

    const tree = (await owner.get<Json>(`${base}/tree`)).body;
    const flat: string[] = [];
    const walk = (nodes: Json[]) => {
      for (const node of nodes) {
        flat.push(node.path);
        if (node.children) walk(node.children);
      }
    };
    walk(tree.entries);
    expect(flat).toEqual(
      expect.arrayContaining(['src/x.ts', 'docs/deep/deeper/note.txt', '.gitignore', 'keep.log']),
    );
    expect(
      flat.some(
        (entry) => entry.includes('node_modules') || entry.startsWith('.git/') || entry === 'a.log',
      ),
    ).toBe(false);
    expect(tree).toMatchObject({ truncated: false, truncatedBy: null, entryCount: flat.length });
  });

  it('AT-PJ-060 (adapted): a tree larger than the limit says that it was cut, and by what, instead of pretending to be complete', async () => {
    const cut = (await owner.get<Json>(`${base}/tree?limit=4`)).body;
    expect(cut).toMatchObject({ truncated: true, truncatedBy: 'entries' });
    expect(cut.entryCount).toBeLessThanOrEqual(4);
    const shallow = (await owner.get<Json>(`${base}/tree?depth=1`)).body;
    expect(shallow).toMatchObject({ truncated: true, truncatedBy: 'depth' });
    expect(shallow.entries.find((entry: Json) => entry.name === 'docs').childrenOmitted).toBe(true);
    const limits = (await owner.get<Json>('/api/files/limits')).body;
    expect(limits).toMatchObject({
      maxTreeEntries: 10_000,
      maxTextBytes: 5 * 1024 * 1024,
      maxUploadFiles: 100,
    });
  });

  it('AT-PJ-061: a read cannot leave the project — not by climbing with "..", not with an absolute path, not into another project — and returns no content', async () => {
    const attempts = [
      '../files-other/secret.txt',
      'src/../../files-other/secret.txt',
      '../../../../../../etc/passwd',
      path.join(other.rootDir, 'secret.txt'),
      '/etc/passwd',
      path.join(studio.dataDir, 'studio.db'),
    ];
    for (const attempt of attempts) {
      for (const url of [
        `${base}/content?path=${q(attempt)}`,
        `${base}/raw?path=${q(attempt)}`,
        `${base}/list?path=${q(attempt)}`,
        `${base}/archive?path=${q(attempt)}`,
      ]) {
        const response = await owner.get<ErrorBody>(url);
        expect([400, 403], url).toContain(response.status);
        expect(JSON.stringify(response.body)).not.toContain('another project');
        expect(JSON.stringify(response.body)).not.toContain('root:');
      }
    }
    refusedOutside(await read(owner, '../files-other/secret.txt'), 'climbing out');
    // Its own files, of course, are read.
    const mine = (await read(owner, 'src/x.ts')).body;
    expect(mine).toMatchObject({
      kind: 'text',
      path: 'src/x.ts',
      content: 'export const x = 1;\n',
      lineEnding: 'lf',
    });
  });

  it('AT-PJ-062: a link that leads outside the project is followed by nothing — reading, saving, creating or uploading through it is refused and the outside target is unchanged', async () => {
    // Reads.
    refusedOutside(await read(owner, 'links/file-out'), 'read through a file link');
    refusedOutside(
      await owner.get(`${base}/raw?path=${q('links/file-out')}`),
      'download through a file link',
    );
    refusedOutside(await list(owner, 'links/folder-out'), 'list through a folder link');
    refusedOutside(
      await owner.get(`${base}/archive?path=${q('links/folder-out')}`),
      'archive through a folder link',
    );
    // Writes.
    refusedOutside(
      await save(owner, 'links/file-out', 'overwritten', null, { force: true }),
      'save through a file link',
    );
    refusedOutside(
      await save(owner, 'links/folder-out/new.txt', 'planted', null),
      'save inside a folder link',
    );
    refusedOutside(
      await owner.post(`${base}/entries`, {
        parent: 'links/folder-out',
        name: 'made.txt',
        kind: 'file',
      }),
      'create inside a folder link',
    );
    refusedOutside(
      await save(owner, 'links/dangling', 'through a dangling link', null, { force: true }),
      'save to a dangling link',
    );
    refusedOutside(
      await owner.post(`${base}/move`, { from: 'keep.log', to: 'links/folder-out/keep.log' }),
      'move into a folder link',
    );
    const uploaded = await upload(owner, 'links/folder-out', [
      { name: 'up.txt', content: 'uploaded' },
    ]);
    expect(
      uploaded.status === 403 ||
        (uploaded.body.stored?.length === 0 &&
          uploaded.body.skipped?.[0]?.reason === 'outside_project'),
    ).toBe(true);

    expect(readFileSync(path.join(outside, 'target.txt'), 'utf8')).toBe('outside and untouched\n');
    expect(readdirSync(path.join(outside, 'folder'))).toEqual([]);
    expect(existsSync(path.join(outside, 'not-there.txt'))).toBe(false);
    expect(existsSync(path.join(project.rootDir, 'keep.log'))).toBe(true);
    // The listing tells the reader what kind of link each one is, so the client can say why it will not open.
    const links = (await list(owner, 'links')).body.entries as Array<{
      name: string;
      kind: string;
      linkTarget?: string;
    }>;
    expect(
      Object.fromEntries(
        links
          .filter((entry) => entry.kind === 'symlink')
          .map((entry) => [entry.name, entry.linkTarget]),
      ),
    ).toEqual({
      'file-out': 'outside',
      'folder-out': 'outside',
      dangling: 'missing',
      'inside-link': 'file',
    });
  });

  it('AT-PJ-063: a link to another file inside the project can be saved through; deleting a link removes the link and not its target', async () => {
    const opened = (await read(owner, 'links/inside-link')).body;
    expect(opened.content).toBe('inside\n');
    const saved = await save(
      owner,
      'links/inside-link',
      'changed through the link\n',
      opened.version,
    );
    expect(saved.status).toBe(200);
    expect(readFileSync(path.join(project.rootDir, 'links', 'inside-target.txt'), 'utf8')).toBe(
      'changed through the link\n',
    );
    expect(lstatSync(path.join(project.rootDir, 'links', 'inside-link')).isSymbolicLink()).toBe(
      true,
    );
    expect((await owner.post(`${base}/delete`, { path: 'links/inside-link' })).status).toBe(204);
    expect(existsSync(path.join(project.rootDir, 'links', 'inside-target.txt'))).toBe(true);
    expect(
      lstatSync(path.join(project.rootDir, 'links', 'inside-link'), { throwIfNoEntry: false }),
    ).toBeUndefined();
    // Deleting a link that points outside removes only the link, too.
    expect((await owner.post(`${base}/delete`, { path: 'links/dangling' })).status).toBe(204);
    expect((await owner.post(`${base}/delete`, { path: 'links/file-out' })).status).toBe(204);
    expect(readFileSync(path.join(outside, 'target.txt'), 'utf8')).toBe('outside and untouched\n');
  });

  it('§7.2: the repository’s own data (.git) can be neither read nor written through the file API, however the name is spelled', async () => {
    const protectedPath = (response: { status: number; body: unknown }, what: string) => {
      expect(response.status, what).toBe(403);
      expect((response.body as ErrorBody).error.code, what).toBe('protected_path');
    };
    for (const spelling of [
      '.git/config',
      '.git/HEAD',
      '.GIT/config',
      '.Git/config',
      './.git/config',
      'src/../.git/config',
    ]) {
      protectedPath(await read(owner, spelling), `read ${spelling}`);
      protectedPath(await owner.get(`${base}/raw?path=${q(spelling)}`), `download ${spelling}`);
    }
    protectedPath(await list(owner, '.git'), 'list');
    protectedPath(await owner.get(`${base}/archive?path=.git`), 'archive');
    protectedPath(
      await save(owner, '.git/hooks/pre-commit', '#!/bin/sh\necho owned\n', null),
      'plant a hook',
    );
    protectedPath(
      await save(owner, '.git/config', '[core]\n', null, { force: true }),
      'overwrite the configuration',
    );
    protectedPath(
      await owner.post(`${base}/entries`, {
        parent: '.git/hooks',
        name: 'post-checkout',
        kind: 'file',
      }),
      'create a hook',
    );
    protectedPath(
      await owner.post(`${base}/move`, { from: 'keep.log', to: '.git/hooks/pre-push' }),
      'move a file in as a hook',
    );
    protectedPath(
      await owner.post(`${base}/move`, { from: '.git', to: 'not-git' }),
      'rename it away',
    );
    protectedPath(
      await owner.post(`${base}/delete`, { path: '.git', recursive: true }),
      'delete it',
    );
    const nested = await owner.post(`${base}/entries`, {
      parent: 'src',
      name: '.git',
      kind: 'directory',
    });
    expect([400, 403]).toContain(nested.status); // a nested one cannot be made either
    expect(existsSync(path.join(project.rootDir, 'src', '.git'))).toBe(false);
    const uploaded = await upload(owner, '.git/hooks', [
      { name: 'pre-commit', content: 'echo owned' },
    ]);
    expect(
      uploaded.status === 403 ||
        (uploaded.body.stored?.length === 0 && uploaded.body.skipped?.[0]?.reason === 'protected'),
    ).toBe(true);
    const sneaked = await upload(owner, '', [
      { name: 'pre-commit', content: 'echo owned', relativePath: '.git/hooks/pre-commit' },
    ]);
    expect(sneaked.body.stored ?? []).toEqual([]);

    expect(existsSync(path.join(project.rootDir, '.git', 'hooks', 'pre-commit'))).toBe(false);
    expect(existsSync(path.join(project.rootDir, '.git', 'hooks', 'pre-push'))).toBe(false);
    expect(existsSync(path.join(project.rootDir, '.git', 'HEAD'))).toBe(true);
    // The archive of the whole project leaves it out as well.
    const archive = await download(owner, `${base}/archive?path=`);
    expect(readZip(archive.bytes).some((entry) => entry.name.includes('.git/'))).toBe(false);
  });

  it('AT-PJ-064/065: a new item needs a real name — a slash, a control character, only dots or nothing is refused; an existing name is a conflict, also when renaming', async () => {
    const before = names((await list(owner, 'src')).body);
    for (const name of [
      'a/b.txt',
      '..',
      '.',
      '',
      '   ',
      'bad\u0001name',
      'tab\tname',
      'null\u0000byte',
    ]) {
      const refused = await owner.post<ErrorBody>(`${base}/entries`, {
        parent: 'src',
        name,
        kind: 'file',
      });
      expect(refused.status, JSON.stringify(name)).toBe(400);
      expect(refused.body.error.message.length).toBeGreaterThan(5);
    }
    expect(names((await list(owner, 'src')).body)).toEqual(before);

    const created = await owner.post<Json>(`${base}/entries`, {
      parent: 'src',
      name: 'new.ts',
      kind: 'file',
    });
    expect(created.status).toBe(201);
    expect(existsSync(path.join(project.rootDir, 'src', 'new.ts'))).toBe(true);
    expect(
      (
        await owner.post<Json>(`${base}/entries`, {
          parent: 'src',
          name: 'folder',
          kind: 'directory',
        })
      ).status,
    ).toBe(201);
    const duplicate = await owner.post<ErrorBody>(`${base}/entries`, {
      parent: 'src',
      name: 'new.ts',
      kind: 'file',
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('already_exists');
    const clash = await owner.post<ErrorBody>(`${base}/move`, {
      from: 'src/new.ts',
      to: 'src/x.ts',
    });
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('already_exists');
    expect(readFileSync(path.join(project.rootDir, 'src', 'x.ts'), 'utf8')).toBe(
      'export const x = 1;\n',
    );
    // A rename that is free succeeds.
    expect(
      (await owner.post(`${base}/move`, { from: 'src/new.ts', to: 'src/renamed.ts' })).status,
    ).toBeLessThan(300);
    expect(names((await list(owner, 'src')).body)).toEqual(['folder', 'renamed.ts', 'x.ts']);
    expect(
      (
        await owner.post<ErrorBody>(`${base}/entries`, {
          parent: 'no/such/folder',
          name: 'x.txt',
          kind: 'file',
        })
      ).status,
    ).toBe(404);
  });

  it('AT-PJ-066: deleting a folder takes its contents with it only when asked to; the project folder itself can never be deleted', async () => {
    await mkdir(path.join(project.rootDir, 'trash', 'nested'), { recursive: true });
    await writeFile(path.join(project.rootDir, 'trash', 'nested', 'file.txt'), 'x');
    const careful = await owner.post<ErrorBody>(`${base}/delete`, { path: 'trash' });
    expect(careful.status).toBe(409);
    expect(careful.body.error.code).toBe('directory_not_empty');
    expect(existsSync(path.join(project.rootDir, 'trash', 'nested', 'file.txt'))).toBe(true); // "cancelling deletes nothing"
    expect((await owner.post(`${base}/delete`, { path: 'trash', recursive: true })).status).toBe(
      204,
    );
    expect(existsSync(path.join(project.rootDir, 'trash'))).toBe(false);

    for (const root of ['.', './', 'src/..']) {
      const refused = await owner.post<ErrorBody>(`${base}/delete`, {
        path: root,
        recursive: true,
      });
      expect(refused.status, root).toBe(403);
      expect(refused.body.error.code).toBe('project_root');
    }
    expect((await owner.post(`${base}/delete`, { path: '', recursive: true })).status).toBe(400);
    expect(existsSync(path.join(project.rootDir, 'README.md'))).toBe(true);
    expect(
      (await owner.post<ErrorBody>(`${base}/delete`, { path: 'no-such-file.txt' })).status,
    ).toBe(404);
  });

  it('AT-PJ-072/073 (adapted): a save writes exactly what was sent and returns the new version; Windows line endings and a byte-order mark survive a round trip untouched', async () => {
    const windows = '﻿first line\r\nsecond line\r\n';
    await writeFile(path.join(project.rootDir, 'crlf.txt'), windows);
    const opened = (await read(owner, 'crlf.txt')).body;
    expect(opened).toMatchObject({ kind: 'text', lineEnding: 'crlf', content: windows });
    // Saving what was read changes nothing on disk.
    const same = await save(owner, 'crlf.txt', opened.content, opened.version);
    expect(same.status).toBe(200);
    expect(readFileSync(path.join(project.rootDir, 'crlf.txt'), 'utf8')).toBe(windows);

    const edited = `${windows}third line\r\n`;
    const saved = await save(owner, 'crlf.txt', edited, same.body.version);
    expect(saved.body).toMatchObject({
      path: 'crlf.txt',
      created: false,
      size: Buffer.byteLength(edited),
    });
    expect(saved.body.version).not.toBe(opened.version);
    expect(readFileSync(path.join(project.rootDir, 'crlf.txt'), 'utf8')).toBe(edited);
    expect((await read(owner, 'crlf.txt')).body.version).toBe(saved.body.version);
    // A new file is created by saving with "must not exist".
    const created = await save(owner, 'docs/new-note.md', '# New\n', null);
    expect(created.body).toMatchObject({ created: true, path: 'docs/new-note.md' });
    expect(readFileSync(path.join(project.rootDir, 'docs', 'new-note.md'), 'utf8')).toBe('# New\n');
  });

  it('PJ-043: a save carries the version that was read — a file changed in the meantime (by another editor, an agent or on disk) is not overwritten unless the user says so', async () => {
    await writeFile(path.join(project.rootDir, 'shared.txt'), 'original\n');
    const mine = (await read(owner, 'shared.txt')).body;
    const tablet = await studio.owner();
    const theirs = (await read(tablet, 'shared.txt')).body;
    expect(theirs.version).toBe(mine.version);
    expect((await save(tablet, 'shared.txt', 'saved on the tablet\n', theirs.version)).status).toBe(
      200,
    );

    const stale = await save(owner, 'shared.txt', 'saved on the laptop\n', mine.version);
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('file_changed');
    expect(stale.body.error.message).toContain('Nothing was saved');
    expect(readFileSync(path.join(project.rootDir, 'shared.txt'), 'utf8')).toBe(
      'saved on the tablet\n',
    );
    // The refusal says which version is current, so the editor can show the difference and ask.
    const current = (await read(owner, 'shared.txt')).body.version;
    expect(stale.body.error.details).toMatchObject({ currentVersion: current });

    // A change made behind the product's back is noticed just the same.
    await writeFile(
      path.join(project.rootDir, 'shared.txt'),
      'changed on disk by something else\n',
    );
    expect((await save(owner, 'shared.txt', 'again\n', current)).status).toBe(409);
    // Deleted in the meantime: also a conflict, not a silent re-creation.
    await rm(path.join(project.rootDir, 'shared.txt'));
    const gone = await save(owner, 'shared.txt', 'again\n', current);
    expect(gone.status).toBe(409);
    expect(existsSync(path.join(project.rootDir, 'shared.txt'))).toBe(false);
    // "Must not exist" refuses when it does; the explicit overwrite is the one way through.
    const exists = await save(owner, 'README.md', 'clobbered\n', null);
    expect(exists.status).toBe(409);
    expect(exists.body.error.code).toBe('file_exists');
    expect(readFileSync(path.join(project.rootDir, 'README.md'), 'utf8')).toContain('needle');
    await writeFile(path.join(project.rootDir, 'forced.txt'), 'before\n');
    expect(
      (
        await save(owner, 'forced.txt', 'overwritten on purpose\n', 'a-version-that-is-wrong', {
          force: true,
        })
      ).status,
    ).toBe(200);
    expect(readFileSync(path.join(project.rootDir, 'forced.txt'), 'utf8')).toBe(
      'overwritten on purpose\n',
    );
    // A save without saying which version was read is not accepted at all.
    expect(
      (await owner.put(`${base}/content`, { path: 'forced.txt', content: 'no version' })).status,
    ).toBe(400);
  });

  it('AT-PJ-070 (adapted): a text body above the editor’s limit is refused with 413 and the file on disk is unchanged', async () => {
    await writeFile(path.join(project.rootDir, 'big.txt'), 'small for now\n');
    const opened = (await read(owner, 'big.txt')).body;
    const refused = await save(owner, 'big.txt', 'x'.repeat(5 * 1024 * 1024 + 1), opened.version);
    expect(refused.status).toBe(413);
    expect(refused.body.error.message).toMatch(/5 MB/);
    expect(readFileSync(path.join(project.rootDir, 'big.txt'), 'utf8')).toBe('small for now\n');
  });

  it('AT-PJ-077/078 (adapted): a binary file opens as "binary", never as garbled text; an image may be shown inline — sandboxed — and nothing that could run in the page may', async () => {
    const png = (await read(owner, 'docs/pixel.png')).body;
    expect(png).toMatchObject({ kind: 'binary', previewable: true, mediaType: 'image/png' });
    expect(png.content).toBeUndefined();
    const blob = (await read(owner, 'docs/data.bin')).body;
    expect(blob).toMatchObject({ kind: 'binary', previewable: false });

    const inline = await download(
      owner,
      `${base}/raw?path=${q('docs/pixel.png')}&disposition=inline`,
    );
    expect(inline.status).toBe(200);
    expect(inline.headers.get('content-type')).toBe('image/png');
    expect(inline.headers.get('content-security-policy')).toContain('sandbox');
    expect(inline.headers.get('x-content-type-options')).toBe('nosniff');
    expect(inline.bytes.equals(PNG)).toBe(true);

    await writeFile(
      path.join(project.rootDir, 'docs', 'page.html'),
      '<script>alert(document.cookie)</script>',
    );
    await writeFile(
      path.join(project.rootDir, 'docs', 'drawing.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
    );
    for (const active of ['docs/page.html', 'docs/drawing.svg', 'docs/data.bin']) {
      const refused = await owner.get(`${base}/raw?path=${q(active)}&disposition=inline`);
      expect(refused.status, active).toBe(415);
      const asDownload = await download(owner, `${base}/raw?path=${q(active)}`);
      expect(asDownload.status).toBe(200);
      expect(asDownload.headers.get('content-disposition')).toMatch(/^attachment/);
      expect(asDownload.headers.get('content-type')).not.toMatch(/html|svg/);
    }
  });

  it('AT-PJ-083: a downloaded file is byte-for-byte the file on disk; a downloaded folder is a ZIP of exactly the files the tree shows under it', async () => {
    const file = await download(owner, `${base}/raw?path=${q('docs/data.bin')}`);
    expect(file.status).toBe(200);
    expect(file.bytes.equals(readFileSync(path.join(project.rootDir, 'docs', 'data.bin')))).toBe(
      true,
    );
    // A part of it can be asked for.
    const part = await download(owner, `${base}/raw?path=${q('docs/data.bin')}`, {
      range: 'bytes=10-19',
    });
    expect(part.status).toBe(206);
    expect([...part.bytes]).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);

    await writeFile(
      path.join(project.rootDir, 'docs', 'debug.log'),
      'ignored by the ignore file\n',
    );
    await symlink(path.join(outside, 'target.txt'), path.join(project.rootDir, 'docs', 'link-out'));
    const archive = await download(owner, `${base}/archive?path=docs`);
    expect(archive.status).toBe(200);
    expect(archive.headers.get('content-type')).toContain('zip');
    const entries = readZip(archive.bytes).filter((entry) => !entry.isDirectory);
    const tree = (await owner.get<Json>(`${base}/tree?path=docs`)).body;
    const shown: string[] = [];
    const walk = (nodes: Json[]) => {
      for (const node of nodes) {
        if (node.kind === 'file') shown.push(node.path);
        if (node.children) walk(node.children);
      }
    };
    walk(tree.entries);
    expect(entries.map((entry) => entry.name).sort()).toEqual(shown.map((entry) => entry).sort());
    expect(shown).toContain('docs/deep/deeper/note.txt');
    expect(shown).not.toContain('docs/debug.log');
    expect(entries.some((entry) => entry.name.includes('link-out'))).toBe(false); // links are left out
    for (const entry of entries)
      expect(
        entry.data.equals(readFileSync(path.join(project.rootDir, entry.name))),
        entry.name,
      ).toBe(true);
    expect(JSON.stringify(entries.map((entry) => entry.data.toString('latin1')))).not.toContain(
      'outside and untouched',
    );
    await rm(path.join(project.rootDir, 'docs', 'link-out'));
  });

  it('AT-PJ-068: an upload keeps the folder structure it was given beneath the target; an existing file is left alone unless replacing was asked for', async () => {
    const first = await upload(owner, 'src', [
      { name: 'c.txt', content: 'deep upload', relativePath: 'dropped/a/b/c.txt' },
      { name: 'top.txt', content: 'top upload' },
    ]);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ target: 'src', requested: 2, skipped: [] });
    expect(first.body.stored.map((item: Json) => item.path).sort()).toEqual([
      'src/dropped/a/b/c.txt',
      'src/top.txt',
    ]);
    expect(
      readFileSync(path.join(project.rootDir, 'src', 'dropped', 'a', 'b', 'c.txt'), 'utf8'),
    ).toBe('deep upload');

    const again = await upload(owner, 'src', [{ name: 'top.txt', content: 'second version' }]);
    expect(again.body.stored).toEqual([]);
    expect(again.body.skipped).toEqual([{ name: 'top.txt', reason: 'exists' }]);
    expect(readFileSync(path.join(project.rootDir, 'src', 'top.txt'), 'utf8')).toBe('top upload');
    const replaced = await upload(
      owner,
      'src',
      [{ name: 'top.txt', content: 'second version' }],
      true,
    );
    expect(replaced.body.stored).toEqual([{ path: 'src/top.txt', size: 14, replaced: true }]);
    expect(readFileSync(path.join(project.rootDir, 'src', 'top.txt'), 'utf8')).toBe(
      'second version',
    );
  });

  it('AT-PJ-069: of two uploaded files, the one whose path climbs out of the project is skipped and reported; the other is stored; nothing is written outside', async () => {
    const result = await upload(owner, 'src', [
      {
        name: 'escape.txt',
        content: 'should not land',
        relativePath: '../../../outside-files/escape.txt',
      },
      { name: 'honest.txt', content: 'lands' },
    ]);
    expect(result.status).toBe(200);
    expect(result.body.requested).toBe(2);
    expect(result.body.stored.map((item: Json) => item.path)).toEqual(['src/honest.txt']);
    expect(result.body.skipped).toHaveLength(1);
    expect(['outside_project', 'invalid_name']).toContain(result.body.skipped[0].reason);
    expect(existsSync(path.join(outside, 'escape.txt'))).toBe(false);
    expect(existsSync(path.join(studio.workspace, 'escape.txt'))).toBe(false);
    expect(readdirSync(outside).sort()).toEqual(['folder', 'target.txt']);
    const absolute = await upload(owner, '', [
      { name: 'abs.txt', content: 'x', relativePath: path.join(outside, 'abs.txt') },
    ]);
    expect(absolute.body.stored ?? []).toEqual([]);
    expect(existsSync(path.join(outside, 'abs.txt'))).toBe(false);
  });

  it('AT-PJ-067 (adapted): an upload with more files than the limit is refused with a message naming the limit, and nothing of it is stored', async () => {
    await mkdir(path.join(project.rootDir, 'bulk'));
    const many = Array.from({ length: 101 }, (_unused, index) => ({
      name: `f${index}.txt`,
      content: 'x',
    }));
    const refused = await upload(owner, 'bulk', many);
    expect(refused.status).toBe(413);
    expect(refused.body.error.code).toBe('too_many_files');
    expect(refused.body.error.message).toContain('100');
    expect(readdirSync(path.join(project.rootDir, 'bulk'))).toEqual([]);
    const empty = await owner.post<ErrorBody>(`${base}/upload?target=bulk`, new FormData());
    expect(empty.status).toBe(400);
  });

  it('AT-PJ-081: the file-name search for "@" mentions returns at most ten project-relative paths by default and says when there were more', async () => {
    await mkdir(path.join(project.rootDir, 'tests'));
    for (let index = 0; index < 30; index += 1)
      await writeFile(path.join(project.rootDir, 'tests', `test-${index}.ts`), '');
    const found = (await owner.get<Json>(`${base}/search?query=test`)).body;
    expect(found.results).toHaveLength(10);
    expect(found.truncated).toBe(true);
    for (const match of found.results as Array<{ path: string; name: string }>) {
      expect(match.path.startsWith('/')).toBe(false);
      expect(match.path.toLowerCase()).toContain('test');
      expect(existsSync(path.join(project.rootDir, match.path))).toBe(true);
    }
    const one = (await owner.get<Json>(`${base}/search?query=${q('x.ts')}`)).body;
    expect(one.results.map((match: Json) => match.path)).toContain('src/x.ts');
    expect((await owner.get<Json>(`${base}/search?query=index.js`)).body.results).toEqual([]); // nothing from the dependency folder
    expect((await owner.get(`${base}/search?query=`)).status).toBe(400);
    // Searching what files say: the line and where it is.
    const grep = (await owner.get<Json>(`${base}/grep?query=needle`)).body;
    expect(grep.matches).toEqual([
      { path: 'README.md', line: 3, text: 'The needle is in this haystack.' },
    ]);
  });

  it('files.changed: a save on one device tells the other devices looking at the project which file changed', async () => {
    const tablet = await studio.owner();
    const live = await Realtime.open(studio, tablet);
    await live.subscribe(`project:${project.id}`);
    const created = await save(owner, 'announced.txt', 'hello\n', null);
    expect(created.status).toBe(200);
    const told = await live.event(`project:${project.id}`, 'files.changed');
    expect(told.data).toMatchObject({
      projectId: project.id,
      paths: ['announced.txt'],
      userId: owner.userId,
    });
    expect(['saved', 'created']).toContain(told.data.kind);
    await owner.post(`${base}/delete`, { path: 'announced.txt' });
    await live.event(`project:${project.id}`, 'files.changed', {
      where: (frame) => frame.data.kind === 'deleted',
    });
    await live.close();
  });

  it('access: a read-only member reads and downloads and cannot change anything; someone the project was not shared with finds nothing; a visitor is turned away', async () => {
    const reader = await createMember(studio, owner, 'filereader');
    const stranger = await createMember(studio, owner, 'filestranger');
    await shareProject(owner, project.id, reader.userId!, 'read');
    expect((await read(reader, 'src/x.ts')).body.content).toBe('export const x = 1;\n');
    expect((await download(reader, `${base}/raw?path=${q('docs/data.bin')}`)).status).toBe(200);
    expect((await download(reader, `${base}/archive?path=src`)).status).toBe(200);
    const version = (await read(reader, 'src/x.ts')).body.version;
    for (const attempt of [
      save(reader, 'src/x.ts', 'export const x = 2;\n', version),
      reader.post(`${base}/entries`, { parent: 'src', name: 'by-reader.ts', kind: 'file' }),
      reader.post(`${base}/move`, { from: 'src/x.ts', to: 'src/y.ts' }),
      reader.post(`${base}/delete`, { path: 'src/x.ts' }),
      upload(reader, 'src', [{ name: 'by-reader.txt', content: 'x' }]),
    ]) {
      const refused = await attempt;
      expect(refused.status).toBe(403);
      expect((refused.body as ErrorBody).error.code).toBe('project_read_only');
    }
    expect(readFileSync(path.join(project.rootDir, 'src', 'x.ts'), 'utf8')).toBe(
      'export const x = 1;\n',
    );
    expect(existsSync(path.join(project.rootDir, 'src', 'by-reader.txt'))).toBe(false);

    for (const url of [
      `${base}/list`,
      `${base}/tree`,
      `${base}/content?path=README.md`,
      `${base}/raw?path=README.md`,
      `${base}/archive?path=src`,
      `${base}/search?query=x`,
      `${base}/grep?query=needle`,
    ]) {
      const hidden = await stranger.get<ErrorBody>(url);
      expect(hidden.status, url).toBe(404);
      expect(hidden.body.error.code).toBe('project_not_found');
      expect((await studio.client().get(url)).status, url).toBe(401); // AT-PJ-205
    }
    expect((await save(stranger, 'README.md', 'x', null, { force: true })).status).toBe(404);
    const anonymous = studio.client();
    expect(
      (
        await anonymous.put(`${base}/content`, {
          path: 'README.md',
          content: 'x',
          baseVersion: null,
          force: true,
        })
      ).status,
    ).toBe(401);
    expect(readFileSync(path.join(project.rootDir, 'README.md'), 'utf8')).toContain('needle');
  });

  it('AT-PJ-085: when a project’s folder has disappeared from the disk its file tools say so plainly, and other projects are unaffected', async () => {
    const doomed = await createProject(studio, owner, 'vanishing');
    await writeFile(path.join(doomed.rootDir, 'file.txt'), 'x');
    expect((await owner.get(`/api/projects/${doomed.id}/files/list`)).status).toBe(200);
    await rm(doomed.rootDir, { recursive: true });
    for (const url of ['list', 'tree', 'content?path=file.txt']) {
      const gone = await owner.get<ErrorBody>(`/api/projects/${doomed.id}/files/${url}`);
      expect(gone.status, url).toBe(404);
      expect(gone.body.error.code).toBe('project_folder_missing');
      expect(gone.body.error.message).toContain('no longer exists');
    }
    expect((await list(owner)).status).toBe(200);
  });
});
