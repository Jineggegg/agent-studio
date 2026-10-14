import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Realtime } from './support/realtime.js';
import type { ApiClient, RunningStudio } from './support/studio.js';
import {
  createMember,
  createProject,
  shareProject,
  startAgentStudio,
  type ErrorBody,
  type Json,
  type Project,
} from './support/workbench.js';

/**
 * 6.1 — Shared memory as the app sees it (requirements 04 §6.1, §7.1).
 *
 * Notes are Markdown files in folders: `global`, and one folder per project
 * (named after the project's working directory). Deliberate differences this
 * file is written for: notes can be created and edited in the app, with a
 * version check so two devices cannot silently overwrite each other; a person
 * without a project does not see its folder at all; and text that looks like
 * a credential is refused for people as well as for agents.
 *
 * What an agent can reach is in `memory-agents.test.ts`.
 */
describe('6.1 memory: notes, search, versions, access', () => {
  let studio: RunningStudio;
  let owner: ApiClient;
  let alpha: Project;
  let beta: Project;
  let alphaFolder: string;
  let betaFolder: string;

  beforeAll(async () => {
    studio = await startAgentStudio();
    owner = await studio.owner();
    alpha = await createProject(studio, owner, 'Alpha App', {
      icon: { symbol: 'rocket', color: 'green' },
    });
    beta = await createProject(studio, owner, 'beta');
    const folders = (await owner.get<{ folders: Json[] }>('/api/memory/folders')).body.folders;
    alphaFolder = folders.find((folder) => folder.project?.id === alpha.id).name;
    betaFolder = folders.find((folder) => folder.project?.id === beta.id).name;
  });
  afterAll(() => studio?.destroy());

  const q = encodeURIComponent;
  const create = (
    client: ApiClient,
    folder: string,
    title: string,
    body: string,
    extra: Record<string, unknown> = {},
  ) => client.post<Json>('/api/memory/notes', { folder, title, body, ...extra });
  const note = (client: ApiClient, id: string) => client.get<Json>(`/api/memory/note?id=${q(id)}`);
  const list = (client: ApiClient, query = '') =>
    client.get<{ notes: Json[]; total: number }>(`/api/memory/notes${query}`);
  const search = (client: ApiClient, text: string, folder?: string) =>
    client.get<{ hits: Json[]; total: number; query: string }>(
      `/api/memory/search?q=${q(text)}${folder ? `&folder=${q(folder)}` : ''}`,
    );

  it('AT-MEM-003 (adapted): a project’s folder is named after its working directory and carries the project’s name and icon; someone without the project does not see the folder at all', async () => {
    expect(alphaFolder).toBe('alpha-app');
    const folders = (await owner.get<{ folders: Json[] }>('/api/memory/folders')).body.folders;
    expect(folders[0]).toMatchObject({ name: 'global', kind: 'global', project: null });
    expect(folders.find((folder) => folder.name === 'alpha-app')).toMatchObject({
      kind: 'project',
      access: 'write',
      project: {
        id: alpha.id,
        name: 'Alpha App',
        icon: { symbol: 'rocket', color: 'green' },
        archived: false,
      },
    });
    const stranger = await createMember(studio, owner, 'memstranger');
    const theirs = (await stranger.get<{ folders: Json[] }>('/api/memory/folders')).body.folders;
    expect(theirs.map((folder) => folder.name)).toEqual(['global']);
    expect(JSON.stringify(theirs)).not.toContain('Alpha App');
  });

  it('AT-MEM-001: recent notes across folders come newest-update first with the exact count; folders are listed with "global" first', async () => {
    const made: string[] = [];
    for (const [folder, title] of [
      [alphaFolder, 'Deploy rules'],
      ['global', 'House style'],
      [alphaFolder, 'Release checklist'],
      [alphaFolder, 'Known issues'],
      ['global', 'Glossary'],
    ] as const) {
      const created = await create(owner, folder, title, `Body of ${title}.`);
      expect(created.status).toBe(201);
      made.push(created.body.id);
    }
    expect(made[0]).toBe('alpha-app/deploy-rules'); // an id is the folder and a readable name, never a client-chosen path
    const recent = (await list(owner)).body;
    expect(recent.total).toBe(5);
    expect(recent.notes.map((item) => item.title)).toEqual([
      'Glossary',
      'Known issues',
      'Release checklist',
      'House style',
      'Deploy rules',
    ]);
    // Updating an old note moves it to the top.
    const old = (await note(owner, made[0]!)).body;
    expect(
      (
        await owner.put<Json>('/api/memory/note', {
          id: old.id,
          baseVersion: old.version,
          body: 'Deploy on Tuesdays only.',
        })
      ).status,
    ).toBe(200);
    expect((await list(owner)).body.notes[0].title).toBe('Deploy rules');
    const folders = (await owner.get<{ folders: Json[] }>('/api/memory/folders')).body.folders;
    expect(folders.map((folder) => `${folder.name}:${folder.count}`).slice(0, 2)).toEqual([
      'global:2',
      'alpha-app:3',
    ]);
    expect((await list(owner, `?folder=${alphaFolder}`)).body.total).toBe(3);
  });

  it('AT-MEM-002: sixty notes in one folder, some in sub-folders, are listed forty at a time with the exact total', async () => {
    for (let index = 1; index <= 60; index += 1) {
      const folder = index % 5 === 0 ? `${betaFolder}/archive` : betaFolder;
      const created = await create(owner, folder, `Note number ${index}`, `Text of note ${index}.`);
      expect(created.status, JSON.stringify(created.body)).toBe(201);
    }
    const first = (await list(owner, `?folder=${betaFolder}`)).body;
    expect(first.notes).toHaveLength(40);
    expect(first.total).toBe(60);
    const rest = (await list(owner, `?folder=${betaFolder}&offset=40`)).body;
    expect(rest.notes).toHaveLength(20);
    expect(new Set([...first.notes, ...rest.notes].map((item) => item.id)).size).toBe(60);
    expect((await list(owner, `?folder=${betaFolder}/archive`)).body.total).toBe(12);
    expect((await owner.get(`/api/memory/notes?folder=${betaFolder}&limit=101`)).status).toBe(400);
  });

  it('AT-MEM-004/005: search finds English words, and a two-character word inside an unbroken Chinese sentence when the note carries it as a keyword; a folder narrows the search', async () => {
    await create(
      owner,
      alphaFolder,
      'Deployment window',
      'We deploy the service every Tuesday after the review.',
      { tags: ['ops'] },
    );
    await create(
      owner,
      betaFolder,
      'Beta deploy notes',
      'The beta deploy needs a manual migration first.',
    );
    await create(
      owner,
      alphaFolder,
      '部署说明',
      '每次上线之前必须先在预发环境完成部署验证然后才能继续。',
      { keywords: ['部署', '预发'] },
    );

    const english = (await search(owner, 'deploy')).body;
    expect(english.hits.map((hit) => hit.id)).toEqual(
      expect.arrayContaining(['alpha-app/deployment-window', 'beta/beta-deploy-notes']),
    );
    const hit = english.hits.find((item) => item.id === 'beta/beta-deploy-notes')!;
    expect(hit.snippet.text.toLowerCase()).toContain('deploy');
    expect(hit.snippet.highlights.length).toBeGreaterThan(0);
    const [start, end] = hit.snippet.highlights[0] as [number, number];
    expect(hit.snippet.text.slice(start, end).toLowerCase()).toContain('deploy');

    const scoped = (await search(owner, 'deploy', alphaFolder)).body;
    expect(scoped.hits.every((item) => item.folder === alphaFolder)).toBe(true);
    expect(scoped.hits.filter((item) => item.id === 'alpha-app/deployment-window')).toHaveLength(1); // once
    expect(scoped.hits.map((item) => item.id)).not.toContain('beta/beta-deploy-notes');

    const chinese = (await search(owner, '部署')).body;
    expect(chinese.hits.map((item) => item.title)).toContain('部署说明');
    expect((await search(owner, '预发')).body.hits.map((item) => item.title)).toContain('部署说明');
    expect((await search(owner, 'zeppelin')).body.hits).toEqual([]);
    // Tags can be listed and used to narrow the list.
    expect(
      (await owner.get<{ tags: Json[] }>(`/api/memory/tags?folder=${alphaFolder}`)).body.tags,
    ).toEqual([{ tag: 'ops', count: 1 }]);
    expect((await list(owner, '?tag=ops')).body.notes.map((item) => item.title)).toEqual([
      'Deployment window',
    ]);
  });

  it('AT-MEM-006: a query of 201 characters is refused as invalid; an empty query gives an empty list', async () => {
    expect((await search(owner, 'x'.repeat(201))).status).toBe(400);
    const empty = await search(owner, '');
    expect(empty.status).toBe(200);
    expect(empty.body.hits).toEqual([]);
    expect((await search(owner, '   ')).body.hits).toEqual([]);
    // Characters that mean something to a search engine are just text here.
    for (const tricky of ['deploy" OR 1=1 --', 'NEAR(', '*', 'title:deploy', '"unterminated']) {
      expect((await search(owner, tricky)).status, tricky).toBe(200);
    }
  });

  it('a note opened on two devices cannot be silently overwritten — a save or delete with an out-of-date version is refused, and the newer text stays', async () => {
    const created = (await create(owner, 'global', 'Meeting notes', 'First draft.')).body;
    const tablet = await studio.owner();
    const onLaptop = (await note(owner, created.id)).body;
    const onTablet = (await note(tablet, created.id)).body;
    expect(onLaptop.version).toBe(onTablet.version);
    const first = await tablet.put<Json>('/api/memory/note', {
      id: created.id,
      baseVersion: onTablet.version,
      body: 'Edited on the tablet.',
    });
    expect(first.status).toBe(200);
    expect(first.body.version).not.toBe(onTablet.version);

    const stale = await owner.put<ErrorBody>('/api/memory/note', {
      id: created.id,
      baseVersion: onLaptop.version,
      body: 'Edited on the laptop.',
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('memory_note_changed');
    expect((await note(owner, created.id)).body.body).toBe('Edited on the tablet.');
    const staleDelete = await owner.delete<ErrorBody>(
      `/api/memory/note?id=${q(created.id)}&version=${onLaptop.version}`,
    );
    expect(staleDelete.status).toBe(409);
    expect((await note(owner, created.id)).status).toBe(200);
    // With the current version the edit goes through; tags and keywords are kept as given.
    const current = (await note(owner, created.id)).body;
    const saved = await owner.put<Json>('/api/memory/note', {
      id: created.id,
      baseVersion: current.version,
      body: 'Merged by hand.',
      tags: ['Meetings', 'meetings'],
      keywords: ['weekly'],
    });
    expect(saved.body).toMatchObject({ body: 'Merged by hand.', keywords: ['weekly'] });
    expect(saved.body.tags).toEqual(['meetings']);
    // A save must say which version it read.
    expect(
      (await owner.put('/api/memory/note', { id: created.id, body: 'no version' })).status,
    ).toBe(400);
    // The same title again in the same folder is a conflict, not a second file and not an overwrite.
    const twice = await create(
      owner,
      'global',
      'Meeting notes',
      'A different note with the same name.',
    );
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('memory_note_exists');
    expect((await note(owner, created.id)).body.body).toBe('Merged by hand.');
  });

  it('a note can be renamed and moved to another folder; its old id no longer exists', async () => {
    const created = (await create(owner, 'global', 'Scratch idea', 'Worth keeping.')).body;
    const renamed = await owner.post<Json>('/api/memory/note/move', {
      id: created.id,
      title: 'Kept idea',
      baseVersion: created.version,
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({
      id: 'global/kept-idea',
      title: 'Kept idea',
      body: 'Worth keeping.',
    });
    expect((await note(owner, created.id)).status).toBe(404);
    const moved = await owner.post<Json>('/api/memory/note/move', {
      id: renamed.body.id,
      folder: alphaFolder,
    });
    expect(moved.body).toMatchObject({ id: 'alpha-app/kept-idea', folder: alphaFolder });
    expect(
      (await list(owner, `?folder=${alphaFolder}`)).body.notes.map((item) => item.id),
    ).toContain('alpha-app/kept-idea');
    // A folder cannot be invented at the top level, and a note cannot be moved out of the notes altogether.
    for (const folder of [
      'brand-new-top-level',
      '../outside',
      '/etc',
      'alpha-app/../../outside',
      '.hidden',
    ]) {
      const refused = await owner.post<ErrorBody>('/api/memory/note/move', {
        id: moved.body.id,
        folder,
      });
      expect(refused.status, folder).toBeGreaterThanOrEqual(400);
      expect(refused.status, folder).toBeLessThan(500);
    }
    expect((await note(owner, 'alpha-app/kept-idea')).status).toBe(200);
  });

  it('AT-MEM-011/012: a deleted note is gone and the count goes down by one; an unknown id is "not found"; an id that tries to leave the notes is refused as invalid', async () => {
    const created = (await create(owner, 'global', 'Delete me', 'Soon gone.')).body;
    const before = (await list(owner, '?folder=global')).body.total;
    expect((await owner.delete(`/api/memory/note?id=${q(created.id)}`)).status).toBe(204);
    expect((await note(owner, created.id)).status).toBe(404);
    expect((await list(owner, '?folder=global')).body.total).toBe(before - 1);
    expect((await search(owner, 'Soon gone')).body.hits).toEqual([]);

    const unknown = await owner.delete<ErrorBody>('/api/memory/note?id=global/never-existed');
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('memory_note_not_found');
    for (const bad of [
      '../../etc/passwd',
      'global/../../outside',
      '/global/x',
      'global\\x',
      'global/x\u0001y',
      'global/.hidden',
      'x',
    ]) {
      for (const attempt of [
        owner.delete<ErrorBody>(`/api/memory/note?id=${q(bad)}`),
        owner.get<ErrorBody>(`/api/memory/note?id=${q(bad)}`),
      ]) {
        expect((await attempt).status, JSON.stringify(bad)).toBe(400);
      }
    }
    expect((await list(owner, '?folder=global')).body.total).toBe(before - 1);
  });

  it('AT-MEM-018: text that states a credential — a private key, a password assignment, a long random string — is refused for a person too; the refusal names the kind and never repeats the value', async () => {
    const before = (await list(owner)).body.total;
    const key = [
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW',
      '-----END OPENSSH PRIVATE KEY-----',
    ].join('\n');
    const random = 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5bC7d';
    for (const [body, fragment] of [
      [`The deploy key is:\n${key}`, 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmU'],
      ['The database login is password = Xy7!abcd for now.', 'Xy7!abcd'],
      [`Use ${random} to call the service.`, random],
    ] as const) {
      const refused = await create(owner, 'global', `Secret ${fragment.length}`, body);
      expect(refused.status, body.slice(0, 30)).toBe(422);
      expect(refused.body.error.code).toBe('memory_credential');
      expect(refused.body.error.message.length).toBeGreaterThan(10);
      expect(JSON.stringify(refused.body)).not.toContain(fragment);
    }
    // The same when an existing note is edited to contain one.
    const harmless = (
      await create(owner, 'global', 'Access notes', 'Ask the team lead for access.')
    ).body;
    const edited = await owner.put<ErrorBody>('/api/memory/note', {
      id: harmless.id,
      baseVersion: harmless.version,
      body: 'The login is password = Xy7!abcd',
    });
    expect(edited.status).toBe(422);
    expect((await note(owner, harmless.id)).body.body).toBe('Ask the team lead for access.');
    expect((await list(owner)).body.total).toBe(before + 1);
    expect(studio.output()).not.toContain('Xy7!abcd');
  });

  it('AT-MEM-019: mentioning a credential without stating one is fine — where a token is kept, a limit, an algorithm, a rule', async () => {
    for (const [title, body] of [
      ['Where the token lives', 'The API token is kept in the team vault, under "deploy".'],
      ['Token limit', 'The model has a token limit 2048 for this endpoint.'],
      ['Signing', 'The signing key uses ed25519 and is rotated yearly.'],
      ['Password rule', 'A password is mandatory. Use the company password manager.'],
    ] as const) {
      const created = await create(owner, 'global', title, body);
      expect(created.status, `${title}: ${JSON.stringify(created.body)}`).toBe(201);
      expect(created.body.credential).toBeNull();
    }
  });

  it('AT-MEM-020 (adapted): a note needs a title of at most 120 characters without slashes and a body that is neither empty nor oversized', async () => {
    for (const [title, body] of [
      ['Valid title', ''],
      ['', 'A body without a title.'],
      ['   ', 'A body with a blank title.'],
      ['x'.repeat(121), 'Title too long.'],
      ['a/b', 'Slash in the title.'],
      ['a\\b', 'Backslash in the title.'],
      ['Too big', 'x'.repeat(64_001)],
    ] as const) {
      expect(
        (await create(owner, 'global', title, body)).status,
        JSON.stringify(title).slice(0, 30),
      ).toBe(400);
    }
    expect((await create(owner, 'global', 'x'.repeat(120), 'Longest allowed title.')).status).toBe(
      201,
    );
    expect(
      (await create(owner, 'no-such-top-level-folder', 'Stray', 'Nowhere to put it.')).status,
    ).toBeGreaterThanOrEqual(400);
  });

  it('AT-MEM-030: a note’s file edited by hand on the server is what the app reads next — nothing needs restarting', async () => {
    const created = (await create(owner, 'global', 'Edited by hand', 'Written through the app.'))
      .body;
    const status = (await owner.get<Json>('/api/memory/status')).body;
    expect(status).toMatchObject({ healthy: true, problem: null, agentAccess: true });
    const file = path.join(status.location, 'global', 'edited-by-hand.md');
    expect(existsSync(file)).toBe(true);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('Written through the app.');
    writeFileSync(
      file,
      text.replace('Written through the app.', 'Changed in a text editor on the server.'),
    );
    const reread = (await note(owner, created.id)).body;
    expect(reread.body).toContain('Changed in a text editor on the server.');
    expect(reread.version).not.toBe(created.version);
    expect(
      (await search(owner, 'text editor on the server')).body.hits.map((hit) => hit.id),
    ).toContain(created.id);
    // A save that started from the app's old copy is refused: the hand edit is not lost.
    const stale = await owner.put<ErrorBody>('/api/memory/note', {
      id: created.id,
      baseVersion: created.version,
      body: 'The app’s older copy.',
    });
    expect(stale.status).toBe(409);
    // Only the owner is told where the notes live.
    const member = await createMember(studio, owner, 'memlocation');
    expect((await member.get<Json>('/api/memory/status')).body.location).toBeNull();
  });

  it('AT-MEM-013 (people): a member cannot list, search, read, change or watch notes of a project that was not shared with them; read-only sharing is read-only', async () => {
    const secret = (
      await create(owner, alphaFolder, 'Launch plan', 'The launch codename is periwinkle.')
    ).body;
    const member = await createMember(studio, owner, 'memmember');
    await create(owner, 'global', 'For everyone', 'Shared with the whole Studio: marigold.');

    // Not shared: invisible everywhere.
    expect((await note(member, secret.id)).status).toBe(404);
    expect((await search(member, 'periwinkle')).body.hits).toEqual([]);
    expect(
      (await list(member)).body.notes.every(
        (item) => item.folder === 'global' || item.folder.startsWith('global/'),
      ),
    ).toBe(true);
    expect((await list(member, `?folder=${alphaFolder}`)).status).toBe(404);
    expect((await member.get(`/api/memory/tags?folder=${alphaFolder}`)).status).toBe(404);
    expect(
      (await create(member, alphaFolder, 'Planted', 'By someone without the project.')).status,
    ).toBe(404);
    expect(
      (
        await member.put('/api/memory/note', {
          id: secret.id,
          baseVersion: secret.version,
          body: 'Overwritten.',
        })
      ).status,
    ).toBe(404);
    expect((await member.delete(`/api/memory/note?id=${q(secret.id)}`)).status).toBe(404);
    expect(
      (await member.post('/api/memory/note/move', { id: secret.id, folder: 'global' })).status,
    ).toBe(404);
    const live = await Realtime.open(studio, member);
    expect((await live.subscribe(`memory:${alphaFolder}`)).op).toBe('rejected');
    expect((await live.subscribe('memory:global')).op).toBe('subscribed');
    // The shared folder is theirs to read.
    expect((await search(member, 'marigold')).body.hits.map((hit) => hit.title)).toEqual([
      'For everyone',
    ]);

    // Shared read-only: readable, searchable, watchable — not writable.
    await shareProject(owner, alpha.id, member.userId!, 'read');
    const readable = await note(member, secret.id);
    expect(readable.body).toMatchObject({
      body: 'The launch codename is periwinkle.',
      access: 'read',
    });
    expect((await search(member, 'periwinkle')).body.hits.map((hit) => hit.id)).toEqual([
      secret.id,
    ]);
    expect((await live.subscribe(`memory:${alphaFolder}`)).op).toBe('subscribed');
    for (const attempt of [
      create(member, alphaFolder, 'By a reader', 'Not allowed.'),
      member.put('/api/memory/note', {
        id: secret.id,
        baseVersion: readable.body.version,
        body: 'Overwritten.',
      }),
      member.delete(`/api/memory/note?id=${q(secret.id)}`),
      member.post('/api/memory/note/move', { id: secret.id, folder: 'global' }),
    ]) {
      const refused = await attempt;
      expect(refused.status).toBe(403);
      expect((refused.body as ErrorBody).error.code).toBe('memory_read_only');
    }
    // A change made by the owner reaches the reader's device.
    const from = live.mark();
    const changed = await owner.put<Json>('/api/memory/note', {
      id: secret.id,
      baseVersion: readable.body.version,
      body: 'The launch codename is still periwinkle.',
    });
    expect(changed.status).toBe(200);
    const told = await live.event(`memory:${alphaFolder}`, 'memory.changed', { from });
    expect(told.data).toMatchObject({ action: 'updated', id: secret.id });

    // The share is taken away: the folder is gone again and the stream is cut.
    const cutFrom = live.mark();
    await owner.delete(`/api/projects/${alpha.id}/members/${member.userId}`);
    expect((await note(member, secret.id)).status).toBe(404);
    expect((await search(member, 'periwinkle')).body.hits).toEqual([]);
    await owner.put('/api/memory/note', {
      id: secret.id,
      baseVersion: changed.body.version,
      body: 'Changed after the share ended: zinnia.',
    });
    expect((await live.subscribe(`memory:${alphaFolder}`)).op).toBe('rejected');
    expect(JSON.stringify(live.frames.slice(cutFrom))).not.toContain('zinnia');
    await live.close();
  });

  it('AT-MEM-031: every memory capability needs a sign-in, and no answer may be kept by a cache', async () => {
    const visitor = studio.client();
    for (const url of [
      '/api/memory/status',
      '/api/memory/folders',
      '/api/memory/notes',
      '/api/memory/search?q=deploy',
      '/api/memory/tags',
      '/api/memory/note?id=global/glossary',
    ]) {
      expect((await visitor.get(url)).status, url).toBe(401);
      const answered = await owner.get(url);
      expect(answered.status, url).toBe(200);
      expect(answered.headers.get('cache-control'), url).toContain('no-store');
    }
    expect(
      (await visitor.post('/api/memory/notes', { folder: 'global', title: 'Anonymous', body: 'x' }))
        .status,
    ).toBe(401);
    expect((await visitor.delete('/api/memory/note?id=global/glossary')).status).toBe(401);
    // The owner's switches are the owner's.
    const member = await createMember(studio, owner, 'memswitch');
    expect((await member.put('/api/memory/settings', { agentAccess: false })).status).toBe(403);
    expect((await member.post('/api/memory/reindex')).status).toBe(403);
    expect((await owner.get<Json>('/api/memory/status')).body.agentAccess).toBe(true);
  });

  it('the notes are plain files: rebuilding the index from them loses nothing', async () => {
    const before = (await list(owner)).body.total;
    const status = (await owner.get<Json>('/api/memory/status')).body;
    expect(
      readdirSync(path.join(status.location, 'global')).some((name) => name.endsWith('.md')),
    ).toBe(true);
    const rebuilt = await owner.post<Json>('/api/memory/reindex');
    expect(rebuilt.status).toBe(200);
    expect(rebuilt.body.notes).toBe(before);
    expect((await list(owner)).body.total).toBe(before);
    expect((await search(owner, 'deploy')).body.hits.length).toBeGreaterThan(0);
  });
});
